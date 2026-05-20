import {
  type ParsedSkill,
  type SkillOp,
  type OutputDecl,
  type SkillRequire,
  type SkillTarget,
  parse,
} from "./parser.js";
import { applyFilter } from "./filters.js";
import type { SkillStore } from "./connectors/types.js";

/**
 * Semantic analysis + render. Three phases:
 *
 *  1. Resolve declared `# Vars:` / `# Requires:` against caller inputs +
 *     the optional require-resolver callback (skipped at T1 baseline if no
 *     resolver is supplied; declared `# Requires:` lines without a resolver
 *     hit fallback or surface as missing).
 *  2. Topological sort. Detects cycles and missing-dep refs.
 *  3. Render. Three output formats: `prompt` (canonical Anthropic-Skill-shaped
 *     markdown), `prose` (narrative for human reading), `test` reserved.
 *
 * Data-skill compile-time inlining (decision-1) is T3 work — at T1 baseline,
 * an explicit `&` op or `$ skill_name` invocation compiles as a runtime
 * skill-call. The T3 thread reworks this to inline `# Type: data` skill
 * content at compile time.
 */

export type RenderFormat = "prompt" | "prose";

/** Resolves a `# Requires:` declaration to a concrete value, or null. */
export type RequireResolver = (req: SkillRequire) => string | null | Promise<string | null>;

export interface CompileOptions {
  inputs?: Record<string, string>;
  format?: RenderFormat;
  /** Optional resolver for `# Requires:` cascade. Without it, requires fall through to declared fallback or surface as missing. */
  requireResolver?: RequireResolver;
  /** Optional SkillStore — used to validate `# OnError:` fallback skill exists at compile time. */
  skillStore?: SkillStore;
}

export interface CompileResult {
  skillName: string | null;
  format: RenderFormat;
  resolvedVariables: Record<string, string>;
  targetOrder: string[];
  output: string;
  triggers: ParsedSkill["triggers"];
  outputs: OutputDecl[];
  onError: string | null;
  warnings: string[];
  /** Pass-through to the runtime — saves re-parsing. */
  parsed: ParsedSkill;
}

/**
 * Compile a skill source string. The high-level entrypoint embedders use.
 * Throws on hard errors (parse errors, missing entry target, dep cycle,
 * unresolved required vars); the message is structured for agent consumption.
 */
export async function compile(
  source: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const { inputs, format = "prompt", requireResolver, skillStore } = options;

  const parsed = parse(source);
  if (parsed.parseErrors.length > 0) {
    throw new Error(
      `Skill parse errors:\n- ${parsed.parseErrors.join("\n- ")}`,
    );
  }
  if (parsed.targets.size === 0) {
    throw new Error(`Skill parsed with zero targets.`);
  }
  if (parsed.entryTarget === null) {
    throw new Error(
      `Skill has no entry target (missing \`default:\` line and no targets defined).`,
    );
  }

  if (parsed.onError !== null && skillStore !== undefined) {
    try {
      await skillStore.metadata(parsed.onError);
    } catch (err) {
      // SkillNotFoundError (or any error from metadata lookup) → fail-clean
      // at compile time rather than at runtime when the fallback would fire.
      throw new Error(
        `Skill references missing fallback skill '${parsed.onError}' in \`# OnError:\` header.`,
      );
    }
  }

  // Variable resolution precedence: caller inputs > `# Requires:` cascade >
  // `# Vars:` defaults.
  const inputMap = inputs ?? {};
  const resolved = new Map<string, string>();

  for (const v of parsed.vars) {
    if (Object.prototype.hasOwnProperty.call(inputMap, v.name)) {
      resolved.set(v.name, inputMap[v.name]!);
    }
  }
  for (const r of parsed.requires) {
    if (resolved.has(r.target)) continue;
    if (Object.prototype.hasOwnProperty.call(inputMap, r.target)) {
      resolved.set(r.target, inputMap[r.target]!);
    }
  }
  for (const r of parsed.requires) {
    if (resolved.has(r.target)) continue;
    if (requireResolver !== undefined) {
      const value = await requireResolver(r);
      if (value !== null) {
        resolved.set(r.target, value);
        continue;
      }
    }
    if (r.fallback !== null) resolved.set(r.target, r.fallback);
  }
  for (const v of parsed.vars) {
    if (resolved.has(v.name)) continue;
    if (v.default !== undefined) resolved.set(v.name, v.default);
  }

  const declaredNames = new Set<string>([
    ...parsed.vars.map((v) => v.name),
    ...parsed.requires.map((r) => r.target),
  ]);
  const missing: string[] = [];
  for (const name of declaredNames) {
    if (!resolved.has(name)) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`Missing required variables: ${missing.join(", ")}`);
  }

  const order = toposort(parsed.targets, parsed.entryTarget);


  // Default output declaration when `# Output:` is absent.
  const outputs: OutputDecl[] = parsed.outputs.length > 0 ? parsed.outputs : [{ kind: "text" }];

  const warnings: string[] = [];
  if (order.length < parsed.targets.size) {
    const reached = new Set(order);
    const orphans: string[] = [];
    for (const name of parsed.targets.keys()) {
      if (!reached.has(name)) orphans.push(name);
    }
    warnings.push(
      `Targets {${orphans.join(", ")}} are not reachable from entry target '${parsed.entryTarget}'. ` +
      `Either declare dependencies (Make-style: 'b: a' makes b depend on a), ` +
      `set 'default: <name>' to pick a different entry target, ` +
      `or fold the steps into the entry target as inline ops.`,
    );
  }

  const output = format === "prose"
    ? renderProse(parsed, resolved, order)
    : renderPrompt(parsed, resolved, order);

  return {
    skillName: parsed.name,
    format,
    resolvedVariables: Object.fromEntries(resolved),
    targetOrder: order,
    output,
    triggers: parsed.triggers,
    outputs,
    onError: parsed.onError,
    warnings,
    parsed,
  };
}

/**
 * Topological sort starting at `entry`. Leaves-first ordering. Throws on
 * cycle or missing-dependency reference. Exported so embedders that compile
 * by hand (parse → walk targets → ...) can use the same ordering as the
 * default compile pipeline.
 */
export function toposort(targets: Map<string, SkillTarget>, entry: string): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Dependency cycle detected at target '${name}'`);
    }
    const target = targets.get(name);
    if (!target) {
      throw new Error(`Target '${name}' references missing dependency`);
    }
    visiting.add(name);
    for (const dep of target.deps) visit(dep);
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  }
  visit(entry);
  return order;
}

/**
 * Compile-time variable substitution. Resolved declared vars get replaced;
 * unknown refs (target outputs, iterator vars, ambient runtime refs) pass
 * through verbatim for the runtime to substitute.
 */
function substitute(body: string, resolved: Map<string, string>): string {
  return body.replace(
    /\$\(([^|)\s]+)\s*(?:\|\s*([A-Za-z_]\w*))?\s*\)/g,
    (match: string, name: string, filter: string | undefined) => {
      if (!resolved.has(name)) return match;
      const raw = resolved.get(name)!;
      if (!filter) return raw;
      return applyFilter(raw, filter);
    },
  );
}

function renderOpPrompt(op: SkillOp, targetName: string, resolved: Map<string, string>, prefix = ""): string[] {
  const body = op.kind === "$set" ? op.body : substitute(op.body, resolved);
  switch (op.kind) {
    case "$":     return [`${prefix}- Call tool: ${op.mcpConnector !== undefined ? `${op.mcpConnector}.` : ""}${body} — bind output to $(${targetName}.output)`];
    case "$set":  return [`${prefix}- Bind variable: ${op.setName} = ${op.setValue}`];
    case "?":     return [`${prefix}- Reason: ${body}`];
    case "@":     return [`${prefix}- Run shell: ${body} — bind output to $(${targetName}.output)`];
    case "!":     return [`${prefix}- Tell the user: ${body}`];
    case "??":    return [`${prefix}- Ask the user: ${body}`];
    case "foreach": {
      const listExpr = substitute(op.foreachList!, resolved);
      const lines = [`${prefix}- For each \`${op.foreachIter}\` in ${listExpr}, do (loop-local scope):`];
      for (const innerOp of op.foreachBody!) {
        lines.push(...renderOpPrompt(innerOp, targetName, resolved, prefix + "  "));
      }
      return lines;
    }
    case ">": {
      const p = op.retrievalParams!;
      const querySub = substitute(p.query, resolved);
      const extraStr = Object.entries(p.extra)
        .map(([k, v]) => `${k}=${substitute(v, resolved)}`)
        .join(", ");
      const tail = extraStr ? `, ${extraStr}` : "";
      return [
        `${prefix}- Retrieve from MemoryStore \`${p.connector}\`: mode=${p.mode}, query="${querySub}", limit=${p.limit}${tail} — bind result list to $(${op.outputVar}).`,
      ];
    }
    case "~": {
      const p = op.localModelParams!;
      const promptSub = substitute(p.prompt, resolved);
      const modelName = p.model ?? "default";
      const tokensTail = p.maxTokens !== undefined ? `, maxTokens=${p.maxTokens}` : "";
      return [
        `${prefix}- Invoke LocalModel \`${modelName}\` with prompt="${promptSub}"${tokensTail} — bind response to $(${op.outputVar}).`,
      ];
    }
    case "if": {
      const lines: string[] = [];
      for (let i = 0; i < op.ifBranches!.length; i++) {
        const branch = op.ifBranches![i]!;
        const label = i === 0 ? "If" : "Otherwise if";
        lines.push(`${prefix}- ${label} ${branch.cond}, do:`);
        for (const innerOp of branch.body) {
          lines.push(...renderOpPrompt(innerOp, targetName, resolved, prefix + "  "));
        }
      }
      if (op.ifElseBody !== undefined) {
        lines.push(`${prefix}- Otherwise, do:`);
        for (const innerOp of op.ifElseBody) {
          lines.push(...renderOpPrompt(innerOp, targetName, resolved, prefix + "  "));
        }
      }
      return lines;
    }
  }
}

function renderPrompt(parsed: ParsedSkill, resolved: Map<string, string>, order: string[]): string {
  const out: string[] = [];
  out.push(`# Skill: ${parsed.name ?? "(unnamed)"}`);
  if (parsed.description) out.push(parsed.description);
  out.push("");
  if (parsed.onError !== null) {
    out.push(`**If this skill fails, invoke fallback:** ${parsed.onError}`);
    out.push("");
  }
  if (resolved.size > 0) {
    out.push("## Resolved variables");
    for (const [k, v] of resolved) out.push(`- ${k} = ${v}`);
    out.push("");
  }
  out.push("## Steps (topological order)");
  let stepNum = 1;
  for (const name of order) {
    const target = parsed.targets.get(name);
    if (!target) continue;
    out.push("");
    out.push(`### ${stepNum}. ${name}${target.deps.length > 0 ? `  (after: ${target.deps.join(", ")})` : ""}`);
    for (const op of target.ops) {
      out.push(...renderOpPrompt(op, name, resolved));
    }
    if (target.elseBlock !== undefined) {
      out.push("");
      out.push(`**On failure of ${name}, do:**`);
      for (const op of target.elseBlock) {
        out.push(...renderOpPrompt(op, name, resolved));
      }
    }
    stepNum += 1;
  }
  return out.join("\n");
}

function renderOpProse(op: SkillOp, resolved: Map<string, string>): string[] {
  const body = op.kind === "$set" ? op.body : substitute(op.body, resolved);
  switch (op.kind) {
    case "$":     return [`Calls a tool: ${op.mcpConnector !== undefined ? `${op.mcpConnector}.` : ""}${body}.`];
    case "$set":  return [`Sets variable ${op.setName} to ${op.setValue}.`];
    case "?":     return [`Reasons through: ${body}.`];
    case "@":     return [`Runs a shell command: ${body}.`];
    case "!":     return [`Reports back to the user: ${body}.`];
    case "??":    return [`Pauses to ask the user: ${body}.`];
    case "foreach": {
      const listExpr = substitute(op.foreachList!, resolved);
      const inner = op.foreachBody!.flatMap((o) => renderOpProse(o, resolved));
      return [`For each \`${op.foreachIter}\` in ${listExpr} (loop-local scope), runs: ${inner.join(" ")}`];
    }
    case ">": {
      const p = op.retrievalParams!;
      const querySub = substitute(p.query, resolved);
      const extraStr = Object.entries(p.extra)
        .map(([k, v]) => `${k}=${substitute(v, resolved)}`)
        .join(", ");
      const tail = extraStr ? ` (filters: ${extraStr})` : "";
      return [`Queries MemoryStore \`${p.connector}\` with mode=${p.mode}, query="${querySub}", limit=${p.limit}${tail}; binds to $(${op.outputVar}).`];
    }
    case "~": {
      const p = op.localModelParams!;
      const promptSub = substitute(p.prompt, resolved);
      const modelName = p.model ?? "default";
      const tokensTail = p.maxTokens !== undefined ? ` (maxTokens=${p.maxTokens})` : "";
      return [`Calls LocalModel \`${modelName}\` with prompt="${promptSub}"${tokensTail}; binds to $(${op.outputVar}).`];
    }
    case "if": {
      const parts: string[] = [];
      for (let i = 0; i < op.ifBranches!.length; i++) {
        const branch = op.ifBranches![i]!;
        const label = i === 0 ? "If" : "Otherwise if";
        const inner = branch.body.flatMap((o) => renderOpProse(o, resolved));
        parts.push(`${label} ${branch.cond}, runs: ${inner.join(" ")}`);
      }
      if (op.ifElseBody !== undefined) {
        const inner = op.ifElseBody.flatMap((o) => renderOpProse(o, resolved));
        parts.push(`Otherwise, runs: ${inner.join(" ")}`);
      }
      return [parts.join(" ")];
    }
  }
}

function renderProse(parsed: ParsedSkill, resolved: Map<string, string>, order: string[]): string {
  const out: string[] = [];
  out.push(`# ${parsed.name ?? "(unnamed)"}`);
  if (parsed.description) {
    out.push("");
    out.push(parsed.description);
  }
  if (parsed.onError !== null) {
    out.push("");
    out.push(`**On error, falls back to:** ${parsed.onError}`);
  }
  if (resolved.size > 0) {
    out.push("");
    out.push("**Inputs:** " + Array.from(resolved.entries()).map(([k, v]) => `${k} = ${v}`).join("; "));
  }
  for (const name of order) {
    const target = parsed.targets.get(name);
    if (!target) continue;
    out.push("");
    out.push(`## ${name}`);
    const sentences: string[] = [];
    if (target.deps.length > 0) {
      sentences.push(`Runs after ${target.deps.join(", ")}.`);
    }
    for (const op of target.ops) {
      sentences.push(...renderOpProse(op, resolved));
    }
    out.push(sentences.join(" "));
    if (target.elseBlock !== undefined) {
      const elseSentences = target.elseBlock.flatMap((op) => renderOpProse(op, resolved));
      out.push("");
      out.push(`**On failure:** ${elseSentences.join(" ")}`);
    }
  }
  return out.join("\n");
}
