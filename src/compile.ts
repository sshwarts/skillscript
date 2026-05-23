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
import {
  type ProvenanceBlock,
  buildProvenance,
  renderInlineProvenance,
} from "./provenance.js";
import { lint } from "./lint.js";
import { LintFailureError } from "./errors.js";

/**
 * Semantic analysis + render. Four phases:
 *
 *  1. Resolve declared `# Vars:` / `# Requires:` against caller inputs +
 *     the optional require-resolver callback.
 *  2. **Data-skill inlining** (T3). For every `&` op referencing a
 *     `# Type: data` skill, replace the op with the inlined content;
 *     procedural-skill refs remain as `&` ops for runtime invocation.
 *     Skill-dep cycles error here.
 *  3. Topological sort (target-deps + skill-deps). Detects cycles + missing refs.
 *  4. Render. Two output formats: `prompt` (canonical agent-shaped
 *     markdown), `prose` (narrative for human reading).
 *
 * Inlining: when a `&` op references a data-typed skill, the substituted
 * shape is a `$set <outputVar> = <data content>` op if `outputVar` is
 * named, otherwise a `!` op carrying the data content. This keeps the
 * dispatch shape compatible with the existing runtime — no new op kinds
 * needed downstream. The data skill's source body (everything after the
 * headers) is the inlined content.
 */

export type RenderFormat = "prompt" | "prose";

/** Resolves a `# Requires:` declaration to a concrete value, or null. */
export type RequireResolver = (req: SkillRequire) => string | null | Promise<string | null>;

export interface CompileOptions {
  inputs?: Record<string, string>;
  format?: RenderFormat;
  /** Optional resolver for `# Requires:` cascade. Without it, requires fall through to declared fallback or surface as missing. */
  requireResolver?: RequireResolver;
  /** Optional SkillStore — used for `# OnError:` validation, data-skill inlining (T3), and source-skill provenance lookup. */
  skillStore?: SkillStore;
  /** When true, embed the provenance block at the bottom of the rendered artifact instead of returning it as a sidecar. Default false (sidecar shape). */
  inlineProvenance?: boolean;
  /**
   * Skip the tier-1 lint preflight. Default false (preflight runs). Setting
   * true is mostly useful for tests that exercise compile paths the lint
   * would reject — production callers should let preflight run.
   */
  skipLintPreflight?: boolean;
  /**
   * Runtime `enableUnsafeShell` flag, if known to the caller. When `false`,
   * the lint preflight escalates `@ unsafe` ops to tier-1 (v0.2.11 Bug 5)
   * because the runtime would refuse them — surface up-front instead of
   * compiling clean and failing at first fire.
   */
  enableUnsafeShell?: boolean;
}

/**
 * Recorded per inlined data-skill. Phase 3's provenance block aggregates
 * these so `skillfile audit` can detect recompile-staleness by comparing
 * recorded vs current `content_hash`.
 */
export interface InlinedDataSkillRef {
  name: string;
  version: string;
  content_hash: string;
}

export interface CompileResult {
  skillName: string | null;
  format: RenderFormat;
  resolvedVariables: Record<string, string>;
  targetOrder: string[];
  output: string;
  triggers: ParsedSkill["triggers"];
  outputs: OutputDecl[];
  /** Data-skill content_hashes recorded for recompile-staleness detection. Empty if no `&` data-skill refs. */
  dataSkillsInlined: InlinedDataSkillRef[];
  /**
   * Structured provenance block for the compiled artifact. Carries the
   * source skill's identity + every inlined data-skill's `content_hash`
   * + compiler/language versions + compile timestamp. Phase 4's
   * `skillfile audit` consumes this to detect recompile-staleness.
   */
  provenance: ProvenanceBlock;
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
  const { inputs, format = "prompt", requireResolver, skillStore, inlineProvenance = false } = options;

  // Lint preflight — tier-1 violations block compilation per ERD §3.
  // Parse errors surface here too (as parse-error rule findings) before the
  // legacy error throw below; preserving the throw shape keeps existing
  // catchers working while giving lint-aware callers a richer diagnostic.
  if (options.skipLintPreflight !== true) {
    const lintResult = await lint(source, {
      ...(skillStore !== undefined ? { skillStore } : {}),
      callSite: "compile-preflight",
      ...(options.enableUnsafeShell !== undefined ? { enableUnsafeShell: options.enableUnsafeShell } : {}),
    });
    const tier1 = lintResult.findings.filter((f) => f.severity === "error");
    if (tier1.length > 0) {
      throw new LintFailureError(
        tier1.map((f) => ({
          rule: f.rule,
          message: f.message,
          ...(f.block !== undefined ? { block: f.block } : {}),
          severity: f.severity,
          ...(f.remediation !== undefined ? { remediation: f.remediation } : {}),
          ...(f.extras !== undefined ? { extras: f.extras } : {}),
        })),
        "compile",
      );
    }
  }

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

  // Phase 2 (T3): inline data-skill `&` references. Procedural-skill refs
  // are left as `&` ops with ampParams populated for T5's runtime to dispatch.
  // Skill-dep cycles error here. Tracks every inlined data-skill's
  // content_hash for Phase 3's provenance block.
  const dataSkillsInlined: InlinedDataSkillRef[] = [];
  if (skillStore !== undefined) {
    await inlineDataSkills(parsed, skillStore, dataSkillsInlined, [parsed.name ?? "(unnamed)"]);
  } else if (anyAmpDataLookupNeeded(parsed)) {
    // Skill body contains `&` ops but no SkillStore was provided. Compile
    // still proceeds — refs stay as procedural-style for T5 — but issue a
    // warning if the skill might have meant a data-skill ref.
    // (We can't know without loading; just emit a hint.)
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

  // Provenance: look up the source skill's version + content_hash via
  // SkillStore if available, otherwise leave those fields undefined.
  let sourceVersion: string | undefined;
  let sourceContentHash: string | undefined;
  if (skillStore !== undefined && parsed.name !== null) {
    try {
      const meta = await skillStore.metadata(parsed.name);
      sourceVersion = meta.version;
      sourceContentHash = meta.content_hash;
    } catch {
      // Skill not stored yet (compile-from-source path) — fields stay undefined.
    }
  }
  const provenance = buildProvenance({
    sourceSkillName: parsed.name,
    ...(sourceVersion !== undefined ? { sourceVersion } : {}),
    ...(sourceContentHash !== undefined ? { sourceContentHash } : {}),
    dataSkillsInlined,
  });

  let output = format === "prose"
    ? renderProse(parsed, resolved, order)
    : renderPrompt(parsed, resolved, order);
  if (inlineProvenance) {
    output += renderInlineProvenance(provenance);
  }

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
    dataSkillsInlined,
    provenance,
  };
}

/**
 * Walk every op in every target (recursing into foreach/if bodies) and
 * replace `&` ops that reference data-typed skills with inlined content.
 * Procedural-skill refs stay as `&` ops for the runtime to invoke. Cycles
 * error with a chain trace.
 */
async function inlineDataSkills(
  parsed: ParsedSkill,
  store: SkillStore,
  inlinedRecord: InlinedDataSkillRef[],
  chain: string[],
): Promise<void> {
  for (const target of parsed.targets.values()) {
    target.ops = await inlineOps(target.ops, store, inlinedRecord, chain);
    if (target.elseBlock !== undefined) {
      target.elseBlock = await inlineOps(target.elseBlock, store, inlinedRecord, chain);
    }
  }
}

async function inlineOps(
  ops: SkillOp[],
  store: SkillStore,
  inlinedRecord: InlinedDataSkillRef[],
  chain: string[],
): Promise<SkillOp[]> {
  const out: SkillOp[] = [];
  for (const op of ops) {
    if (op.kind === "&" && op.ampParams !== undefined) {
      const refName = op.ampParams.skillName;
      if (chain.includes(refName)) {
        const path = [...chain, refName];
        const err = new Error(
          `Skill-dep cycle detected: ${path.join(" → ")}. ` +
          `Data skills cannot inline through a reference loop.`,
        ) as Error & { cycle?: string[]; rule?: string };
        // Agent-parseable structure: caller code can inspect err.cycle as
        // a JSON array of skill names without parsing the message string.
        err.cycle = path;
        err.rule = "skill-dep-cycle";
        throw err;
      }
      const source = await store.load(refName);
      const refParsed = parse(source.source);
      if (refParsed.type === "data") {
        inlinedRecord.push({
          name: refName,
          version: source.version,
          content_hash: source.content_hash,
        });
        // Recursively inline data-skills referenced by this data-skill.
        await inlineDataSkills(refParsed, store, inlinedRecord, [...chain, refName]);
        // Synthesize the inlined ops. Output-binding case (`-> VAR`)
        // collapses the content into one $set so $(VAR) substitution
        // sees a single value. Bare case splats into N `!` ops mirroring
        // the data-skill's op structure — preserves per-rule granularity
        // so an agent reading the parent's compiled output sees the
        // guidance directives as separate items, not one giant emission.
        if (op.outputVar !== undefined) {
          const content = dataSkillContent(refParsed);
          out.push({
            kind: "$set",
            body: `$set ${op.outputVar} = ${content}`,
            setName: op.outputVar,
            setValue: content,
          });
        } else {
          for (const dataOp of dataSkillBangOps(refParsed)) {
            out.push({ kind: "!", body: dataOp });
          }
        }
        continue;
      }
      // Procedural ref: leave as-is for T5 runtime.
      out.push(op);
      continue;
    }
    // Recurse into nested bodies for non-& ops.
    if (op.foreachBody !== undefined) {
      out.push({ ...op, foreachBody: await inlineOps(op.foreachBody, store, inlinedRecord, chain) });
      continue;
    }
    if (op.ifBranches !== undefined) {
      const newBranches = await Promise.all(
        op.ifBranches.map(async (b) => ({ cond: b.cond, body: await inlineOps(b.body, store, inlinedRecord, chain) })),
      );
      const next: SkillOp = { ...op, ifBranches: newBranches };
      if (op.ifElseBody !== undefined) {
        next.ifElseBody = await inlineOps(op.ifElseBody, store, inlinedRecord, chain);
      }
      out.push(next);
      continue;
    }
    out.push(op);
  }
  return out;
}

/**
 * Extract the inlineable content of a data-skill as a single joined string.
 * Used for output-binding inlining (`& data -> VAR`) where the consumer
 * wants the whole content as one value.
 */
function dataSkillContent(parsed: ParsedSkill): string {
  return dataSkillBangOps(parsed).join("\n");
}

/**
 * Extract each `!` op body from a data-skill in topological order.
 * Used for bare-`&` inlining where we synthesize N `!` ops in the parent
 * to preserve the per-rule structure agents need for reading.
 */
function dataSkillBangOps(parsed: ParsedSkill): string[] {
  if (parsed.entryTarget === null) return [];
  const order = toposort(parsed.targets, parsed.entryTarget);
  const lines: string[] = [];
  for (const name of order) {
    const target = parsed.targets.get(name);
    if (!target) continue;
    for (const op of target.ops) {
      if (op.kind === "!") lines.push(op.body);
    }
  }
  return lines;
}

function anyAmpDataLookupNeeded(parsed: ParsedSkill): boolean {
  for (const target of parsed.targets.values()) {
    if (hasAmpOp(target.ops)) return true;
    if (target.elseBlock !== undefined && hasAmpOp(target.elseBlock)) return true;
  }
  return false;
}

function hasAmpOp(ops: SkillOp[]): boolean {
  for (const op of ops) {
    if (op.kind === "&") return true;
    if (op.foreachBody !== undefined && hasAmpOp(op.foreachBody)) return true;
    if (op.ifBranches !== undefined) {
      for (const b of op.ifBranches) if (hasAmpOp(b.body)) return true;
    }
    if (op.ifElseBody !== undefined && hasAmpOp(op.ifElseBody)) return true;
  }
  return false;
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
    case "$":     return [`${prefix}- Call tool: ${op.mcpConnector !== undefined ? `${op.mcpConnector}.` : ""}${body} — bind output to $(${op.outputVar ?? `${targetName}.output`})`];
    case "$set":  return [`${prefix}- Bind variable: ${op.setName} = ${op.setValue}`];
    case "?":     return [`${prefix}- Reason: ${body}`];
    case "@":     return [`${prefix}- Run shell: ${body} — bind output to $(${op.outputVar ?? `${targetName}.output`})`];
    case "!":     return [`${prefix}- Tell the user: ${body}`];
    case "??":    return [`${prefix}- Ask the user: ${body}`];
    case "&": {
      const p = op.ampParams!;
      const argsStr = Object.entries(p.args).map(([k, v]) => `${k}=${substitute(v, resolved)}`).join(" ");
      const bindTail = op.outputVar !== undefined ? ` — bind result to $(${op.outputVar})` : "";
      return [`${prefix}- Invoke skill: ${p.skillName}${argsStr ? ` (${argsStr})` : ""}${bindTail}`];
    }
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
      // v0.2.12 Bug 18: substitute on `limit` and `mode` for consistency
      // with `query` and `extra`. Pre-fix, limit=$(MAX) rendered literally.
      const limitSub = typeof p.limit === "string" ? substitute(p.limit, resolved) : p.limit;
      const modeSub = substitute(p.mode, resolved);
      const extraStr = Object.entries(p.extra)
        .map(([k, v]) => `${k}=${substitute(v, resolved)}`)
        .join(", ");
      const tail = extraStr ? `, ${extraStr}` : "";
      return [
        `${prefix}- Retrieve from MemoryStore \`${p.connector}\`: mode=${modeSub}, query="${querySub}", limit=${limitSub}${tail} — bind result list to $(${op.outputVar}).`,
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
    case "&": {
      const p = op.ampParams!;
      const argsStr = Object.entries(p.args).map(([k, v]) => `${k}=${substitute(v, resolved)}`).join(", ");
      const bindTail = op.outputVar !== undefined ? `; binds to $(${op.outputVar})` : "";
      return [`Invokes skill ${p.skillName}${argsStr ? ` with ${argsStr}` : ""}${bindTail}.`];
    }
    case "foreach": {
      const listExpr = substitute(op.foreachList!, resolved);
      const inner = op.foreachBody!.flatMap((o) => renderOpProse(o, resolved));
      return [`For each \`${op.foreachIter}\` in ${listExpr} (loop-local scope), runs: ${inner.join(" ")}`];
    }
    case ">": {
      const p = op.retrievalParams!;
      const querySub = substitute(p.query, resolved);
      // v0.2.12 Bug 18: substitute limit/mode here too (mirror of the
      // prompt-format renderer above).
      const limitSub = typeof p.limit === "string" ? substitute(p.limit, resolved) : p.limit;
      const modeSub = substitute(p.mode, resolved);
      const extraStr = Object.entries(p.extra)
        .map(([k, v]) => `${k}=${substitute(v, resolved)}`)
        .join(", ");
      const tail = extraStr ? ` (filters: ${extraStr})` : "";
      return [`Queries MemoryStore \`${p.connector}\` with mode=${modeSub}, query="${querySub}", limit=${limitSub}${tail}; binds to $(${op.outputVar}).`];
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
