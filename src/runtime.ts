import type { ParsedSkill, SkillOp, OutputDecl } from "./parser.js";
import type { DeliveryMeta, DeliveryReceipt, WakeReceipt, WakeOpts } from "./connectors/agent.js";
import { randomUUID } from "node:crypto";
import { tokenizeKeywordArgs, processSetValue, interpretDoubleQuotedEscapes } from "./parser.js";
import { applyFilter, parseFilterChain } from "./filters.js";
import { dispatchExecuteSkillIntercept } from "./composition.js";
import type { Registry } from "./connectors/registry.js";
import { validateQualifiedDispatch } from "./dispatch-validate.js";
import { spawn } from "node:child_process";
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir } from "node:fs/promises";
import { dirname as pathDirname } from "node:path";
import {
  OpError,
  ConnectorNotFoundError,
  OpTimeoutError,
  UnsafeShellDisabledError,
  ShellBinaryNotAllowedError,
  UnresolvedVariableError,
  TypeMismatchError,
  MissingSkillReferenceError,
  UnconfirmedMutationError,
  messageOf,
} from "./errors.js";
import {
  classifyMutation,
  authorizationGranted,
  buildAuthorizationSuggestion,
  type MutationAuthState,
} from "./mutation-gate.js";
import { TraceBuilder, shouldTraceFire } from "./trace.js";
import type { TraceConfig, TraceStore } from "./trace.js";

/**
 * Runtime executor. Pure mechanical execution: walks the parsed skill
 * tree, dispatches each op to its handler, threads variable state.
 *
 * Key design properties:
 *   - `$ TOOL ...` ops route through McpConnector via the registry.
 *     Without one wired, ops echo and bind null (mechanical-only mode).
 *   - `@ shell ...` is echo-only. Runtime never shell-execs; calling agent
 *     dispatches via its own Bash tool. Principle of least privilege.
 *   - `outputs` populates default-to-`lastBoundVar`, else emissions.
 *   - `??` (ask user) is fail-fast — runtime cannot pause for input.
 *   - `?` (reason) is a thought-step — emitted, doesn't bind.
 *   - Error chain: target-level `else:` → skill-level `# OnError:` fallback
 *     → bubble up.
 *   - Foreach scope is loop-local — vars introduced inside the body deleted on exit.
 */

export interface ExecuteContext {
  registry: Registry;
  /**
   * The skill's OWNER identity — used for outbound substrate scoping.
   * Set from `SkillMeta.author` at every dispatch entry-point (composition,
   * scheduler, MCP execute_skill-by-name). Threaded through to McpConnector
   * dispatch overrides so substrate reads/writes land in the owner's scope.
   *
   * NOT the same as the authenticated caller — for that, see `callerAgentId`
   * below. v0.16.9 wired this for outbound scoping; v0.18.4 split it from
   * caller-identity which had been conflating into `DeliveryMeta.caller_agent_id`.
   */
  agentId?: string;
  /**
   * v0.18.4 — the AUTHENTICATED CALLER who fired this execution.
   * Distinct from `agentId` (owner): a request from agent `cc` invoking
   * a skill owned by agent `alice` produces `callerAgentId=cc, agentId=alice`.
   *
   * Captured at the MCP `/rpc` boundary from `McpRequestCtx.callerIdentity`
   * (when `mcpCallerIdentityHeader` is configured) and threaded through into
   * `DeliveryMeta.origin.caller_agent_id` so notifications correctly
   * attribute the firing agent. Inherited through composition (child skills
   * preserve the original caller even when child runs under a different
   * owner). Scheduler-fired skills (cron, session) leave this undefined —
   * no human caller fired them.
   *
   * Per Perry's Q5a — notifications author as the authenticated caller,
   * NOT the skill author/owner.
   */
  callerAgentId?: string;
  /** Test escape hatch: dispatch `$` ops bare-named tools through this callback when no `primary` McpConnector is registered. */
  toolDispatch?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Invoked when target ops fail with no target-level `else:` but the skill declares `# OnError:`. */
  fallbackSkillExecutor?: (
    skillName: string,
    vars: Record<string, unknown>,
  ) => Promise<ExecuteResult>;
  /** Mechanical-only preview: `$` ops skip real dispatch and bind a placeholder. */
  mechanical?: boolean;
  /**
   * Runtime absolute timeout (milliseconds) — the built-in fallback when no
   * per-op, skill, or connector default applies. Per ERD §6 decision 7,
   * default is 300_000ms (5 minutes). Configurable for tests + deployments
   * with shorter cancellation windows.
   */
  absoluteTimeoutMs?: number;
  /**
   * Enables `@ unsafe <command>` dispatch via full bash shell. Default
   * `false` — `@ unsafe` ops fail with `UnsafeShellDisabledError`. Per
   * Section 4 Security: operators opt in explicitly per deployment; lint
   * flags every `@ unsafe` op regardless.
   */
  enableUnsafeShell?: boolean;
  /**
   * v0.18.8 — operator-controlled allowlist of binaries reachable via
   * `shell(...)` ops. **Default-deny when undefined** (BREAKING from
   * v0.18.7 — adopters must declare what shell binaries their deployment
   * permits). Per Perry's two-axes-decoupled rule (thread `7aab6f3f`):
   * binary-scope (this) and syntax-scope (`enableUnsafeShell`) are
   * independent.
   *
   * Safe path: `shell(command="curl ...")` parses `curl` as the binary;
   * must be in the list.
   * Unsafe path: `shell(command="...", unsafe=true)` invokes `bash -c`;
   * "bash" must be in the list to permit ANY unsafe shell. All-or-nothing
   * on the unsafe path — parse-based binary enumeration would be unsound
   * against agent-author threat model (see playbook for OS-level
   * binary-scope on unsafe path).
   */
  shellAllowlist?: string[];
  /**
   * Dispatch trace recording config per ERD §8. Combined with `traceStore`
   * to persist records. Mode "off" / undefined skips tracing entirely;
   * "on" traces every fire; "sample" samples deterministically via
   * SHA-256(trigger_id + skill_name). Build-only (no persistence) happens
   * when `traceStore` is undefined even with mode "on" — useful for tests.
   */
  trace?: TraceConfig;
  /** Persistence backend for trace records. Wires alongside `trace`. */
  traceStore?: TraceStore;
  /**
   * Trigger context for trace identity + sampling + DeliveryMeta.origin.
   * Scheduler passes the fired trigger's metadata; direct callers can
   * synthesize. v0.9.6 — `source` values are constrained to the Q8 enum
   * (cron / session / webhook / agent / cli / dashboard / inline) when
   * the value flows into DeliveryMeta.origin.trigger_kind.
   */
  triggerCtx?: { source: string; name: string; fired_at_ms: number; trigger_id?: string };
  /**
   * v0.9.6 — root entry-point skill name for composition chains. When
   * skill A inlines B via `&`, A's execution sets this; B's nested
   * execute() inherits it; B's deliver()-time meta gets
   * `entry_skill_name = A`. Undefined for top-level execution (the
   * emitter IS the entry skill).
   */
  entrySkillName?: string;
  /**
   * v0.9.6 — current skill's name + frontmatter eventType, stashed by
   * `execute()` at the top of the per-skill run so deep-stack op
   * handlers (notify(), etc.) can build DeliveryMeta without threading
   * `parsed` through every call hop. Internal-use; do not set from
   * outside execute().
   */
  _currentSkillName?: string;
  _currentSkillEventType?: string | null;
  /** Skill identity for trace records. Optional — falls back to parsed.name + version inference. */
  skillVersion?: string;
  /**
   * Current recursion depth for `$ execute_skill` composition (v0.2.8).
   * Each nested compose-call increments the counter; the runtime throws
   * a structured error when depth exceeds `maxRecursionDepth`. Undefined
   * is treated as 0 (top-level execution).
   */
  recursionDepth?: number;
  /**
   * Recursion-depth ceiling for `$ execute_skill`. Default 10. Configurable
   * for tests + deployments with deeper composition chains.
   */
  maxRecursionDepth?: number;
  /**
   * v0.19.0 — optional pre-minted trace_id. The `/event` HTTP ingress
   * generates a UUID at accept time, returns it synchronously as
   * `run_id` in the 200 response, then dispatches async. The TraceBuilder
   * adopts this ID so the trace later written matches the `run_id` the
   * caller already received. Without this, run_id ≠ trace_id and the
   * synchronous-accept token wouldn't round-trip to the dashboard.
   * Undefined → TraceBuilder mints fresh (existing v1 behavior).
   */
  preMintedTraceId?: string;
}

/**
 * Structured op-error record in `result.errors[]`. Per ERD §8: each entry
 * names the error class, op kind, target, message, and a canned remediation
 * string for operators + agents to act on. `innerCause` preserves the
 * underlying error when the error chain propagated through multiple layers.
 */
export interface ExecutionError {
  target: string;
  opKind: string;
  message: string;
  class: string;
  remediation?: string;
  innerCause?: string;
}

/**
 * v0.9.2 — fallback-fire record per P1.4. When an op's `(fallback: ...)`
 * trailer absorbs a dispatch failure, the runtime appends one record so
 * callers can distinguish "real success" from "fallback substituted."
 * Previously the caller saw `errors: []` either way and couldn't tell.
 */
export interface FallbackRecord {
  target: string;
  opKind: string;
  value: unknown;
  reason: string;
}

export interface ExecuteResult {
  finalVars: Record<string, unknown>;
  emissions: string[];
  outputs: Record<string, unknown>;
  errors: ExecutionError[];
  /**
   * v0.9.2 — fallback events. Populated when an op's `(fallback: ...)`
   * trailer caught a dispatch failure. Empty array when no fallbacks
   * fired. Inspect `length > 0` to detect partial-success runs.
   */
  fallbacks: FallbackRecord[];
  targetOrder: string[];
  /**
   * Delivery receipts from `AgentConnector.deliver` calls fired after the
   * skill completes. Populated when the skill declares
   * `# Output: agent: <name>` or `# Output: template: <name>`. (v0.8.0
   * renamed `prompt-context:` → `agent:` per substrate-neutrality.)
   * Empty array (not undefined) when no agent-targeted output decls fired.
   * Skipped in `mechanical` mode — placeholders aren't delivered to real
   * substrates during previews.
   */
  agentDeliveryReceipts: AgentDeliveryReceiptRecord[];
  /**
   * v0.18.5 — wake receipts from `AgentConnector.wake` calls fired when
   * `notify(agent="X@session", ...)` or `# Output: agent: X@session`
   * routed to wake() instead of deliver(). Per Perry's address-routed
   * notify decision (thread `c453afa2`): the `@session` suffix on the
   * agent_id encodes wake-class dispatch; the runtime routes accordingly.
   * Parallel to `agentDeliveryReceipts` for the deliver-class path.
   */
  agentWakeReceipts: AgentWakeReceiptRecord[];
}

export interface AgentDeliveryReceiptRecord {
  agent_id: string;
  output_kind: "agent" | "template";
  receipt: DeliveryReceipt;
  /**
   * v0.9.2 — true when no real AgentConnector was wired and the
   * NoOpAgentConnector fallback "handled" the dispatch (i.e. accepted
   * the payload without delivering it anywhere). Cold authors writing
   * `# Output: agent: oncall` skills against a runtime without an
   * AgentConnector get a clear signal that the delivery didn't happen.
   * Per P1.1 finding in `dec3ca8a`.
   */
  delivery_skipped?: boolean;
  /** Human-readable reason when `delivery_skipped: true`. */
  reason?: string;
}

/**
 * v0.18.5 — wake-class dispatch receipt. Populated when the runtime
 * routes `notify()` / `# Output: agent:` to `AgentConnector.wake()`
 * because the `agent_id` contained an `@session` suffix.
 *
 * `source_kind` distinguishes the skill-author surface that fired the
 * wake — "notify" (mid-skill imperative op) vs "agent" / "template"
 * (skill-completion lifecycle hook). The substrate sees only the wake()
 * call; this discriminator is for runtime observability + dashboard
 * rendering.
 */
export interface AgentWakeReceiptRecord {
  agent_id: string;
  source_kind: "notify" | "agent" | "template";
  receipt: WakeReceipt;
  /**
   * Set when no real AgentConnector was wired and the NoOp fallback
   * "handled" the wake (with a stderr warning). Mirror of the
   * delivery-side `delivery_skipped` semantics.
   */
  wake_skipped?: boolean;
  /** Human-readable reason when `wake_skipped: true`. */
  reason?: string;
}

interface ExecOpsResult {
  lastBoundVar: string | null;
  lastValue: unknown;
}

/**
 * v0.18.5 — address-routing predicate per Perry's design call (thread
 * `c453afa2`). The presence of `@session` on the agent_id encodes
 * wake-class dispatch; bare addresses route to deliver(). The `@` is
 * the routing signal — same convention as `waiting_on` / mailbox /
 * broker semantics. Returns true if the address contains an `@`
 * (substrate decomposes the composite further if it cares).
 */
function isWakeAddress(agentId: string): boolean {
  return agentId.includes("@");
}

/**
 * v0.18.8 — shell binary-scope predicate per Perry's two-axes-decoupled
 * rule (thread `7aab6f3f`). Default-deny: undefined allowlist refuses
 * every binary. Empty array: explicit "no binaries permitted" — also
 * refuses (distinct from undefined for observability — operator
 * declared the empty list on purpose).
 *
 * Comparison is exact-match on the literal first token. No path
 * resolution, no canonicalization — the token IS the binary as written
 * in the skill source. Operators reason about what's in skill source.
 */
function isBinaryAllowed(binary: string, allowlist: string[] | undefined): boolean {
  if (allowlist === undefined) return false;
  return allowlist.includes(binary);
}

/**
 * v0.18.5 — prepend a runtime-emitted routing-note to a receipt's
 * `warnings` array (creates the array if absent). Used to surface the
 * implicit address-routing decision at receipt-inspection time, per
 * Perry's discoverability requirement. Does not mutate the input
 * receipt; returns a new object.
 */
function addRoutingWarning<R extends { warnings?: string[] }>(receipt: R, note: string): R {
  const existing = receipt.warnings ?? [];
  return { ...receipt, warnings: [note, ...existing] };
}

/**
 * v0.9.6 audit Q8 — build the `DeliveryMeta` envelope for an `AgentConnector.deliver()`
 * call. Runtime is the sole producer of meta; adopters consume but never construct.
 *
 * - `dispatch_id` is one UUID per call to this helper. Lifecycle hook callers and
 *   notify() callers each call it once per emit; multi-connector broadcast (one
 *   notify(), N wired connectors) shares the same id across all N deliver() calls
 *   because we hold the same `meta` reference across the loop.
 * - `sent_at` is the runtime emit-clock (NOT the substrate's delivered_at).
 * - `origin.trigger_kind` maps from `ctx.triggerCtx.source` per Q8 enum.
 *   `inline` is the fallback when no triggerCtx is set.
 * - `origin.entry_skill_name` propagates from `ctx.entrySkillName` (set when
 *   composition runs an inner skill).
 * - `origin.caller_agent_id` propagates from `ctx.callerAgentId` (v0.18.4) —
 *   the AUTHENTICATED CALLER who fired the dispatch. Distinct from
 *   `ctx.agentId` (skill OWNER, used for outbound substrate scoping). Cron /
 *   session triggers leave it undefined (no human caller); MCP execute_skill
 *   under `X-Agent-Id: X` populates it from the inbound header; composition
 *   inherits it from the parent context (child skills preserve the original
 *   caller even when run under a different owner).
 * - `event_type` precedence: opOverrides.event_type ?? parsed.eventType ?? undefined.
 *   `notify(event_type=...)` kwarg wins; `# Event-type:` frontmatter is the fallback.
 * - `correlation_id` only set when explicitly passed via opOverrides (notify()
 *   kwarg). Lifecycle hooks always emit with correlation_id undefined per Q8.
 */
function buildLifecycleMeta(
  skillName: string | null,
  frontmatterEventType: string | null,
  ctx: ExecuteContext,
  opOverrides?: { event_type?: string; correlation_id?: string },
): DeliveryMeta {
  const triggerKind = (ctx.triggerCtx?.source ?? "inline") as DeliveryMeta["origin"]["trigger_kind"];
  const eventType = opOverrides?.event_type ?? frontmatterEventType ?? undefined;
  const name = skillName ?? "(unnamed)";
  return {
    dispatch_id: randomUUID(),
    sent_at: Date.now(),
    origin: {
      skill_name: name,
      ...(ctx.entrySkillName !== undefined && ctx.entrySkillName !== name
        ? { entry_skill_name: ctx.entrySkillName }
        : {}),
      trigger_kind: triggerKind,
      ...(ctx.callerAgentId !== undefined ? { caller_agent_id: ctx.callerAgentId } : {}),
    },
    ...(eventType !== undefined ? { event_type: eventType } : {}),
    ...(opOverrides?.correlation_id !== undefined ? { correlation_id: opOverrides.correlation_id } : {}),
  };
}

/**
 * Execute a parsed skill against the live variable state. Walks targets in
 * the provided order. Each target's ops run sequentially; on failure the
 * chain falls back to `else:` → `# OnError:` → bubble.
 */
export async function execute(
  parsed: ParsedSkill,
  initialVars: Record<string, unknown>,
  order: string[],
  ctx: ExecuteContext,
): Promise<ExecuteResult> {
  const vars = new Map<string, unknown>();
  // Tier-1 ambient refs per language reference §3. Runtime injects these
  // by default; caller-provided initialVars override (e.g., scheduler's
  // dispatchSkill pre-populates EVENT.* and TRIGGER_TYPE for cron/session
  // fires; bare execute() callers still get clock-time defaults so
  // `$(EVENT.fired_at_unix)` resolves uniformly across dispatch paths).
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  // v0.5.0 item 6: align $(NOW) with the documented shape — ISO-8601
  // timestamp per language reference §3 + help-content frontmatter.
  // Pre-v0.5.0 substituted raw epoch ms; cold authors (R3 minion 2) hit
  // the surprise. Numeric epoch ms/sec remain available via
  // $(EVENT.fired_at) / $(EVENT.fired_at_unix).
  vars.set("NOW", new Date(nowMs).toISOString());
  vars.set("USER", ctx.agentId ?? "unknown");
  vars.set("SESSION_CONTEXT", "");
  // v0.9.6 — "manual" enum value dropped per audit Q12; "inline" is the
  // fallback for runtime-direct callers without explicit trigger context.
  vars.set("TRIGGER_TYPE", "inline");
  vars.set("TRIGGER_PAYLOAD", "");
  vars.set("EVENT.fired_at", nowMs);
  vars.set("EVENT.fired_at_unix", nowSec);
  vars.set("EVENT.fired_at_plus_1h_unix", nowSec + 3600);
  vars.set("EVENT.fired_at_plus_1d_unix", nowSec + 86_400);
  vars.set("EVENT.fired_at_plus_7d_unix", nowSec + 604_800);
  for (const v of parsed.vars) {
    if (v.default !== undefined) vars.set(v.name, coerceLiteralValue(v.default));
  }
  for (const [k, val] of Object.entries(initialVars)) {
    vars.set(k, typeof val === "string" ? coerceLiteralValue(val) : val);
  }
  const emissions: string[] = [];
  const errors: ExecutionError[] = [];
  const fallbacks: FallbackRecord[] = [];
  let lastBoundVar: string | null = null;

  const absoluteTimeoutMs = ctx.absoluteTimeoutMs ?? DEFAULT_RUNTIME_ABSOLUTE_TIMEOUT_MS;

  // Trace recording (per ERD §8). Build when shouldTraceFire returns true;
  // skip entirely when off (the NFR-11 floor — errors still surface via
  // `result.errors[]`).
  // v0.9.6 — "manual" enum value dropped per audit Q12; "inline" is the
  // fallback for callers without explicit trigger context.
  const triggerCtx = ctx.triggerCtx ?? { source: "inline", name: "", fired_at_ms: nowMs };
  const triggerId = triggerCtx.trigger_id ?? `${triggerCtx.source}:${triggerCtx.name}`;
  const skillName = parsed.name ?? "(anonymous)";
  // v0.9.6 — stash skill identity onto ctx so deep-stack op handlers
  // (notify()) can read for DeliveryMeta without threading `parsed`
  // through every call hop. Internal convention; do not set from outside.
  ctx = { ...ctx, _currentSkillName: skillName, _currentSkillEventType: parsed.eventType };
  const traceBuilder = shouldTraceFire(ctx.trace, triggerId, skillName)
    ? new TraceBuilder(skillName, ctx.skillVersion ?? "unknown", triggerCtx, { agent_id: ctx.agentId }, ctx.preMintedTraceId)
    : null;

  for (const targetName of order) {
    const target = parsed.targets.get(targetName);
    if (!target) continue;

    let targetLastBound: string | null = null;
    let targetLastValue: unknown = undefined;

    // Fresh mutation-auth state per target. `skillAutonomous` is set from
    // the parsed header. v0.16.0 retired the `sawConfirm` path with the
    // `ask` op removal.
    const authState: MutationAuthState = {
      skillAutonomous: parsed.autonomous === true,
    };
    try {
      const r = await execOps(target.ops, vars, emissions, fallbacks, ctx, targetName, parsed.timeout, absoluteTimeoutMs, traceBuilder, authState);
      targetLastBound = r.lastBoundVar;
      targetLastValue = r.lastBoundVar !== null ? vars.get(r.lastBoundVar) : r.lastValue;
    } catch (err) {
      errors.push(buildExecutionError(err, targetName));
      if (target.elseBlock !== undefined) {
        try {
          const r = await execOps(target.elseBlock, vars, emissions, fallbacks, ctx, targetName, parsed.timeout, absoluteTimeoutMs, traceBuilder, authState);
          targetLastBound = r.lastBoundVar;
          targetLastValue = r.lastBoundVar !== null ? vars.get(r.lastBoundVar) : r.lastValue;
        } catch (innerErr) {
          errors.push(buildExecutionError(innerErr, targetName, "else"));
        }
      } else if (parsed.onError !== null && ctx.fallbackSkillExecutor) {
        try {
          const fbResult = await ctx.fallbackSkillExecutor(
            parsed.onError,
            Object.fromEntries(vars),
          );
          for (const em of fbResult.emissions) emissions.push(em);
          for (const fe of fbResult.errors) errors.push(fe);
        } catch (fbErr) {
          errors.push(buildExecutionError(fbErr, parsed.onError, "skill-fallback"));
        }
        break;
      } else {
        break;
      }
    }

    vars.set(`${targetName}.output`, targetLastValue);
    if (targetLastBound !== null) lastBoundVar = targetLastBound;
  }

  // Outputs map per `# Output:` declarations. Per-kind value semantics:
  //   - Agent-bound surfaces (`agent:`, `template:`): default to joined
  //     emissions. These deliver content for an agent to read or execute;
  //     trailing op JSON values are the wrong shape.
  //   - Programmatic surfaces (`text`, `file:`): default to lastBoundVar
  //     (structured), fall back to emissions array. Callers consuming
  //     `outputs.text` typically want the structured return value.
  //   - `none`: no-op marker; value irrelevant.
  // Output payload-shape coercion: when the output kind is text-shaped
  // (joined emissions are the natural delivery payload) we publish the
  // string in `outputs[key]`; otherwise we pass the last bound variable
  // through structurally. Membership here is about payload shape, not
  // semantic destination.
  const TEXT_COERCED_OUTPUT_KINDS = new Set<OutputDecl["kind"]>(["agent", "template"]);
  // Agent-bound dispatch uses literal kind checks below so TS can narrow
  // `decl.kind` to the discriminated `DeliveryPayload.kind` automatically;
  // a runtime Set forces a type predicate. Keep the literals colocated
  // with the dispatch loop so the agent-bound semantic set is one-line
  // grep-able.
  const outputDecls: OutputDecl[] = parsed.outputs.length > 0
    ? parsed.outputs
    : [{ kind: "text" }];
  // v0.19.4 — body-text-as-output template. When the skill authored a
  // template (text between frontmatter and first target), render it
  // once with the final vars map and let it own canonical output across
  // all kinds. Empty / absent template preserves legacy joined-emissions
  // / lastBoundVar fallbacks exactly. Complementary channels per
  // c7ddfc50: emit() continues to feed transcript via `emissions`
  // unchanged — only the canonical-output channel shifts. Per
  // Perry+CC sign-off in 920078c8.
  const canonicalTemplate: string | null = parsed.outputTemplate !== null
    ? substituteRuntime(parsed.outputTemplate, vars)
    : null;
  const outputs: Record<string, unknown> = {};
  for (const decl of outputDecls) {
    const key = decl.target !== undefined ? `${decl.kind}:${decl.target}` : decl.kind;
    if (canonicalTemplate !== null) {
      outputs[key] = canonicalTemplate;
    } else if (TEXT_COERCED_OUTPUT_KINDS.has(decl.kind)) {
      outputs[key] = emissions.join("\n");
    } else if (emissions.length > 0) {
      // v0.19.10 — emissions over lastBoundVar for text/file/none kinds when
      // emit() was called. Pre-v0.19.10 `lastBoundVar` masked emit()
      // entries: a skill that emit()'d a brief AND bound `-> R` mid-flow
      // (internal scratch) had outputs.text = R, hiding the brief. Closes
      // Perry's `650c5a9c` Finding 3 — the author explicitly wrote
      // `emit()`, so emissions ARE the intended output; `-> R` is scratch.
      outputs[key] = emissions.join("\n");
    } else if (lastBoundVar !== null && vars.has(lastBoundVar)) {
      outputs[key] = vars.get(lastBoundVar);
    } else {
      outputs[key] = emissions.slice();
    }
  }

  // Dispatch agent-targeted output decls through AgentConnector.
  // (T7.1) `agent: <name>` routes as `kind: "augment"` (v0.8.0 rename
  // of legacy `prompt-context:`); `template: <name>` as `kind: "template"`.
  //
  // v0.18.5 — address-routed dispatch per Perry's design call (thread
  // `c453afa2`). The `agent_id` itself encodes the dispatch class:
  //   - bare `<agent>` → `AgentConnector.deliver()` (mailbox-class)
  //   - `<agent>@<session>` → `AgentConnector.wake()` (session-targeted
  //     interrupt; suffix preserved on the opaque `agent_id` passed to
  //     wake — substrate decomposes per v0.18.2 contract)
  //
  // Skipped in mechanical mode so previews don't deliver placeholder
  // content to real substrates. Connector fallback:
  // Registry.getAgentConnectorOrDefault() returns a transparent
  // NoOpAgentConnector when no adapter is wired, so the dispatch loop
  // never throws on missing-substrate; we pair with the explicit
  // `hasAgentConnector()` check to flag `delivery_skipped` /
  // `wake_skipped`.
  const agentDeliveryReceipts: AgentDeliveryReceiptRecord[] = [];
  const agentWakeReceipts: AgentWakeReceiptRecord[] = [];
  if (ctx.mechanical !== true) {
    for (const decl of outputDecls) {
      if (decl.target === undefined) continue;
      // Agent-bound output kinds: literal `===` so TS narrows decl.kind
      // for the deliver() payload discriminator below.
      if (decl.kind !== "agent" && decl.kind !== "template") continue;
      const key = `${decl.kind}:${decl.target}`;
      const body = String(outputs[key] ?? emissions.join("\n"));
      const agent = ctx.registry.getAgentConnectorOrDefault();
      // v0.9.6 audit Q8 — build DeliveryMeta per the locked v1.0 shape.
      const meta = buildLifecycleMeta(parsed.name, parsed.eventType, ctx);
      // v0.9.2 — P1.1 flag the no-op dispatch case.
      const hasRealConnector = ctx.registry.hasAgentConnector();
      const routesToWake = isWakeAddress(decl.target);
      try {
        if (routesToWake) {
          // v0.18.5 — wake-class dispatch. `body` becomes WakeOpts.context
          // (preamble for the wake message). `agent_id` includes the
          // `@session` suffix — substrate decomposes.
          const wakeOpts: WakeOpts = body.length > 0 ? { context: body } : {};
          const wakeReceipt = await agent.wake(decl.target, wakeOpts);
          const enriched = addRoutingWarning(wakeReceipt, "lifecycle-hook routed to wake-class because agent_id contains '@session'");
          const wakeRecord: AgentWakeReceiptRecord = { agent_id: decl.target, source_kind: decl.kind, receipt: enriched };
          if (!hasRealConnector) {
            wakeRecord.wake_skipped = true;
            wakeRecord.reason = `No AgentConnector wired for runtime; NoOpAgentConnector accepted but didn't wake. Wire an AgentConnector via registry.registerAgentConnector('primary', <YourImpl>) to enable real wake.`;
          }
          agentWakeReceipts.push(wakeRecord);
        } else {
          const receipt = decl.kind === "agent"
            ? await agent.deliver(decl.target, { kind: "augment", content: body, meta })
            : await agent.deliver(decl.target, { kind: "template", prompt: body, meta });
          const record: AgentDeliveryReceiptRecord = { agent_id: decl.target, output_kind: decl.kind, receipt };
          if (!hasRealConnector) {
            record.delivery_skipped = true;
            record.reason = `No AgentConnector wired for runtime; NoOpAgentConnector accepted but didn't deliver. Wire an AgentConnector via registry.registerAgentConnector('primary', <YourImpl>) to enable real delivery.`;
          } else if (receipt.delivery_skipped === true) {
            // v0.9.6 Q7 — connector signaled accept-but-not-pushed (offline,
            // rate-limit drop, etc.). Honor the contract-level signal.
            record.delivery_skipped = true;
          }
          agentDeliveryReceipts.push(record);
        }
      } catch (err) {
        // Dispatch failure is non-fatal — record alongside other errors so
        // the dashboard surfaces it, but don't propagate. Skill execution
        // already succeeded by this point.
        process.stderr.write(
          `[agent-dispatch] ${decl.kind}:${decl.target} (${routesToWake ? "wake" : "deliver"}) failed: ${(err as Error).message}\n`,
        );
      }
    }
  }

  // Persist trace record if recording was active. Write is non-blocking —
  // a failed write logs to stderr but doesn't change the execute() result
  // (per ERD §8 NFR-11 floor: errors in trace persistence shouldn't bubble
  // up as op errors; the trace store is an observability surface, not a
  // dispatch dependency).
  if (traceBuilder !== null && ctx.traceStore !== undefined) {
    const record = traceBuilder.finalize(emissions, outputs, errors);
    try {
      await ctx.traceStore.write(record);
    } catch (err) {
      process.stderr.write(`[trace] failed to write record ${record.trace_id}: ${(err as Error).message}\n`);
    }
  }

  return {
    finalVars: Object.fromEntries(vars),
    emissions,
    outputs,
    errors,
    fallbacks,
    targetOrder: order,
    agentDeliveryReceipts,
    agentWakeReceipts,
  };
}

async function execOps(
  ops: SkillOp[],
  vars: Map<string, unknown>,
  emissions: string[],
  fallbacks: FallbackRecord[],
  ctx: ExecuteContext,
  targetName: string,
  skillTimeoutSec: number | string | null,
  absoluteTimeoutMs: number,
  traceBuilder: TraceBuilder | null,
  authState: MutationAuthState,
): Promise<ExecOpsResult> {
  let lastBoundVar: string | null = null;
  let lastValue: unknown = undefined;
  for (const op of ops) {
    // v0.16.0 — `ask` removed; mutation gate now relies solely on `approved=`
    // per-op kwarg + `# Autonomous: true` skill flag (sawConfirm path retired).
    const mutKind = classifyMutation(op);
    if (mutKind !== null && !authorizationGranted(op, authState)) {
      throw new UnconfirmedMutationError(
        mutKind.kind,
        mutKind.detail,
        ["# Autonomous: true header", "approved=\"reason\" per-op kwarg"],
        buildAuthorizationSuggestion(mutKind),
        op.kind,
        targetName,
      );
    }
    const r = await execOp(op, vars, emissions, fallbacks, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs, traceBuilder, authState);
    if (r.lastBoundVar !== null) {
      lastBoundVar = r.lastBoundVar;
      lastValue = r.lastValue;
    } else if (r.lastValue !== undefined) {
      lastValue = r.lastValue;
    }
  }
  return { lastBoundVar, lastValue };
}

async function execOp(
  op: SkillOp,
  vars: Map<string, unknown>,
  emissions: string[],
  fallbacks: FallbackRecord[],
  ctx: ExecuteContext,
  targetName: string,
  skillTimeoutSec: number | string | null,
  absoluteTimeoutMs: number,
  traceBuilder: TraceBuilder | null,
  authState: MutationAuthState,
): Promise<ExecOpsResult> {
  const startMs = traceBuilder !== null ? Date.now() : 0;
  let errored = false;
  let blockedReason: "binary-not-allowed" | undefined;
  try {
    return await execOpInner(op, vars, emissions, fallbacks, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs, traceBuilder, authState);
  } catch (err) {
    errored = true;
    // v0.18.8 — capture structured block reasons so dashboards can
    // filter `/fires` by "what binaries did skills try to invoke off
    // the allowlist." Per Perry's observe→promote loop.
    if (err instanceof ShellBinaryNotAllowedError) {
      blockedReason = "binary-not-allowed";
    }
    // Default-tag any escaping error with `op.kind`. Explicit makeOpError()
    // tags take precedence. Fixes the case where `~` failures classified as `?`.
    const e = err as Error & { opKind?: string };
    if (e.opKind === undefined) e.opKind = op.kind;
    throw e;
  } finally {
    if (traceBuilder !== null) {
      const connector = extractOpConnector(op);
      traceBuilder.recordOp({
        op_kind: op.kind,
        target: targetName,
        body: op.body,
        started_at_ms: startMs,
        duration_ms: Date.now() - startMs,
        errored,
        ...(connector !== undefined ? { connector } : {}),
        ...(blockedReason !== undefined ? { blocked_reason: blockedReason } : {}),
      });
    }
  }
}

/** Extract the connector instance name for `$` ops; undefined for others. */
function extractOpConnector(op: SkillOp): string | undefined {
  if (op.kind === "$") return op.mcpConnector ?? "primary";
  return undefined;
}

async function execOpInner(
  op: SkillOp,
  vars: Map<string, unknown>,
  emissions: string[],
  fallbacks: FallbackRecord[],
  ctx: ExecuteContext,
  targetName: string,
  skillTimeoutSec: number | string | null,
  absoluteTimeoutMs: number,
  traceBuilder: TraceBuilder | null,
  authState: MutationAuthState = { skillAutonomous: false },
): Promise<ExecOpsResult> {
  switch (op.kind) {
    case "$set": {
      // v0.5.0 item 3 — `$set X = "...$(REF)..."` now resolves $(REF) at
      // bind time. Pre-v0.5.0 this was literals-only per the v0.2.6 spec
      // (lesson `dc824ee4`); the cold-author corpus hit the literals-only
      // footgun twice (T6 dogfood + R3 minion 4) independently. Mirrors
      // bash double-quoted assignment.
      const substituted = substituteRuntime(op.setValue!, vars);
      const coerced = coerceLiteralValue(substituted);
      vars.set(op.setName!, coerced);
      return { lastBoundVar: op.setName!, lastValue: coerced };
    }
    case "$append": {
      // v0.3.0 accumulator. Append a value to a list-typed VAR that was
      // previously initialized in an enclosing scope (via `$set VAR = []`
      // or `# Vars: VAR=[]`). Substitutes refs in the value first — unlike
      // $set which is literals-only — because the canonical pattern is
      // appending an iteration-local ref like `$(M.id)`.
      const targetName = op.setName!;
      const existing = vars.get(targetName);
      if (existing === undefined) {
        // Lint should have caught this at compile; defensive guard at runtime
        // for skipLintPreflight paths or programmatic execution.
        throw new OpError(
          `\`$append ${targetName} ...\`: target variable not initialized.`,
          "$append",
          `Initialize via \`$set ${targetName} = []\` (list-append) or \`$set ${targetName} = ""\` (string-concat), or declare in \`# Vars: ${targetName}=[]\`.`,
          targetName,
        );
      }
      const substituted = substituteRuntime(op.setValue!, vars);
      const coerced = coerceLiteralValue(substituted);
      if (ctx.mechanical === true) {
        // Mechanical mode: emit the append record, do NOT mutate. Per spec —
        // the placeholder remains in place for downstream refs; the trace
        // shows what would have been appended.
        emissions.push(
          `Would append to $(${targetName}): ${stringifyValue(coerced)} (mechanical: true preview).`,
        );
        return { lastBoundVar: targetName, lastValue: existing };
      }
      // v0.5.0 item 2 — bash-shaped pair: type-dispatch on target.
      // List → push (existing v0.3.0 behavior). String → concatenate
      // (new). Numeric/object/null → tier-1 error. Closes the
      // string-composition gap the R3 corpus hit (minion 4).
      if (Array.isArray(existing)) {
        existing.push(coerced);
        return { lastBoundVar: targetName, lastValue: existing };
      }
      if (typeof existing === "string") {
        const appendStr = typeof coerced === "string" ? coerced : stringifyValue(coerced);
        const concatenated = existing + appendStr;
        vars.set(targetName, concatenated);
        return { lastBoundVar: targetName, lastValue: concatenated };
      }
      throw new OpError(
        `\`$append ${targetName} ...\`: target must be a list or string (got ${existing === null ? "null" : typeof existing}).`,
        "$append",
        `Initialize via \`$set ${targetName} = []\` for list-append, or \`$set ${targetName} = ""\` for string-concat.`,
        targetName,
      );
    }
    case "?": {
      const body = substituteRuntime(op.body, vars);
      emissions.push(`Reason: ${body}`);
      return { lastBoundVar: null, lastValue: undefined };
    }
    case "emit": {
      const body = substituteRuntime(op.body, vars);
      emissions.push(body);
      return { lastBoundVar: null, lastValue: undefined };
    }
    case "shell": {
      // v0.19.12 — shell op now honors `(fallback: "...")` op-trailer
      // (closes Perry's `9d8ff1b1`). Pre-fix the trailer was silently
      // no-oped on shell — file_read's precedent (catch throw → bind
      // fallback + record) is the right pattern. Apply uniformly: argv
      // form, command= form, and unsafe form all share the same
      // try/catch + empty-result coverage. Fallback triggers on:
      // (a) any throw during execution, (b) empty-string stdout after
      // trim — matching the $-dispatch op-trailer semantics.
      const shellFallback = op.fallback;
      const recordShellFallback = (value: string, reason: string): {
        lastBoundVar: string;
        lastValue: string;
      } => {
        const flatKey = `${targetName}.output`;
        vars.set(flatKey, value);
        if (op.outputVar !== undefined) vars.set(op.outputVar, value);
        fallbacks.push({
          target: targetName,
          opKind: "shell",
          value,
          reason,
        });
        return { lastBoundVar: op.outputVar ?? flatKey, lastValue: value };
      };

      // v0.19.11 — argv form. Explicit token list; no tokenization, no
      // quote-stripping, no shell. Each element gets per-element
      // substitution and goes directly to spawn(argv[0], argv.slice(1)).
      // Closes Perry's `adc87d52` cold-author-safety finding.
      if (op.argv !== undefined) {
        const substArgv = op.argv.map((el) => substituteRuntime(el, vars));
        const shellTimeoutMs = resolveOpTimeoutMs(undefined, skillTimeoutSec, absoluteTimeoutMs, vars);
        if (ctx.mechanical === true) {
          const preview = substArgv.join(" ");
          emissions.push(`Would run shell argv: ${preview} (mechanical: true preview).`);
          const flatKey = `${targetName}.output`;
          const placeholder = `[mechanical: would run argv ${preview.slice(0, 40)}${preview.length > 40 ? "..." : ""}]`;
          vars.set(flatKey, placeholder);
          if (op.outputVar !== undefined) vars.set(op.outputVar, placeholder);
          return {
            lastBoundVar: op.outputVar ?? flatKey,
            lastValue: placeholder,
          };
        }
        const [bin, ...args] = substArgv;
        let stdoutArgv: string;
        try {
          // v0.18.8 binary-scope gate. argv[0] IS the binary by construction;
          // the allowlist applies identically to argv mode and command= mode.
          if (!isBinaryAllowed(bin!, ctx.shellAllowlist)) {
            throw new ShellBinaryNotAllowedError(bin!, ctx.shellAllowlist, targetName);
          }
          stdoutArgv = await execShellCommand(bin!, args, shellTimeoutMs);
        } catch (err) {
          if (shellFallback !== undefined) {
            return recordShellFallback(shellFallback, `shell argv failed: ${messageOf(err)}`);
          }
          throw err;
        }
        // Empty-stdout fallback (matches $-op trailer empty-result semantic).
        if (shellFallback !== undefined && stdoutArgv.trim() === "") {
          return recordShellFallback(shellFallback, "shell argv produced empty stdout");
        }
        const flatKeyArgv = `${targetName}.output`;
        vars.set(flatKeyArgv, stdoutArgv);
        if (op.outputVar !== undefined) vars.set(op.outputVar, stdoutArgv);
        return {
          lastBoundVar: op.outputVar ?? flatKeyArgv,
          lastValue: stdoutArgv,
        };
      }
      const body = op.policy === "unsafe"
        ? substituteRuntimeUnsafe(op.body, vars)
        : substituteRuntime(op.body, vars);
      const shellTimeoutMs = resolveOpTimeoutMs(undefined, skillTimeoutSec, absoluteTimeoutMs, vars);
      if (ctx.mechanical === true) {
        const label = op.policy === "unsafe" ? "Would run unsafe shell" : "Would run shell";
        emissions.push(`${label}: ${body} (mechanical: true preview).`);
        const flatKey = `${targetName}.output`;
        const placeholder = `[mechanical: would run ${body.slice(0, 40)}${body.length > 40 ? "..." : ""}]`;
        vars.set(flatKey, placeholder);
        if (op.outputVar !== undefined) vars.set(op.outputVar, placeholder);
        return {
          lastBoundVar: op.outputVar ?? flatKey,
          lastValue: placeholder,
        };
      }
      let stdout: string;
      try {
        if (op.policy === "unsafe") {
          if (ctx.enableUnsafeShell !== true) {
            throw new UnsafeShellDisabledError(body, targetName);
          }
          // v0.18.8 — binary-scope gate (independent axis from
          // ENABLE_UNSAFE_SHELL). Unsafe path invokes `bash -c <body>`;
          // the literal first token IS `bash`. All-or-nothing: bash on
          // allowlist → unsafe runs anything; bash off → unsafe refused.
          // Per Perry's reframe (thread `7aab6f3f`): NO parse-based
          // enumeration of body binaries — it's unsound against agent-
          // author threat model. Sound binary-scope on unsafe is OS-level.
          if (!isBinaryAllowed("bash", ctx.shellAllowlist)) {
            throw new ShellBinaryNotAllowedError("bash", ctx.shellAllowlist, targetName);
          }
          stdout = await execShellCommand("bash", ["-c", body], shellTimeoutMs);
        } else {
          const tokens = tokenizeShellArgs(body);
          if (tokens.length === 0) {
            throw new OpError(
              `Empty \`shell(...)\` op body in target '${targetName}'.`,
              "shell",
              "Provide a non-empty `command=\"...\"` kwarg.",
              targetName,
            );
          }
          const [bin, ...args] = tokens;
          // v0.18.8 — binary-scope gate. Safe-path grammar guarantees
          // one binary + no metacharacters, so the first token IS the
          // binary. Default-deny when allowlist unset (BREAKING).
          if (!isBinaryAllowed(bin!, ctx.shellAllowlist)) {
            throw new ShellBinaryNotAllowedError(bin!, ctx.shellAllowlist, targetName);
          }
          stdout = await execShellCommand(bin!, args, shellTimeoutMs);
        }
      } catch (err) {
        if (shellFallback !== undefined) {
          return recordShellFallback(shellFallback, `shell failed: ${messageOf(err)}`);
        }
        throw err;
      }
      // Empty-stdout fallback (matches $-op trailer empty-result semantic).
      if (shellFallback !== undefined && stdout.trim() === "") {
        return recordShellFallback(shellFallback, "shell produced empty stdout");
      }
      const flatKey = `${targetName}.output`;
      vars.set(flatKey, stdout);
      if (op.outputVar !== undefined) vars.set(op.outputVar, stdout);
      return {
        lastBoundVar: op.outputVar ?? flatKey,
        lastValue: stdout,
      };
    }
    case "inline": {
      // Deferred-resolution path. `inline` ops that reached runtime are
      // either (a) forward-references that compile couldn't inline because
      // the target wasn't yet stored, or (b) the rare "raw AST bypassed
      // compile()" case. Surface as MissingSkillReferenceError so `# OnError:`
      // can catch.
      const skillName = op.ampParams?.skillName ?? "(unknown)";
      throw new MissingSkillReferenceError(skillName, "inline", "inline", targetName);
    }
    case "file_read": {
      // v0.7.0 — runtime-intrinsic file read. Substitutes `${VAR}` /
      // `$(VAR)` in the path before resolving.
      const rawPath = op.fileParams?.path ?? "";
      const path = substituteRuntime(rawPath, vars);
      const flatKey = `${targetName}.output`;
      if (ctx.mechanical === true) {
        const placeholder = `[mechanical: would read ${path}]`;
        emissions.push(`Would read file: ${path} (mechanical: true preview).`);
        vars.set(flatKey, placeholder);
        if (op.outputVar !== undefined) vars.set(op.outputVar, placeholder);
        return { lastBoundVar: op.outputVar ?? flatKey, lastValue: placeholder };
      }
      let content: string;
      try {
        content = await fsReadFile(path, "utf8");
      } catch (err) {
        if (op.fallback !== undefined) {
          const fallbackValue = op.fallback;
          vars.set(flatKey, fallbackValue);
          if (op.outputVar !== undefined) vars.set(op.outputVar, fallbackValue);
          // v0.9.2 — P1.4 record fallback firing so callers can distinguish
          // "read succeeded" from "fallback substituted."
          fallbacks.push({
            target: targetName,
            opKind: "file_read",
            value: fallbackValue,
            reason: `file_read failed: ${messageOf(err)}`,
          });
          return { lastBoundVar: op.outputVar ?? flatKey, lastValue: fallbackValue };
        }
        throw new OpError(
          `\`file_read(path="${path}")\` in target '${targetName}' failed: ${messageOf(err)}`,
          "file_read",
          "Verify the path exists and is readable, or add `(fallback: \"default\")` to the op for graceful failure.",
          targetName,
        );
      }
      vars.set(flatKey, content);
      if (op.outputVar !== undefined) vars.set(op.outputVar, content);
      return { lastBoundVar: op.outputVar ?? flatKey, lastValue: content };
    }
    case "file_write": {
      // v0.7.0 — runtime-intrinsic file write. Substitutes `${VAR}` /
      // `$(VAR)` in both path and content before writing.
      // v0.14.1 Layer B — mutation gate regression guard. Same predicate
      // as Layer A in `execOps`; defense-in-depth against any future
      // caller that bypasses the dispatcher. Fail-closed default authState
      // makes this throw if invoked outside the normal execOps path.
      {
        const mutKind = classifyMutation(op);
        if (mutKind !== null && !authorizationGranted(op, authState)) {
          throw new UnconfirmedMutationError(
            mutKind.kind,
            mutKind.detail,
            ["# Autonomous: true header", "preceding ?? / ask() in same target", "approved=\"reason\" per-op kwarg"],
            buildAuthorizationSuggestion(mutKind),
            op.kind,
            targetName,
          );
        }
      }
      const rawPath = op.fileParams?.path ?? "";
      const rawContent = op.fileParams?.content ?? "";
      const path = substituteRuntime(rawPath, vars);
      const content = substituteRuntime(rawContent, vars);
      if (ctx.mechanical === true) {
        emissions.push(`Would write file: ${path} (${content.length} chars; mechanical: true preview).`);
        return { lastBoundVar: null, lastValue: undefined };
      }
      try {
        await fsMkdir(pathDirname(path), { recursive: true });
        await fsWriteFile(path, content, "utf8");
      } catch (err) {
        throw new OpError(
          `\`file_write(path="${path}")\` in target '${targetName}' failed: ${messageOf(err)}`,
          "file_write",
          "Verify the path is writable. Parent directory is auto-created; check filesystem permissions.",
          targetName,
        );
      }
      // v0.9.2 — P2.5 transcript line on successful write so cold authors
      // can confirm side effects landed without reading the file back.
      emissions.push(`[file_write] wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`);
      return { lastBoundVar: null, lastValue: undefined };
    }
    case "notify": {
      // v0.8.0 — mid-skill synchronous agent alert via wired AgentConnector(s).
      // `agent` is required; `message` defaults to joined accumulated emissions
      // when absent (per the Q1 lockdown — `notify(agent="X")` with no message
      // delivers what's been emitted so far). `connectors` optionally restricts
      // the fan-out to a named subset.
      const rawAgent = op.notifyParams?.agent ?? "";
      const agent = substituteRuntime(rawAgent, vars);
      const rawMessage = op.notifyParams?.message;
      const message = rawMessage !== undefined
        ? substituteRuntime(rawMessage, vars)
        : emissions.join("\n");
      const restrictConnectors = op.notifyParams?.connectors;
      const flatKey = `${targetName}.output`;

      if (ctx.mechanical === true) {
        const ack = { agent, dispatched: [{ connector: "[mechanical]", ok: true }] };
        emissions.push(`Would notify agent '${agent}' (${message.length} chars; mechanical: true preview).`);
        vars.set(flatKey, ack);
        if (op.outputVar !== undefined) vars.set(op.outputVar, ack);
        return { lastBoundVar: op.outputVar ?? flatKey, lastValue: ack };
      }

      // v0.18.5 — address-routed dispatch per Perry's design call (thread
      // `c453afa2`). The `agent_id` itself encodes the dispatch class:
      //   - bare `<agent>` → AgentConnector.deliver() (mailbox-class; v0.8.0 behavior)
      //   - `<agent>@<session>` → AgentConnector.wake() (session-targeted interrupt)
      // The `@` suffix IS the wake signal; no separate `wake=true` kwarg
      // (would create contradictory combos per Perry's discipline note).
      // Substrate sees the opaque composite agent_id on the wake() call
      // and decomposes per v0.18.2 contract.
      const routesToWake = isWakeAddress(agent);
      const allConnectors = ctx.registry.listAgentConnectors();
      const dispatched: Array<{ connector: string; ok: boolean; error?: string; route?: "deliver" | "wake" }> = [];
      // v0.9.6 audit Q8 — ONE notify() op invocation = ONE dispatch_id across
      // every wired connector that gets the deliver() call. (Only used for the
      // deliver-class path; wake() has no DeliveryMeta envelope.)
      const notifyMeta = routesToWake
        ? null
        : buildLifecycleMeta(
            ctx._currentSkillName ?? null,
            ctx._currentSkillEventType ?? null,
            ctx,
            {
              event_type: op.notifyParams?.event_type,
              correlation_id: op.notifyParams?.correlation_id,
            },
          );
      for (const entry of allConnectors) {
        if (restrictConnectors !== undefined && !restrictConnectors.includes(entry.name)) continue;
        let agents: Array<{ agent_id: string }>;
        try {
          agents = await entry.instance.list_agents();
        } catch {
          // If list_agents() fails, skip this connector — can't confirm it
          // claims the target.
          continue;
        }
        // For wake-class addresses, also accept the bare-agent form on the
        // substrate's list_agents() — substrates declare agents at the
        // identity level, not per-session, so `perry@kitchen-terminal`
        // matches a connector that lists `perry`.
        const bareAgent = routesToWake ? agent.split("@")[0] ?? agent : agent;
        if (!agents.some((a) => a.agent_id === agent || a.agent_id === bareAgent)) continue;
        try {
          if (routesToWake) {
            const wakeOpts: WakeOpts = message.length > 0 ? { context: message } : {};
            // Substrate's wake() receipt is consumed for ACK shape; the
            // dispatched.route="wake" entry is the per-op signal.
            // Lifecycle-hook routed wakes ARE recorded in agentWakeReceipts
            // (with the routing-warning prepended); notify() follows the
            // existing pattern where mid-skill ops self-contain via ACK.
            await entry.instance.wake(agent, wakeOpts);
            dispatched.push({ connector: entry.name, ok: true, route: "wake" });
          } else {
            await entry.instance.deliver(agent, {
              kind: "augment",
              content: message,
              meta: notifyMeta!,
            });
            dispatched.push({ connector: entry.name, ok: true, route: "deliver" });
          }
        } catch (err) {
          dispatched.push({
            connector: entry.name,
            ok: false,
            route: routesToWake ? "wake" : "deliver",
            error: messageOf(err),
          });
        }
      }
      const ack = { agent, dispatched };
      vars.set(flatKey, ack);
      if (op.outputVar !== undefined) vars.set(op.outputVar, ack);
      return { lastBoundVar: op.outputVar ?? flatKey, lastValue: ack };
    }
    case "$": {
      // v0.14.1 Layer B — mutation gate regression guard. Re-checks at the
      // `$` dispatch site for `data_write` + mutating-name shapes; same
      // predicate as Layer A in `execOps`. Fail-closed default authState
      // means a caller that bypasses execOps and calls execOpInner directly
      // (or a future dispatch surface that forgets to plumb authState)
      // throws instead of silently dispatching the mutation. Non-mutation
      // `$` ops (`$ search_*`, `$ llm`, etc.) pass through cleanly because
      // `classifyMutation` returns null.
      {
        const mutKind = classifyMutation(op);
        if (mutKind !== null && !authorizationGranted(op, authState)) {
          throw new UnconfirmedMutationError(
            mutKind.kind,
            mutKind.detail,
            ["# Autonomous: true header", "preceding ?? / ask() in same target", "approved=\"reason\" per-op kwarg"],
            buildAuthorizationSuggestion(mutKind),
            op.kind,
            targetName,
          );
        }
      }
      const body = substituteRuntime(op.body, vars);
      const m = /^([A-Za-z_][\w:-]*)\s*([\s\S]*)$/.exec(body);
      if (m === null) {
        throw new OpError(
          `Malformed \`$\` op body: '${body}' — expected 'TOOL_NAME key=value ...'`,
          "$",
          "Use `$ tool_name key=value ...` syntax. See `help({topic: 'ops'})` for examples.",
          targetName,
        );
      }
      const toolName = m[1]!;
      const argsStr = m[2] ?? "";
      const args = parseToolArgs(argsStr);
      // v0.16.0 — op-level `timeout=N` kwarg reserved for `$` dispatch (parity
      // with legacy `~` `timeoutSeconds`). Pop from args before forwarding so
      // connectors don't see a kwarg they didn't declare. Accepts int literal
      // or `$(VAR)` / `${VAR}` ref string; resolveOpTimeoutMs coerces refs.
      const rawTimeoutKwarg = args["timeout"];
      let perOpTimeoutSec: number | string | undefined;
      if (typeof rawTimeoutKwarg === "number") perOpTimeoutSec = rawTimeoutKwarg;
      else if (typeof rawTimeoutKwarg === "string" && rawTimeoutKwarg !== "") perOpTimeoutSec = rawTimeoutKwarg;
      if (rawTimeoutKwarg !== undefined) delete args["timeout"];
      const connectorLabel = op.mcpConnector !== undefined ? `${op.mcpConnector}.` : "";
      const flatKey = `${targetName}.output`;

      // Mechanical preview, registry-routed, test escape hatch, no-dispatcher.
      if (ctx.mechanical === true) {
        emissions.push(
          `Would call tool ${connectorLabel}${toolName} with ${JSON.stringify(args)} (mechanical: true preview).`,
        );
        // Bind a placeholder that responds to dotted access (`$(X.field)`)
        // so cold-agent skills using `$ tool -> X` then `$(X.title)` etc.
        // can execute end-to-end without real dispatch.
        const placeholder = makeMechanicalPlaceholder(op.outputVar ?? flatKey);
        vars.set(flatKey, placeholder);
        if (op.outputVar !== undefined) vars.set(op.outputVar, placeholder);
        return {
          lastBoundVar: op.outputVar ?? flatKey,
          lastValue: placeholder,
        };
      }

      // v0.2.8: built-in `$ execute_skill` intercept. The composition
      // module handles arg parsing + recursion-guarded dispatch so this
      // op handler stays under the narrow-core LOC ceiling.
      if (toolName === "execute_skill" && op.mcpConnector === undefined) {
        try {
          const childResult = await dispatchExecuteSkillIntercept(args, targetName, ctx);
          vars.set(flatKey, childResult);
          if (op.outputVar !== undefined) vars.set(op.outputVar, childResult);
          return { lastBoundVar: op.outputVar ?? flatKey, lastValue: childResult };
        } catch (err) {
          throw new OpError(
            `\`$ execute_skill\` failed: ${messageOf(err)}`,
            "$",
            "Inspect the inner error; the child skill may have its own runtime failures. See its trace via `skillfile fires <skill>`.",
            targetName,
          );
        }
      }

      // v0.3.3: `$ json_parse <expr> -> OUT` intercept. Parses the
      // post-substitution input as JSON and binds the structured value
      // (object/array/scalar) to the output var. Pairs with resolveRef's
      // dotted descent so `$(OUT.field)` works in conditions + emit
      // without filter+field grammar surface — closes the v0.3.2 gap
      // where `|json_parse` (string-in/string-out) couldn't propagate
      // parsed structure through `.field` access.
      if (toolName === "json_parse" && op.mcpConnector === undefined) {
        const input = argsStr.trim();
        if (input === "") {
          throw new OpError(
            `\`$ json_parse\` requires an input expression (target '${targetName}').`,
            "$",
            "Provide input: `$ json_parse $(VAR) -> OUT` or `$ json_parse '{\"k\":1}' -> OUT`.",
            targetName,
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(input);
        } catch (err) {
          throw new OpError(
            `\`$ json_parse\` input is not valid JSON. Got: '${input.slice(0, 40)}${input.length > 40 ? "..." : ""}' — ${messageOf(err)}`,
            "$",
            "Ensure the input is valid JSON. Use the `|json` filter on a variable to pre-format if it isn't already structured.",
            targetName,
          );
        }
        vars.set(flatKey, parsed);
        if (op.outputVar !== undefined) vars.set(op.outputVar, parsed);
        return { lastBoundVar: op.outputVar ?? flatKey, lastValue: parsed };
      }

      // Bare-form name-match dispatch: when `$ <name> ...` is bare (no dotted
      // prefix), `<name>` must match a registered connector name. This makes
      // typed-contract patterns (`$ llm prompt=...`, `$ data_read mode=...`)
      // dispatch cleanly to the auto-wired bridge connectors. v0.16.0 dropped
      // the legacy "primary" fallback — substrate-specific MCP tools require
      // named form `$ <connector>.<tool>` and fail clearly if bare-form is
      // used with no matching connector.
      let connectorName: string;
      if (op.mcpConnector !== undefined) {
        connectorName = op.mcpConnector;
      } else if (ctx.registry.hasMcpConnector(toolName)) {
        connectorName = toolName;
      } else {
        connectorName = toolName; // will fail through to ConnectorNotFoundError below
      }

      // v0.4.1 — defense-in-depth allowlist check. Lint catches this at
      // compile time via `disallowed-tool`; this runtime check is the
      // backstop for compiled artifacts run against a different runtime
      // config than the one they were linted against. Only fires when
      // an explicit connector name is set (op.mcpConnector !== undefined)
      // — the implicit "primary" path is for embedder-wired connectors
      // that don't go through connectors.json.
      //
      // v0.9.1 — extended to call the shared `validateQualifiedDispatch`
      // helper so runtime and lint use the SAME source of truth. Catches
      // unknown-tool-on-connector at runtime when lint was skipped.
      if (op.mcpConnector !== undefined && ctx.registry.hasMcpConnector(connectorName)) {
        const diagnostics = validateQualifiedDispatch({
          toolName,
          qualifiedConnector: connectorName,
          registry: ctx.registry,
        });
        const blocking = diagnostics.find((d) => d.severity === "error");
        if (blocking !== undefined) {
          throw new OpError(
            `${blocking.message} (Defense-in-depth: lint should have caught this earlier.)`,
            "$",
            "Run `skillfile lint` against the skill to surface this at compile time.",
            targetName,
          );
        }
      }

      let rawResult: unknown;
      let dispatched = false;
      const timeoutMs = resolveOpTimeoutMs(perOpTimeoutSec, skillTimeoutSec, absoluteTimeoutMs, vars);
      // Op-level fallback (per language reference §9, extended to `$` for
      // cold-agent corpus consistency). On dispatch throw, bind the
      // fallback value to the output var; on missing connector with
      // fallback present, ditto.
      const dollarFallback = op.fallback !== undefined ? coerceLiteralValue(op.fallback) : undefined;
      try {
        if (ctx.registry.hasMcpConnector(connectorName)) {
          const connector = ctx.registry.getMcpConnector(connectorName);
          rawResult = await dispatchWithTimeout(
            () => connector.call(toolName, args, ctx.agentId !== undefined ? { agentId: ctx.agentId } : undefined),
            timeoutMs,
            "$",
          );
          dispatched = true;
        } else if (op.mcpConnector === undefined && ctx.toolDispatch) {
          rawResult = await dispatchWithTimeout(() => ctx.toolDispatch!(toolName, args), timeoutMs, "$");
          dispatched = true;
        } else {
          // v0.5.0 item 5 — was a silent stub before (emitted "Would call
          // tool ..." + bound null). That ate connector misconfiguration
          // errors silently, masking real failures. Now: throw, so the
          // op-level (fallback:) catch below can recover if declared, or
          // the error surfaces immediately.
          // v0.10 — when bare-form (`$ llm`/`$ data_read`/`$ data_write`),
          // pass the tool name so the error message surfaces substrate-aware
          // remediation copy (point cold authors at `substrate.local_model`/
          // `substrate.data_store` in connectors.json, not the generic API).
          throw new ConnectorNotFoundError(
            connectorName,
            "mcp_connector",
            "$",
            targetName,
            op.mcpConnector === undefined ? toolName : undefined,
          );
        }
      } catch (err) {
        if (dollarFallback !== undefined) {
          vars.set(flatKey, dollarFallback);
          if (op.outputVar !== undefined) vars.set(op.outputVar, dollarFallback);
          // v0.9.2 — P1.4 record the fallback substitution
          fallbacks.push({
            target: targetName,
            opKind: "$",
            value: dollarFallback,
            reason: `$ ${connectorLabel}${toolName} failed: ${messageOf(err)}`,
          });
          return { lastBoundVar: op.outputVar ?? flatKey, lastValue: dollarFallback };
        }
        throw err;
      }
      // c580de5: surface inner-tool `isError: true` as an op error. Otherwise
      // the error text gets bound silently to the output var and the skill
      // continues. Throw so the outer execOps catch records this in
      // `result.errors[]` and the else/OnError fallback machinery can fire.
      if (
        rawResult !== null &&
        typeof rawResult === "object" &&
        (rawResult as { isError?: unknown }).isError === true
      ) {
        const innerText = extractToolErrorText(rawResult);
        throw new OpError(
          `tool ${connectorLabel}${toolName} returned isError: ${innerText}`,
          "$",
          "The tool itself failed; inspect the inner error text. Add `(fallback: ...)` to the op for graceful failure.",
          targetName,
        );
      }
      const bindValue = unwrapToolResult(rawResult);
      // v0.16.0 — fallback-on-empty parity with legacy `~`/`>` semantics
      // (LocalModel empty-trimmed-response + Retrieval empty-array both bind
      // fallback). Without this, the doc-vs-code mismatch at parser.ts:84-91
      // (which claims `$` fallback fires "on throw or empty result") would
      // persist. Empty = "" after trim, OR [], OR null/undefined.
      let finalValue: unknown = bindValue;
      if (dollarFallback !== undefined) {
        const isEmptyString = typeof bindValue === "string" && bindValue.trim() === "";
        const isEmptyArray = Array.isArray(bindValue) && bindValue.length === 0;
        const isNullish = bindValue === null || bindValue === undefined;
        if (isEmptyString || isEmptyArray || isNullish) {
          finalValue = dollarFallback;
          fallbacks.push({
            target: targetName,
            opKind: "$",
            value: dollarFallback,
            reason: `$ ${connectorLabel}${toolName} returned empty result`,
          });
        }
      }
      vars.set(flatKey, finalValue);
      if (op.outputVar !== undefined) vars.set(op.outputVar, finalValue);
      return {
        lastBoundVar: op.outputVar ?? flatKey,
        lastValue: finalValue,
      };
    }
    case "foreach": {
      const listVal = resolveListExpr(op.foreachList!, vars);
      const iterName = op.foreachIter!;
      const before = new Set<string>(vars.keys());
      let last: ExecOpsResult = { lastBoundVar: null, lastValue: undefined };
      for (const item of listVal) {
        vars.set(iterName, item);
        last = await execOps(op.foreachBody!, vars, emissions, fallbacks, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs, traceBuilder, authState);
      }
      for (const k of Array.from(vars.keys())) {
        if (!before.has(k)) vars.delete(k);
      }
      return last;
    }
    case "if": {
      for (const branch of op.ifBranches!) {
        if (evalCondition(branch.cond, vars)) {
          return execOps(branch.body, vars, emissions, fallbacks, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs, traceBuilder, authState);
        }
      }
      if (op.ifElseBody !== undefined) {
        return execOps(op.ifElseBody, vars, emissions, fallbacks, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs, traceBuilder, authState);
      }
      return { lastBoundVar: null, lastValue: undefined };
    }
  }
  return { lastBoundVar: null, lastValue: undefined };
}

/**
 * Build a structured ExecutionError from a thrown value. Recognizes OpError
 * subclasses (preserves class name + canned remediation); falls back to
 * generic Error inspection (message + opKind tag) per existing convention.
 */
function buildExecutionError(err: unknown, target: string, opKindOverride?: string): ExecutionError {
  if (err instanceof OpError) {
    const entry: ExecutionError = {
      target: err.target ?? target,
      opKind: opKindOverride ?? err.opKind,
      message: err.message,
      class: err.name,
      remediation: err.remediation,
    };
    if (err.innerCause !== undefined) entry.innerCause = err.innerCause;
    return entry;
  }
  const e = err as Error & { opKind?: string };
  return {
    target,
    opKind: opKindOverride ?? e.opKind ?? "?",
    message: e.message,
    class: e.name ?? "Error",
  };
}

const DEFAULT_RUNTIME_ABSOLUTE_TIMEOUT_MS = 300_000;

/**
 * Per-op timeout resolution chain (ERD §6 decision 7) — top wins:
 *   1. Per-op override (`~ ... timeoutSeconds=30 ...`)
 *   2. Skill-level `# Timeout: N` header
 *   3. Connector instance default (v1: not yet declared by impls — collapses
 *      to built-in fallback when no per-op or skill-level value is present)
 *   4. Built-in language fallback (`absoluteTimeoutMs`, default 300000ms)
 *
 * Both per-op and skill-level values are in seconds (per author convention)
 * and converted to milliseconds here.
 */
function resolveOpTimeoutMs(
  perOpTimeoutSec: number | string | undefined,
  skillTimeoutSec: number | string | null,
  absoluteTimeoutMs: number,
  vars: Map<string, unknown>,
): number {
  if (perOpTimeoutSec !== undefined) {
    return resolveIntParam(perOpTimeoutSec, vars, "timeoutSeconds") * 1000;
  }
  if (skillTimeoutSec !== null) {
    return resolveIntParam(skillTimeoutSec, vars, "# Timeout:") * 1000;
  }
  return absoluteTimeoutMs;
}

/**
 * Race the op against a timer. On timeout, throws `OpTimeoutError`-shaped
 * op-error so the existing else: / # OnError: machinery catches it.
 *
 * v1 caveat: timeout returns control to the executor promptly, but the
 * underlying request may still complete in the background — its result is
 * discarded. v2 should thread AbortSignal through connector contracts so
 * implementations can cancel cleanly.
 */
async function dispatchWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  opKind: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new OpTimeoutError(timeoutMs, opKind));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Decline detection for `??` interactive responses. A response is declining
 * when trimmed-lowercase matches `no`/`n`/`false`/`0` or is empty. Anything
 * else (including "yes", "y", or any non-empty positive content) is treated
 * as approval.
 */
/**
 * Tokenize a shell-style command body into binary + args. Respects matching
 * single/double quotes; strips outer quotes. No metachar interpretation —
 * the structural-spawn sandbox forbids shell processing per decision 2.
 */
function tokenizeShellArgs(body: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/**
 * Spawn a child process and capture stdout. SIGKILL on timeout via the
 * process group (kills child + descendants). Non-zero exit → op-error with
 * stderr preserved per ERD §6 dispatcher routing.
 */
async function execShellCommand(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      // Send SIGKILL to the process group on POSIX. Windows lacks process
      // groups; fall back to direct child kill (descendants leak — out of
      // v1 scope to fix).
      if (process.platform !== "win32" && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new OpError(
        `Failed to spawn '${bin}': ${err.message}`,
        "shell",
        "Verify the binary is on PATH and executable. Check for typos in the `shell(command=...)` body.",
      ));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new OpTimeoutError(timeoutMs, "shell"));
        return;
      }
      if (code !== 0) {
        const trimmed = stderr.trim();
        reject(new OpError(
          `Shell command '${bin}' exited with code ${code}${trimmed ? `: ${trimmed.slice(0, 200)}` : ""}.`,
          "shell",
          "Inspect the stderr output. Add `(fallback: ...)` to the `shell(...)` op for graceful failure on non-zero exit.",
        ));
        return;
      }
      // Strip trailing newline — convention for shell command output.
      resolve(stdout.replace(/\n$/, ""));
    });
  });
}

/**
 * Resolve an integer parameter that may be a literal number or a string
 * containing a `$(VAR)` ref. Substitutes any refs then parseInts. Throws
 * a clear runtime error if the resolved value isn't a positive integer —
 * the parser deferred validation to here because at parse time the ref
 * couldn't be resolved.
 */
function resolveIntParam(raw: number | string, vars: Map<string, unknown>, paramName: string): number {
  if (typeof raw === "number") return raw;
  const substituted = substituteRuntime(raw, vars);
  const n = parseInt(substituted, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`'${paramName}' resolved to '${substituted}', which isn't a positive integer.`);
  }
  return n;
}

function extractToolErrorText(rawResult: unknown): string {
  if (rawResult === null || typeof rawResult !== "object") return String(rawResult);
  const obj = rawResult as { content?: unknown };
  if (Array.isArray(obj.content) && obj.content.length > 0) {
    const first = obj.content[0] as { type?: string; text?: string } | undefined;
    if (first && first.type === "text" && typeof first.text === "string") {
      return first.text;
    }
  }
  try {
    return JSON.stringify(rawResult);
  } catch {
    return "(unparseable error envelope)";
  }
}

function parseToolArgs(argsStr: string): Record<string, unknown> {
  const tokens = tokenizeKeywordArgs(argsStr);
  const args: Record<string, unknown> = {};
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq === -1) continue;
    const key = tok.slice(0, eq).trim();
    const rawValue = tok.slice(eq + 1);
    args[key] = coerceKwargValue(rawValue);
  }
  return args;
}

/**
 * v0.4.1 — typed kwarg coercion for `$ connector.tool key=value` calls.
 * MCP servers often expect typed args (integer `limit`, boolean flags).
 * Pre-v0.4.1 every kwarg was string-typed → caused real failures (YouTrack
 * "expected integer, got String" for `limit=5`).
 *
 * Coercion rules (applied AFTER processSetValue strips matched quotes):
 *   - Quoted strings → string (e.g. `query="for: me"` → "for: me")
 *   - Unquoted `^-?\d+$` → integer
 *   - Unquoted `^-?\d+\.\d+$` → number (float)
 *   - Unquoted `true` / `false` → boolean
 *   - Unquoted `null` → null
 *   - JSON-shaped `[...]` or `{...}` → JSON.parse if valid, else string
 *   - Everything else → string (existing v0.4.0 behavior)
 *
 * Authors can force string by quoting: `count="5"` → "5", `flag="true"` → "true".
 */
function coerceKwargValue(raw: string): unknown {
  const trimmed = raw.replace(/\s+$/, "");
  // v0.15.0 — triple-quote `"""..."""` multi-line literal. Strip the
  // outer triples + interpret \n/\t/\\/\" escapes inside. Mirrors
  // processSetValue's triple-quote path (parser.ts:669). Authors use
  // this for multi-line bodies passed as kwarg values (e.g.
  // `$ skill_write source="""# Skill: child\nrun: ..."""`).
  if (trimmed.length >= 6 && trimmed.startsWith('"""') && trimmed.endsWith('"""')) {
    return interpretDoubleQuotedEscapes(trimmed.slice(3, -3));
  }
  if (trimmed.length >= 2) {
    const first = trimmed[0]!;
    const last = trimmed[trimmed.length - 1]!;
    if (first === '"' && last === '"') {
      // v0.15.0 — interpret \n / \t / \\ / \" escapes (matches
      // processSetValue's behavior for $set + function-call kwargs).
      // Closes the discipline-only-contract gap where $ op kwarg values
      // were the only string-bearing surface not running escape
      // interpretation — surfaced by the skill-store-roundtrip demo
      // probe (cold-adopter dogfood, 2026-06-01).
      return interpretDoubleQuotedEscapes(trimmed.slice(1, -1));
    }
    if (first === "'" && last === "'") {
      // Single-quoted: literal pass-through (parallel to processSetValue).
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  // JSON-shaped — try to parse, fall back to string on failure.
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* not valid JSON — fall through to string */
    }
  }
  return trimmed;
}

function resolveListExpr(expr: string, vars: Map<string, unknown>): unknown[] {
  const trimmed = expr.trim();
  const ref = /^\$\(([^)]+)\)$/.exec(trimmed);
  if (ref) {
    const val = resolveRef(ref[1]!, vars);
    if (Array.isArray(val)) return val;
    if (val === undefined || val === null) return [];
    // v0.4.1 — mirror v0.2.5's `in` RHS tolerance (evalSimpleCondition,
    // ~line 1462): a string value that JSON-parses to an array iterates
    // as the parsed array. Lets `foreach I in $(RAW):` work when RAW is
    // a JSON-string-typed `# Vars:` value or a `~` op result that came
    // back as stringified JSON. `$ json_parse` users already get
    // structured arrays via resolveRef, so this case is the string-
    // typed-var fallback.
    if (typeof val === "string") {
      try {
        const parsed = JSON.parse(val) as unknown;
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* not JSON — fall through to single-element wrap */
      }
    }
    return [val];
  }
  const list = /^\[(.*)\]$/.exec(trimmed);
  if (list) {
    const inner = list[1]!.trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => {
      const t = s.trim();
      if (t.length >= 2) {
        const first = t[0]!;
        const last = t[t.length - 1]!;
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
          return t.slice(1, -1);
        }
      }
      return t;
    });
  }
  const sub = substituteRuntime(trimmed, vars);
  try {
    const v = JSON.parse(sub);
    if (Array.isArray(v)) return v;
  } catch {
    /* not JSON — wrap */
  }
  return [sub];
}

/**
 * Unwrap `CallToolResult`-shaped values into the meaningful payload.
 * Symmetry with `>` (binds `PortableData[]`) and `~` (binds the response
 * string) — `$` should bind the *content*, not the wire envelope.
 *
 * Rules:
 *   1. Non-CallToolResult-shaped — bind as-is.
 *   2. `content[0].type === "text"` + JSON-parseable — bind parsed.
 *   3. `content[0].type === "text"` + non-parseable — bind the raw string.
 *   4. Non-text content — bind the content array.
 */
function unwrapToolResult(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  const obj = result as { content?: unknown };
  if (!Array.isArray(obj.content)) return result;
  const first = obj.content[0] as { type?: string; text?: string } | undefined;
  if (!first) return result;
  if (first.type !== "text" || typeof first.text !== "string") {
    return obj.content;
  }
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

/**
 * Coerce a string literal into its natural JS type when the shape is
 * unambiguous. v1: bracket-list `[a, b, c]` → array. Other shapes pass through.
 */
function coerceLiteralValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return raw;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((s) => {
    const t = s.trim();
    if (t.length >= 2) {
      const first = t[0]!;
      const last = t[t.length - 1]!;
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return t.slice(1, -1);
      }
    }
    return t;
  });
}

// ─── Substitution and condition evaluation (runtime-side) ─────────────────

/**
 * Variant for `@ unsafe` op bodies. The `$$(...)` escape lets authors send
 * `$(...)` literally to bash (for bash command-substitution); skillscript
 * substitution sees `$$` and collapses to `$`. `$(NAME)` (single `$`)
 * remains a skillscript variable substitution.
 */
export function substituteRuntimeUnsafe(text: string, vars: Map<string, unknown>): string {
  // Step 1: pull `$$(` and `$${` escapes out so step 2's regex doesn't see the inner $.
  // v0.7.0: `${VAR}` form added alongside `$(VAR)`; matching `$${` escape.
  const ESCAPE_PAREN = "DOLLAR_PAREN";
  const ESCAPE_BRACE = "DOLLAR_BRACE";
  const escaped = text.replace(/\$\$\(/g, ESCAPE_PAREN).replace(/\$\$\{/g, ESCAPE_BRACE);
  // Step 2: normal skillscript substitution against the de-escaped text.
  const substituted = substituteRuntime(escaped, vars);
  // Step 3: restore the escapes as literal `$(` / `${` for bash.
  return substituted
    .replace(new RegExp(ESCAPE_PAREN, "g"), "$(")
    .replace(new RegExp(ESCAPE_BRACE, "g"), "${");
}

/**
 * Runtime `$(NAME[|filter])` substitution. At runtime the full variable
 * state is in scope; unresolved refs are a hard error (compile-time leaves
 * them to pass through; runtime can't).
 */
export function substituteRuntime(text: string, vars: Map<string, unknown>): string {
  // v0.3.2: filter chain support. The grammar already documents
  // "chain left-to-right" in help-content (line 222); pre-v0.3.2 only the
  // first filter actually applied because the regex captured exactly one.
  // Now: match the ref + optional `|filter|filter|...` chain; apply each
  // filter in order. `$(RAW|json_parse|length)` now works as documented.
  // v0.5.0 item 4: `|fallback:"X"` filter accepts a colon-arg; consumes
  // an undefined upstream ref by substituting X. Positional — comes into
  // effect at the position it appears in the chain.
  // v0.19.12 (Perry `9d8ff1b1`): aligned with $-op trailer fallback —
  // fires on empty-string-after-trim OR empty-array OR null/undefined.
  // Pre-v0.19.12 the filter fired ONLY on undefined; empty-string passed
  // through (the silent-blank case Perry hit with `gh pr list` writing
  // nothing to stdout). Now: same semantic across both fallback surfaces.
  return text.replace(
    // v0.7.0: alternation accepts both `$(REF|chain)` (legacy) and `${REF|chain}`
    // (canonical). Capture groups 1+2 = paren form, 3+4 = brace form.
    /\$(?:\(([^|)\s]+)\s*((?:\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?\s*)*)\)|\{([^|}\s]+)\s*((?:\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?\s*)*)\})/g,
    (_match: string, ref1: string | undefined, fc1: string | undefined, ref2: string | undefined, fc2: string | undefined) => {
      const ref = (ref1 ?? ref2)!;
      const filterChain = fc1 ?? fc2 ?? "";
      let value: unknown = resolveRef(ref, vars);
      const specs = parseFilterChain(filterChain);

      for (const spec of specs) {
        if (spec.name === "fallback") {
          // v0.19.12 — empty-aware. Matches the $-op trailer's
          // emptiness predicate (closes Perry's `9d8ff1b1`).
          const isEmptyString = typeof value === "string" && value.trim() === "";
          const isEmptyArray = Array.isArray(value) && value.length === 0;
          const isNullish = value === null || value === undefined;
          if (isNullish || isEmptyString || isEmptyArray) {
            value = spec.arg ?? "";
          }
          continue;
        }
        if (value === undefined) {
          throw new UnresolvedVariableError(ref, "?");
        }
        value = applyFilter(stringifyValue(value), spec.name, spec.arg);
      }

      if (value === undefined) {
        throw new UnresolvedVariableError(ref, "?");
      }
      return stringifyValue(value);
    },
  );
}

/**
 * Marker symbol for mechanical-mode placeholder objects. Tagged proxies
 * stringify to their label when consumed by `stringifyValue` (used by
 * substituteRuntime), so dotted access like `$(ISSUE.title)` works in
 * mechanical mode even though no real dispatch happened — every property
 * access produces a child placeholder.
 */
const MECHANICAL_PLACEHOLDER = Symbol.for("skillscript.mechanical_placeholder");

/**
 * Build a mechanical-mode placeholder. Acts like an object whose properties
 * are also placeholders (recursive), but `stringifyValue` unwraps it to
 * the literal label string. Lets cold-agent skills that use `$(VAR.field)`
 * patterns execute end-to-end in mechanical mode without infrastructure.
 */
function makeMechanicalPlaceholder(label: string): unknown {
  const target = { [MECHANICAL_PLACEHOLDER]: label };
  return new Proxy(target, {
    get(target, key) {
      if (key === MECHANICAL_PLACEHOLDER) return label;
      // Symbol-keyed access (Symbol.iterator, Symbol.toPrimitive, etc.):
      // return the target's own value so JS internals see a plain object.
      if (typeof key === "symbol") return Reflect.get(target, key);
      // String-keyed access: synthesize a deeper placeholder.
      return makeMechanicalPlaceholder(`${label}.${String(key)}`);
    },
  });
}

function isMechanicalPlaceholder(v: unknown): v is { [k: symbol]: string } {
  return v !== null && typeof v === "object" && (v as Record<symbol, unknown>)[MECHANICAL_PLACEHOLDER] !== undefined;
}

/**
 * Resolve `$(NAME)` or `$(NAME.path)` against the variable map. Two strategies:
 *   1. Flat-key match (full ref including dots). Handles `targetname.output`.
 *   2. Dot-path traversal — split, descend.
 * Returns `undefined` when unresolved.
 */
export function resolveRef(ref: string, vars: Map<string, unknown>): unknown {
  if (vars.has(ref)) return vars.get(ref);
  const path = ref.split(".");
  const root = path[0]!;
  if (!vars.has(root)) return undefined;
  let cur: unknown = vars.get(root);
  for (let i = 1; i < path.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[path[i]!];
  }
  return cur;
}

/**
 * Render a value for inline substitution. Scalars stringify naturally;
 * objects/arrays JSON-serialize. `null` renders as the literal `"null"` so
 * authors can distinguish bound-to-null from unresolved.
 */
export function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  if (isMechanicalPlaceholder(v)) return (v as Record<symbol, unknown>)[MECHANICAL_PLACEHOLDER] as string;
  return JSON.stringify(v);
}

// v0.3.4 — filter chain support in conditions. Each `(REF)(|filter)?`
// becomes `(REF)(|filter)*` matching substituteRuntime's chain pattern.
// v0.7.0 — loose-bracket form `\$[({]...[)}]` accepts both `$(REF)` and
// `${REF}`. Mixed brackets (e.g. `$(REF}`) can't reach runtime — parser
// validates with strict alternation per REF_PATTERN.
const TRUTHY = /^\s*\$[({]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)((?:\s*\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)[)}]\s*$/;
const EQ = /^\s*\$[({]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)((?:\s*\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)[)}]\s*(==|!=)\s*"([^"]*)"\s*$/;
/** Ref-vs-ref equality (per language reference §5 + 2026-05-21 grammar extension). Filter chain + dotted-field-access permitted on either side. */
const EQ_REF = /^\s*\$[({]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)((?:\s*\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)[)}]\s*(==|!=)\s*\$[({]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)((?:\s*\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)[)}]\s*$/;
const CMP = /^\s*\$[({]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)((?:\s*\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)[)}]\s*(<=|>=|<|>)\s*"([^"]*)"\s*$/;
const CMP_REF = /^\s*\$[({]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)((?:\s*\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)[)}]\s*(<=|>=|<|>)\s*\$[({]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)((?:\s*\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)[)}]\s*$/;
const IN = /^\s*\$[({]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)((?:\s*\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)[)}]\s+(not\s+)?in\s+\$[({]([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[)}]\s*$/;

/**
 * Apply a chain of pipe filters to a value. The chain string is the
 * raw `|f1|f2|...` segment captured by condition regexes; this helper
 * trims, splits, drops empties, and runs each filter in order.
 * Empty chain → returns the input untouched.
 *
 * Mirrors `substituteRuntime`'s chain-apply loop so the two surfaces
 * (substitution + conditions) carry identical filter semantics — closes
 * the recurring "filter chain works in substitution but not conditions"
 * gap named in dev-log §14.
 */
function applyFilterChain(value: string, chain: string | undefined): string {
  if (chain === undefined || chain === "") return value;
  const specs = parseFilterChain(chain);
  let s = value;
  for (const spec of specs) {
    if (spec.name === "fallback") continue;
    s = applyFilter(s, spec.name, spec.arg);
  }
  return s;
}

/**
 * Condition-context variant of the chain applier. Threads the original
 * undefined-ness through so `|fallback:"X"` can consume an unresolved ref.
 * Used by EQ / CMP / IN paths in evalSimpleCondition. v0.5.0 item 4.
 */
function applyFilterChainCondition(value: unknown, chain: string | undefined): string {
  const specs = parseFilterChain(chain);
  let current: unknown = value;
  for (const spec of specs) {
    if (spec.name === "fallback") {
      if (current === undefined) current = spec.arg ?? "";
      continue;
    }
    if (current === undefined) current = "";
    current = applyFilter(stringifyValue(current), spec.name, spec.arg);
  }
  if (current === undefined) current = "";
  return stringifyValue(current);
}

/**
 * v0.3.2 — find the index of a top-level token (`and`, `or`) at paren-depth 0
 * outside quoted strings. Returns -1 if not found. Used by the recursive
 * compound decomposition below; scans right-to-left for left-associativity
 * with the standard precedence (so `a and b and c` parses as
 * `(a and b) and c` — the rightmost AND is the outer split point).
 *
 * NOT a full tokenizer. Just looks for the literal word `token` bounded by
 * whitespace, skipping over quoted strings and parenthesized sub-expressions.
 */
function findOuterToken(cond: string, token: string): number {
  let depth = 0;
  let inQuote: '"' | "'" | null = null;
  let bestIdx = -1;
  for (let i = 0; i < cond.length; i++) {
    const ch = cond[i]!;
    if (inQuote !== null) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    // Match ` token ` with word boundaries; LHS / RHS whitespace required.
    if (ch === " " && cond.slice(i + 1, i + 1 + token.length) === token) {
      const after = cond[i + 1 + token.length];
      if (after === " " || after === "\t") {
        bestIdx = i; // continue scanning to find the rightmost match
      }
    }
  }
  return bestIdx;
}

/**
 * Strip exactly one layer of matched outer parens. Returns the original
 * if the outer parens don't balance (e.g. `(a) and (b)` — the leading `(`
 * closes before the end, so the outer parens aren't a wrapper).
 */
function stripOuterParens(cond: string): string {
  const trimmed = cond.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return trimmed;
  let depth = 0;
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length - 1; i++) {
    const ch = trimmed[i]!;
    if (inQuote !== null) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return trimmed; // outer parens don't wrap; bail
    }
  }
  return trimmed.slice(1, -1).trim();
}

/**
 * v0.3.2 — compound condition dispatcher. Order matches precedence:
 *   OR (lowest) → AND → NOT → simple-shape regex (leaves)
 *
 * Short-circuit: AND eval RHS only when LHS truthy; OR only when LHS falsy.
 * That preserves the "validate-then-access" pattern (`if $(X) == "ok" and
 * $(MAYBE_UNRESOLVED)`) where the RHS would error if eagerly evaluated.
 */
export function evalCondition(cond: string, vars: Map<string, unknown>): boolean {
  const stripped = stripOuterParens(cond);
  // OR (lowest precedence) — split first.
  const orIdx = findOuterToken(stripped, "or");
  if (orIdx >= 0) {
    const lhs = stripped.slice(0, orIdx);
    const rhs = stripped.slice(orIdx + 4); // " or " is 4 chars (leading space already excluded by orIdx)
    return evalCondition(lhs, vars) || evalCondition(rhs, vars);
  }
  // AND
  const andIdx = findOuterToken(stripped, "and");
  if (andIdx >= 0) {
    const lhs = stripped.slice(0, andIdx);
    const rhs = stripped.slice(andIdx + 5); // " and " is 5 chars
    return evalCondition(lhs, vars) && evalCondition(rhs, vars);
  }
  // NOT prefix (unary, binds higher than and/or, lower than comparison)
  const trimmedLead = stripped.trimStart();
  if (trimmedLead.startsWith("not ")) {
    return !evalCondition(trimmedLead.slice(4), vars);
  }
  return evalSimpleCondition(stripped, vars);
}

function evalSimpleCondition(cond: string, vars: Map<string, unknown>): boolean {
  const t = TRUTHY.exec(cond);
  if (t) {
    const val = resolveRef(t[1]!, vars);
    const chain = t[2];
    const filtered = chain && val !== undefined ? applyFilterChain(stringifyValue(val), chain) : val;
    return isTruthy(filtered);
  }
  const e = EQ.exec(cond);
  if (e) {
    const [, ref, chain, op, lit] = e;
    const val = resolveRef(ref!, vars);
    // v0.5.0 item 4: condition-aware chain threading so `|default:"X"`
    // consumes undefined refs in conditional context too.
    const final = applyFilterChainCondition(val, chain);
    return op === "==" ? final === lit : final !== lit;
  }
  const eRef = EQ_REF.exec(cond);
  if (eRef) {
    const [, lhsRef, lhsChain, op, rhsRef, rhsChain] = eRef;
    const lhsVal = resolveRef(lhsRef!, vars);
    const rhsVal = resolveRef(rhsRef!, vars);
    const lhsFinal = applyFilterChainCondition(lhsVal, lhsChain);
    const rhsFinal = applyFilterChainCondition(rhsVal, rhsChain);
    return op === "==" ? lhsFinal === rhsFinal : lhsFinal !== rhsFinal;
  }
  const cmp = CMP.exec(cond);
  if (cmp) {
    const [, ref, chain, op, lit] = cmp;
    const val = resolveRef(ref!, vars);
    const final = applyFilterChainCondition(val, chain);
    return compareNumeric(final, op as CmpOp, lit!, `$(${ref}${chain ? chain : ""})`);
  }
  const cmpRef = CMP_REF.exec(cond);
  if (cmpRef) {
    const [, lhsRef, lhsChain, op, rhsRef, rhsChain] = cmpRef;
    const lhsVal = resolveRef(lhsRef!, vars);
    const rhsVal = resolveRef(rhsRef!, vars);
    const lhsFinal = applyFilterChainCondition(lhsVal, lhsChain);
    const rhsFinal = applyFilterChainCondition(rhsVal, rhsChain);
    const refDesc = `$(${lhsRef}) ${op} $(${rhsRef})`;
    return compareNumeric(lhsFinal, op as CmpOp, rhsFinal, refDesc);
  }
  const i = IN.exec(cond);
  if (i) {
    const [, lhsRef, lhsChain, notKey, rhsRef] = i;
    let rhsVal = resolveRef(rhsRef!, vars);
    if (rhsVal === undefined) {
      throw new Error(`Runtime error in \`in\` condition: RHS \`$(${rhsRef})\` is unresolved`);
    }
    // Cold-agent corpus tolerance: model responses (`~` op) are strings;
    // when the author prompts for a JSON array and uses it as `in` RHS,
    // auto-parse the string to its array form. Matches how foreach's
    // resolveListExpr tolerates JSON-string list expressions. Strings
    // that don't JSON-parse to an array still error below as before.
    //
    // Mechanical-mode special-case: placeholder strings ("[mechanical:...]")
    // are treated as single-element arrays so `in` checks execute
    // structurally without false errors during dry-run validation.
    if (typeof rhsVal === "string") {
      if (rhsVal.startsWith("[mechanical:")) {
        rhsVal = [rhsVal];
      } else {
        try {
          const parsed = JSON.parse(rhsVal) as unknown;
          if (Array.isArray(parsed)) rhsVal = parsed;
        } catch {
          /* not JSON — fall through to the array-check error */
        }
      }
    }
    // v0.2.12 Bug 23 ripple. After the mechanical-mode `~` handler started
    // binding a Proxy placeholder (was a string pre-fix), `in $(VAR)` where
    // VAR came from a `~` op started failing the array check below. Treat
    // a Proxy placeholder as a single-element array, same tolerance as the
    // string-shaped placeholders above — preserves dry-run truthiness for
    // skills using LLM output as the RHS list.
    if (isMechanicalPlaceholder(rhsVal)) rhsVal = [rhsVal];
    if (!Array.isArray(rhsVal)) {
      const got = rhsVal === null ? "null" : typeof rhsVal;
      throw new Error(`Runtime error in \`in\` condition: RHS \`$(${rhsRef})\` must be an array (got ${got})`);
    }
    const lhsVal = resolveRef(lhsRef!, vars);
    if (lhsVal === undefined) return false;
    const lhsStr = applyFilterChain(stringifyValue(lhsVal), lhsChain);
    const found = rhsVal.some((item) => stringifyValue(item) === lhsStr);
    return notKey !== undefined ? !found : found;
  }
  throw new Error(`Invalid runtime condition (parser should have rejected): ${cond}`);
}

type CmpOp = "<" | ">" | "<=" | ">=";

/**
 * Numeric comparison helper for the `<`/`>`/`<=`/`>=` condition operators
 * (v0.2.5). Both operands coerce via `Number()`; non-finite results raise
 * a `TypeMismatchError` rather than fall back to lexicographic comparison
 * (which would silently mis-compare "10" < "9").
 */
function compareNumeric(lhs: string, op: CmpOp, rhs: string, refDesc: string): boolean {
  const lhsNum = Number(lhs);
  const rhsNum = Number(rhs);
  if (!Number.isFinite(lhsNum) || !Number.isFinite(rhsNum)) {
    throw new TypeMismatchError(refDesc, op, lhs, rhs);
  }
  switch (op) {
    case "<":  return lhsNum < rhsNum;
    case ">":  return lhsNum > rhsNum;
    case "<=": return lhsNum <= rhsNum;
    case ">=": return lhsNum >= rhsNum;
  }
}

function isTruthy(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.length > 0;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
