import type { ParsedSkill, SkillOp, OutputDecl } from "./parser.js";
import type { DeliveryReceipt } from "./connectors/agent.js";
import { tokenizeKeywordArgs, processSetValue } from "./parser.js";
import { applyFilter } from "./filters.js";
import type { Registry } from "./connectors/registry.js";
import { spawn } from "node:child_process";
import {
  OpError,
  ConnectorNotFoundError,
  OpTimeoutError,
  InteractiveOpInAutonomousModeError,
  UnsafeShellDisabledError,
  UnresolvedVariableError,
  TypeMismatchError,
} from "./errors.js";
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
  /** Identity the skill runs as. Threaded through to McpConnector dispatch overrides. */
  agentId?: string;
  /** Test escape hatch: dispatch `$` ops bare-named tools through this callback when no `primary` McpConnector is registered. */
  toolDispatch?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Invoked when target ops fail with no target-level `else:` but the skill declares `# OnError:`. */
  fallbackSkillExecutor?: (
    skillName: string,
    vars: Record<string, unknown>,
  ) => Promise<ExecuteResult>;
  /** Mechanical-only preview: `$` / `~` / `>` ops skip real dispatch and bind a placeholder. */
  mechanical?: boolean;
  /**
   * Interactive-mode user-input callback. When provided, `??` ops invoke it
   * with the prompt and bind the response to the output variable. When
   * omitted, `??` fails fast (autonomous mode per decision 6). Per Section 2
   * Ops `??` decline semantics: a `no`/`n`/empty/falsey response binds the
   * value AND short-circuits downstream targets via soft op-error so
   * `else:` fires.
   */
  askUser?: (prompt: string) => Promise<string>;
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
   * Trigger context for trace identity + sampling. Scheduler passes the
   * fired trigger's metadata; direct callers can synthesize.
   */
  triggerCtx?: { source: string; name: string; fired_at_ms: number; trigger_id?: string };
  /** Skill identity for trace records. Optional — falls back to parsed.name + version inference. */
  skillVersion?: string;
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

export interface ExecuteResult {
  finalVars: Record<string, unknown>;
  emissions: string[];
  outputs: Record<string, unknown>;
  errors: ExecutionError[];
  targetOrder: string[];
  /**
   * Delivery receipts from `AgentConnector.deliver` calls fired after the
   * skill completes. Populated when the skill declares
   * `# Output: prompt-context: <agent>` or `# Output: template: <agent>`.
   * Empty array (not undefined) when no agent-targeted output decls fired.
   * Skipped in `mechanical` mode — placeholders aren't delivered to real
   * substrates during previews.
   */
  agentDeliveryReceipts: AgentDeliveryReceiptRecord[];
}

export interface AgentDeliveryReceiptRecord {
  agent_id: string;
  output_kind: "prompt-context" | "template";
  receipt: DeliveryReceipt;
}

interface ExecOpsResult {
  lastBoundVar: string | null;
  lastValue: unknown;
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
  vars.set("NOW", nowMs);
  vars.set("USER", ctx.agentId ?? "unknown");
  vars.set("SESSION_CONTEXT", "");
  vars.set("TRIGGER_TYPE", "manual");
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
  let lastBoundVar: string | null = null;

  const absoluteTimeoutMs = ctx.absoluteTimeoutMs ?? DEFAULT_RUNTIME_ABSOLUTE_TIMEOUT_MS;

  // Trace recording (per ERD §8). Build when shouldTraceFire returns true;
  // skip entirely when off (the NFR-11 floor — errors still surface via
  // `result.errors[]`).
  const triggerCtx = ctx.triggerCtx ?? { source: "manual", name: "", fired_at_ms: nowMs };
  const triggerId = triggerCtx.trigger_id ?? `${triggerCtx.source}:${triggerCtx.name}`;
  const skillName = parsed.name ?? "(anonymous)";
  const traceBuilder = shouldTraceFire(ctx.trace, triggerId, skillName)
    ? new TraceBuilder(skillName, ctx.skillVersion ?? "unknown", triggerCtx, { agent_id: ctx.agentId })
    : null;

  for (const targetName of order) {
    const target = parsed.targets.get(targetName);
    if (!target) continue;

    let targetLastBound: string | null = null;
    let targetLastValue: unknown = undefined;

    try {
      const r = await execOps(target.ops, vars, emissions, ctx, targetName, parsed.timeout, absoluteTimeoutMs, traceBuilder);
      targetLastBound = r.lastBoundVar;
      targetLastValue = r.lastBoundVar !== null ? vars.get(r.lastBoundVar) : r.lastValue;
    } catch (err) {
      errors.push(buildExecutionError(err, targetName));
      if (target.elseBlock !== undefined) {
        try {
          const r = await execOps(target.elseBlock, vars, emissions, ctx, targetName, parsed.timeout, absoluteTimeoutMs, traceBuilder);
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
  //   - Human-readable surfaces (`prompt-context:`, `slack:`, `card:`):
  //     default to joined emissions. These deliver content for an agent
  //     or human to *read*; trailing `>`/`~` JSON values are the wrong shape.
  //   - Programmatic surfaces (`text`, `file:`): default to lastBoundVar
  //     (structured), fall back to emissions array. Callers consuming
  //     `outputs.text` typically want the structured return value.
  //   - `none`: no-op marker; value irrelevant.
  // Output payload-shape coercion: when the output kind is text-shaped
  // (joined emissions are the natural delivery payload) we publish the
  // string in `outputs[key]`; otherwise we pass the last bound variable
  // through structurally. Membership here is about payload shape, not
  // semantic destination — `slack` and `card` are listed because their
  // delivery payloads are text, NOT because the runtime knows anything
  // about Slack or card UIs. (v1.x: move this to connector-registered
  // metadata via the EmissionConnector design so adopters can register
  // new text-shaped destinations without a runtime code change.)
  const TEXT_COERCED_OUTPUT_KINDS = new Set<OutputDecl["kind"]>(["prompt-context", "template", "slack", "card"]);
  // Agent-bound dispatch uses literal kind checks below so TS can narrow
  // `decl.kind` to the discriminated `DeliveryPayload.kind` automatically;
  // a runtime Set forces a type predicate. Keep the literals colocated
  // with the dispatch loop so the agent-bound semantic set is one-line
  // grep-able.
  const outputDecls: OutputDecl[] = parsed.outputs.length > 0
    ? parsed.outputs
    : [{ kind: "text" }];
  const outputs: Record<string, unknown> = {};
  for (const decl of outputDecls) {
    const key = decl.target !== undefined ? `${decl.kind}:${decl.target}` : decl.kind;
    if (TEXT_COERCED_OUTPUT_KINDS.has(decl.kind)) {
      outputs[key] = emissions.join("\n");
    } else if (lastBoundVar !== null && vars.has(lastBoundVar)) {
      outputs[key] = vars.get(lastBoundVar);
    } else {
      outputs[key] = emissions.slice();
    }
  }

  // Dispatch agent-targeted output decls through AgentConnector.deliver
  // (T7.1). `prompt-context: <agent>` routes as `kind: "augment"`,
  // `template: <agent>` as `kind: "template"`. Skipped in mechanical mode
  // so previews don't deliver placeholder content to real substrates.
  // Connector fallback: Registry.getAgentConnector() returns a transparent
  // NoOpAgentConnector when no adapter is wired, so the dispatch loop
  // never throws on missing-substrate; the no-op logs to stderr.
  const agentDeliveryReceipts: AgentDeliveryReceiptRecord[] = [];
  if (ctx.mechanical !== true) {
    for (const decl of outputDecls) {
      if (decl.target === undefined) continue;
      // Agent-bound output kinds: literal `===` so TS narrows decl.kind
      // for the deliver() payload discriminator below.
      if (decl.kind !== "prompt-context" && decl.kind !== "template") continue;
      const key = `${decl.kind}:${decl.target}`;
      const body = String(outputs[key] ?? emissions.join("\n"));
      const agent = ctx.registry.getAgentConnector();
      try {
        const receipt = decl.kind === "prompt-context"
          ? await agent.deliver(decl.target, { kind: "augment", content: body })
          : await agent.deliver(decl.target, {
              kind: "template",
              prompt: body,
              ...(parsed.name !== null ? { source_skill: parsed.name } : {}),
            });
        agentDeliveryReceipts.push({ agent_id: decl.target, output_kind: decl.kind, receipt });
      } catch (err) {
        // Delivery failure is non-fatal — record alongside other errors so
        // the dashboard surfaces it, but don't propagate. Skill execution
        // already succeeded by this point.
        process.stderr.write(
          `[agent-deliver] ${decl.kind}:${decl.target} failed: ${(err as Error).message}\n`,
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
    targetOrder: order,
    agentDeliveryReceipts,
  };
}

async function execOps(
  ops: SkillOp[],
  vars: Map<string, unknown>,
  emissions: string[],
  ctx: ExecuteContext,
  targetName: string,
  skillTimeoutSec: number | string | null,
  absoluteTimeoutMs: number,
  traceBuilder: TraceBuilder | null,
): Promise<ExecOpsResult> {
  let lastBoundVar: string | null = null;
  let lastValue: unknown = undefined;
  for (const op of ops) {
    const r = await execOp(op, vars, emissions, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs, traceBuilder);
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
  ctx: ExecuteContext,
  targetName: string,
  skillTimeoutSec: number | string | null,
  absoluteTimeoutMs: number,
  traceBuilder: TraceBuilder | null,
): Promise<ExecOpsResult> {
  const startMs = traceBuilder !== null ? Date.now() : 0;
  let errored = false;
  try {
    return await execOpInner(op, vars, emissions, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs, traceBuilder);
  } catch (err) {
    errored = true;
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
      });
    }
  }
}

/** Extract the connector instance name for $/~/> ops; undefined for others. */
function extractOpConnector(op: SkillOp): string | undefined {
  switch (op.kind) {
    case "$": return op.mcpConnector ?? "primary";
    case "~": return op.localModelParams?.model ?? "default";
    case ">": return op.retrievalParams?.connector ?? "primary";
    default: return undefined;
  }
}

async function execOpInner(
  op: SkillOp,
  vars: Map<string, unknown>,
  emissions: string[],
  ctx: ExecuteContext,
  targetName: string,
  skillTimeoutSec: number | string | null,
  absoluteTimeoutMs: number,
  traceBuilder: TraceBuilder | null,
): Promise<ExecOpsResult> {
  switch (op.kind) {
    case "$set": {
      const coerced = coerceLiteralValue(op.setValue!);
      vars.set(op.setName!, coerced);
      return { lastBoundVar: op.setName!, lastValue: coerced };
    }
    case "?": {
      const body = substituteRuntime(op.body, vars);
      emissions.push(`Reason: ${body}`);
      return { lastBoundVar: null, lastValue: undefined };
    }
    case "!": {
      const body = substituteRuntime(op.body, vars);
      emissions.push(body);
      return { lastBoundVar: null, lastValue: undefined };
    }
    case "@": {
      const body = op.policy === "unsafe"
        ? substituteRuntimeUnsafe(op.body, vars)
        : substituteRuntime(op.body, vars);
      const shellTimeoutMs = resolveOpTimeoutMs(undefined, skillTimeoutSec, absoluteTimeoutMs, vars);
      if (ctx.mechanical === true) {
        const label = op.policy === "unsafe" ? "Would run unsafe shell" : "Would run shell";
        emissions.push(`${label}: ${body} (mechanical: true preview).`);
        // Bind a placeholder so downstream `$(VAR)` substitutions resolve.
        // Matches the convention used by `$`/`~`/`>` mechanical-mode binding.
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
      if (op.policy === "unsafe") {
        if (ctx.enableUnsafeShell !== true) {
          throw new UnsafeShellDisabledError(body, targetName);
        }
        stdout = await execShellCommand("bash", ["-c", body], shellTimeoutMs);
      } else {
        const tokens = tokenizeShellArgs(body);
        if (tokens.length === 0) {
          throw makeOpError("@", `Empty \`@\` op body in target '${targetName}'.`);
        }
        const [bin, ...args] = tokens;
        stdout = await execShellCommand(bin!, args, shellTimeoutMs);
      }
      const flatKey = `${targetName}.output`;
      vars.set(flatKey, stdout);
      if (op.outputVar !== undefined) vars.set(op.outputVar, stdout);
      return {
        lastBoundVar: op.outputVar ?? flatKey,
        lastValue: stdout,
      };
    }
    case "??": {
      const promptStr = substituteRuntime(op.body, vars);
      if (ctx.askUser === undefined) {
        // Autonomous mode — no interactive surface wired. Per decision 6 +
        // §6 dispatcher routing, `??` fails fast so dependent targets don't
        // silently fall through.
        throw new InteractiveOpInAutonomousModeError(promptStr, targetName);
      }
      const response = await ctx.askUser(promptStr);
      const outName = op.outputVar;
      if (outName !== undefined) vars.set(outName, response);
      // Decline semantics (per Section 2 Ops + §13 Open Q #2 resolution):
      // bind the response AND short-circuit downstream via soft op-error
      // routed through else: / # OnError:. Closes the silent-fall-through
      // security bug pattern (subsequent `apply:` running on a "no").
      if (isDeclineResponse(response)) {
        throw makeOpError(
          "??",
          `User declined at \`??\` prompt: '${promptStr}' (response: '${response}'). Dependent targets short-circuited.`,
        );
      }
      return {
        lastBoundVar: outName ?? null,
        lastValue: response,
      };
    }
    case "&": {
      // `&` ops are resolved at compile time — data-skill content is
      // inlined; procedural-skill refs compile to a runtime invocation
      // shape (not this op). If we hit `&` at runtime, the executor was
      // handed a raw AST that bypassed compile().
      const skillName = op.ampParams?.skillName ?? "(unknown)";
      throw makeOpError(
        "&",
        `\`& ${skillName}\` reached the runtime unresolved. The compile() ` +
        `step inlines data-skills and lowers procedural refs to invocation ` +
        `ops; running raw parsed skills bypasses that. Call compile() ` +
        `before execute().`,
      );
    }
    case "$": {
      const body = substituteRuntime(op.body, vars);
      const m = /^([A-Za-z_][\w:-]*)\s*([\s\S]*)$/.exec(body);
      if (m === null) {
        throw makeOpError(
          "$",
          `Malformed \`$\` op body: '${body}' — expected 'TOOL_NAME key=value ...'`,
        );
      }
      const toolName = m[1]!;
      const argsStr = m[2] ?? "";
      const args = parseToolArgs(argsStr);
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

      const connectorName = op.mcpConnector ?? "primary";
      let rawResult: unknown;
      let dispatched = false;
      const timeoutMs = resolveOpTimeoutMs(undefined, skillTimeoutSec, absoluteTimeoutMs, vars);
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
        } else if (op.mcpConnector !== undefined) {
          throw new ConnectorNotFoundError(connectorName, "mcp_connector", "$", targetName);
        }
      } catch (err) {
        if (dollarFallback !== undefined) {
          vars.set(flatKey, dollarFallback);
          if (op.outputVar !== undefined) vars.set(op.outputVar, dollarFallback);
          return { lastBoundVar: op.outputVar ?? flatKey, lastValue: dollarFallback };
        }
        throw err;
      }

      if (!dispatched) {
        emissions.push(
          `Would call tool ${connectorLabel}${toolName} with ${JSON.stringify(args)} (no dispatcher wired).`,
        );
        vars.set(flatKey, null);
        if (op.outputVar !== undefined) vars.set(op.outputVar, null);
        return {
          lastBoundVar: op.outputVar ?? flatKey,
          lastValue: null,
        };
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
        throw makeOpError(
          "$",
          `tool ${connectorLabel}${toolName} returned isError: ${innerText}`,
        );
      }
      const bindValue = unwrapToolResult(rawResult);
      vars.set(flatKey, bindValue);
      if (op.outputVar !== undefined) vars.set(op.outputVar, bindValue);
      return {
        lastBoundVar: op.outputVar ?? flatKey,
        lastValue: bindValue,
      };
    }
    case ">": {
      const p = op.retrievalParams!;
      const querySub = substituteRuntime(p.query, vars);
      const extraSub: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p.extra)) {
        extraSub[k] = substituteRuntime(v, vars);
      }
      if (ctx.mechanical === true) {
        // Bind a 1-element array of placeholders so foreach M in $(RESULTS)
        // iterates once with a dotted-accessible M (matches common author
        // patterns like `$(M.id)`, `$(M.summary)`). Authors expecting empty
        // result sets test the empty case in unit tests, not mechanical mode.
        const mechanicalValue: unknown = p.fallback !== undefined
          ? p.fallback
          : [makeMechanicalPlaceholder(`${op.outputVar}[0]`)];
        emissions.push(
          `Would query MemoryStore \`${p.connector}\` with mode=${p.mode}, ` +
          `query="${querySub}", limit=${p.limit} (mechanical: true preview). ` +
          `Binding $(${op.outputVar}) = placeholder result set.`,
        );
        vars.set(op.outputVar!, mechanicalValue);
        return { lastBoundVar: op.outputVar!, lastValue: mechanicalValue };
      }
      const store = ctx.registry.getMemoryStore(p.connector);
      const limitResolved = resolveIntParam(p.limit, vars, "limit");
      const filters = {
        query: querySub,
        mode: p.mode,
        limit: limitResolved,
        ...extraSub,
      };
      const retrievalTimeoutMs = resolveOpTimeoutMs(undefined, skillTimeoutSec, absoluteTimeoutMs, vars);
      // Op-level fallback (per language reference §9): on throw OR empty
      // result, bind the fallback value and continue. Without a fallback,
      // throws propagate to `else:` / `# OnError:` / target error.
      // coerceLiteralValue parses array-shaped literals (`[]`, `[a, b]`)
      // into actual arrays so downstream `foreach M in $(VAR)` iterates
      // correctly on the empty/sentinel case.
      const coercedFallback = p.fallback !== undefined ? coerceLiteralValue(p.fallback) : undefined;
      let results: unknown;
      try {
        results = await dispatchWithTimeout(() => store.query(filters), retrievalTimeoutMs, ">");
        if (coercedFallback !== undefined && Array.isArray(results) && results.length === 0) {
          results = coercedFallback;
        }
      } catch (err) {
        if (coercedFallback !== undefined) {
          results = coercedFallback;
        } else {
          throw err;
        }
      }
      vars.set(op.outputVar!, results);
      return { lastBoundVar: op.outputVar!, lastValue: results };
    }
    case "~": {
      const p = op.localModelParams!;
      const promptSub = substituteRuntime(p.prompt, vars);
      if (ctx.mechanical === true) {
        const modelName = p.model ?? "default";
        const placeholder = `[mechanical: would call LocalModel ${modelName} with prompt='${promptSub}']`;
        emissions.push(`Would invoke LocalModel \`${modelName}\` (mechanical: true preview). Binding $(${op.outputVar}) = ${placeholder}`);
        vars.set(op.outputVar!, placeholder);
        return { lastBoundVar: op.outputVar!, lastValue: placeholder };
      }
      let model;
      try {
        model = ctx.registry.getLocalModel(p.model);
      } catch (err) {
        if (p.fallback !== undefined) {
          vars.set(op.outputVar!, p.fallback);
          return { lastBoundVar: op.outputVar!, lastValue: p.fallback };
        }
        throw err;
      }
      const runOpts: { maxTokens?: number; model?: string } = {};
      if (p.maxTokens !== undefined) {
        runOpts.maxTokens = resolveIntParam(p.maxTokens, vars, "maxTokens");
      }
      const tildeTimeoutMs = resolveOpTimeoutMs(p.timeoutSeconds, skillTimeoutSec, absoluteTimeoutMs, vars);
      // Op-level fallback (per language reference §9): on throw OR empty
      // (trimmed) response, bind the fallback value.
      let response: string;
      try {
        response = await dispatchWithTimeout(() => model.run(promptSub, runOpts), tildeTimeoutMs, "~");
        if (p.fallback !== undefined && response.trim() === "") {
          response = p.fallback;
        }
      } catch (err) {
        if (p.fallback !== undefined) {
          response = p.fallback;
        } else {
          throw err;
        }
      }
      vars.set(op.outputVar!, response);
      return { lastBoundVar: op.outputVar!, lastValue: response };
    }
    case "foreach": {
      const listVal = resolveListExpr(op.foreachList!, vars);
      const iterName = op.foreachIter!;
      const before = new Set<string>(vars.keys());
      let last: ExecOpsResult = { lastBoundVar: null, lastValue: undefined };
      for (const item of listVal) {
        vars.set(iterName, item);
        last = await execOps(op.foreachBody!, vars, emissions, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs, traceBuilder);
      }
      for (const k of Array.from(vars.keys())) {
        if (!before.has(k)) vars.delete(k);
      }
      return last;
    }
    case "if": {
      for (const branch of op.ifBranches!) {
        if (evalCondition(branch.cond, vars)) {
          return execOps(branch.body, vars, emissions, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs, traceBuilder);
        }
      }
      if (op.ifElseBody !== undefined) {
        return execOps(op.ifElseBody, vars, emissions, ctx, targetName, skillTimeoutSec, absoluteTimeoutMs, traceBuilder);
      }
      return { lastBoundVar: null, lastValue: undefined };
    }
  }
  return { lastBoundVar: null, lastValue: undefined };
}

function makeOpError(opKind: string, message: string): Error & { opKind: string } {
  const err = new Error(message) as Error & { opKind: string };
  err.opKind = opKind;
  return err;
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
      reject(makeOpError("@", `Failed to spawn '${bin}': ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new OpTimeoutError(timeoutMs, "@"));
        return;
      }
      if (code !== 0) {
        const trimmed = stderr.trim();
        reject(makeOpError(
          "@",
          `Shell command '${bin}' exited with code ${code}${trimmed ? `: ${trimmed.slice(0, 200)}` : ""}.`,
        ));
        return;
      }
      // Strip trailing newline — convention for shell command output.
      resolve(stdout.replace(/\n$/, ""));
    });
  });
}

function isDeclineResponse(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t === "" || t === "no" || t === "n" || t === "false" || t === "0";
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
    args[key] = processSetValue(rawValue);
  }
  return args;
}

function resolveListExpr(expr: string, vars: Map<string, unknown>): unknown[] {
  const trimmed = expr.trim();
  const ref = /^\$\(([^)]+)\)$/.exec(trimmed);
  if (ref) {
    const val = resolveRef(ref[1]!, vars);
    if (Array.isArray(val)) return val;
    if (val === undefined || val === null) return [];
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
 * Symmetry with `>` (binds `PortableMemory[]`) and `~` (binds the response
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
  // Step 1: pull `$$(` escapes out so step 2's regex doesn't see the inner $.
  const ESCAPE = " DOLLAR_DOLLAR_PAREN ";
  const escaped = text.replace(/\$\$\(/g, ESCAPE);
  // Step 2: normal skillscript substitution against the de-escaped text.
  const substituted = substituteRuntime(escaped, vars);
  // Step 3: restore the escape as literal `$(` for bash.
  return substituted.replace(new RegExp(ESCAPE, "g"), "$(");
}

/**
 * Runtime `$(NAME[|filter])` substitution. At runtime the full variable
 * state is in scope; unresolved refs are a hard error (compile-time leaves
 * them to pass through; runtime can't).
 */
export function substituteRuntime(text: string, vars: Map<string, unknown>): string {
  return text.replace(
    /\$\(([^|)\s]+)\s*(?:\|\s*([A-Za-z_]\w*))?\s*\)/g,
    (_match: string, ref: string, filter: string | undefined) => {
      const value = resolveRef(ref, vars);
      if (value === undefined) {
        throw new UnresolvedVariableError(ref, "?");
      }
      const s = stringifyValue(value);
      if (!filter) return s;
      return applyFilter(s, filter);
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

const TRUTHY = /^\s*\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s*\|\s*([A-Za-z_]\w*))?\)\s*$/;
const EQ = /^\s*\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s*\|\s*([A-Za-z_]\w*))?\)\s*(==|!=)\s*"([^"]*)"\s*$/;
/** Ref-vs-ref equality (per language reference §5 + 2026-05-21 grammar extension). Filter + dotted-field-access permitted on either side. */
const EQ_REF = /^\s*\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s*\|\s*([A-Za-z_]\w*))?\)\s*(==|!=)\s*\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s*\|\s*([A-Za-z_]\w*))?\)\s*$/;
const CMP = /^\s*\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s*\|\s*([A-Za-z_]\w*))?\)\s*(<=|>=|<|>)\s*"([^"]*)"\s*$/;
const CMP_REF = /^\s*\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s*\|\s*([A-Za-z_]\w*))?\)\s*(<=|>=|<|>)\s*\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s*\|\s*([A-Za-z_]\w*))?\)\s*$/;
const IN = /^\s*\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s*\|\s*([A-Za-z_]\w*))?\)\s+(not\s+)?in\s+\$\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\)\s*$/;

export function evalCondition(cond: string, vars: Map<string, unknown>): boolean {
  const t = TRUTHY.exec(cond);
  if (t) {
    const val = resolveRef(t[1]!, vars);
    const filter = t[2];
    const filtered = filter && val !== undefined ? applyFilter(stringifyValue(val), filter) : val;
    return isTruthy(filtered);
  }
  const e = EQ.exec(cond);
  if (e) {
    const [, ref, filter, op, lit] = e;
    const val = resolveRef(ref!, vars);
    const valStr = val === undefined ? "" : stringifyValue(val);
    // Filter applies BEFORE comparison so `if $(COLOR|trim) == "yellow"` matches
    // values that local models return with trailing whitespace.
    const final = filter !== undefined ? applyFilter(valStr, filter) : valStr;
    return op === "==" ? final === lit : final !== lit;
  }
  const eRef = EQ_REF.exec(cond);
  if (eRef) {
    const [, lhsRef, lhsFilter, op, rhsRef, rhsFilter] = eRef;
    // Both sides resolve via the same path as `EQ` LHS — undefined → ""
    // (matches the existing tolerance for unresolved refs in conditions).
    const lhsVal = resolveRef(lhsRef!, vars);
    const rhsVal = resolveRef(rhsRef!, vars);
    const lhsStr = lhsVal === undefined ? "" : stringifyValue(lhsVal);
    const rhsStr = rhsVal === undefined ? "" : stringifyValue(rhsVal);
    const lhsFinal = lhsFilter !== undefined ? applyFilter(lhsStr, lhsFilter) : lhsStr;
    const rhsFinal = rhsFilter !== undefined ? applyFilter(rhsStr, rhsFilter) : rhsStr;
    return op === "==" ? lhsFinal === rhsFinal : lhsFinal !== rhsFinal;
  }
  const cmp = CMP.exec(cond);
  if (cmp) {
    const [, ref, filter, op, lit] = cmp;
    const val = resolveRef(ref!, vars);
    const valStr = val === undefined ? "" : stringifyValue(val);
    const final = filter !== undefined ? applyFilter(valStr, filter) : valStr;
    return compareNumeric(final, op as CmpOp, lit!, `$(${ref}${filter !== undefined ? `|${filter}` : ""})`);
  }
  const cmpRef = CMP_REF.exec(cond);
  if (cmpRef) {
    const [, lhsRef, lhsFilter, op, rhsRef, rhsFilter] = cmpRef;
    const lhsVal = resolveRef(lhsRef!, vars);
    const rhsVal = resolveRef(rhsRef!, vars);
    const lhsStr = lhsVal === undefined ? "" : stringifyValue(lhsVal);
    const rhsStr = rhsVal === undefined ? "" : stringifyValue(rhsVal);
    const lhsFinal = lhsFilter !== undefined ? applyFilter(lhsStr, lhsFilter) : lhsStr;
    const rhsFinal = rhsFilter !== undefined ? applyFilter(rhsStr, rhsFilter) : rhsStr;
    const refDesc = `$(${lhsRef}) ${op} $(${rhsRef})`;
    return compareNumeric(lhsFinal, op as CmpOp, rhsFinal, refDesc);
  }
  const i = IN.exec(cond);
  if (i) {
    const [, lhsRef, lhsFilter, notKey, rhsRef] = i;
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
    if (!Array.isArray(rhsVal)) {
      const got = rhsVal === null ? "null" : typeof rhsVal;
      throw new Error(`Runtime error in \`in\` condition: RHS \`$(${rhsRef})\` must be an array (got ${got})`);
    }
    const lhsVal = resolveRef(lhsRef!, vars);
    if (lhsVal === undefined) return false;
    const lhsStr = lhsFilter !== undefined
      ? applyFilter(stringifyValue(lhsVal), lhsFilter)
      : stringifyValue(lhsVal);
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
