import { parse, type ParsedSkill, type SkillOp } from "./parser.js";
import { KNOWN_FILTERS } from "./filters.js";
import type { StaticCapabilities, SkillStore } from "./connectors/types.js";
import type { Registry } from "./connectors/registry.js";

/**
 * Lint engine. T4 ships 21 rules across three severity tiers:
 *
 *   tier-1 (error)   — hard-block at compile; rule output throws LintFailureError
 *                      from `compile()` when present. Catches structural,
 *                      grammar, and reference-integrity violations.
 *   tier-2 (warning) — requires human review before admission. Surfaces
 *                      patterns that may be intentional but warrant
 *                      double-check (`@@` shell, mutation without
 *                      confirmation, model contention).
 *   tier-3 (info)    — advisory style/quality nits. Authors can ignore.
 *
 * Diagnostics are agent-consumable JSON by default. The CLI's `--human`
 * flag renders a terminal-friendly format over the same shape. The
 * structured form carries `rule`, `severity`, `message`, optional `block`
 * (target name), and rule-specific extras (e.g., `cycle: string[]` for
 * `circular-dependency`).
 *
 * Rule registry pattern: every rule is an object `{ id, severity,
 * description, check(parsed, ctx), remediation }`. The `lint()` function
 * walks the registry. Adding a rule = adding an entry to `RULES`.
 *
 * Compile preflight: `compile()` calls `lint()` and throws
 * `LintFailureError` if any tier-1 finding is present. Skills that
 * fail tier-1 lint don't compile.
 */

export type LintSeverity = "error" | "warning" | "info";

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  message: string;
  /** Target name where the violation lives, when applicable. */
  block?: string;
  /** Canned remediation guidance per rule. */
  remediation?: string;
  /** Rule-specific structured extras. Agents parse this; humans see `message`. */
  extras?: Record<string, unknown>;
}

export interface LintResult {
  findings: LintFinding[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

export interface LintOptions {
  /**
   * Connector classes whose `staticCapabilities()` provides the available
   * feature flags. The linter calls these directly — no instance
   * construction, no network, no substrate reachability required.
   */
  classes?: Array<{ staticCapabilities(): StaticCapabilities }>;
  /** Convenience: derive `classes` from a Registry's registered instances. */
  registry?: Registry;
  /**
   * Optional SkillStore for reference-integrity rules (`unknown-skill-reference`,
   * `disabled-skill-reference`). When absent, those rules don't fire — they
   * can't validate without the store. The `missing-skillstore-for-data-ref`
   * rule still fires (it checks for absence, not presence).
   */
  skillStore?: SkillStore;
  /**
   * Where the lint was called from. Surfaces in diagnostics so operators
   * can locate the fix (CLI invocation, library API caller, compile
   * preflight). Default `"api"`.
   */
  callSite?: "cli" | "api" | "compile-preflight";
  /**
   * Runtime `enableUnsafeShell` flag, if known to the caller. When
   * explicitly `false`, the `unsafe-shell-disabled` rule (v0.2.11 Bug 5)
   * fires tier-1 on any `@ unsafe` op — the skill would refuse at
   * runtime, and compile should surface that up-front. When `undefined`
   * (caller doesn't know), only the standard tier-2 `unsafe-shell-op`
   * warning fires.
   */
  enableUnsafeShell?: boolean;
}

interface LintContext {
  parsed: ParsedSkill;
  capabilityClasses: Array<{ staticCapabilities(): StaticCapabilities }> | null;
  skillStore: SkillStore | undefined;
  hasSkillStore: boolean;
  callSite: "cli" | "api" | "compile-preflight";
  enableUnsafeShell: boolean | undefined;
}

export interface LintRule {
  id: string;
  severity: LintSeverity;
  description: string;
  check(ctx: LintContext): LintFinding[] | Promise<LintFinding[]>;
  remediation: string;
}

// ─── lint() entry point ────────────────────────────────────────────────────

export async function lint(source: string, options?: LintOptions): Promise<LintResult> {
  const parsed = parse(source);
  const ctx: LintContext = {
    parsed,
    capabilityClasses: options?.classes ?? collectClassesFromRegistry(options?.registry),
    skillStore: options?.skillStore,
    hasSkillStore: options?.skillStore !== undefined,
    callSite: options?.callSite ?? "api",
    enableUnsafeShell: options?.enableUnsafeShell,
  };
  const findings: LintFinding[] = [];
  for (const rule of RULES) {
    const result = await rule.check(ctx);
    for (const f of result) {
      findings.push({
        ...f,
        remediation: f.remediation ?? rule.remediation,
      });
    }
  }
  // Stable sort: by severity (error > warning > info), then rule id, then block.
  const sevWeight: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) =>
    sevWeight[a.severity] - sevWeight[b.severity] ||
    a.rule.localeCompare(b.rule) ||
    (a.block ?? "").localeCompare(b.block ?? ""),
  );
  return {
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warningCount: findings.filter((f) => f.severity === "warning").length,
    infoCount: findings.filter((f) => f.severity === "info").length,
  };
}

/** Synchronous variant for callers that don't need SkillStore-dependent rules. */
export function lintSync(source: string, options?: LintOptions): LintResult {
  const parsed = parse(source);
  const ctx: LintContext = {
    parsed,
    capabilityClasses: options?.classes ?? collectClassesFromRegistry(options?.registry),
    skillStore: options?.skillStore,
    hasSkillStore: options?.skillStore !== undefined,
    callSite: options?.callSite ?? "api",
    enableUnsafeShell: options?.enableUnsafeShell,
  };
  const findings: LintFinding[] = [];
  for (const rule of RULES) {
    const result = rule.check(ctx);
    if (result instanceof Promise) {
      throw new Error(`Rule '${rule.id}' is async; use lint() instead of lintSync().`);
    }
    for (const f of result) {
      findings.push({ ...f, remediation: f.remediation ?? rule.remediation });
    }
  }
  const sevWeight: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) =>
    sevWeight[a.severity] - sevWeight[b.severity] ||
    a.rule.localeCompare(b.rule) ||
    (a.block ?? "").localeCompare(b.block ?? ""),
  );
  return {
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warningCount: findings.filter((f) => f.severity === "warning").length,
    infoCount: findings.filter((f) => f.severity === "info").length,
  };
}

/** Human-readable formatter over the structured LintResult. JSON is the canonical form; this is for `--human` CLI output. */
export function formatLintResult(result: LintResult): string {
  if (result.findings.length === 0) return "OK: no findings.";
  const lines: string[] = [];
  for (const f of result.findings) {
    const block = f.block ? ` (in ${f.block})` : "";
    lines.push(`[${f.severity}] ${f.rule}${block}: ${f.message}`);
    if (f.remediation) lines.push(`  → ${f.remediation}`);
  }
  lines.push(``);
  lines.push(`${result.errorCount} error(s), ${result.warningCount} warning(s), ${result.infoCount} info.`);
  return lines.join("\n");
}

// ─── Rule registry ─────────────────────────────────────────────────────────

const PARSE_ERROR: LintRule = {
  id: "parse-error",
  severity: "error",
  description: "Any syntax error collected by the parser.",
  remediation: "Fix the grammar error per the message. Check op syntax, header form, indent levels.",
  check: (ctx) => ctx.parsed.parseErrors.map((msg) => ({
    rule: "parse-error",
    severity: "error",
    message: msg,
  })),
};

const NO_TARGETS: LintRule = {
  id: "no-targets",
  severity: "error",
  description: "Skill defines zero targets.",
  remediation: "Declare at least one target. A target is a name + `:` + indented op lines.",
  check: (ctx) => {
    if (ctx.parsed.targets.size === 0 && ctx.parsed.parseErrors.length === 0) {
      return [{
        rule: "no-targets",
        severity: "error",
        message: "Skill defines no targets. A skill needs at least one target with ops.",
      }];
    }
    return [];
  },
};

const NO_ENTRY_TARGET: LintRule = {
  id: "no-entry-target",
  severity: "error",
  description: "Targets exist but no entry resolved. Currently unreachable since the parser's fallback picks the last target — kept in the registry so authoring tools can introspect the rule list; a parser change that tracks `entryTargetExplicit` would activate this.",
  remediation: "Add `default: <target-name>` at the bottom of the skill.",
  check: (ctx) => {
    if (ctx.parsed.targets.size > 0 && ctx.parsed.entryTarget === null) {
      return [{
        rule: "no-entry-target",
        severity: "error",
        message: "Skill has no entry target. Declare one with `default: <target-name>`.",
      }];
    }
    return [];
  },
};

const ORPHAN_TARGET: LintRule = {
  id: "orphan-target",
  severity: "warning",
  description: "A target isn't reachable from the entry via the `needs:` DAG.",
  remediation: "Declare a dependency (Make-style: `b: a` makes b depend on a), change `default:`, or fold the steps into the entry target.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    if (ctx.parsed.entryTarget === null || !ctx.parsed.targets.has(ctx.parsed.entryTarget)) return findings;
    const reached = new Set<string>();
    function walk(name: string): void {
      if (reached.has(name)) return;
      reached.add(name);
      const t = ctx.parsed.targets.get(name);
      if (!t) return;
      for (const dep of t.deps) walk(dep);
    }
    walk(ctx.parsed.entryTarget);
    for (const name of ctx.parsed.targets.keys()) {
      if (!reached.has(name)) {
        findings.push({
          rule: "orphan-target",
          severity: "warning",
          message: `Target '${name}' is not reachable from entry target '${ctx.parsed.entryTarget}'.`,
          block: name,
        });
      }
    }
    return findings;
  },
};

const UNKNOWN_CAPABILITY: LintRule = {
  id: "unknown-capability",
  severity: "error",
  description: "A `# Requires:` capability clause names a feature flag no registered connector class provides.",
  remediation: "Either remove the requirement, configure a connector class that provides the flag, or fix the typo in the flag name.",
  check: (ctx) => {
    if (ctx.parsed.requiredCapabilities.length === 0 || ctx.capabilityClasses === null) return [];
    const provided = buildFeatureSet(ctx.capabilityClasses);
    const findings: LintFinding[] = [];
    for (const cap of ctx.parsed.requiredCapabilities) {
      if (!provided.has(cap)) {
        findings.push({
          rule: "unknown-capability",
          severity: "error",
          message: `Skill requires capability '${cap}', but no registered connector class provides it. ` +
            `Available: ${provided.size === 0 ? "(none)" : Array.from(provided).sort().join(", ")}.`,
        });
      }
    }
    return findings;
  },
};

/**
 * Tier-1 ambient refs per language reference §3 — runtime injects these
 * automatically; authors don't declare them. The lint considers them
 * pre-declared.
 */
const AMBIENT_VARS: readonly string[] = [
  "NOW",
  "USER",
  "SESSION_CONTEXT",
  "TRIGGER_TYPE",
  "TRIGGER_PAYLOAD",
  "ERROR_CONTEXT",
];

const UNDECLARED_VAR: LintRule = {
  id: "undeclared-var",
  severity: "error",
  description: "An op body references `$(NAME)` for a variable that's not declared in `# Vars:`/`# Requires:`, not output-bound by any op anywhere in the skill, not a foreach iterator in scope, and not a tier-1 ambient ref (NOW/USER/SESSION_CONTEXT/TRIGGER_TYPE/TRIGGER_PAYLOAD/ERROR_CONTEXT).",
  remediation: "Add the variable to `# Vars:` or `# Requires:`, or check the spelling against the declared variable list.",
  check: (ctx) => {
    const declared = new Set<string>(AMBIENT_VARS);
    for (const v of ctx.parsed.vars) declared.add(v.name);
    for (const r of ctx.parsed.requires) declared.add(r.target);
    // Collect output-bound vars across the whole skill — once bound by any
    // target's $set / -> outputVar / foreach iterator, the var is available
    // for substitution downstream. The runtime walks targets in topo-sort;
    // by the time a downstream target executes, earlier targets' bindings
    // have populated `vars`.
    for (const target of ctx.parsed.targets.values()) {
      const collect = (op: SkillOp): void => {
        if (op.setName !== undefined) declared.add(op.setName);
        if (op.outputVar !== undefined) declared.add(op.outputVar);
        if (op.foreachIter !== undefined) declared.add(op.foreachIter);
      };
      walkOps(target.ops, collect);
      // Bindings inside `else:` error-handler blocks also become available
      // downstream — the runtime executes the else: chain when the main
      // body throws and propagates any $set bindings into the vars Map.
      if (target.elseBlock !== undefined) walkOps(target.elseBlock, collect);
    }
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      const reported = new Set<string>(); // dedupe per target
      for (const op of target.ops) {
        // `@ unsafe` ops use bash `$(...)` syntax — handled by
        // unsafe-shell-ambiguous-subst, which offers the dual rewrite
        // (`$$(NAME)` for bash, `$(KNOWN_VAR)` for skillscript). Skip here
        // to avoid double-reporting.
        if (op.kind === "@" && op.policy === "unsafe") continue;
        for (const ref of extractVarRefs(op)) {
          // Heuristic: dotted refs (targetname.output, MEMORY.field) pass
          // as ambient — runtime substitution handles dotted lookups.
          if (ref.includes(".")) continue;
          if (declared.has(ref)) continue;
          if (reported.has(ref)) continue;
          reported.add(ref);
          findings.push({
            rule: "undeclared-var",
            severity: "error",
            message: `Reference to undeclared variable '$(${ref})' in op of target '${targetName}'.`,
            block: targetName,
            extras: { var_name: ref },
          });
        }
      }
    }
    return findings;
  },
};

const UNKNOWN_FILTER: LintRule = {
  id: "unknown-filter",
  severity: "error",
  description: "A `$(VAR|filter)` reference uses a filter not in the registered set.",
  remediation: `Use a known filter: ${KNOWN_FILTERS.join(", ")}. Or remove the filter to substitute the raw value.`,
  check: (ctx) => {
    const knownSet = new Set<string>(KNOWN_FILTERS);
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      const reported = new Set<string>(); // dedupe per target
      for (const op of target.ops) {
        for (const { name, filter } of extractVarRefsWithFilter(op)) {
          if (!filter || knownSet.has(filter)) continue;
          const key = `${name}|${filter}`;
          if (reported.has(key)) continue;
          reported.add(key);
          findings.push({
            rule: "unknown-filter",
            severity: "error",
            message: `Reference '$(${name}|${filter})' in target '${targetName}' uses unknown filter '${filter}'.`,
            block: targetName,
            extras: { var_name: name, filter },
          });
        }
      }
    }
    return findings;
  },
};

const MALFORMED_OP_GRAMMAR: LintRule = {
  id: "malformed-op-grammar",
  severity: "error",
  description: "An op line failed parser grammar validation. Surfaces parse errors that originate from op-specific shape.",
  remediation: "Check the op's syntax against the language reference. Common cases: `>` and `~` need `key=value ... -> VAR`; `& skill arg=value -> VAR` for skill invocations.",
  check: (ctx) => ctx.parsed.parseErrors
    .filter((msg) => /Malformed `[~>&$@!?]/.test(msg))
    .map((msg) => ({
      rule: "malformed-op-grammar",
      severity: "error" as const,
      message: msg,
    })),
};

const INVALID_CONDITIONAL_SYNTAX: LintRule = {
  id: "invalid-conditional-syntax",
  severity: "error",
  description: "An `if:` / `elif:` condition uses syntax outside the v1 narrow grammar (truthy / `==` / `!=` / `in` / `not in`).",
  remediation: "Restructure the condition to use a supported shape. v1 explicitly excludes AND/OR, numeric comparison, and defined-checks.",
  check: (ctx) => ctx.parsed.parseErrors
    .filter((msg) => /Unsupported condition/.test(msg))
    .map((msg) => ({
      rule: "invalid-conditional-syntax",
      severity: "error" as const,
      message: msg,
    })),
};

const SINGLE_EQUALS: LintRule = {
  id: "single-equals",
  severity: "error",
  description: "An `if:` / `elif:` condition uses single `=` for equality. Skillscript condition equality is `==` (two-character).",
  remediation: "Replace `=` with `==`. The diagnostic includes the rewritten line.",
  check: (ctx) => ctx.parsed.parseErrors
    .filter((msg) => /`=` is not valid in a condition; use `==`/.test(msg))
    .map((msg) => ({
      rule: "single-equals",
      severity: "error" as const,
      message: msg,
    })),
};

const RESERVED_KEYWORD: LintRule = {
  id: "reserved-keyword",
  severity: "error",
  description: "An identifier (skill name, variable name, target name, or foreach iterator) uses a reserved keyword. Reserved words: `default`, `needs`, `if`, `elif`, `else`, `foreach`, `in`, `not`, `unsafe` (current) and `while`, `for`, `match`, `try`, `catch`, `return` (future-reserved).",
  remediation: "Rename to a non-reserved identifier. The diagnostic includes a suggested rename.",
  check: (ctx) => ctx.parsed.parseErrors
    .filter((msg) => / is a reserved keyword/.test(msg))
    .map((msg) => ({
      rule: "reserved-keyword",
      severity: "error" as const,
      message: msg,
    })),
};

const INDENTATION: LintRule = {
  id: "indentation",
  severity: "error",
  description: "Indentation must be spaces-only with consistent depth within a block. Tabs and mid-block indent changes are parse errors.",
  remediation: "Replace tabs with spaces (conventional indent is 4 spaces). Within a block, every non-sub-block line must use the same indent depth.",
  check: (ctx) => ctx.parsed.parseErrors
    .filter((msg) => /Tab characters in indentation|Mid-block indent change/.test(msg))
    .map((msg) => ({
      rule: "indentation",
      severity: "error" as const,
      message: msg,
    })),
};

// v0.3.1: demoted tier-1 → tier-2. Forward-references are allowed; the
// runtime throws `SkillNotFoundError` if the ref still can't resolve at
// execute time. The tier-3 `deferred-skill-reference` advisory below
// confirms the deferred-resolution path is engaged.
const UNKNOWN_SKILL_REFERENCE: LintRule = {
  id: "unknown-skill-reference",
  severity: "warning",
  description: "An `&` or `$ execute_skill` op references a skill that's not present in the configured SkillStore. Lint warning (not error) since v0.3.1 — runtime throws `SkillNotFoundError` if still missing at execute time.",
  remediation: "If this is a typo, fix the spelling against your declarations. If it's a forward reference to a skill you'll author next, this warning clears once the skill is stored. The runtime will throw `SkillNotFoundError` at execute time if the skill is still missing.",
  check: async (ctx) => {
    if (ctx.skillStore === undefined) return [];
    const findings: LintFinding[] = [];
    const seen = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      for (const ref of collectAmpRefsFromOps(target.ops)) {
        const key = `${ref.via}:${ref.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          await ctx.skillStore.metadata(ref.name);
        } catch {
          findings.push({
            rule: "unknown-skill-reference",
            severity: "warning",
            message: `Skill '${targetName}' references skill '${ref.name}' via \`${ref.via}\`, but the SkillStore has no skill by that name.`,
            block: targetName,
            extras: { referenced_skill: ref.name, via: ref.via },
          });
        }
      }
    }
    return findings;
  },
};

// v0.2.12 Bug 26. Tier-2 warning when a `>` retrieval op carries kwargs
// outside the documented set. Cold author wrote `since=1h` (hallucinated
// time-window predicate) and the kwarg passed silently. The documented
// kwarg set is mode/query/limit/connector/fallback plus filter shapes
// the connector advertises via staticCapabilities (out of band here).
const KNOWN_RETRIEVAL_KWARGS = new Set(["mode", "query", "limit", "connector", "fallback"]);

const UNKNOWN_RETRIEVAL_ARG: LintRule = {
  id: "unknown-retrieval-arg",
  severity: "warning",
  description: "A `>` retrieval op carries a kwarg outside the documented set (mode/query/limit/connector/fallback).",
  remediation: "Remove the kwarg, or check it against your MemoryStore connector's documentation — extras pass through to the connector but unrecognized ones often indicate hallucinated syntax.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== ">") return;
        const extras = op.retrievalParams?.extra ?? {};
        for (const k of Object.keys(extras)) {
          if (KNOWN_RETRIEVAL_KWARGS.has(k)) continue;
          findings.push({
            rule: "unknown-retrieval-arg",
            severity: "warning",
            message: `\`>\` op in target '${targetName}' carries unknown kwarg '${k}'. Documented kwargs: ${Array.from(KNOWN_RETRIEVAL_KWARGS).join(", ")}. If '${k}' is a connector-specific filter, confirm it against the connector's docs.`,
            block: targetName,
            extras: { unknown_kwarg: k },
          });
        }
      });
    }
    return findings;
  },
};

// v0.3.1: tier-3 advisory that fires alongside the demoted tier-2
// unknown-skill-reference / unknown-template-reference. Confirms the
// deferred-resolution path is engaged so cold authors can distinguish
// "intentional forward-ref" from "typo I should fix now."
const DEFERRED_SKILL_REFERENCE: LintRule = {
  id: "deferred-skill-reference",
  severity: "info",
  description: "An `&` / `$ execute_skill` / `# Templates:` reference targets a skill not currently in the SkillStore; resolution is deferred to execute time (v0.3.1+).",
  remediation: "If this is a forward reference, this advisory will clear once the referenced skill is stored. If it's a typo, fix the spelling — the runtime will throw `SkillNotFoundError` at execute time if still missing.",
  check: async (ctx) => {
    if (ctx.skillStore === undefined) return [];
    const findings: LintFinding[] = [];
    const seenComposition = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      for (const ref of collectAmpRefsFromOps(target.ops)) {
        const key = `${ref.via}:${ref.name}`;
        if (seenComposition.has(key)) continue;
        seenComposition.add(key);
        try {
          await ctx.skillStore.metadata(ref.name);
        } catch {
          findings.push({
            rule: "deferred-skill-reference",
            severity: "info",
            message: `Skill '${ref.name}' referenced via \`${ref.via}\` is not currently in the SkillStore. Lint demoted in v0.3.1 — will resolve at execute time if the skill exists by then, or throw SkillNotFoundError if not. If this is a typo, fix it now; if it's a forward reference, this advisory will clear once you store '${ref.name}'.`,
            block: targetName,
            extras: { referenced_skill: ref.name, via: ref.via },
          });
        }
      }
    }
    for (const name of ctx.parsed.templates) {
      try {
        await ctx.skillStore.metadata(name);
      } catch {
        findings.push({
          rule: "deferred-skill-reference",
          severity: "info",
          message: `Skill '${name}' referenced via \`# Templates:\` is not currently in the SkillStore. Lint demoted in v0.3.1 — will resolve at execute time if the skill exists by then, or throw SkillNotFoundError if not. If this is a typo, fix it now; if it's a forward reference, this advisory will clear once you store '${name}'.`,
          extras: { referenced_skill: name, via: "# Templates" },
        });
      }
    }
    return findings;
  },
};

// v0.2.12 Bug 17. `# Templates:` refs were not lint-validated despite
// `# OnError:` having compile-time validation (since v0.2.10).
// v0.3.1: demoted tier-1 → tier-2 alongside unknown-skill-reference.
// Runtime throws SkillNotFoundError on delivery if still missing.
const UNKNOWN_TEMPLATE_REFERENCE: LintRule = {
  id: "unknown-template-reference",
  severity: "warning",
  description: "`# Templates: <name>` references a skill that's not present in the configured SkillStore. Lint warning (not error) since v0.3.1 — runtime throws on delivery if still missing.",
  remediation: "If this is a typo, fix the spelling. If it's a forward reference, the warning clears once the template skill is stored. Delivery throws if the template is still missing at runtime.",
  check: async (ctx) => {
    if (ctx.skillStore === undefined) return [];
    if (ctx.parsed.templates.length === 0) return [];
    const findings: LintFinding[] = [];
    for (const name of ctx.parsed.templates) {
      try {
        await ctx.skillStore.metadata(name);
      } catch {
        findings.push({
          rule: "unknown-template-reference",
          severity: "warning",
          message: `Skill references template '${name}' via \`# Templates:\`, but the SkillStore has no skill by that name.`,
          extras: { referenced_skill: name },
        });
      }
    }
    return findings;
  },
};

const DISABLED_SKILL_REFERENCE: LintRule = {
  id: "disabled-skill-reference",
  severity: "error",
  description: "An `&` op references a skill whose `# Status:` is `disabled`.",
  remediation: "Re-enable the target skill via `update_status`, or remove the reference. Disabled skills are intentionally not compose-able to surface deprecation paths.",
  check: async (ctx) => {
    if (ctx.skillStore === undefined) return [];
    const findings: LintFinding[] = [];
    const checked = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      for (const ref of collectAmpRefsFromOps(target.ops)) {
        if (checked.has(ref.name)) continue;
        checked.add(ref.name);
        try {
          const meta = await ctx.skillStore.metadata(ref.name);
          if (meta.status === "Disabled") {
            findings.push({
              rule: "disabled-skill-reference",
              severity: "error",
              message: `Skill '${targetName}' references '${ref.name}' via \`${ref.via}\` which is disabled.`,
              block: targetName,
              extras: { referenced_skill: ref.name, via: ref.via, target_status: meta.status },
            });
          }
        } catch {
          /* unknown-skill-reference handles missing-skill case */
        }
      }
    }
    return findings;
  },
};

/** Patterns that strongly suggest a credential in plaintext. Conservative — false positives are noisy, false negatives are dangerous, so we err on the side of catching obvious cases. */
const CREDENTIAL_ARG_PATTERN = /\b(apikey|api_key|token|secret|password|passwd|pwd|auth_token|access_token|bearer)\s*=/i;

const CREDENTIAL_IN_ARGS: LintRule = {
  id: "credential-in-args",
  severity: "error",
  description: "A `$` op carries arg values that match credential-like patterns. Credentials don't belong in skill source.",
  remediation: "Move credentials to per-connector config (env vars, mounted secrets). Skill args should reference operator-managed values, not embed them.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "$") return;
        if (CREDENTIAL_ARG_PATTERN.test(op.body)) {
          findings.push({
            rule: "credential-in-args",
            severity: "error",
            message: `\`$\` op in target '${targetName}' appears to carry credential-like arg ('${op.body.slice(0, 40)}...').`,
            block: targetName,
          });
        }
      });
    }
    return findings;
  },
};

const STATUS_DISABLED: LintRule = {
  id: "status-disabled",
  severity: "error",
  description: "The skill being compiled is `# Status: Disabled`. Disabled skills don't compile.",
  remediation: "Transition the skill to `approved` or `draft` via `update_status` before compiling, or revisit whether the skill should be disabled.",
  check: (ctx) => {
    if (ctx.parsed.status !== "Disabled") return [];
    return [{
      rule: "status-disabled",
      severity: "error",
      message: `Skill '${ctx.parsed.name ?? "(unnamed)"}' is \`# Status: Disabled\` and cannot be compiled.`,
    }];
  },
};

const CIRCULAR_DEPENDENCY: LintRule = {
  id: "circular-dependency",
  severity: "error",
  description: "The target dependency DAG has a cycle, OR a `&` skill-reference chain has one.",
  remediation: "Break the cycle by restructuring the dependency graph or extracting shared logic into a separate skill.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    if (ctx.parsed.entryTarget === null) return findings;
    // Target-level cycle detection (compile.ts's toposort throws on this
    // at runtime; we replicate the walk for lint-time detection so
    // diagnostics surface before the throw).
    const visiting = new Set<string>();
    const visited = new Set<string>();
    function visit(name: string, path: string[]): boolean {
      if (visiting.has(name)) {
        const cycleStart = path.indexOf(name);
        const cycle = cycleStart >= 0 ? [...path.slice(cycleStart), name] : [name];
        findings.push({
          rule: "circular-dependency",
          severity: "error",
          message: `Dependency cycle in targets: ${cycle.join(" → ")}.`,
          extras: { cycle },
        });
        return true;
      }
      if (visited.has(name)) return false;
      visiting.add(name);
      const target = ctx.parsed.targets.get(name);
      if (target) {
        for (const dep of target.deps) {
          if (visit(dep, [...path, name])) {
            visiting.delete(name);
            return true;
          }
        }
      }
      visiting.delete(name);
      visited.add(name);
      return false;
    }
    visit(ctx.parsed.entryTarget, []);
    return findings;
  },
};

const MISSING_DEPENDENCY: LintRule = {
  id: "missing-dependency",
  severity: "error",
  description: "A `needs:` clause references a target that's not declared in this skill.",
  remediation: "Add the target definition, or remove the reference. Targets are declared as `<name>: [deps]` at the top level of a skill.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    for (const [name, target] of ctx.parsed.targets) {
      for (const dep of target.deps) {
        if (!ctx.parsed.targets.has(dep)) {
          findings.push({
            rule: "missing-dependency",
            severity: "error",
            message: `Target '${name}' depends on '${dep}', which isn't declared in this skill.`,
            block: name,
            extras: { missing_dep: dep },
          });
        }
      }
    }
    return findings;
  },
};

const MISSING_SKILLSTORE_FOR_DATA_REF: LintRule = {
  id: "missing-skillstore-for-data-ref",
  severity: "error",
  description: "Skill body uses `&` to reference another skill, but no SkillStore was provided to compile/lint. Data-skill inlining is silently skipped — the `&` op survives into the runtime, which rejects it.",
  remediation: "Pass a SkillStore via `compile()` / `lint()` options, or via the CLI environment. Without it, references can't resolve.",
  check: (ctx) => {
    if (ctx.hasSkillStore) return [];
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      for (const op of target.ops) {
        if (op.kind === "&") {
          findings.push({
            rule: "missing-skillstore-for-data-ref",
            severity: "error",
            message: `Skill references skill '${op.ampParams?.skillName ?? "(unknown)"}' via \`&\`, but lint was invoked without a SkillStore (call site: ${ctx.callSite}). Data-skill inlining will silently skip; the \`&\` op will survive into the runtime and error.`,
            block: targetName,
            extras: { call_site: ctx.callSite },
          });
          // One finding per skill is sufficient; the operator fixes it once.
          return findings;
        }
      }
    }
    return findings;
  },
};

// ─── Tier-2 rules (warning) ─────────────────────────────────────────────────

const DEPRECATED_QUESTION: LintRule = {
  id: "deprecated-question",
  severity: "warning",
  description: "Skill uses bare `?` (deprecated). The implicit-context reasoning form makes behavior depend on context not visible in the skill source. Compile-error in v1.x.",
  remediation: "Rewrite as `~ prompt=\"<explicit reasoning task>\" -> VAR`. Use the explicit prompt to capture what the implicit `?` was doing (\"decide whether to escalate\", \"classify this input\", etc.).",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind === "?") {
          const varName = op.outputVar ?? "VAR";
          findings.push({
            rule: "deprecated-question",
            severity: "warning",
            message: `\`?\` op in target '${targetName}' is deprecated (compile-error in v1.x). rewrite as: \`~ prompt="<explicit reasoning task>" -> ${varName}\``,
            block: targetName,
          });
        }
      });
    }
    return findings;
  },
};

const UNSAFE_SHELL_AMBIGUOUS_SUBST: LintRule = {
  id: "unsafe-shell-ambiguous-subst",
  severity: "warning",
  description: "An `@ unsafe` op body contains `$(NAME)` where NAME isn't a declared skillscript variable. Collides with bash's `$(command)` command-substitution syntax.",
  remediation: "Use `$$(...)` to send the `$(...)` literally to bash (command-substitution), or `$(KNOWN_VAR)` to reference a declared skillscript variable.",
  check: (ctx) => {
    const declared = new Set<string>();
    for (const v of ctx.parsed.vars) declared.add(v.name);
    for (const r of ctx.parsed.requires) declared.add(r.target);
    for (const target of ctx.parsed.targets.values()) {
      const collect = (op: SkillOp): void => {
        if (op.setName !== undefined) declared.add(op.setName);
        if (op.outputVar !== undefined) declared.add(op.outputVar);
        if (op.foreachIter !== undefined) declared.add(op.foreachIter);
      };
      walkOps(target.ops, collect);
      // Bindings inside `else:` error-handler blocks also become available
      // downstream — the runtime executes the else: chain when the main
      // body throws and propagates any $set bindings into the vars Map.
      if (target.elseBlock !== undefined) walkOps(target.elseBlock, collect);
    }
    const findings: LintFinding[] = [];
    // Permissive — matches any `$(...)` in @ unsafe body that's not `$$(...)`.
    // Skillscript vars are strict identifiers; bash command-subs can contain
    // anything. The rule wants to fire on both.
    const REF_RE = /(?<!\$)\$\(([^)]+)\)/g;
    for (const [targetName, target] of ctx.parsed.targets) {
      const reported = new Set<string>();
      walkOps(target.ops, (op) => {
        if (op.kind !== "@" || op.policy !== "unsafe") return;
        const re = new RegExp(REF_RE.source, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(op.body)) !== null) {
          const inner = m[1]!;
          // A declared skillscript variable is safe. Strict-identifier match
          // — anything else (spaces, special chars, etc.) is implicitly bash.
          const trimmed = inner.trim();
          if (/^[A-Za-z_]\w*$/.test(trimmed) && declared.has(trimmed)) continue;
          // v0.2.11 Bug 4: dotted refs (EVENT.fired_at_unix, MEMORY.x,
          // <target>.output) are runtime ambient/output families — same
          // dotted-passthrough heuristic as `undeclared-var`. The
          // unsafe-shell warning was telling cold authors to rewrite
          // `$(EVENT.fired_at_unix)` as `$$(EVENT.fired_at_unix)` (bash
          // command-sub), which would just try to execute "EVENT...".
          if (trimmed.includes(".")) continue;
          // v0.2.11 Bug 4: bare ambient refs (NOW, USER, ERROR_CONTEXT,
          // SESSION_CONTEXT, TRIGGER_TYPE, TRIGGER_PAYLOAD) also pass —
          // runtime injects them, author doesn't declare.
          if (AMBIENT_VARS.includes(trimmed)) continue;
          if (reported.has(inner)) continue;
          reported.add(inner);
          findings.push({
            rule: "unsafe-shell-ambiguous-subst",
            severity: "warning",
            message: `\`$(${inner})\` in \`@ unsafe\` body of target '${targetName}' is ambiguous — either send literally to bash via \`$$(${inner})\`, or use a declared skillscript variable.`,
            block: targetName,
            extras: { ref: inner },
          });
        }
      });
    }
    return findings;
  },
};

const UNSAFE_SHELL_OP: LintRule = {
  id: "unsafe-shell-op",
  severity: "warning",
  description: "Skill uses `@ unsafe` (opt-in full-shell exec). Requires human review every time.",
  remediation: "Confirm the operator deployment has `runtime.enable_unsafe_shell = true` and the shell content is reviewed. Prefer the default `@ <binary> <args>` form (structured-spawn sandbox) when the work can decompose to single binaries.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind === "@" && op.policy === "unsafe") {
          findings.push({
            rule: "unsafe-shell-op",
            severity: "warning",
            message: `\`@ unsafe\` shell op in target '${targetName}': '${op.body.slice(0, 60)}${op.body.length > 60 ? "..." : ""}'`,
            block: targetName,
          });
        }
      });
    }
    return findings;
  },
};

/**
 * v0.2.11 Bug 5. Tier-1 escalation of the unsafe-shell signal — only
 * fires when the caller passed `enableUnsafeShell: false` explicitly.
 * Without that knowledge (the field is undefined), this rule stays
 * silent and the tier-2 `unsafe-shell-op` warning is the only signal.
 *
 * When the runtime is known-disabled, every `@ unsafe` op is a guaranteed
 * runtime refusal (`UnsafeShellDisabledError`). Surfacing that at compile
 * time instead of letting the skill compile clean and then fail at first
 * fire avoids the "compiles clean but won't run" gap Perry's harness
 * surfaced (memory `b6176e02`).
 */
const UNSAFE_SHELL_DISABLED: LintRule = {
  id: "unsafe-shell-disabled",
  severity: "error",
  description: "Skill uses `@ unsafe`, but the runtime was configured with `enableUnsafeShell: false`. The op will refuse at first fire.",
  remediation: "Either set `enableUnsafeShell: true` on the runtime (after reviewing the shell content), or refactor the `@ unsafe` op to use the structured `@ <binary> <args>` form (sandboxed, no bash).",
  check: (ctx) => {
    if (ctx.enableUnsafeShell !== false) return [];
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind === "@" && op.policy === "unsafe") {
          findings.push({
            rule: "unsafe-shell-disabled",
            severity: "error",
            message: `\`@ unsafe\` op in target '${targetName}' would refuse at runtime: \`enableUnsafeShell\` is false. Command: '${op.body.slice(0, 60)}${op.body.length > 60 ? "..." : ""}'`,
            block: targetName,
          });
        }
      });
    }
    return findings;
  },
};

/**
 * Tool-name patterns that strongly suggest mutating operations.
 * Conservative — false positives are tolerable for warnings; false
 * negatives are dangerous.
 *
 * v0.2.11 Bug 6: extended with archive_/prune_/deploy_/expire_/
 * consolidate_/purge_/reset_/rotate_/move_/rename_/drop_/truncate_/
 * upsert_/overwrite_/clear_/wipe_/finalize_ — Perry's wild-and-crazy
 * harness surfaced a cluster of mutating tools that the original
 * write/update/delete/etc. set didn't catch (`archive_old_threads`,
 * `prune_threads`, `deploy_release`, `dangerous-cleanup`'s `expire_*`).
 */
const MUTATING_TOOL_PATTERN = /^(?:write_|update_|delete_|remove_|set_|create_|insert_|put_|patch_|destroy_|archive_|prune_|deploy_|expire_|consolidate_|purge_|reset_|rotate_|move_|rename_|drop_|truncate_|upsert_|overwrite_|clear_|wipe_|finalize_).*/;

const UNCONFIRMED_MUTATION: LintRule = {
  id: "unconfirmed-mutation",
  severity: "warning",
  description: "A `$` op invokes a tool whose name suggests mutation (write/update/delete/...) without a preceding `??` confirmation step.",
  remediation: "Add a `??` confirmation op before the mutation, or restructure to make the mutation explicit in the skill's name/output.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      let sawConfirm = false;
      for (const op of target.ops) {
        if (op.kind === "??") sawConfirm = true;
        if (op.kind === "$" && !sawConfirm) {
          const toolName = op.body.split(/\s+/)[0] ?? "";
          if (MUTATING_TOOL_PATTERN.test(toolName)) {
            findings.push({
              rule: "unconfirmed-mutation",
              severity: "warning",
              message: `\`$\` op in target '${targetName}' invokes '${toolName}' (mutating shape) without a preceding \`??\` confirmation.`,
              block: targetName,
            });
          }
        }
      }
    }
    return findings;
  },
};

const MODEL_CONTENTION: LintRule = {
  id: "model-contention",
  severity: "warning",
  description: "Skill body has a `$` op dispatching async batch work on a model + a downstream `~ model=X` synchronous call to the same model. The runtime serializes per-model; the sync call queues behind the batch.",
  remediation: "Use distinct models for async vs sync work: e.g., `gemma2` for batch + `qwen` for the interactive verdict. See ERD §3 model selection convention.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    // Heuristic: collect ~ op model names per target. Flag if any $ op
    // in the same target dispatches a batch-classification-shaped tool
    // (name contains "olsen", "scan", "batch", "classify"). Conservative.
    for (const [targetName, target] of ctx.parsed.targets) {
      const syncModels = new Set<string>();
      walkOps(target.ops, (op) => {
        if (op.kind === "~" && op.localModelParams?.model) syncModels.add(op.localModelParams.model);
      });
      if (syncModels.size === 0) return findings;
      walkOps(target.ops, (op) => {
        if (op.kind !== "$") return;
        const toolName = op.body.split(/\s+/)[0] ?? "";
        if (/scan|batch|classify|atomize/i.test(toolName)) {
          findings.push({
            rule: "model-contention",
            severity: "warning",
            message: `Target '${targetName}' dispatches batch work via '${toolName}' AND uses sync \`~ model=...\` — possible model contention on the same backend.`,
            block: targetName,
          });
        }
      });
    }
    return findings;
  },
};

const DRAFT_WITH_TRIGGER: LintRule = {
  id: "draft-with-trigger",
  severity: "warning",
  description: "Skill has `# Status: Draft` but declares triggers. Draft skills shouldn't be fire-able autonomously.",
  remediation: "Promote to `approved` once tested, or remove the trigger declarations until the skill is ready.",
  check: (ctx) => {
    if (ctx.parsed.status !== "Draft" || ctx.parsed.triggers.length === 0) return [];
    return [{
      rule: "draft-with-trigger",
      severity: "warning",
      message: `Skill is \`# Status: Draft\` but declares ${ctx.parsed.triggers.length} trigger(s). Draft skills won't fire — promote or drop the triggers.`,
    }];
  },
};

const REFERENCE_TO_DISABLED_SKILL: LintRule = {
  id: "reference-to-disabled-skill",
  severity: "warning",
  description: "An `&` op references a skill whose `# Status:` is `disabled`. Tier-2 warning to surface deprecation paths without breaking existing references.",
  remediation: "Plan a migration off the disabled skill. Existing references resolve; new authoring should pick a non-disabled target.",
  check: async (ctx) => {
    if (ctx.skillStore === undefined) return [];
    const findings: LintFinding[] = [];
    const checked = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      for (const ref of collectAmpRefsFromOps(target.ops)) {
        if (checked.has(ref.name)) continue;
        checked.add(ref.name);
        try {
          const meta = await ctx.skillStore.metadata(ref.name);
          if (meta.status === "Disabled") {
            findings.push({
              rule: "reference-to-disabled-skill",
              severity: "warning",
              message: `Target '${targetName}' references '${ref.name}' via \`${ref.via}\` which is disabled.`,
              block: targetName,
              extras: { referenced_skill: ref.name, via: ref.via },
            });
          }
        } catch {
          /* unknown-skill-reference handles missing case */
        }
      }
    }
    return findings;
  },
};

// ─── Tier-3 rules (info) ────────────────────────────────────────────────────

const NO_DEFAULT_TARGET: LintRule = {
  id: "no-default-target",
  severity: "info",
  description: "Multi-target skill resolves entry via fallback (last target) instead of an explicit `default:` declaration. Authors lose intent visibility.",
  remediation: "Add `default: <target-name>` to make the entry point explicit.",
  check: (ctx) => {
    if (ctx.parsed.targets.size <= 1) return [];
    // The parser sets entryTarget to the last declared target when no `default:`
    // line was present. Re-derive that condition from the source.
    // Simpler: ParsedSkill doesn't distinguish explicit vs fallback. The
    // parser's behavior is `entryTarget === null` only when no targets at
    // all; with targets it picks the last. So we can't distinguish at
    // this layer without a parser change. For v1.0-dev, skip the check
    // (parser change deferred to v1.x).
    return [];
  },
};

const DUPLICATE_SKILL_NAME: LintRule = {
  id: "duplicate-skill-name",
  severity: "info",
  description: "Another skill in the SkillStore has the same name as this one. Risk of authoring confusion.",
  remediation: "Rename one of the skills. Unique names per substrate; conflicts surface as ambiguous-name errors at load time.",
  check: async (ctx) => {
    if (ctx.skillStore === undefined || ctx.parsed.name === null) return [];
    const matches = await ctx.skillStore.query();
    const dupes = matches.filter((m) => m.name === ctx.parsed.name);
    if (dupes.length <= 1) return [];
    return [{
      rule: "duplicate-skill-name",
      severity: "info",
      message: `${dupes.length} skills in the SkillStore share the name '${ctx.parsed.name}'.`,
    }];
  },
};

const PLUGIN_COLLISION: LintRule = {
  id: "plugin-collision",
  severity: "info",
  description: "The same plugin name resolves in both filesystem and npm — operator should confirm which wins per the resolution-order config.",
  remediation: "Set `plugins.resolution_order` in config.toml to commit to a precedence order, or remove the duplicate.",
  check: () => {
    // Plugin loader doesn't exist yet (T7). Rule shape is here so the
    // registry shape stays complete; check returns empty until T7 wires
    // plugin discovery.
    return [];
  },
};

const UNUSED_AUGMENTING_HEADER: LintRule = {
  id: "unused-augmenting-header",
  severity: "warning",
  description: "`# Delivery-context:` or `# Templates:` set on a skill that has no `prompt-context:` or `template:` output declaration. The fields route through `DeliveryPayload`; without an agent-bound output they don't reach a substrate.",
  remediation: "Either add an agent-bound output (`# Output: prompt-context: <agent>` or `# Output: template: <agent>`) so the augmenting fields fire, or remove `# Delivery-context:` / `# Templates:` from the frontmatter if the skill is genuinely Headless.",
  check: (ctx) => {
    const hasAgentBoundOutput = ctx.parsed.outputs.some(
      (o) => o.kind === "prompt-context" || o.kind === "template",
    );
    if (hasAgentBoundOutput) return [];
    const findings: LintFinding[] = [];
    if (ctx.parsed.deliveryContext !== null) {
      findings.push({
        rule: "unused-augmenting-header",
        severity: "warning",
        message: "`# Delivery-context:` is set but this skill has no `prompt-context:` or `template:` output — the value won't reach any agent.",
      });
    }
    if (ctx.parsed.templates.length > 0) {
      findings.push({
        rule: "unused-augmenting-header",
        severity: "warning",
        message: `\`# Templates:\` lists ${ctx.parsed.templates.length} skill(s) but this skill has no \`prompt-context:\` or \`template:\` output — the field won't reach any agent.`,
      });
    }
    return findings;
  },
};

// v0.3.0 accumulator lint helpers. Scope-aware walker tracks nesting
// via {id, kind} pairs so the accumulator rules can distinguish target-
// body / foreach / if-branch scopes. An init's path is an ANCESTOR of
// an append's path iff it's a strict prefix.
type ScopeNode = { id: number; kind: "foreach" | "if-branch" | "if-else" };
type ScopePath = ReadonlyArray<ScopeNode>;
function isAncestorScope(initPath: ScopePath, appendPath: ScopePath): boolean {
  if (initPath.length >= appendPath.length) return false;
  for (let i = 0; i < initPath.length; i++) {
    if (initPath[i]!.id !== appendPath[i]!.id) return false;
  }
  return true;
}
function isSameScope(a: ScopePath, b: ScopePath): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.id !== b[i]!.id) return false;
  return true;
}
function pathContainsForeach(p: ScopePath): boolean {
  for (const n of p) if (n.kind === "foreach") return true;
  return false;
}

function walkOpsWithScope(
  ops: SkillOp[],
  visit: (op: SkillOp, path: ScopePath) => void,
  nextScopeId: { n: number },
  path: ScopePath = [],
): void {
  for (const op of ops) {
    visit(op, path);
    if (op.foreachBody !== undefined) {
      const child: ScopeNode = { id: nextScopeId.n++, kind: "foreach" };
      walkOpsWithScope(op.foreachBody, visit, nextScopeId, [...path, child]);
    }
    if (op.ifBranches !== undefined) {
      for (const b of op.ifBranches) {
        const child: ScopeNode = { id: nextScopeId.n++, kind: "if-branch" };
        walkOpsWithScope(b.body, visit, nextScopeId, [...path, child]);
      }
    }
    if (op.ifElseBody !== undefined) {
      const child: ScopeNode = { id: nextScopeId.n++, kind: "if-else" };
      walkOpsWithScope(op.ifElseBody, visit, nextScopeId, [...path, child]);
    }
  }
}

function isStaticListLiteral(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith("[") && t.endsWith("]");
}

const UNINITIALIZED_APPEND: LintRule = {
  id: "uninitialized-append",
  severity: "error",
  description: "`$append VAR ...` where VAR isn't initialized in any enclosing scope (target body, # Vars: declaration, or shallower foreach/if block).",
  remediation: "Add `$set VAR = []` before the `$append` (in the target body, not inside the foreach), or declare in `# Vars: VAR=[]`. If you meant a different variable, check the spelling against your declarations.",
  check: (ctx) => {
    const declaredGlobal = new Set<string>();
    for (const v of ctx.parsed.vars) declaredGlobal.add(v.name);
    for (const r of ctx.parsed.requires) declaredGlobal.add(r.target);
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      const inits = new Map<string, ScopePath[]>();
      const sc1 = { n: 1 };
      walkOpsWithScope(target.ops, (op, path) => {
        if (op.kind === "$set" && op.setName !== undefined) {
          const arr = inits.get(op.setName) ?? [];
          arr.push([...path]);
          inits.set(op.setName, arr);
        }
      }, sc1);
      const sc2 = { n: 1 };
      walkOpsWithScope(target.ops, (op, path) => {
        if (op.kind !== "$append" || op.setName === undefined) return;
        const varName = op.setName;
        if (declaredGlobal.has(varName)) return;
        const initPaths = inits.get(varName) ?? [];
        const hasAncestor = initPaths.some((ip) => isAncestorScope(ip, path));
        const hasSame = initPaths.some((ip) => isSameScope(ip, path));
        // Same-scope counts as "visible" for resolution purposes — the
        // init runs before the append in the same block (foreach iteration,
        // straight target body, etc.). Whether it's the RIGHT shape for an
        // accumulator is `foreach-local-accumulator-target`'s job.
        const isVisible = hasAncestor || hasSame;
        const hasOther = initPaths.some((ip) => !isAncestorScope(ip, path) && !isSameScope(ip, path));
        if (initPaths.length === 0) {
          findings.push({
            rule: "uninitialized-append",
            severity: "error",
            message: `\`$append ${varName} ...\` in target '${targetName}': ${varName} is not initialized. Add \`$set ${varName} = []\` before the \`$append\` (or declare in \`# Vars: ${varName}=[]\`). If you meant a different variable, check the spelling against your declarations.`,
            block: targetName,
            extras: { var_name: varName },
          });
        } else if (!isVisible && hasOther) {
          // init exists in a sibling/inner scope, not visible at the append site.
          findings.push({
            rule: "uninitialized-append",
            severity: "error",
            message: `\`$append ${varName} ...\` in target '${targetName}': ${varName}'s \`$set\` initialization is in a sibling or inner block, not visible at this append site. Move the init to the target body (or a common enclosing scope) before the \`$append\`.`,
            block: targetName,
            extras: { var_name: varName },
          });
        }
      }, sc2);
    }
    return findings;
  },
};

const FOREACH_LOCAL_ACCUMULATOR_TARGET: LintRule = {
  id: "foreach-local-accumulator-target",
  severity: "error",
  description: "`$append VAR ...` where VAR's `$set VAR = []` initialization is in the SAME scope (typically same foreach body). Each iteration resets VAR; the accumulator silently loses all but the last iteration's append.",
  remediation: "Move `$set VAR = []` outside the foreach (to the target body), so the append mutates a single outer-scope list that persists across iterations.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      const inits = new Map<string, ScopePath[]>();
      const sc1 = { n: 1 };
      walkOpsWithScope(target.ops, (op, path) => {
        if (op.kind === "$set" && op.setName !== undefined) {
          const arr = inits.get(op.setName) ?? [];
          arr.push([...path]);
          inits.set(op.setName, arr);
        }
      }, sc1);
      const sc2 = { n: 1 };
      walkOpsWithScope(target.ops, (op, path) => {
        if (op.kind !== "$append" || op.setName === undefined) return;
        const initPaths = inits.get(op.setName) ?? [];
        const hasAncestor = initPaths.some((ip) => isAncestorScope(ip, path));
        const hasSame = initPaths.some((ip) => isSameScope(ip, path));
        // Only fires when the SAME scope is inside a foreach. Same scope at
        // target-body level (both ops at depth 0) is fine — that's just
        // sequential init + append, no iteration to lose data across.
        if (!hasAncestor && hasSame && pathContainsForeach(path)) {
          findings.push({
            rule: "foreach-local-accumulator-target",
            severity: "error",
            message: `\`$append ${op.setName} ...\` in target '${targetName}': \`$set ${op.setName} = []\` is in the same scope as the append (typically the same foreach body). Each iteration resets ${op.setName}, silently losing all but the last iteration's data. Move the \`$set ${op.setName} = []\` to the target body, before the foreach.`,
            block: targetName,
            extras: { var_name: op.setName },
          });
        }
      }, sc2);
    }
    return findings;
  },
};

const APPEND_TO_NON_LIST: LintRule = {
  id: "append-to-non-list",
  severity: "error",
  description: "`$append VAR ...` where VAR's static initialization is a non-list value. $append v0.3.0 is list-only.",
  remediation: "Initialize VAR with a list literal (`$set VAR = []` or `# Vars: VAR=[]`). String concat and map-shaped accumulation are out of scope for v0.3.0.",
  check: (ctx) => {
    const staticInits = new Map<string, string>();
    for (const v of ctx.parsed.vars) {
      if (v.default !== undefined) staticInits.set(v.name, v.default);
    }
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind === "$set" && op.setName !== undefined && op.setValue !== undefined && !/\$\(/.test(op.setValue)) {
          staticInits.set(op.setName, op.setValue);
        }
      });
      walkOps(target.ops, (op) => {
        if (op.kind !== "$append" || op.setName === undefined) return;
        const init = staticInits.get(op.setName);
        if (init === undefined) return;
        if (!isStaticListLiteral(init)) {
          findings.push({
            rule: "append-to-non-list",
            severity: "error",
            message: `\`$append ${op.setName} ...\` in target '${targetName}': ${op.setName} is initialized to a non-list value (\`${init.slice(0, 40)}${init.length > 40 ? "..." : ""}\`). $append v0.3.0 requires a list-typed target.`,
            block: targetName,
            extras: { var_name: op.setName, init_value: init },
          });
        }
      });
    }
    return findings;
  },
};

const RULES: LintRule[] = [
  // Tier-1 (error)
  PARSE_ERROR,
  NO_TARGETS,
  NO_ENTRY_TARGET,
  ORPHAN_TARGET,
  UNKNOWN_CAPABILITY,
  UNDECLARED_VAR,
  UNKNOWN_FILTER,
  MALFORMED_OP_GRAMMAR,
  INVALID_CONDITIONAL_SYNTAX,
  SINGLE_EQUALS,
  INDENTATION,
  RESERVED_KEYWORD,
  UNKNOWN_SKILL_REFERENCE,
  UNKNOWN_TEMPLATE_REFERENCE,
  DEFERRED_SKILL_REFERENCE,
  UNKNOWN_RETRIEVAL_ARG,
  UNINITIALIZED_APPEND,
  FOREACH_LOCAL_ACCUMULATOR_TARGET,
  APPEND_TO_NON_LIST,
  DISABLED_SKILL_REFERENCE,
  CREDENTIAL_IN_ARGS,
  STATUS_DISABLED,
  CIRCULAR_DEPENDENCY,
  MISSING_DEPENDENCY,
  MISSING_SKILLSTORE_FOR_DATA_REF,
  // Tier-2 (warning)
  DEPRECATED_QUESTION,
  UNSAFE_SHELL_AMBIGUOUS_SUBST,
  UNSAFE_SHELL_OP,
  UNSAFE_SHELL_DISABLED,
  UNCONFIRMED_MUTATION,
  MODEL_CONTENTION,
  DRAFT_WITH_TRIGGER,
  REFERENCE_TO_DISABLED_SKILL,
  UNUSED_AUGMENTING_HEADER,
  // Tier-3 (info)
  NO_DEFAULT_TARGET,
  DUPLICATE_SKILL_NAME,
  PLUGIN_COLLISION,
];

/** Read-only view of the rule registry — for tooling that introspects v1 rules. */
export function listRules(): ReadonlyArray<Omit<LintRule, "check">> {
  return RULES.map(({ id, severity, description, remediation }) => ({ id, severity, description, remediation }));
}

// ─── AST walking helpers ───────────────────────────────────────────────────

function walkOps(ops: SkillOp[], visit: (op: SkillOp) => void): void {
  for (const op of ops) {
    visit(op);
    if (op.foreachBody !== undefined) walkOps(op.foreachBody, visit);
    if (op.ifBranches !== undefined) {
      for (const b of op.ifBranches) walkOps(b.body, visit);
    }
    if (op.ifElseBody !== undefined) walkOps(op.ifElseBody, visit);
  }
}

// v0.2.12 Bug 19: tag refs with op kind so diagnostics report the actual
// operator (pre-Bug-19 every message said "via `&`" even for `$ execute_skill`).
interface CompositionRef { name: string; via: "&" | "$ execute_skill"; }

function collectAmpRefsFromOps(ops: SkillOp[]): CompositionRef[] {
  const out: CompositionRef[] = [];
  const seen = new Set<string>();
  const emit = (name: string, via: CompositionRef["via"]): void => {
    const key = `${via}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, via });
  };
  walkOps(ops, (op) => {
    if (op.kind === "&" && op.ampParams !== undefined) emit(op.ampParams.skillName, "&");
    // v0.2.11 Bug 7: $ execute_skill is also a composition primitive.
    if (op.kind === "$" && /^execute_skill\b/.test(op.body)) {
      const m = /\bskill_name\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w-]*))/.exec(op.body);
      if (m !== null) {
        const name = m[1] ?? m[2] ?? m[3];
        if (name !== undefined && name !== "") emit(name, "$ execute_skill");
      }
    }
  });
  return out;
}

function extractVarRefs(op: SkillOp): string[] {
  const text = collectOpText(op);
  const re = /\$\(([^|)\s]+)(?:\s*\|\s*[A-Za-z_]\w*)?\)/g;
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) refs.push(m[1]!);
  return refs;
}

function extractVarRefsWithFilter(op: SkillOp): Array<{ name: string; filter?: string }> {
  const text = collectOpText(op);
  const re = /\$\(([^|)\s]+)(?:\s*\|\s*([A-Za-z_]\w*))?\)/g;
  const out: Array<{ name: string; filter?: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const entry: { name: string; filter?: string } = { name: m[1]! };
    if (m[2] !== undefined) entry.filter = m[2];
    out.push(entry);
  }
  return out;
}

function collectOpText(op: SkillOp): string {
  let text = op.body;
  if (op.retrievalParams !== undefined) {
    text += " " + op.retrievalParams.query + " " + Object.values(op.retrievalParams.extra).join(" ");
  }
  if (op.localModelParams !== undefined) text += " " + op.localModelParams.prompt;
  if (op.setValue !== undefined) text += " " + op.setValue;
  if (op.foreachList !== undefined) text += " " + op.foreachList;
  return text;
}

/** Walk surrounding `foreach` scopes to see if `varName` is an iterator currently in scope at `op`. Conservative: walks the parent ops tree. */
function isLoopIterInScope(allOps: SkillOp[], target: SkillOp, varName: string): boolean {
  function check(ops: SkillOp[]): boolean {
    for (const op of ops) {
      if (op === target) return false;
      if (op.kind === "foreach" && op.foreachIter === varName) {
        if (op.foreachBody !== undefined && containsOp(op.foreachBody, target)) return true;
      }
      if (op.foreachBody !== undefined && check(op.foreachBody)) return true;
      if (op.ifBranches !== undefined) {
        for (const b of op.ifBranches) if (check(b.body)) return true;
      }
      if (op.ifElseBody !== undefined && check(op.ifElseBody)) return true;
    }
    return false;
  }
  return check(allOps);
}

function containsOp(ops: SkillOp[], target: SkillOp): boolean {
  for (const op of ops) {
    if (op === target) return true;
    if (op.foreachBody !== undefined && containsOp(op.foreachBody, target)) return true;
    if (op.ifBranches !== undefined) {
      for (const b of op.ifBranches) if (containsOp(b.body, target)) return true;
    }
    if (op.ifElseBody !== undefined && containsOp(op.ifElseBody, target)) return true;
  }
  return false;
}

// ─── Capability helpers (shared with the unknown-capability rule) ──────────

function collectClassesFromRegistry(
  registry: Registry | undefined,
): Array<{ staticCapabilities(): StaticCapabilities }> | null {
  if (registry === undefined) return null;
  return [
    ...registry.listSkillStoreClasses(),
    ...registry.listMemoryStoreClasses(),
    ...registry.listLocalModelClasses(),
    ...registry.listMcpConnectorClasses(),
  ];
}

function buildFeatureSet(
  classes: Array<{ staticCapabilities(): StaticCapabilities }>,
): Set<string> {
  const provided = new Set<string>();
  for (const Ctor of classes) {
    const caps = Ctor.staticCapabilities();
    for (const [flag, value] of Object.entries(caps.features)) {
      if (value === true) provided.add(`${caps.connector_type}.${flag}`);
    }
  }
  return provided;
}
