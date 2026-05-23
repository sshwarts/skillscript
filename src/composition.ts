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
import { MissingSkillReferenceError } from "./errors.js";

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
  final_vars: Record<string, unknown>;
  transcript: string[];
  outputs: Record<string, unknown>;
  errors: ExecuteResult["errors"];
  target_order: string[];
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

  const compiled = await compile(loaded.source, { inputs, skillStore });

  // Propagate the parent context with the depth incremented and the
  // child chain extended. Mechanical mode carries through unchanged.
  const childCtx: ExecuteContext = {
    ...ctx,
    recursionDepth: depth,
    maxRecursionDepth: limit,
  };

  const result = await execute(
    compiled.parsed,
    compiled.resolvedVariables,
    compiled.targetOrder,
    childCtx,
  );

  return {
    skill_name: compiled.skillName ?? skillName,
    final_vars: result.finalVars,
    transcript: result.emissions,
    outputs: result.outputs,
    errors: result.errors,
    target_order: compiled.targetOrder,
  };
}

function resolveSkillStore(registry: Registry): SkillStore {
  if (registry.hasSkillStore("primary")) return registry.getSkillStore("primary");
  throw new Error(
    "execute_skill requires a SkillStore registered as 'primary' in the runtime registry. " +
    "Wire one via `bootstrap()` or `registry.registerSkillStore('primary', ...)`.",
  );
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
  const childSkillName = typeof args["skill_name"] === "string" ? args["skill_name"] : "";
  if (childSkillName === "") {
    throw new Error(`\`$ execute_skill\` op missing required \`skill_name\` arg (target '${targetName}').`);
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
