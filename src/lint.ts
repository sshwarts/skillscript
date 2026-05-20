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
}

interface LintContext {
  parsed: ParsedSkill;
  capabilityClasses: Array<{ staticCapabilities(): StaticCapabilities }> | null;
  skillStore: SkillStore | undefined;
  hasSkillStore: boolean;
  callSite: "cli" | "api" | "compile-preflight";
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

const UNDECLARED_VAR: LintRule = {
  id: "undeclared-var",
  severity: "error",
  description: "An op body references `$(NAME)` for a variable that's not declared in `# Vars:`/`# Requires:`, not output-bound by any op anywhere in the skill, and not a foreach iterator in scope.",
  remediation: "Add the variable to `# Vars:` or `# Requires:`, or check the spelling against the declared variable list.",
  check: (ctx) => {
    const declared = new Set<string>();
    for (const v of ctx.parsed.vars) declared.add(v.name);
    for (const r of ctx.parsed.requires) declared.add(r.target);
    // Collect output-bound vars across the whole skill — once bound by any
    // target's $set / -> outputVar / foreach iterator, the var is available
    // for substitution downstream. The runtime walks targets in topo-sort;
    // by the time a downstream target executes, earlier targets' bindings
    // have populated `vars`.
    for (const target of ctx.parsed.targets.values()) {
      walkOps(target.ops, (op) => {
        if (op.setName !== undefined) declared.add(op.setName);
        if (op.outputVar !== undefined) declared.add(op.outputVar);
        if (op.foreachIter !== undefined) declared.add(op.foreachIter);
      });
    }
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      const reported = new Set<string>(); // dedupe per target
      for (const op of target.ops) {
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

const UNKNOWN_SKILL_REFERENCE: LintRule = {
  id: "unknown-skill-reference",
  severity: "error",
  description: "An `&` op references a skill that's not present in the configured SkillStore.",
  remediation: "Check the skill name spelling, or store the missing skill before referencing it. If the reference is intentional and the skill will be added later, defer compile until it exists.",
  check: async (ctx) => {
    if (ctx.skillStore === undefined) return [];
    const findings: LintFinding[] = [];
    const seen = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      for (const refName of collectAmpRefsFromOps(target.ops)) {
        if (seen.has(refName)) continue;
        seen.add(refName);
        try {
          await ctx.skillStore.metadata(refName);
        } catch {
          findings.push({
            rule: "unknown-skill-reference",
            severity: "error",
            message: `Skill '${targetName}' references skill '${refName}' via \`&\`, but the SkillStore has no skill by that name.`,
            block: targetName,
            extras: { referenced_skill: refName },
          });
        }
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
      for (const refName of collectAmpRefsFromOps(target.ops)) {
        if (checked.has(refName)) continue;
        checked.add(refName);
        try {
          const meta = await ctx.skillStore.metadata(refName);
          if (meta.status === "disabled") {
            findings.push({
              rule: "disabled-skill-reference",
              severity: "error",
              message: `Skill '${targetName}' references '${refName}' which is disabled.`,
              block: targetName,
              extras: { referenced_skill: refName, target_status: meta.status },
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
  description: "The skill being compiled is `# Status: disabled`. Disabled skills don't compile.",
  remediation: "Transition the skill to `approved` or `draft` via `update_status` before compiling, or revisit whether the skill should be disabled.",
  check: (ctx) => {
    if (ctx.parsed.status !== "disabled") return [];
    return [{
      rule: "status-disabled",
      severity: "error",
      message: `Skill '${ctx.parsed.name ?? "(unnamed)"}' is \`# Status: disabled\` and cannot be compiled.`,
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

const UNSAFE_SHELL_OP: LintRule = {
  id: "unsafe-shell-op",
  severity: "warning",
  description: "Skill uses `@@` (opt-in unsafe shell execution). Requires human review.",
  remediation: "Confirm the operator deployment has `runtime.enable_unsafe_shell = true` and the shell content is reviewed. Prefer `@` (echo-only, no exec) when possible.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        // `@@` isn't yet a distinct op-kind in the v1 parser; detected via
        // raw body inspection of `@` ops whose body starts with the second @.
        if (op.kind === "@" && op.body.startsWith("@")) {
          findings.push({
            rule: "unsafe-shell-op",
            severity: "warning",
            message: `\`@@\` shell op in target '${targetName}': '${op.body.slice(0, 60)}...'`,
            block: targetName,
          });
        }
      });
    }
    return findings;
  },
};

/** Tool-name patterns that strongly suggest mutating operations. Conservative — false positives are tolerable for warnings; false negatives are dangerous. */
const MUTATING_TOOL_PATTERN = /^(?:write_|update_|delete_|remove_|set_|create_|insert_|put_|patch_|destroy_).*/;

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
  description: "Skill has `# Status: draft` but declares triggers. Draft skills shouldn't be fire-able autonomously.",
  remediation: "Promote to `approved` once tested, or remove the trigger declarations until the skill is ready.",
  check: (ctx) => {
    if (ctx.parsed.status !== "draft" || ctx.parsed.triggers.length === 0) return [];
    return [{
      rule: "draft-with-trigger",
      severity: "warning",
      message: `Skill is \`# Status: draft\` but declares ${ctx.parsed.triggers.length} trigger(s). Draft skills won't fire — promote or drop the triggers.`,
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
      for (const refName of collectAmpRefsFromOps(target.ops)) {
        if (checked.has(refName)) continue;
        checked.add(refName);
        try {
          const meta = await ctx.skillStore.metadata(refName);
          if (meta.status === "disabled") {
            findings.push({
              rule: "reference-to-disabled-skill",
              severity: "warning",
              message: `Target '${targetName}' references '${refName}' which is disabled.`,
              block: targetName,
              extras: { referenced_skill: refName },
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
  UNKNOWN_SKILL_REFERENCE,
  DISABLED_SKILL_REFERENCE,
  CREDENTIAL_IN_ARGS,
  STATUS_DISABLED,
  CIRCULAR_DEPENDENCY,
  MISSING_DEPENDENCY,
  MISSING_SKILLSTORE_FOR_DATA_REF,
  // Tier-2 (warning)
  UNSAFE_SHELL_OP,
  UNCONFIRMED_MUTATION,
  MODEL_CONTENTION,
  DRAFT_WITH_TRIGGER,
  REFERENCE_TO_DISABLED_SKILL,
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

function collectAmpRefsFromOps(ops: SkillOp[]): Set<string> {
  const out = new Set<string>();
  walkOps(ops, (op) => {
    if (op.kind === "&" && op.ampParams !== undefined) out.add(op.ampParams.skillName);
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
