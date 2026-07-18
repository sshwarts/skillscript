// Public composition primitive (v0.2.8). Wraps the runtime's compile +
// execute pipeline behind a single function callable two ways:
//
//   1. From outside the runtime — `execute_skill` MCP tool handler in
//      `mcp-server.ts` delegates here.
//   2. From inside a skill body — the `$` op handler in `runtime.ts`
//      intercepts the literal tool name `execute_skill` (when no MCP
//      connector is explicitly specified) and dispatches here, so
//      skills can compose without requiring an MCP connector to be
//      wired by the operator. Closes the gap Perry surfaced in thread
//      `45c167bc`: prior to this, the only "invoke another skill" path
//      was AMP's private `amp_execute_skill`.
//
// Recursion guard: each call increments `ctx.recursionDepth`. Throws a
// structured `RecursionDepthExceededError` when depth crosses
// `ctx.maxRecursionDepth` (default 10). The same execution context
// propagates `mechanical: true` through the whole sub-graph so a
// TestFlight preview at the parent never accidentally fires real ops
// in a child.

import { compile } from "./compile.js";
import { execute, type ExecuteContext, type ExecuteResult } from "./runtime.js";
import type { Registry } from "./connectors/registry.js";
import type { SkillStore } from "./connectors/types.js";
import { MissingSkillReferenceError, ApprovalRejectedError } from "./errors.js";
import { evaluateApprovalGate, isSecuredMode } from "./approval.js";

const DEFAULT_MAX_RECURSION_DEPTH = 10;

export class RecursionDepthExceededError extends Error {
  constructor(public readonly chain: ReadonlyArray<string>, public readonly limit: number) {
    super(
      `execute_skill recursion depth exceeded (limit ${limit}). Chain: ${chain.join(" → ")}. ` +
      `Likely an infinite-loop in skill composition; check for a child skill that calls back into a parent.`,
    );
    this.name = "RecursionDepthExceededError";
  }
}

export class SkillNotFoundForCompositionError extends Error {
  constructor(public readonly skillName: string) {
    super(`execute_skill: skill '${skillName}' not found in SkillStore`);
    this.name = "SkillNotFoundForCompositionError";
  }
}

export interface ExecuteSkillOpts {
  /** SkillStore for the child-skill lookup. Defaults to `registry.getSkillStore("primary")`. */
  skillStore?: SkillStore;
  /** Override or extend the parent's ExecuteContext (mechanical, agentId, registry, etc.). */
  ctx: ExecuteContext;
  /** Diagnostic chain of skill names already in flight; used for the recursion-error message. */
  chain?: ReadonlyArray<string>;
}

export interface ExecuteSkillResult {
  skill_name: string;
  /**
   * v0.17.5 — back-compat view of the declared `# Returns:` surface as
   * a full filtered map, for programmatic iteration over all exports
   * (`foreach K in ${R.final_vars}: ...`). The canonical *named* access
   * is at the top level of the result envelope: `${R.SUMMARY}` not
   * `${R.final_vars.SUMMARY}` (per spec). Both paths address the same
   * data — the named path is the documented canonical, the map path
   * is for iteration / introspection.
   */
  final_vars: Record<string, unknown>;
  transcript: string[];
  outputs: Record<string, unknown>;
  errors: ExecuteResult["errors"];
  target_order: string[];
  /**
   * v0.9.2 — P1.4 fallback events. Populated when an op's `(fallback: ...)`
   * trailer caught a dispatch failure. Empty array `[]` on clean runs.
   * Surfaces over the MCP wire so consumers can distinguish real success
   * from fallback-substituted success.
   */
  fallbacks: ExecuteResult["fallbacks"];
  /**
   * v0.9.2 — P1.1 AgentConnector dispatch receipts with `delivery_skipped`
   * flag when the NoOp fallback "handled" the dispatch (no real connector
   * wired). Surfaces over the MCP wire alongside errors / outputs.
   */
  agent_delivery_receipts: ExecuteResult["agentDeliveryReceipts"];
  /**
   * v0.18.5 — wake-class dispatch receipts from address-routed `notify()` /
   * `# Output: agent: X@session`. Parallel to `agent_delivery_receipts`;
   * empty when no `@session` addresses were dispatched.
   */
  agent_wake_receipts: ExecuteResult["agentWakeReceipts"];
  /** True when the run's `# Deadline:` was exceeded (partial result). */
  deadline_exceeded?: boolean;
  /** Mutations cut mid-flight by the deadline — "issued, outcome uncertain". */
  uncertain_effects?: ExecuteResult["uncertainEffects"];
}

/**
 * Load + compile + execute a skill by name. Used by both the public
 * `execute_skill` MCP tool and the in-skill `$ execute_skill` op
 * intercept. Throws structured errors that the caller surfaces as
 * either MCP error responses or op-error records.
 */
export async function executeSkillByName(
  skillName: string,
  inputs: Record<string, string>,
  opts: ExecuteSkillOpts,
): Promise<ExecuteSkillResult> {
  const { ctx, chain = [] } = opts;
  const depth = (ctx.recursionDepth ?? 0) + 1;
  const limit = ctx.maxRecursionDepth ?? DEFAULT_MAX_RECURSION_DEPTH;
  if (depth > limit) {
    throw new RecursionDepthExceededError([...chain, skillName], limit);
  }

  const skillStore = opts.skillStore ?? resolveSkillStore(ctx.registry);
  let loaded;
  try {
    loaded = await skillStore.load(skillName);
  } catch {
    // v0.3.1: structured runtime error that flows through `# OnError:`.
    // The legacy SkillNotFoundForCompositionError is kept exported for
    // backwards-compat but the new code path throws the OpError shape.
    throw new MissingSkillReferenceError(skillName, "$", "$ execute_skill");
  }

  // v0.9.0 — universal execution gate. Reject Draft/Disabled, naked
  // Approved (no token), and tampered bodies (hash mismatch). Flows
  // through `# OnError:` like any other ConnectorError subclass.
  const gate = evaluateApprovalGate(loaded.source);
  if (!gate.ok) {
    throw new ApprovalRejectedError(skillName, gate.reason, "executeSkillByName");
  }

  const compiled = await compile(loaded.source, { inputs, skillStore });

  // Propagate the parent context with the depth incremented and the
  // child chain extended. Mechanical mode carries through unchanged.
  //
  // v0.9.6 audit Q8 — entry_skill_name plumbing per Perry's plumbing-risk
  // callout (`1bc9d7a2` multi-layer-promise lesson). When parent A composes
  // child B, B's DeliveryMeta.origin.entry_skill_name must show A. Rule:
  // - If parent already has entrySkillName set (parent is itself a composed
  //   helper), preserve it — deeper-than-2-level chains intentionally lose
  //   the middle per the audit footnote
  // - Otherwise, parent IS the entry; child inherits parent's
  //   `_currentSkillName` as its entrySkillName
  //
  // v0.16.9 — identity follows the skill. Override `agentId` from the
  // CHILD skill's `metadata.author`. Per Perry's `fd18e3f7` cross-author
  // ack: when parent A (Alice) composes child B (Bob), B runs under Bob's
  // identity — NOT Alice's. Same invariant for every skill run:
  // `ctx.agentId = skill.author`. v0.17+ adds dual-identity for the
  // delegation case (Alice on-behalf-of-Bob).
  //
  // v0.18.4 — `callerAgentId` (authenticated caller) propagates via
  // `...ctx` and is NOT reset on composition. When agent `cc` invokes
  // parent A (Alice) which composes child B (Bob), B's notify() emits
  // `caller_agent_id: cc` (not Alice, not Bob). The caller IS the
  // chain originator — composition doesn't reset who fired the chain.
  const childCtx: ExecuteContext = {
    ...ctx,
    recursionDepth: depth,
    // The run root is a wrapper call made from OUTSIDE any execute frame
    // (MCP/scheduler): `_insideExecute` is unset. A nested `$ execute_skill`
    // reaches here from within an execute frame, so `_insideExecute` is set →
    // not the root. This lets the root's run-boundary CONVERT a deadline into a
    // partial result even though `recursionDepth` is 1 here (finding C).
    _runRoot: ctx._insideExecute !== true,
    maxRecursionDepth: limit,
    entrySkillName: ctx.entrySkillName ?? ctx._currentSkillName,
    // v1.0 Gate #7 — the gate above passed (valid v3 signature in secured mode),
    // so this stored skill is authorized to perform effects. The verified load
    // IS the capability mint; explicit (not inherited) so the child's own
    // approval governs, not the parent's.
    effectsAuthorized: true,
    ...(loaded.metadata.author !== undefined ? { agentId: loaded.metadata.author } : {}),
  };

  const result = await execute(
    compiled.parsed,
    compiled.resolvedVariables,
    compiled.targetOrder,
    childCtx,
  );

  // v0.17.3 — filter final_vars to the declared `# Returns:` surface.
  // Closes Perry's `1ea3d625` Finding 2: child's full execution state
  // (including unbounded scratch like a 39KB RAW JSON) leaked into the
  // parent's bound `R`, compounding with composition depth.
  // v0.17.5 — spread the filtered returns onto the result envelope's
  // top level so `${R.SUMMARY}` is the canonical named-access path per
  // spec. `final_vars` keeps the same filtered map as the iteration
  // view (foreach over all exports). Per Perry's `e01f4148` ack:
  // "skill is a function; declared returns ARE the result. `final_vars`
  // is an implementation name — exposing it is an abstraction leak."
  // The parser's reserved-name guard (RESERVED_ENVELOPE_FIELDS) blocks
  // declared names from colliding with envelope fields, so the spread
  // is safe — envelope-field literal kvs below win on order anyway
  // (defense-in-depth even though parser should have caught collisions).
  const filtered = filterFinalVarsByReturns(result.finalVars, compiled.parsed.returns);
  return {
    ...filtered,
    skill_name: compiled.skillName ?? skillName,
    final_vars: filtered,
    transcript: result.emissions,
    outputs: result.outputs,
    errors: result.errors,
    target_order: compiled.targetOrder,
    fallbacks: result.fallbacks,
    agent_wake_receipts: result.agentWakeReceipts,
    agent_delivery_receipts: result.agentDeliveryReceipts,
    ...(result.deadlineExceeded ? { deadline_exceeded: true } : {}),
    ...(result.uncertainEffects !== undefined ? { uncertain_effects: result.uncertainEffects } : {}),
  };
}

/**
 * v0.17.3 — Returns-filter. The declared `# Returns: X, Y, Z` surface
 * names which `final_vars` keys propagate from the child to the caller.
 * Empty returns array → no `final_vars` exported (the no-`# Returns:`
 * default). Returns array with names → only those keys exported.
 *
 * Unbound declared names are silently absent — caught at lint time by
 * `unknown-returns-ref` (tier-1), so reaching this point means parse
 * succeeded but a declared name had no $set / op-binding. Filtering
 * tolerates that asymmetry at runtime; the lint enforces it at author
 * time.
 */
function filterFinalVarsByReturns(
  finalVars: Record<string, unknown>,
  returns: readonly string[],
): Record<string, unknown> {
  if (returns.length === 0) return {};
  const filtered: Record<string, unknown> = {};
  for (const name of returns) {
    if (name in finalVars) filtered[name] = finalVars[name];
  }
  return filtered;
}

function resolveSkillStore(registry: Registry): SkillStore {
  if (registry.hasSkillStore("primary")) return registry.getSkillStore("primary");
  throw new Error(
    "execute_skill requires a SkillStore registered as 'primary' in the runtime registry. " +
    "Wire one via `bootstrap()` or `registry.registerSkillStore('primary', ...)`.",
  );
}

/**
 * v0.9.0 — ad-hoc inline-source execution. Per thread `10746795`: ad-hoc
 * scripting needs a path that doesn't pollute the SkillStore. Inline
 * source NEVER crosses the SkillStore boundary, so the hash-token
 * approval gate (which lives at that boundary) doesn't engage.
 *
 * Threat model: the gate protects against silent-swap of stored
 * autonomous skills. Inline-source has no silent-swap attack — the
 * caller wrote or saw the source they're handing in. Invocation IS
 * the review. Same intuition as `bash -c "..."`.
 *
 * Child skills referenced via `& <name>` or `$ execute_skill skill_name=...`
 * STILL go through the SkillStore + gate — only the top-level inline
 * body is ungated.
 */
export async function executeSkillFromSource(
  source: string,
  inputs: Record<string, string>,
  opts: ExecuteSkillOpts,
): Promise<ExecuteSkillResult> {
  const { ctx, chain = [] } = opts;
  const depth = (ctx.recursionDepth ?? 0) + 1;
  const limit = ctx.maxRecursionDepth ?? DEFAULT_MAX_RECURSION_DEPTH;
  if (depth > limit) {
    throw new RecursionDepthExceededError([...chain, "(inline)"], limit);
  }

  const skillStore = opts.skillStore ?? (ctx.registry.hasSkillStore("primary") ? ctx.registry.getSkillStore("primary") : undefined);
  const compiled = await compile(source, { inputs, ...(skillStore !== undefined ? { skillStore } : {}) });

  // v1.0 Gate #7 — source-mode capability. An ad-hoc body bypasses the SkillStore,
  // so in secured mode it may perform effects ONLY if the body itself carries a
  // valid signature (i.e. an operator approved exactly this body). An unsigned /
  // agent-authored body runs with effects refused at the dispatch choke (compile,
  // preview, $set, emit only). Unsecured mode preserves the historical free run.
  const effectsAuthorized = !isSecuredMode() || evaluateApprovalGate(source).ok;

  const childCtx: ExecuteContext = {
    ...ctx,
    recursionDepth: depth,
    // Root iff invoked from outside any execute frame — see executeSkillByName.
    _runRoot: ctx._insideExecute !== true,
    maxRecursionDepth: limit,
    effectsAuthorized,
  };

  const result = await execute(
    compiled.parsed,
    compiled.resolvedVariables,
    compiled.targetOrder,
    childCtx,
  );

  // v0.17.5 — same spread pattern as executeSkillByName; declared
  // returns at top level + the iteration-view `final_vars` map.
  const filtered = filterFinalVarsByReturns(result.finalVars, compiled.parsed.returns);
  return {
    ...filtered,
    skill_name: compiled.skillName ?? "(inline)",
    final_vars: filtered,
    transcript: result.emissions,
    outputs: result.outputs,
    errors: result.errors,
    target_order: compiled.targetOrder,
    fallbacks: result.fallbacks,
    agent_delivery_receipts: result.agentDeliveryReceipts,
    agent_wake_receipts: result.agentWakeReceipts,
    ...(result.deadlineExceeded ? { deadline_exceeded: true } : {}),
    ...(result.uncertainEffects !== undefined ? { uncertain_effects: result.uncertainEffects } : {}),
  };
}

/**
 * In-skill `$ execute_skill` op handler. Extracted from runtime.ts to
 * keep that module's LOC under the ERD §1 narrow-core ceiling.
 * Returns the child skill's result for binding to `$(VAR)`. Throws on
 * malformed args, recursion overflow, or missing skill — the caller
 * (the `$` op dispatcher) wraps with `makeOpError`.
 *
 * Two syntaxes for child-skill inputs are supported (v0.2.9 fix):
 *
 *   Style 1 — bare kwargs (natural skill grammar):
 *     $ execute_skill skill_name="child" WHO="$(NAME)" -> R
 *
 *   Style 2 — explicit `inputs={...}` JSON object (MCP-call parity):
 *     $ execute_skill skill_name="child" inputs={"WHO": "$(NAME)"} -> R
 *
 * Style 2 was silently dropped in v0.2.8: the `$` op parses kwargs as
 * flat strings, so `inputs={...}` arrived as the literal JSON string,
 * was passed to the child as a kwarg named `inputs`, and the child
 * (which doesn't declare `inputs` as a variable) ignored it. Per
 * Perry's thread `64445b4f`.
 */
export async function dispatchExecuteSkillIntercept(
  args: Record<string, unknown>,
  targetName: string,
  ctx: ExecuteContext,
): Promise<ExecuteSkillResult> {
  // v0.15.2 — accept either `name` (canonical) or `skill_name` (back-compat
  // alias) as the kwarg. Aligns with the MCP-wire surface + the other
  // `skill_*` tools. The function-call form (`execute_skill(name="...")`)
  // is normalized to `skill_name=` by the parser, so this branch primarily
  // serves the legacy direct-`$` form (`$ execute_skill name="..."`).
  const nameKwarg = typeof args["name"] === "string" ? args["name"] : "";
  const skillNameKwarg = typeof args["skill_name"] === "string" ? args["skill_name"] : "";
  if (nameKwarg !== "" && skillNameKwarg !== "" && nameKwarg !== skillNameKwarg) {
    throw new Error(
      `\`$ execute_skill\` in target '${targetName}': ambiguous kwargs — \`name\` and \`skill_name\` are aliases; supply only one (or matching values).`,
    );
  }
  const childSkillName = nameKwarg !== "" ? nameKwarg : skillNameKwarg;
  if (childSkillName === "") {
    throw new Error(`\`$ execute_skill\` op missing required \`name\` (or \`skill_name\`) arg (target '${targetName}').`);
  }
  const childInputs = extractChildInputs(args);
  return executeSkillByName(childSkillName, childInputs, {
    ctx,
    chain: [`target:${targetName}`],
  });
}

function extractChildInputs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  // Style 2 first — if `inputs` kwarg parses as a JSON object, unpack it
  // into the inputs map. Symmetric with the MCP-call form.
  const rawInputs = args["inputs"];
  if (typeof rawInputs === "string") {
    try {
      const parsed = JSON.parse(rawInputs) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          out[k] = String(v);
        }
      }
    } catch {
      /* not JSON — fall through; `inputs` was a bare string kwarg, not a JSON object */
    }
  } else if (rawInputs !== null && typeof rawInputs === "object" && !Array.isArray(rawInputs)) {
    for (const [k, v] of Object.entries(rawInputs as Record<string, unknown>)) {
      out[k] = String(v);
    }
  }
  // Style 1 — bare kwargs become inputs directly. `inputs` and `skill_name`
  // are handled separately so they don't leak into the child's variable scope.
  for (const [k, v] of Object.entries(args)) {
    if (k === "skill_name" || k === "inputs") continue;
    out[k] = String(v);
  }
  return out;
}
