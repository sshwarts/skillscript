import { parse, tokenizeKeywordArgs, type ParsedSkill, type SkillOp } from "./parser.js";
import { classifyMutation, authorizationGranted, type MutationAuthState } from "./mutation-gate.js";
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
  /**
   * Names of registered MCP connector instances (v0.4.0). When provided,
   * `unknown-connector` lint rule fires tier-1 on `$ name.tool` refs to
   * names not in the list. When undefined, the rule is silent (caller
   * doesn't know what's wired). Derived from `registry` if only the
   * registry is provided.
   */
  mcpConnectorNames?: string[];
  /**
   * Per-connector tool allowlists (v0.4.1). Map of connector name to
   * the list of tool names that connector permits. `disallowed-tool`
   * lint fires tier-1 on `$ name.tool` where `tool` isn't in the list.
   * Connectors not in this map (or with `undefined` value) are treated
   * as allow-all. Derived from `registry` when only the registry is
   * provided.
   */
  mcpConnectorAllowedTools?: Map<string, string[]>;
  /**
   * Errors from `connectors.json` load pass (v0.4.0). When provided,
   * `unknown-connector-class` lint rule re-surfaces the subset of these
   * about unknown class names so cold-author tooling sees them through
   * the lint API. Other config errors flow through `parse-error`-style
   * surfacing in the bootstrap result.
   */
  connectorConfigErrors?: string[];
  /** v0.8.0 — registered AgentConnector names (empty = none wired). */
  agentConnectorNames?: string[];
  /**
   * v0.16.4 — registered LocalModel alias names (the names skills target
   * via `$ llm model="<alias>"`). Plus the union of `models_available`
   * across every registered LocalModel's `manifest()` payload — substrate-
   * aware typo-catch. When both are undefined (caller didn't supply data),
   * `unknown-llm-model` is silent.
   *
   * Derived from `registry` when only the registry is provided AND the
   * caller uses the async `lint()` entry point. `lintSync()` derives only
   * `localModelAliases` (sync probe of registry list); `localModelsAvailable`
   * stays undefined since `manifest()` is async.
   */
  localModelAliases?: string[];
  localModelsAvailable?: string[];
  /**
   * v0.16.8 — tool names that return bare arrays (not envelope-wrapped).
   * When `foreach IT in ${VAR}` iterates a bare `$ <tool>` op output whose
   * tool name is in this list, the `object-iteration-advisory` suppresses
   * (the bare-iteration is correct for these tools). Default `[]` —
   * substrate-neutral. Adopters configure per their MCP ecosystem
   * (substrate-specific tool names belong at the adopter layer, not in
   * bundled runtime defaults — per the source-reader-signal discipline).
   *
   * Per warm-adopter dogfood finding `c497b479`: the advisory was firing
   * false-positives against bare-array-returning MCP tools, and its
   * prescriptive `.items` suggestion produced runtime failures when
   * authors trusted it. Wording softened independently (`.items`
   * suggestion removed); this list is the explicit opt-out for adopters
   * whose tools genuinely return bare arrays.
   */
  bareArrayReturnTools?: string[];
  /**
   * v0.18.8 — operator's shell binary allowlist. When set, the
   * `shell-binary-not-allowed` rule fires tier-1 errors on any
   * `shell(command="X ...")` whose first token isn't in the list.
   *
   * **Lint = local advisory; runtime = authoritative.** The allowlist
   * lint checks against here is the AUTHOR's environment, which may
   * differ from production. Passing lint does NOT guarantee the call
   * will run — the production runtime gate is the authoritative
   * boundary. Per Perry's framing (thread `7aab6f3f`): immediate
   * author feedback at compile-time, defense-in-depth with runtime.
   *
   * Undefined → lint skips this rule (no allowlist context); the
   * runtime still default-denies at execution. This split lets adopter
   * tooling lint with the production allowlist when known (CI pipelines
   * loading the deployment's .env) while authoring tools can lint
   * permissively without false-positive noise.
   */
  shellAllowlist?: string[];
}

interface LintContext {
  parsed: ParsedSkill;
  /** v0.9.4 — raw source as fed to lint(). Some rules (skill-name-collision)
   *  need to compare against stored bodies to avoid false positives on re-lints. */
  source: string;
  capabilityClasses: Array<{ staticCapabilities(): StaticCapabilities }> | null;
  skillStore: SkillStore | undefined;
  hasSkillStore: boolean;
  callSite: "cli" | "api" | "compile-preflight";
  enableUnsafeShell: boolean | undefined;
  mcpConnectorNames: string[] | undefined;
  connectorConfigErrors: string[];
  mcpConnectorAllowedTools: Map<string, string[]>;
  agentConnectorNames: string[] | undefined;
  localModelAliases: string[] | undefined;
  localModelsAvailable: string[] | undefined;
  bareArrayReturnTools: string[];
  /**
   * v0.18.8 — operator shell binary allowlist (see `LintOptions.shellAllowlist`).
   * Undefined when not supplied — the `shell-binary-not-allowed` rule
   * skips its check in that case (runtime still default-denies).
   */
  shellAllowlist: string[] | undefined;
  /**
   * v0.9.1 — per-connector declared tool surface from `McpConnectorClass.staticTools()`.
   * Map entry: connector name → tool array (declared surface) OR null (class doesn't
   * expose static surface, e.g., RemoteMcpConnector). Missing entry means
   * connector isn't wired. Used by `validateQualifiedDispatch` to catch
   * `$ ref.unknown_tool` at lint time (P0.1 fix).
   */
  mcpConnectorStaticTools: Map<string, string[] | null>;
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
  const localModelInfo = options?.localModelAliases !== undefined
    ? { aliases: options.localModelAliases, modelsAvailable: options.localModelsAvailable ?? [] }
    : await collectLocalModelInfoFromRegistry(options?.registry);
  const ctx: LintContext = {
    parsed,
    source,
    capabilityClasses: options?.classes ?? collectClassesFromRegistry(options?.registry),
    skillStore: options?.skillStore,
    hasSkillStore: options?.skillStore !== undefined,
    callSite: options?.callSite ?? "api",
    enableUnsafeShell: options?.enableUnsafeShell,
    mcpConnectorNames: options?.mcpConnectorNames ?? collectMcpConnectorNamesFromRegistry(options?.registry),
    connectorConfigErrors: options?.connectorConfigErrors ?? [],
    mcpConnectorAllowedTools: options?.mcpConnectorAllowedTools ?? collectMcpConnectorAllowedToolsFromRegistry(options?.registry),
    agentConnectorNames: options?.agentConnectorNames ?? collectAgentConnectorNamesFromRegistry(options?.registry),
    localModelAliases: localModelInfo?.aliases,
    localModelsAvailable: localModelInfo?.modelsAvailable,
    bareArrayReturnTools: options?.bareArrayReturnTools ?? [],
    shellAllowlist: options?.shellAllowlist,
    mcpConnectorStaticTools: collectMcpConnectorStaticToolsFromRegistry(options?.registry),
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
    source,
    capabilityClasses: options?.classes ?? collectClassesFromRegistry(options?.registry),
    skillStore: options?.skillStore,
    hasSkillStore: options?.skillStore !== undefined,
    callSite: options?.callSite ?? "api",
    enableUnsafeShell: options?.enableUnsafeShell,
    mcpConnectorNames: options?.mcpConnectorNames ?? collectMcpConnectorNamesFromRegistry(options?.registry),
    connectorConfigErrors: options?.connectorConfigErrors ?? [],
    mcpConnectorAllowedTools: options?.mcpConnectorAllowedTools ?? collectMcpConnectorAllowedToolsFromRegistry(options?.registry),
    agentConnectorNames: options?.agentConnectorNames ?? collectAgentConnectorNamesFromRegistry(options?.registry),
    localModelAliases: options?.localModelAliases ?? collectLocalModelAliasesFromRegistry(options?.registry),
    localModelsAvailable: options?.localModelsAvailable,
    bareArrayReturnTools: options?.bareArrayReturnTools ?? [],
    shellAllowlist: options?.shellAllowlist,
    mcpConnectorStaticTools: collectMcpConnectorStaticToolsFromRegistry(options?.registry),
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
  description: "Any syntax error collected by the parser (catch-all for shapes not owned by a more specific tier-1 rule).",
  remediation: "Fix the grammar error per the message. Check op syntax, header form, indent levels.",
  check: (ctx) => ctx.parsed.parseErrors
    // v0.3.4: skip messages a more specific tier-1 rule already owns —
    // pre-fix both this rule and the specific one fired identical bodies,
    // doubling noise. Each pattern below mirrors the corresponding tier-1
    // rule's filter regex; PARSE_ERROR stays catch-all for unowned shapes
    // (header issues, foreach/needs malformed, etc.).
    //
    // Owning rules:
    //   invalid-conditional-syntax → Unsupported condition
    //   single-equals              → `=` is not valid in a condition
    //   malformed-op-grammar       → Malformed `<op>`
    //   reserved-keyword           → is a reserved keyword
    //   indentation                → Tab characters / Mid-block indent change
    .filter((msg) => !/Unsupported condition|`=` is not valid in a condition|Malformed `[~>&$@!?]|is a reserved keyword|Tab characters in indentation|Mid-block indent change/.test(msg))
    .map((msg) => ({
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
        // Unsafe `shell` ops use bash `$(...)` syntax — handled by
        // unsafe-shell-ambiguous-subst, which offers the dual rewrite
        // (`$$(NAME)` for bash, `$(KNOWN_VAR)` for skillscript). Skip here
        // to avoid double-reporting.
        if (op.kind === "shell" && op.policy === "unsafe") continue;
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

// v0.17.3 — `# Returns: X, Y` where X (or Y) isn't bound anywhere in the
// skill body. Tier-1: an undeclared export is structurally broken — the
// skill claims to return something it never sets. Same shape as
// `undeclared-var` but checked against the export-surface side. Per
// Perry's `1ea3d625` Finding 2 + skillscript's `6fb6ac1c` empirical
// pre-flight; the lint enforces the function-signature contract at
// author time so the runtime-side Returns-filter doesn't silently
// produce an absent value.
const UNKNOWN_RETURNS_REF: LintRule = {
  id: "unknown-returns-ref",
  severity: "error",
  description: "A name in `# Returns:` isn't bound anywhere in the skill body — not declared in `# Vars:`/`# Requires:`, not output-bound by any op, not a foreach iterator. The skill declares an export it never produces.",
  remediation: "Bind the variable with `$set`, `-> VAR` on an op, a foreach iterator, or declare it in `# Vars:`/`# Requires:`. Or remove the name from `# Returns:` if it shouldn't be exported.",
  check: (ctx) => {
    if (ctx.parsed.returns.length === 0) return [];
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
      if (target.elseBlock !== undefined) walkOps(target.elseBlock, collect);
    }
    const findings: LintFinding[] = [];
    for (const name of ctx.parsed.returns) {
      if (declared.has(name)) continue;
      findings.push({
        rule: "unknown-returns-ref",
        severity: "error",
        message: `\`# Returns: ${name}\` — '${name}' isn't bound anywhere in the skill body. Bind it with \`$set ${name} = ...\` / \`-> ${name}\` on an op / a foreach iterator / \`# Vars: ${name}=...\`, or remove it from \`# Returns:\`.`,
        block: "(frontmatter)",
        extras: { referenced_name: name },
      });
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
  remediation: "Check the op's syntax against the language reference. `$ tool key=value ... -> VAR` for MCP dispatch; `verb(kwarg=value, ...) [-> VAR]` for runtime intrinsics.",
  check: (ctx) => ctx.parsed.parseErrors
    .filter((msg) => /Malformed `\$|Malformed function-call|Legacy `[~>&@!?]/.test(msg))
    .map((msg) => ({
      rule: "malformed-op-grammar",
      severity: "error" as const,
      message: msg,
    })),
};

const INVALID_CONDITIONAL_SYNTAX: LintRule = {
  id: "invalid-conditional-syntax",
  severity: "error",
  description: "An `if:` / `elif:` condition uses syntax outside the supported grammar.",
  remediation: "Use a supported shape: truthy `$(REF)`; `$(REF) ==/!=/</>/<=/>= \"literal\"` or `$(REF) ==/!=/</>/<=/>= $(REF)`; `$(REF) (not) in $(REF)`; composable with `and` / `or` / `not` and parens. Filters + dotted-field allowed inside `$(REF)`. For field access on parsed JSON, use `$ json_parse $(VAR) -> P` then `$(P.field)`.",
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
// execute time. v0.9.4.1: paired `deferred-skill-reference` advisory
// removed — the warning's remediation already explains the forward-ref
// path; the second finding was just noise (per Perry's `77ed6c65`
// "4 diagnostics for 2 missing skills" cold-author finding).
const UNKNOWN_SKILL_REFERENCE: LintRule = {
  id: "unknown-skill-reference",
  severity: "warning",
  description: "An `&` or `$ execute_skill` op references a skill that's not present in the configured SkillStore. Lint warning (not error) since v0.3.1 — runtime throws `SkillNotFoundError` if still missing at execute time. Dedup is per-missing-skill, not per-call-site (v0.9.4.1).",
  remediation: "If this is a typo, fix the spelling against your declarations. If it's a forward reference to a skill you'll author next, this warning clears once the skill is stored. The runtime will throw `SkillNotFoundError` at execute time if the skill is still missing.",
  check: async (ctx) => {
    if (ctx.skillStore === undefined) return [];
    const findings: LintFinding[] = [];
    // v0.9.4.1 — dedup by skill name (not via:name) so one missing skill
    // referenced via both `&` and `$ execute_skill` (or from multiple
    // targets) produces one diagnostic, not N. Per Perry's `77ed6c65`
    // next-ring finding: "4 diagnostics for 2 missing skills" — the via
    // and target list now folds into a single message.
    const byName = new Map<string, { vias: Set<string>; firstTarget: string }>();
    for (const [targetName, target] of ctx.parsed.targets) {
      for (const ref of collectAmpRefsFromOps(target.ops)) {
        const entry = byName.get(ref.name);
        if (entry === undefined) byName.set(ref.name, { vias: new Set([ref.via]), firstTarget: targetName });
        else entry.vias.add(ref.via);
      }
    }
    for (const [name, { vias, firstTarget }] of byName) {
      try {
        await ctx.skillStore.metadata(name);
      } catch {
        const viaList = Array.from(vias).map((v) => `\`${v}\``).join(" / ");
        findings.push({
          rule: "unknown-skill-reference",
          severity: "warning",
          message: `Skill '${name}' is referenced via ${viaList} (first seen in target '${firstTarget}'), but the SkillStore has no skill by that name.`,
          block: firstTarget,
          extras: { referenced_skill: name, vias: Array.from(vias) },
        });
      }
    }
    return findings;
  },
};

// v0.4.0 — `$ name.tool` references a connector name not registered.
// `connectorNames` is the authoritative list from the Registry (passed
// through LintOptions); when undefined (caller doesn't know what's
// wired) the rule is silent rather than risk false positives.
const UNKNOWN_CONNECTOR: LintRule = {
  id: "unknown-connector",
  severity: "error",
  description: "A `$ name.tool` op references a connector name that's not registered. Either the name is misspelled or `connectors.json` is missing an entry.",
  remediation: "Check the connector name against `connectors.json` (or whatever wired the registry). Either fix the spelling or add the entry. `runtime_capabilities()` lists the names currently wired.",
  check: (ctx) => {
    if (ctx.mcpConnectorNames === undefined) return [];
    const known = new Set(ctx.mcpConnectorNames);
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "$" || op.mcpConnector === undefined) return;
        const ref = op.mcpConnector;
        if (known.has(ref)) return;
        const key = `${targetName}:${ref}`;
        if (reported.has(key)) return;
        reported.add(key);
        findings.push({
          rule: "unknown-connector",
          severity: "error",
          message: `\`$ ${ref}.<tool>\` in target '${targetName}' references unknown connector '${ref}'. Wired connectors: ${known.size === 0 ? "(none)" : [...known].join(", ")}.`,
          block: targetName,
          extras: { referenced_connector: ref },
        });
      });
    }
    return findings;
  },
};

// v0.16.4 — `$ llm prompt="..." model="X"` where X matches neither any
// registered LocalModel alias name NOR any `models_available` entry from
// any registered LocalModel's `manifest()` payload. Tier-2 warning.
//
// Closes the documented-but-unenforced surface from v0.16.2 (the `model=`
// kwarg shipped working at runtime but a typo like `model="qwen2.5"` —
// intending the upstream Ollama tag `qwen2.5:7b` or the alias `qwen` —
// would silently fall through to the default model). With v0.16.3
// putting `manifest()` in `runtime_capabilities`, the lint now has
// substrate-aware source of truth: both alias names AND each registered
// LocalModel's underlying model surface participate in the typo-catch.
//
// Silent unless context carries the data — `lint()` without a `registry`
// or explicit `localModelAliases` cannot validate. Variable-substituted
// values (`model="${TAG}"`) are skipped — the literal isn't a model
// identifier at compile time.
const UNKNOWN_LLM_MODEL: LintRule = {
  id: "unknown-llm-model",
  severity: "warning",
  description: "A `$ llm` op carries `model=\"X\"` where X is neither a registered LocalModel alias nor a model in any registered LocalModel's `models_available` manifest field.",
  remediation: "Check the model name against the runtime's registered LocalModels — `runtime_capabilities()` lists every alias plus each instance's `manifest.models_available`. Either fix the typo, register the model under a runtime alias (e.g., `registry.registerLocalModel(\"<alias>\", <instance>)`), or wrap the value in a substitution if it's resolved at runtime.",
  check: (ctx) => {
    if (ctx.localModelAliases === undefined) return [];
    const known = new Set<string>(ctx.localModelAliases);
    if (ctx.localModelsAvailable !== undefined) {
      for (const m of ctx.localModelsAvailable) known.add(m);
    }
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "$") return;
        // Bare-form `$ llm ...` puts `llm` as the first token of op.body
        // with op.mcpConnector === undefined. Named-form `$ llm.run ...`
        // would set op.mcpConnector === "llm" — match either.
        const tokens = tokenizeKeywordArgs(op.body);
        const head = tokens[0];
        const isLlmDispatch =
          op.mcpConnector === "llm" || (head === "llm" && op.mcpConnector === undefined);
        if (!isLlmDispatch) return;
        for (const tok of tokens) {
          const eq = tok.indexOf("=");
          if (eq === -1) continue;
          const key = tok.slice(0, eq).trim();
          if (key !== "model") continue;
          let value = tok.slice(eq + 1).trim();
          // Strip outer quotes if present.
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (value === "") continue;
          // Substitutions — `${TAG}` / `$(TAG)` — are runtime-resolved.
          if (value.includes("$(") || value.includes("${")) continue;
          if (known.has(value)) continue;
          const dedupKey = `${targetName}:${value}`;
          if (reported.has(dedupKey)) continue;
          reported.add(dedupKey);
          const knownDescr = known.size === 0
            ? "(no LocalModels registered)"
            : [...known].sort().join(", ");
          findings.push({
            rule: "unknown-llm-model",
            severity: "warning",
            message: `\`$ llm model="${value}"\` in target '${targetName}': '${value}' matches no registered LocalModel alias and no \`models_available\` entry from any registered LocalModel. Known: ${knownDescr}.`,
            block: targetName,
            extras: { referenced_model: value },
          });
        }
      });
    }
    return findings;
  },
};

// v0.16.5 — `$ llm` op with a kwarg outside the canonical closed set.
// Catches authors leaking provider-API kwargs (e.g., `temperature=0.7`)
// which the LocalModelMcpConnector bridge silently drops — LocalModel.run()
// only consumes `{maxTokens, model}`. Tier-2 warning.
//
// Sibling to `unknown-llm-model` (v0.16.4) — same shape, different axis.
// The `model=` axis validates a value against registered substrate state;
// this rule validates a kwarg KEY against the documented closed surface.
//
// Per memory `9254a648`. Closed set lives in `LLM_KWARG_SURFACE`.
const LLM_KWARG_SURFACE = new Set([
  "prompt",
  "maxTokens",
  "model",
  "timeout",
  "approved",
  "fallback",
]);

const UNKNOWN_LLM_ARG: LintRule = {
  id: "unknown-llm-arg",
  severity: "warning",
  description: "A `$ llm` op carries a kwarg outside the canonical surface (`prompt`/`maxTokens`/`model`/`timeout`/`approved`/`fallback`). Provider-API kwargs (e.g., `temperature=`) silently dropped by the bridge.",
  remediation: "Drop the kwarg, or substitute the canonical equivalent. The closed surface is documented under `$ llm` in the language reference. If your substrate accepts additional kwargs, configure them at the LocalModel adapter layer (e.g., construct an OpenAILocalModel with `defaultTemperature: 0.7`) — kwargs from the skill body must match the substrate-neutral contract.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "$") return;
        const tokens = tokenizeKeywordArgs(op.body);
        const head = tokens[0];
        const isLlmDispatch =
          op.mcpConnector === "llm" || (head === "llm" && op.mcpConnector === undefined);
        if (!isLlmDispatch) return;
        for (const tok of tokens) {
          const eq = tok.indexOf("=");
          if (eq === -1) continue;
          const key = tok.slice(0, eq).trim();
          if (LLM_KWARG_SURFACE.has(key)) continue;
          const dedupKey = `${targetName}:${key}`;
          if (reported.has(dedupKey)) continue;
          reported.add(dedupKey);
          findings.push({
            rule: "unknown-llm-arg",
            severity: "warning",
            message: `\`$ llm\` in target '${targetName}' carries unknown kwarg '${key}'. Canonical surface: ${[...LLM_KWARG_SURFACE].sort().join(", ")}.`,
            block: targetName,
            extras: { kwarg: key },
          });
        }
      });
    }
    return findings;
  },
};

// v0.16.5 — `$ data_read` op with a kwarg outside the canonical closed
// set. Replaces the deleted `unknown-retrieval-arg` rule which targeted
// the v0.7.0-removed `>` symbol op surface. Same shape as `unknown-llm-arg`.
// Per memory `9254a648`.
const DATA_READ_KWARG_SURFACE = new Set([
  "mode",
  "query",
  "limit",
  "connector",
  "fallback",
  "domain_tags",
  "filters",
  "min_confidence",
]);

const UNKNOWN_DATA_READ_ARG: LintRule = {
  id: "unknown-data-read-arg",
  severity: "warning",
  description: "A `$ data_read` op carries a kwarg outside the canonical surface (`mode`/`query`/`limit`/`connector`/`fallback`/`domain_tags`/`filters`/`min_confidence`).",
  remediation: "Drop the kwarg, or substitute the canonical equivalent. The closed surface is documented under `$ data_read` in the language reference. Substrate-specific filters belong inside the `filters={...}` object literal, not as top-level kwargs.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "$") return;
        const tokens = tokenizeKeywordArgs(op.body);
        const head = tokens[0];
        const isDataReadDispatch =
          op.mcpConnector === "data_read" || (head === "data_read" && op.mcpConnector === undefined);
        if (!isDataReadDispatch) return;
        for (const tok of tokens) {
          const eq = tok.indexOf("=");
          if (eq === -1) continue;
          const key = tok.slice(0, eq).trim();
          if (DATA_READ_KWARG_SURFACE.has(key)) continue;
          const dedupKey = `${targetName}:${key}`;
          if (reported.has(dedupKey)) continue;
          reported.add(dedupKey);
          findings.push({
            rule: "unknown-data-read-arg",
            severity: "warning",
            message: `\`$ data_read\` in target '${targetName}' carries unknown kwarg '${key}'. Canonical surface: ${[...DATA_READ_KWARG_SURFACE].sort().join(", ")}.`,
            block: targetName,
            extras: { kwarg: key },
          });
        }
      });
    }
    return findings;
  },
};

// v0.4.1 — `$ name.tool` where `name` is configured with an
// `allowed_tools` list that doesn't include `tool`. Tier-1 lint error
// at compile time. Closes the "minion-safe by default" framing from
// Perry's amendment 8a7356dc.
const DISALLOWED_TOOL: LintRule = {
  id: "disallowed-tool",
  severity: "error",
  description: "A `$ name.tool` op references a tool not permitted by the connector's `allowed_tools` allowlist.",
  remediation: "Either rewrite the skill to use a tool that's in the allowlist, or update `connectors.json` to grant access. The runtime refuses disallowed dispatch even if lint is bypassed (defense-in-depth).",
  check: (ctx) => {
    if (ctx.mcpConnectorAllowedTools.size === 0) return [];
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "$" || op.mcpConnector === undefined) return;
        const ref = op.mcpConnector;
        const allowed = ctx.mcpConnectorAllowedTools.get(ref);
        if (allowed === undefined) return; // no allowlist → allow-all
        // Extract tool name from op.body — first token before whitespace.
        const m = /^([A-Za-z_][\w:-]*)/.exec(op.body);
        if (m === null) return;
        const toolName = m[1]!;
        if (allowed.includes(toolName)) return;
        const key = `${targetName}:${ref}:${toolName}`;
        if (reported.has(key)) return;
        reported.add(key);
        findings.push({
          rule: "disallowed-tool",
          severity: "error",
          message: `\`$ ${ref}.${toolName}\` in target '${targetName}' is not in the allowlist for connector '${ref}'. ${allowed.length === 0 ? "Allowlist is empty (connector configured but no tools permitted)." : `Allowed: ${allowed.join(", ")}.`} Either rewrite or grant access in connectors.json.`,
          block: targetName,
          extras: { connector: ref, tool: toolName, allowed },
        });
      });
    }
    return findings;
  },
};

// v0.9.1 — `$ ref.tool` where `ref` is wired AND `allowed_tools` doesn't
// exclude `tool` AND the connector class declares its static tool surface
// AND `tool` is NOT in that declared surface. Tier-1 error.
//
// Closes the v0.9.0 multi-layer-promise recurrence (third in the
// v0.7.2→v0.7.3→v0.9.0 series). Before v0.9.1, `disallowed-tool` only
// fired when an explicit allow-list was configured; connectors with
// `allowed_tools: undefined` (allow-all) green-lit any qualified tool
// name. Runtime then failed downstream with misleading kwarg errors.
//
// The fix: connectors that ship with a closed static tool surface
// (LocalModelMcpConnector → ["prompt"], DataStoreMcpConnector →
// ["query", "data_write"]) declare it via `staticTools()`; lint
// validates qualified dispatches against that surface.
//
// Connectors WITHOUT a declared static surface (RemoteMcpConnector,
// adopter classes) emit the tier-3 `unverified-qualified-tool`
// advisory instead — see UNVERIFIED_QUALIFIED_TOOL below.
const UNKNOWN_TOOL_ON_CONNECTOR: LintRule = {
  id: "unknown-tool-on-connector",
  severity: "error",
  description: "A qualified `$ ref.tool` op references a tool not declared on the connector class's static surface.",
  remediation: "Use a tool from the connector's declared list (see `runtime_capabilities()` for the wired connector and its class). If the tool genuinely exists on the connector but isn't in the static list, that's a connector-class bug — file as such; for now use bare-form `$ tool ...` if the name-match dispatch reaches the right connector.",
  check: (ctx) => {
    if (ctx.mcpConnectorStaticTools.size === 0) return [];
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "$" || op.mcpConnector === undefined) return;
        const ref = op.mcpConnector;
        const declared = ctx.mcpConnectorStaticTools.get(ref);
        if (declared === undefined || declared === null) return; // no info; UNVERIFIED rule handles
        const m = /^([A-Za-z_][\w:-]*)/.exec(op.body);
        if (m === null) return;
        const toolName = m[1]!;
        if (declared.includes(toolName)) return;
        // If an `allowed_tools` allowlist excludes the tool, `disallowed-tool`
        // already fires — avoid double-reporting.
        const allowed = ctx.mcpConnectorAllowedTools.get(ref);
        if (allowed !== undefined && !allowed.includes(toolName)) return;
        const key = `${targetName}:${ref}:${toolName}`;
        if (reported.has(key)) return;
        reported.add(key);
        findings.push({
          rule: "unknown-tool-on-connector",
          severity: "error",
          message: `\`$ ${ref}.${toolName}\` in target '${targetName}' — tool '${toolName}' is not declared on connector '${ref}'. Declared tools: ${declared.length === 0 ? "(none)" : declared.join(", ")}. Use a declared tool, or wire a different connector that supports '${toolName}'.`,
          block: targetName,
          extras: { connector: ref, tool: toolName, declared_tools: declared },
        });
      });
    }
    return findings;
  },
};

// v0.9.1 — tier-3 advisory for qualified dispatches against connectors
// whose class doesn't declare a static tool surface. RemoteMcpConnector
// is the canonical case: it wraps an arbitrary upstream MCP server, so
// the tool list is only knowable at runtime via `tools/list`. Adopter
// classes that don't implement `staticTools()` land here too.
//
// Surfaces as `info` (advisory) — author sees the hint, can proceed if
// they know the tool exists. Pairs with the structural validateDispatch
// extraction; the runtime still dispatches, and if the tool is missing
// the connector-specific error surfaces at execute time.
const UNVERIFIED_QUALIFIED_TOOL: LintRule = {
  id: "unverified-qualified-tool",
  severity: "info",
  description: "A qualified `$ ref.tool` op against a connector class without a static tool surface — can't validate at compile time.",
  remediation: "Verify the tool exists on the connector before relying on this. RemoteMcpConnector adopters can use `runtime_capabilities()` to inspect the upstream `tools/list`; class authors can implement `staticTools()` to lift this validation into lint.",
  check: (ctx) => {
    if (ctx.mcpConnectorStaticTools.size === 0) return [];
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "$" || op.mcpConnector === undefined) return;
        const ref = op.mcpConnector;
        // null = wired but class doesn't expose; undefined = not wired (different rule)
        if (ctx.mcpConnectorStaticTools.get(ref) !== null) return;
        const m = /^([A-Za-z_][\w:-]*)/.exec(op.body);
        if (m === null) return;
        const toolName = m[1]!;
        const key = `${targetName}:${ref}:${toolName}`;
        if (reported.has(key)) return;
        reported.add(key);
        findings.push({
          rule: "unverified-qualified-tool",
          severity: "info",
          message: `\`$ ${ref}.${toolName}\` in target '${targetName}' — connector '${ref}' doesn't declare its tool surface statically; can't validate at compile time. Verify the tool exists on the connector; runtime will fail with a connector-specific error if it doesn't.`,
          block: targetName,
          extras: { connector: ref, tool: toolName },
        });
      });
    }
    return findings;
  },
};

// v0.5.0 item 5 — bare `$ TOOL` op (no connector prefix) when no
// `primary` connector is wired. Runtime now throws ConnectorNotFoundError
// instead of silent-stub (was: emitted "Would call tool X" + bound null,
// masking real misconfiguration). Lint surfaces the same diagnostic at
// compile time when the runtime registry is queryable.
//
// v0.7.3 — name-match-before-primary fix (matches the v0.7.2 runtime
// dispatch resolver). Bare `$ <name>` where `<name>` matches a wired
// connector name (e.g., the auto-wired `llm` + `memory` bridges) routes
// to that connector directly; the lint must mirror the runtime's
// resolution order or the bare-form canonical syntax fails at lint
// before reaching dispatch. Same lesson as the v0.7.2 push-blocker:
// multi-layer promises need every layer to match.
//
// False-positive guard: only fires when `mcpConnectorNames` is non-undefined
// (lint context has real registry info) — embedder contexts that don't
// expose the registry stay silent rather than risk noise on legitimate
// toolDispatch-only setups.
// v0.9.4.1 — fallback-aware demotion. When every call site for a (target, tool)
// pair carries an op-level `(fallback: ...)` trailer, demote the tier-1 error
// to advisory (info). Lint runs at authoring-time; `(fallback:)` is honored at
// dispatch-time, so the runtime is guarded even though the connector isn't
// wired here. Per Perry's `77ed6c65` next-ring finding: cold authors expect
// `(fallback:)` to suppress the tier-1 error (it didn't pre-v0.9.4.1), and
// the lint message didn't explain the layering. Now: if all sites have
// fallback → info with layering explanation; if any site lacks it → error
// (unchanged).
// v0.16.0 — bare-form `$ <tool>` is reserved for runtime-intrinsic ops + tools
// whose name name-matches a registered MCP connector (the typed-contract pattern,
// e.g. `$ llm prompt=...` dispatches to the `llm` connector). Substrate-specific
// MCP tool dispatch (e.g. `amp_olsen_task`) MUST use named form `$ <connector>.<tool>`
// — no more "primary fallback" leniency. Closes the discipline-only-contract gap
// where adopters wrote bare-form expecting `primary` and silent-failed on cron-fired
// paths when primary wasn't registered.
const BARE_FORM_INTRINSICS = new Set(["execute_skill", "json_parse"]);

const UNWIRED_PRIMARY_CONNECTOR: LintRule = {
  id: "unwired-primary-connector",
  severity: "error",
  description: "A bare `$ TOOL` op (no connector prefix) routes only to (a) a runtime-intrinsic op or (b) a wired connector whose name matches the op name. v0.16.0 removed the `primary` fallback — substrate-specific MCP tools require named form `$ <connector>.<tool>`.",
  remediation: "Use named form `$ <connector>.<tool>` for substrate-specific MCP dispatch (e.g., `$ amp.amp_olsen_task` instead of `$ amp_olsen_task`). Bare form is reserved for runtime intrinsics (`execute_skill`, `json_parse`) and typed-contract ops where the tool name matches a wired connector (e.g., `$ llm prompt=...` if `llm` is wired).",
  check: (ctx) => {
    if (ctx.mcpConnectorNames === undefined) return [];
    const findings: LintFinding[] = [];
    // Collect per (target, tool); track whether ALL call sites carry an op-level fallback.
    const groups = new Map<string, { targetName: string; toolName: string; allFallback: boolean }>();
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "$" || op.mcpConnector !== undefined) return;
        const m = /^([A-Za-z_][\w:-]*)/.exec(op.body);
        if (m === null) return;
        const toolName = m[1]!;
        if (BARE_FORM_INTRINSICS.has(toolName)) return;
        // Name-match: bare op name matches a wired connector → typed-contract
        // pattern (e.g., `$ llm` against wired `llm` connector). Runtime
        // dispatch resolver routes directly.
        if (ctx.mcpConnectorNames!.includes(toolName)) return;
        const key = `${targetName}:${toolName}`;
        const hasFallback = op.fallback !== undefined;
        const existing = groups.get(key);
        if (existing === undefined) {
          groups.set(key, { targetName, toolName, allFallback: hasFallback });
        } else if (!hasFallback) {
          existing.allFallback = false;
        }
      });
    }
    for (const { targetName, toolName, allFallback } of groups.values()) {
      const wired = ctx.mcpConnectorNames!.length === 0 ? "(none)" : ctx.mcpConnectorNames!.join(", ");
      if (allFallback) {
        findings.push({
          rule: "unwired-primary-connector",
          severity: "info",
          message: `\`$ ${toolName}\` in target '${targetName}': connector isn't wired (wired: ${wired}), but every call site declares \`(fallback: ...)\`. Tier-1 lint demoted — at runtime, the fallback value binds when the dispatch errors, so the skill keeps working without the real connector.`,
          block: targetName,
          extras: { tool: toolName, hasFallback: true },
        });
      } else {
        findings.push({
          rule: "unwired-primary-connector",
          severity: "error",
          message: `\`$ ${toolName}\` in target '${targetName}' is bare-form but '${toolName}' is not a runtime intrinsic AND doesn't match any wired MCP connector. Bare form is reserved for typed-contract / intrinsic ops. Use named form \`$ <connector>.${toolName}\` for substrate-specific MCP dispatch. Wired connectors: ${wired}.`,
          block: targetName,
          extras: { tool: toolName },
        });
      }
    }
    return findings;
  },
};

// v0.4.0 — `connectors.json` declares `class: "Foo"` where `Foo` is not
// in the closed-set class registry. The loader catches this at startup
// and surfaces via `connectorConfigErrors`; this rule re-surfaces the
// subset that's class-related into the lint diagnostic stream so cold-
// author tooling (compile_skill / lint_skill MCP) sees them.
const UNKNOWN_CONNECTOR_CLASS: LintRule = {
  id: "unknown-connector-class",
  severity: "error",
  description: "`connectors.json` references a connector class that's not in the closed-set class registry (v0.4.0).",
  remediation: "Use one of the known classes (see `runtime_capabilities()` for the list shipped in this runtime). Plugin-style runtime-arbitrary class loading is deliberately out of scope; future classes ship via CHANGELOG-tracked additions to the registry.",
  check: (ctx) => ctx.connectorConfigErrors
    .filter((msg) => /unknown connector class/.test(msg))
    .map((msg) => ({
      rule: "unknown-connector-class" as const,
      severity: "error" as const,
      message: msg,
    })),
};

// v0.3.1 → v0.9.4.1: `deferred-skill-reference` advisory removed. The
// paired unknown-skill-reference warning's remediation already covers the
// "this advisory clears once you store the skill" guidance; the second
// finding was just noise (Perry's `77ed6c65` — "4 diagnostics for 2
// missing skills"). Cold authors now see one warning per missing skill,
// not two.

// v0.3.3 — `|json_parse` filter removed; the shape `$(VAR|json_parse).field`
// is statically detectable. Fire a tier-3 advisory pointing at the new
// `$ json_parse $(VAR) -> P` op so authors who carried the v0.3.2 pattern
// forward get a direct remediation instead of the generic "unknown filter"
// error from applyFilter.
const UNPARSED_JSON_FIELD_ACCESS: LintRule = {
  id: "unparsed-json-field-access",
  severity: "info",
  description: "Op text contains `$(VAR|json_parse).field` — the `|json_parse` filter was removed in v0.3.3.",
  remediation: "Replace with `$ json_parse $(VAR) -> P` then access `$(P.field)`. The op binds the parsed structure so dotted descent works in conditions + emit. See help({topic: \"ops\"}).",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const BAD = /\$(?:\([^)]*\|\s*json_parse\s*\)|\{[^}]*\|\s*json_parse\s*\})\.([A-Za-z_]\w*)/;
    const reportIfMatches = (text: string, targetName: string): void => {
      const m = BAD.exec(text);
      if (m === null) return;
      findings.push({
        rule: "unparsed-json-field-access",
        severity: "info",
        message: `In target '${targetName}': \`$(...|json_parse).${m[1]}\` — the \`|json_parse\` filter was removed in v0.3.3. Replace with \`$ json_parse $(VAR) -> P\` then \`$(P.${m[1]})\`.`,
        block: targetName,
      });
    };
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.body !== undefined) reportIfMatches(op.body, targetName);
        if (op.foreachList !== undefined) reportIfMatches(op.foreachList, targetName);
        if (op.ifBranches !== undefined) {
          for (const b of op.ifBranches) reportIfMatches(b.cond, targetName);
        }
        if (op.ampParams !== undefined) {
          for (const v of Object.values(op.ampParams.args)) reportIfMatches(v, targetName);
        }
      });
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

// Credential detection covers two surfaces:
//
//   1. KEY shape — identifier names that conventionally hold secrets,
//      followed by `=` or `:` (covers MCP-tool kwargs, HTTP headers like
//      `Authorization: Bearer ...`, connector config k:v pairs).
//
//   2. VALUE shape — recognizable token prefixes/structures (Bearer
//      tokens, OpenAI `sk-` keys, GitHub `ghp_` tokens, JWT `eyJ.X.Y`).
//      Catches credentials in unnamed positions (e.g., literal Bearer
//      token in a shell command body).
//
// Tier-2 (warning) — broader patterns mean some false positives are
// expected. False positives are noisy; false negatives are dangerous.
const CREDENTIAL_KEY_PATTERN = /\b(api[_-]?key|token|secret|password|passwd|pwd|auth(?:[_-]?token)?|access[_-]?token|bearer|client[_-]?secret|private[_-]?key|signing[_-]?key|refresh[_-]?token|connection[_-]?string|vault[_-]?token|db[_-]?password)\s*[:=]/i;
const CREDENTIAL_VALUE_PATTERN = /(?:Bearer\s+[A-Za-z0-9_.~+/=-]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\bghp_[A-Za-z0-9]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;

function findsCredential(text: string): boolean {
  return CREDENTIAL_KEY_PATTERN.test(text) || CREDENTIAL_VALUE_PATTERN.test(text);
}

const CREDENTIAL_IN_ARGS: LintRule = {
  id: "credential-in-args",
  severity: "warning",
  description: "An op or `# Vars:` default appears to carry credential-like content. Credentials don't belong in skill source.",
  remediation: "Move credentials to per-connector config (env vars in connectors.json, mounted secrets). Skill source should reference operator-managed values via `# Requires: user-var:NAME -> VAR`, not embed them.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    const emit = (where: string, snippet: string, block?: string): void => {
      const key = `${where}:${snippet.slice(0, 60)}`;
      if (reported.has(key)) return;
      reported.add(key);
      findings.push({
        rule: "credential-in-args",
        severity: "warning",
        message: `${where}: credential-like content detected ('${snippet.slice(0, 60).replace(/\n/g, " ")}${snippet.length > 60 ? "..." : ""}').`,
        ...(block !== undefined ? { block } : {}),
      });
    };
    // # Vars: default values — author-written, often where adopters paste secrets by mistake.
    for (const v of ctx.parsed.vars) {
      if (v.default !== undefined && findsCredential(v.default)) {
        emit(`# Vars: ${v.name} default`, v.default);
      }
    }
    // Op bodies + value-bearing fields across all op kinds.
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        // Op body — covers $, shell, emit, $set body, foreach list, etc.
        if (op.body !== undefined && findsCredential(op.body)) {
          emit(`Op '${op.kind}' in target '${targetName}'`, op.body, targetName);
        }
        // Mutation-statement value (setValue holds the RHS of $set / $append).
        if (op.setValue !== undefined && findsCredential(op.setValue)) {
          emit(`'${op.kind}' value in target '${targetName}'`, op.setValue, targetName);
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
        if (op.kind === "inline") {
          findings.push({
            rule: "missing-skillstore-for-data-ref",
            severity: "error",
            message: `Skill references skill '${op.ampParams?.skillName ?? "(unknown)"}' via \`inline(...)\`, but lint was invoked without a SkillStore (call site: ${ctx.callSite}). Data-skill inlining will silently skip; the \`inline\` op will survive into the runtime and error.`,
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
        if (op.kind !== "shell" || op.policy !== "unsafe") return;
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

// Sibling to unsafe-shell-ambiguous-subst: that rule catches refs that
// AREN'T declared (potential bash command-sub collision); this rule
// catches refs that ARE declared but are inlined raw into bash, missing
// the `|shell` escape filter. Author intent is "substitute this variable"
// but they haven't told the runtime to bash-escape it — variable values
// containing spaces or shell metacharacters break the command silently
// or, worse, become injectable.
const UNSAFE_SHELL_UNESCAPED_SUBST: LintRule = {
  id: "unsafe-shell-unescaped-subst",
  severity: "warning",
  description: "An `unsafe=true` shell op interpolates a declared variable into a bash command body without the `|shell` escape filter. Variable values containing whitespace or shell metacharacters break the command or become injectable.",
  remediation: "Add the `|shell` filter on every interpolation: `${VAR|shell}` produces a single bash-quoted token. The filter exists for exactly this case — it's the canonical escape for unsafe-shell substitution.",
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
      if (target.elseBlock !== undefined) walkOps(target.elseBlock, collect);
    }
    const findings: LintFinding[] = [];
    // Match both `${VAR|filters}` and `$(VAR|filters)` forms. Capture the
    // var name + the filter chain. Single `$` only — `$$(...)` is the
    // bash-literal escape, not a skillscript substitution.
    const REF_RE = /(?<!\$)\$(?:\{([^|}\s]+)((?:\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)\}|\(([^|)\s]+)((?:\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)\))/g;
    for (const [targetName, target] of ctx.parsed.targets) {
      const reported = new Set<string>();
      walkOps(target.ops, (op) => {
        if (op.kind !== "shell" || op.policy !== "unsafe") return;
        const re = new RegExp(REF_RE.source, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(op.body)) !== null) {
          const varName = (m[1] ?? m[3])!;
          const chain = (m[2] ?? m[4]) ?? "";
          // Skip dotted refs (structured access — author's responsibility).
          if (varName.includes(".")) continue;
          // Skip ambient refs — runtime-injected, author can't filter them.
          if (AMBIENT_VARS.includes(varName)) continue;
          // Skip refs whose ROOT identifier isn't declared (those fire as
          // `unsafe-shell-ambiguous-subst` or `undeclared-var` instead).
          if (!declared.has(varName)) continue;
          // The cure: a `|shell` filter in the chain.
          if (/\|\s*shell\b/.test(chain)) continue;
          if (reported.has(varName)) continue;
          reported.add(varName);
          findings.push({
            rule: "unsafe-shell-unescaped-subst",
            severity: "warning",
            message: `\`\${${varName}}\` interpolated into \`shell(command=..., unsafe=true)\` body in target '${targetName}' without the \`|shell\` escape filter. Variable values with spaces or shell metacharacters will break the command or become injectable. Rewrite as \`\${${varName}|shell}\`.`,
            block: targetName,
            extras: { var_name: varName },
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
        if (op.kind === "shell" && op.policy === "unsafe") {
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
        if (op.kind === "shell" && op.policy === "unsafe") {
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
 * v0.18.8 — author-time advisory for the operator's shell binary
 * allowlist. Per Perry's two-axes-decoupled rule (thread `7aab6f3f`):
 * binary-scope is a SEPARATE concern from syntax-scope, so this rule
 * is deliberately NOT part of the `unsafe-shell-*` family.
 *
 * Tier-1 error severity matches the runtime: an off-list binary will
 * refuse at execution time. Surfacing at compile-time gives the
 * author immediate "binary X not permitted" feedback rather than
 * runtime-failure-on-first-fire.
 *
 * **Lint is local advisory; runtime is authoritative.** This rule
 * checks against `LintOptions.shellAllowlist` which is the AUTHOR's
 * environment (their local `.env` or the linter's loaded config). The
 * production runtime may have a different allowlist — passing lint
 * does NOT guarantee the call will run. Authors lint with their own
 * env; CI pipelines linting against the deployment's .env catch the
 * production-environment-specific gaps.
 *
 * If `ctx.shellAllowlist` is undefined (LintOptions didn't supply one),
 * the rule skips silently — the runtime's default-deny still fires at
 * execution. This split prevents false-positive noise when authoring
 * tools lack the production-allowlist context.
 *
 * Unsafe path: `shell(..., unsafe=true)` resolves to `bash -c <body>`
 * at runtime; the first-token check is against the literal "bash". This
 * rule mirrors that: if the op is unsafe, the binary checked is "bash"
 * (regardless of what the body contains). Per Perry's reframe: no
 * parse-based binary enumeration on the unsafe path.
 */
const SHELL_BINARY_NOT_ALLOWED: LintRule = {
  id: "shell-binary-not-allowed",
  severity: "error",
  description: "A `shell(command=\"X ...\")` op's binary `X` is not in the operator's shell allowlist. The runtime refuses the op at execution time.",
  remediation: "Either add the binary to `SKILLSCRIPT_SHELL_ALLOWLIST` in your `.env` (or `shellAllowlist` in `skillscript.config.json`), or refactor the skill to use a permitted binary. Run `skillfile shell-audit` to discover what binaries your existing corpus uses. Reminder: lint is a local advisory against your author-env allowlist; runtime enforcement is authoritative.",
  check: (ctx) => {
    if (ctx.shellAllowlist === undefined) return [];
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "shell") return;
        const binary = op.policy === "unsafe" ? "bash" : firstShellToken(op.body);
        if (binary === null) return;
        if (ctx.shellAllowlist!.includes(binary)) return;
        const displayed = op.policy === "unsafe" ? "bash" : binary;
        findings.push({
          rule: "shell-binary-not-allowed",
          severity: "error",
          message: `\`shell\` op in target '${targetName}': binary '${displayed}' is not in the configured allowlist (${ctx.shellAllowlist!.length === 0 ? "empty list" : ctx.shellAllowlist!.join(", ")}). ${op.policy === "unsafe" ? "Unsafe-mode shell runs as `bash -c`; 'bash' must be on the allowlist to permit ANY unsafe shell." : ""}`,
          block: targetName,
          extras: { binary: displayed, policy: op.policy ?? "safe" },
        });
      });
    }
    return findings;
  },
};

/**
 * v0.18.8 — extract the first whitespace-separated token from a shell
 * body for allowlist comparison. Best-effort: bodies with `${VAR}`
 * substitutions whose value would resolve to the binary at runtime
 * can't be statically analyzed (runtime check is the authoritative
 * gate). Returns null for empty / substitution-prefix bodies to skip
 * the lint check for those cases.
 */
function firstShellToken(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("${") || trimmed.startsWith("$(")) return null;
  const match = /^([^\s]+)/.exec(trimmed);
  return match === null ? null : match[1]!;
}

/**
 * Mutation-class op fired without author authorization. v0.14.1 refactored
 * to share the classifier + authorization predicate with the runtime gate
 * in `src/mutation-gate.ts` — single source of truth. Today lint surfaces
 * as a warning (advisory); the runtime is the load-bearing enforcement
 * boundary (throws `UnconfirmedMutationError`).
 *
 * Mutation classes via `classifyMutation`: `$ tool` with mutating-name
 * shape, `$ data_write` MCP dispatch, `file_write(...)` runtime intrinsic.
 * Authorization paths via `authorizationGranted`: `# Autonomous: true`,
 * preceding `??` / `ask()` in the same target, or `approved="reason"`
 * per-op kwarg.
 */
const UNCONFIRMED_MUTATION: LintRule = {
  id: "unconfirmed-mutation",
  severity: "warning",
  description: "A mutation-class op runs without author authorization. Mutation classes: `$ tool` with mutating-name shape (write/update/delete/...); `$ data_write` MCP dispatch; `file_write(...)` function-call op. Silent when the skill declares `# Autonomous: true` or when the op carries `approved=\"reason\"` per-op authorization.",
  remediation: "Two ways to authorize: (1) add `# Autonomous: true` at the skill header for cron/agent-fired skills; (2) pass `approved=\"reason\"` kwarg on the mutation op itself (any non-empty string; presence is what matters, value not parsed semantically).",
  check: (ctx) => {
    const skillAutonomous = ctx.parsed.autonomous === true;
    // v0.4.2 — `# Autonomous: true` skills are unattended by design;
    // the user-confirmation pattern doesn't apply. Silent for the whole
    // skill when the header is set. Shared `authorizationGranted` honors
    // this too; the early-return here avoids the per-op loop entirely.
    if (skillAutonomous) return [];
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      const authState: MutationAuthState = { skillAutonomous };
      for (const op of target.ops) {
        if (authorizationGranted(op, authState)) continue;
        const classification = classifyMutation(op);
        if (classification === null) continue;
        if (classification.kind === "file_write") {
          findings.push({
            rule: "unconfirmed-mutation",
            severity: "warning",
            message: `\`file_write(path="${classification.detail}")\` in target '${targetName}' is a mutation op without authorization. Add \`approved="..."\` kwarg or declare \`# Autonomous: true\`.`,
            block: targetName,
            extras: { op_kind: "file_write", path: classification.detail },
          });
        } else {
          findings.push({
            rule: "unconfirmed-mutation",
            severity: "warning",
            message: `\`$\` op in target '${targetName}' invokes '${classification.detail}' (mutating shape) without authorization. Add \`approved="..."\` kwarg or declare \`# Autonomous: true\`.`,
            block: targetName,
            extras: { tool_name: classification.detail },
          });
        }
      }
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
  id: "missing-default-target",
  severity: "error",
  description: "Skill has no explicit `default:` declaration. The parser falls back to the last declared target as the entry point, but the implicit shape is a footgun — the entry point is invisible without reading the bottom of the source.",
  remediation: "Add `default: <target-name>` at the bottom of the skill to make the entry point explicit. The fallback is preserved for back-compat but the implicit form is no longer supported.",
  check: (ctx) => {
    // v0.9.2 — P0.9 lift to tier-1. Per qwen single-shot Test A: missing
    // `default:` silently accepts; runtime picks the last target. Cold
    // authors lose intent visibility. The parser's `entryTargetExplicit`
    // field distinguishes explicit-vs-implicit.
    if (ctx.parsed.targets.size === 0) return []; // no targets → nothing to enter
    if (ctx.parsed.entryTargetExplicit) return [];
    return [{
      rule: "missing-default-target",
      severity: "error",
      message: "Skill has no explicit `default:` declaration. Entry point resolves via fallback (last declared target). Add `default: <target-name>` to make the entry point explicit.",
    }];
  },
};

// v0.9.2 — P0.6 colon-style kwarg syntax (`limit:20`) silently parses as
// part of an adjacent token, then either gets dropped or passed as a
// malformed kwarg the connector won't understand. Per qwen Test A
// finding (a3a20593). Canonical kwarg form is `key=value` (equals sign).
//
// Detect: pattern `\w+:\w+` (or `\w+:"..."` or `\w+:[...]`) appearing in
// op-body kwarg position. Exclude legitimate uses: quoted strings, the
// `(fallback:...)` clause, ratio/time expressions inside string values.
const COLON_KWARG_SYNTAX: LintRule = {
  id: "colon-kwarg-syntax",
  severity: "error",
  description: "Op body uses `key:value` colon syntax for a kwarg. The canonical kwarg form is `key=value`.",
  remediation: "Rewrite as `key=value` (equals sign). Colon-style is reserved for `(fallback: ...)` trailers and frontmatter keys; it's not valid in kwarg position.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        // Only check `$` ops — function-call ops are tokenized by the parser
        // already, so colon-style would either fail tokenization or be silently
        // absorbed.
        if (op.kind !== "$") return;
        // Strip quoted strings + bracket/brace literals before scanning so
        // quotation contents (`"3:30 PM"`), array literals
        // (`[a, foo:bar, b]`), and JSON object values don't trip the rule.
        // The lint is targeting colon-in-kwarg-position only.
        const stripped = op.body
          .replace(/"[^"]*"/g, '""')
          .replace(/'[^']*'/g, "''")
          .replace(/\[[^\]]*\]/g, "[]")
          .replace(/\{[^}]*\}/g, "{}");
        // Pattern: identifier followed by `:` followed by a non-space non-colon
        // char — that's kwarg-position colon. Skip `(fallback: ...)` which
        // already gets parsed out of the body by the time we see it, but
        // belt-and-suspenders skip explicit `fallback:` matches too.
        const re = /(?:^|\s)([A-Za-z_]\w*)\s*:\s*[^\s:][^\s]*/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(stripped)) !== null) {
          const key = m[1]!;
          if (key === "fallback") continue;
          const findingKey = `${targetName}:${op.body}:${key}`;
          if (reported.has(findingKey)) continue;
          reported.add(findingKey);
          findings.push({
            rule: "colon-kwarg-syntax",
            severity: "error",
            message: `\`${op.body.slice(0, 40)}${op.body.length > 40 ? "..." : ""}\` in target '${targetName}' — kwarg \`${key}:\` uses colon syntax. Rewrite as \`${key}=...\` (the canonical kwarg form is \`key=value\`).`,
            block: targetName,
            extras: { kwarg: key },
          });
        }
      });
    }
    return findings;
  },
};

// v0.15.5 — Perry's 1b9d83a7 finding. The parser splits `# Vars:` lines on
// comma; whitespace is NOT a separator. A line like `# Vars: A=1 B=2` parses
// as a single var `A` with default value `1 B=2` — silently dropping `B`.
// Downstream, `$(B)` references fire `undeclared-var` pointing at the
// symptom (the missing var), not the cause (the missing comma). This rule
// surfaces the cause when the suspect pattern shows up in any declared var's
// default value.
//
// Heuristic: scan the default value's non-quoted regions for whitespace
// followed by `IDENT=`. That's the smoking gun for "space-separated where
// the author intended comma-separated."
const VARS_SPACE_SEPARATED: LintRule = {
  id: "vars-space-separated",
  severity: "warning",
  description: "A `# Vars:` declaration's default value looks like it contains a space-separated additional declaration (e.g. `# Vars: A=1 B=2`). The parser requires comma-separated declarations; the second 'var' was absorbed into the first var's default, leaving the second name undeclared.",
  remediation: "Use commas to separate declarations: `# Vars: A=1, B=2`. If the whitespace is intentional (a default value containing a space), wrap the value in quotes: `# Vars: NAME=\"Bob Jones\"`.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    for (const v of ctx.parsed.vars) {
      if (v.default === undefined) continue;
      // Strip quoted regions so a legitimate quoted value with internal
      // whitespace + equals (e.g. `EXPR="a = b"`) doesn't trip the heuristic.
      const stripped = v.default
        .replace(/"[^"]*"/g, '""')
        .replace(/'[^']*'/g, "''");
      // Pattern: whitespace followed by IDENT followed by `=`. If found, the
      // tail of the default has the shape of another kwarg declaration.
      const m = /\s+([A-Za-z_]\w*)\s*=/.exec(stripped);
      if (m === null) continue;
      const suspectName = m[1]!;
      findings.push({
        rule: "vars-space-separated",
        severity: "warning",
        message: `\`# Vars: ${v.name}=${v.default}\` — the substring \` ${suspectName}=\` looks like a space-separated additional declaration. \`# Vars:\` requires comma-separated declarations; did you mean \`# Vars: ${v.name}=..., ${suspectName}=...\`? '${suspectName}' is undeclared because the parser absorbed it into ${v.name}'s default value.`,
        extras: { vars_var: v.name, vars_suspect: suspectName },
      });
    }
    return findings;
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
  description: "`# Event-type:` set on a skill that has no `agent:` or `template:` output declaration. The field flows to `DeliveryMeta.event_type`; without an agent-bound output it doesn't reach a substrate.",
  remediation: "Either add an agent-bound output (`# Output: agent: <name>` or `# Output: template: <name>`) so the event_type fires, or remove `# Event-type:` from the frontmatter if the skill is genuinely Headless.",
  check: (ctx) => {
    const hasAgentBoundOutput = ctx.parsed.outputs.some(
      (o) => o.kind === "agent" || o.kind === "template",
    );
    if (hasAgentBoundOutput) return [];
    const findings: LintFinding[] = [];
    if (ctx.parsed.eventType !== null) {
      findings.push({
        rule: "unused-augmenting-header",
        severity: "warning",
        message: "`# Event-type:` is set but this skill has no `agent:` or `template:` output — the value won't reach any agent.",
      });
    }
    // v0.9.6 — `# Templates:` no longer flows through DeliveryPayload (Q10);
    // the list is consulted by `unknown-template-reference` lint for skill-
    // existence validation, but it's not delivery-bound metadata anymore.
    return findings;
  },
};

// v0.8.0 — tier-2 lint warns per the delivery-model lockdown (`bb34de4e`).
// v0.19.4 — a body-text-as-output template also populates the delivery
// payload (per complementary-channels semantic in c7ddfc50). When a
// template is authored, the lint does NOT fire — the template IS the
// content the lifecycle hook delivers.
const OUTPUT_AGENT_TARGET_NO_EMIT: LintRule = {
  id: "output-agent-target-no-emit",
  severity: "warning",
  description: "`# Output: agent: <name>` or `# Output: template: <name>` declared but skill has no `emit()` ops AND no body-text-as-output template; delivery fires with empty content.",
  remediation: "Author a body-text-as-output template (prose between the frontmatter and the first target), OR add at least one `emit(text=\"...\")` op so the skill produces content for the lifecycle hook delivery. If the skill produces no agent-targeted output, remove the `# Output:` header.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const agentBoundOutputs = ctx.parsed.outputs.filter(
      (o) => (o.kind === "agent" || o.kind === "template") && o.target !== undefined,
    );
    if (agentBoundOutputs.length === 0) return findings;
    // v0.19.4 — body template populates delivery payload too.
    if (ctx.parsed.outputTemplate !== null) return findings;
    let hasEmit = false;
    for (const [, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => { if (op.kind === "emit") hasEmit = true; });
      if (hasEmit) break;
    }
    if (hasEmit) return findings;
    for (const decl of agentBoundOutputs) {
      findings.push({
        rule: "output-agent-target-no-emit",
        severity: "warning",
        message: `\`# Output: ${decl.kind}: ${decl.target}\` declared but skill has no \`emit()\` ops AND no body-text-as-output template; delivery fires with empty content.`,
      });
    }
    return findings;
  },
};

// v0.9.3 — P1.2 numeric-subscript dotted-ref like `${ARRAY.0}` or
// `${LATEST.items.0}`. The substitution machinery's resolveRef does
// string-keyed property access; arrays handle string keys ("0" coerces
// to index 0) at runtime, so single-step `${ARR.0}` may resolve when
// `ARR` is bound to an array — but multi-step `${LATEST.items.0.field}`
// or chained subscripts are fragile and surface as silent failures.
// Per R8 minion #5: cold author wrote `${LATEST.items.0}` against a
// query result; got UnresolvedVariableError. Foreach iteration is the
// canonical pattern for indexed access.
//
// Tier-2 warning: cold authors get a clear nudge toward `foreach`
// instead of guessing at numeric subscripts.
// v0.9.4 — N8 tier-3 advisory: skill with this name already exists in
// the SkillStore. `skill_write` will reject with "already exists. Pass
// overwrite=true to replace." Cold authors iterating on a new skill
// otherwise discover the collision only at write time — round-trip cost
// per R8 minion #6 finding. The lint surfaces it earlier so authors
// can either rename or pass overwrite=true intentionally.
const SKILL_NAME_COLLISION: LintRule = {
  id: "skill-name-collision",
  severity: "info",
  description: "A skill with this name already exists in the SkillStore. `skill_write` will reject unless `overwrite=true` is passed.",
  remediation: "If you intended to replace the existing skill, pass `overwrite=true` to `skill_write`. If not, rename the skill (change the `# Skill:` header value).",
  check: async (ctx) => {
    if (ctx.skillStore === undefined) return [];
    if (ctx.parsed.name === null) return [];
    // CLI lint is the "I'm just checking a file" surface; it shouldn't
    // surface write-preflight warnings. Cold-author write-preflight goes
    // through MCP lint_skill (callSite "api") or compile-preflight.
    if (ctx.callSite === "cli") return [];
    try {
      // Compare the stored body to the source being linted. If identical,
      // the user is re-linting their already-stored skill — no collision
      // worth surfacing. Only fire when the stored body materially differs.
      const stored = await ctx.skillStore.load(ctx.parsed.name);
      if (stored.source === ctx.source) return [];
      return [{
        rule: "skill-name-collision",
        severity: "info" as const,
        message: `Skill '${ctx.parsed.name}' already exists in the SkillStore with a different body. \`skill_write\` will reject without \`overwrite=true\`. Rename, or pass \`overwrite=true\` intentionally.`,
      }];
    } catch {
      // Not found → no collision
      return [];
    }
  },
};

// v0.9.4 — N5 tier-3 advisory on `$set VAR = [{...}]` JSON-object-array
// literals. The parser's processSetValue doesn't JSON-parse the value —
// it strips outer quotes and otherwise treats it as a literal. So
// `$set ISSUES = [{"id":"X","status":"open"}]` binds the STRING
// `[{"id":"X","status":"open"}]` rather than a structured array.
// Cold authors expect JS-class literal parsing; the gap is silent.
// Per haiku/qwen finding N5 in 9086b3f8.
const SET_JSON_LITERAL_ADVISORY: LintRule = {
  id: "set-json-literal-advisory",
  severity: "info",
  description: "`$set VAR = [{...}]` binds the literal string form, not a parsed JSON structure. Skillscript's `$set` is literal-only — JS-class object/array literals don't auto-parse.",
  remediation: "If you need a parsed structure, use `$ json_parse '[{...}]' -> VAR` (parses the JSON and binds the structured value). If literal string accumulation is the intent, the current `$set` behavior is fine — this advisory just clarifies the semantic.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "$set") return;
        const value = op.setValue ?? "";
        // Match the START of the value being an array-of-objects literal.
        if (!/^\s*\[\s*\{/.test(value)) return;
        const key = `${targetName}:${op.setName}`;
        if (reported.has(key)) return;
        reported.add(key);
        findings.push({
          rule: "set-json-literal-advisory",
          severity: "info",
          message: `\`$set ${op.setName} = [{...}]\` in target '${targetName}' binds the literal string form, not parsed JSON. If you need a structured array of objects, use \`$ json_parse '[{...}]' -> ${op.setName}\` instead.`,
          block: targetName,
        });
      });
    }
    return findings;
  },
};

// v0.9.4 — N3 tier-2 advisory on `${R.transcript}` in composition. The
// composition result shape exposes `transcript` as the emissions array
// (per docs); cold authors interpolate it as "the human-readable text"
// and get JSON-ish array stringification. The semantic mismatch is
// silent — lint and runtime accept the ref, but the rendered output is
// wrong-shape. Per R8 minion #6 finding in 9086b3f8.
//
// Detect: `${VAR.transcript}` references where VAR was bound by a
// `$ execute_skill ... -> VAR` op (i.e., the child-skill result envelope).
// The conservative-but-actionable form: match any `${VAR.transcript}`
// substitution and advise. False positives possible (if a user binds a
// non-composition var named with `.transcript`), but the suggestion
// reads as a helpful nudge either way.
// v0.17.4 — `${R.final_vars.X}` where R was bound by `$ execute_skill
// skill_name="<child>" ... -> R` and `X` isn't in `<child>`'s declared
// `# Returns:`. The runtime filter drops the value silently — the
// caller gets `undefined`/empty at substitution time. Lint catches the
// asymmetry between caller's reach and child's declared export.
// Sibling to v0.17.3's `unknown-returns-ref` (tier-1) on the
// declaration side; this rule is tier-2 advisory on the consumer side.
//
// Forward-reference deferred: if the called skill isn't in the
// SkillStore at lint time, skip — `unknown-skill-reference` (tier-2)
// already flags the missing-ref case. Once the called skill exists,
// this rule fires the next time the host is linted.
const UNEXPORTED_FINAL_VAR_ACCESS: LintRule = {
  id: "unexported-final-var-access",
  severity: "warning",
  description: "A `${R.final_vars.X}` reference accesses a name not declared in the called skill's `# Returns:` header. The runtime filter drops the value; the substitution renders empty.",
  remediation: "Add `X` to the called skill's `# Returns:` header (to export it), or remove the access (if you meant `${R.outputs.text}` or another always-exported field).",
  check: async (ctx) => {
    if (ctx.skillStore === undefined) return [];
    // Step 1: build a map of execute_skill bindings — { boundVar: calledSkillName }
    const bindings = new Map<string, string>();
    for (const target of ctx.parsed.targets.values()) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "$" || op.outputVar === undefined) return;
        if (!/^execute_skill\b/.test(op.body)) return;
        // v0.15.2 — accept either `name` or `skill_name` (back-compat alias).
        const m = /\b(?:skill_name|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w-]*))/.exec(op.body);
        if (m === null) return;
        const skillName = m[1] ?? m[2] ?? m[3];
        if (skillName === undefined || skillName === "") return;
        bindings.set(op.outputVar, skillName);
      });
    }
    if (bindings.size === 0) return [];
    // Step 2: load each referenced skill's parsed.returns. Cache the
    // lookup so multiple references to the same child resolve once.
    const returnsCache = new Map<string, Set<string> | null>();
    const loadReturns = async (skillName: string): Promise<Set<string> | null> => {
      if (returnsCache.has(skillName)) return returnsCache.get(skillName)!;
      let result: Set<string> | null;
      try {
        const loaded = await ctx.skillStore!.load(skillName);
        const parsed = parse(loaded.source);
        result = new Set(parsed.returns);
      } catch {
        result = null; // missing skill — forward-reference deferred to unknown-skill-reference
      }
      returnsCache.set(skillName, result);
      return result;
    };
    // Step 3: walk ops looking for both `${R.final_vars.X}` (iteration-view
    // explicit path) and `${R.X}` (canonical top-level path per v0.17.5).
    // For top-level: skip always-exported envelope fields (outputs,
    // transcript, etc. — those are valid sibling access). For
    // final_vars-explicit: skip the `.final_vars` segment itself.
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    // Always-exported result-envelope fields. Top-level access to these
    // is canonical and must NOT fire this rule. Source-of-truth aligned
    // with parser's RESERVED_ENVELOPE_FIELDS — declared returns can't
    // collide with these, so any top-level `${R.<field>}` where `<field>`
    // is in this set is sibling-access to the envelope, not an
    // unexported-return reach.
    const ALWAYS_EXPORTED = new Set(["skill_name", "outputs", "transcript", "errors", "target_order", "fallbacks", "agent_delivery_receipts", "final_vars"]);
    // Two regexes — explicit path `${R.final_vars.X}` and top-level
    // path `${R.X}`. Both forms (`$(...)` legacy + `${...}` canonical).
    // The top-level regex is more permissive — caller-side checks below
    // filter out envelope-field hits and non-execute_skill bindings.
    const reExplicit = /\$[({]([A-Za-z_]\w*)\.final_vars\.([A-Za-z_]\w*)/g;
    const reTopLevel = /\$[({]([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;
    for (const [targetName, target] of ctx.parsed.targets) {
      const scanString = async (s: string): Promise<void> => {
        // Collect both kinds of matches. Skip envelope fields in
        // top-level matches (final_vars itself is in ALWAYS_EXPORTED so
        // `${R.final_vars}` bare access doesn't fire — but
        // `${R.final_vars.X}` triggers the explicit regex first).
        type Match = { bindVar: string; fieldName: string; raw: string; via: "top-level" | "final_vars" };
        const localMatches: Match[] = [];
        let m: RegExpExecArray | null;
        reExplicit.lastIndex = 0;
        while ((m = reExplicit.exec(s)) !== null) {
          localMatches.push({ bindVar: m[1]!, fieldName: m[2]!, raw: m[0], via: "final_vars" });
        }
        reTopLevel.lastIndex = 0;
        while ((m = reTopLevel.exec(s)) !== null) {
          // Skip `${R.final_vars.X}` matches — already captured by
          // reExplicit above with the X named, not "final_vars".
          if (m[2] === "final_vars") continue;
          // Skip the other always-exported envelope fields.
          if (ALWAYS_EXPORTED.has(m[2]!)) continue;
          localMatches.push({ bindVar: m[1]!, fieldName: m[2]!, raw: m[0], via: "top-level" });
        }
        for (const { bindVar, fieldName, raw, via } of localMatches) {
          if (!bindings.has(bindVar)) continue;
          const calledSkill = bindings.get(bindVar)!;
          const returns = await loadReturns(calledSkill);
          if (returns === null) continue; // forward-ref, deferred
          if (returns.has(fieldName)) continue;
          const key = `${targetName}:${raw}`;
          if (reported.has(key)) continue;
          reported.add(key);
          const declared = returns.size === 0 ? "(none — skill has no `# Returns:` header)" : `[${Array.from(returns).join(", ")}]`;
          const remediation = via === "top-level"
            ? `Add '${fieldName}' to '${calledSkill}'\`s \`# Returns:\` (declared returns access via \`\${${bindVar}.<name>}\` top-level), or use \`\${${bindVar}.outputs.text}\` for the always-exported emission stream.`
            : `Add '${fieldName}' to '${calledSkill}'\`s \`# Returns:\` or use \`\${${bindVar}.outputs.text}\` for the always-exported emission stream.`;
          findings.push({
            rule: "unexported-final-var-access",
            severity: "warning",
            message: `\`${raw}...}\` in target '${targetName}' accesses '${fieldName}' on the result of \`execute_skill\` to '${calledSkill}', but '${fieldName}' isn't in that skill's \`# Returns:\` (declared: ${declared}). The runtime filter drops it; substitution renders empty. ${remediation}`,
            block: targetName,
            extras: { bind_var: bindVar, called_skill: calledSkill, field: fieldName, declared_returns: Array.from(returns), access_path: via },
          });
        }
      };
      const collect = async (op: SkillOp): Promise<void> => {
        if (op.body !== undefined) await scanString(op.body);
        if (op.setValue !== undefined) await scanString(op.setValue);
      };
      const walkAsync = async (ops: SkillOp[]): Promise<void> => {
        for (const op of ops) {
          await collect(op);
          if (op.foreachBody !== undefined) await walkAsync(op.foreachBody);
          if (op.ifBranches !== undefined) for (const b of op.ifBranches) await walkAsync(b.body);
          if (op.ifElseBody !== undefined) await walkAsync(op.ifElseBody);
        }
      };
      await walkAsync(target.ops);
      if (target.elseBlock !== undefined) await walkAsync(target.elseBlock);
    }
    return findings;
  },
};

// ─── v0.19.4 body-text-as-output template rules ──────────────────────────
//
// Four rules covering the new authoring surface. The template region is the
// text between the frontmatter and the first target; runtime renders it as
// canonical output. Per Perry+CC sign-off in c7ddfc50 / 920078c8 / ad0b868e.

/**
 * v0.19.4 — every `${VAR}` / `$(VAR)` in the template must resolve to a
 * declared input (`# Vars:` / `# Requires:`), a `$set` or `->` binding
 * anywhere in the skill, an ambient ref, or a dotted access on one of the
 * above. Mechanical coupling — no semantic guessing. Same machinery as
 * `undeclared-var` (tier-1), applied to the template instead of op bodies.
 * Tier-1: a template referencing unbound vars renders empty at runtime,
 * silently producing wrong-looking output.
 */
const UNSET_TEMPLATE_VAR: LintRule = {
  id: "unset-template-var",
  severity: "error",
  description: "A `${VAR}` reference in the body-text-as-output template doesn't resolve to a declared `# Vars:` / `# Requires:` input, an ambient ref, or a `$set` / `->` binding anywhere in the skill body. Substitution will render empty — the published output silently drops the value.",
  remediation: "Add VAR to `# Vars:`, bind it via `$set VAR = ...` or `<op> -> VAR` in a target's compute block, or check the spelling against the declared / bound variable list.",
  check: (ctx) => {
    if (ctx.parsed.outputTemplate === null) return [];
    const declared = new Set<string>(AMBIENT_VARS);
    for (const v of ctx.parsed.vars) declared.add(v.name);
    for (const r of ctx.parsed.requires) declared.add(r.target);
    for (const target of ctx.parsed.targets.values()) {
      const collect = (op: SkillOp): void => {
        if (op.setName !== undefined) declared.add(op.setName);
        if (op.outputVar !== undefined) declared.add(op.outputVar);
        if (op.foreachIter !== undefined) declared.add(op.foreachIter);
      };
      walkOps(target.ops, collect);
      if (target.elseBlock !== undefined) walkOps(target.elseBlock, collect);
    }
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    // Match both legacy `$(NAME)` and canonical `${NAME}` — first identifier
    // segment only; dotted access (`R.field`) checks against the base var.
    const re = /\$[({]([A-Za-z_]\w*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ctx.parsed.outputTemplate)) !== null) {
      const ref = m[1]!;
      if (declared.has(ref)) continue;
      if (reported.has(ref)) continue;
      reported.add(ref);
      findings.push({
        rule: "unset-template-var",
        severity: "error",
        message: `Output template references undeclared variable \`\${${ref}}\` — substitution will render empty at runtime. Declare it in \`# Vars:\` or bind it via \`$set\` / \`-> ${ref}\` in a target.`,
        extras: { var_name: ref },
      });
    }
    return findings;
  },
};

/**
 * v0.19.4 — Pin 4 tier-2 advisory. Parser captures lines in the template
 * region that match bare `<word>:` alone (no content after colon, no
 * following op-block). These read ambiguously: an author might have meant
 * a target header that they forgot to indent under, or template prose
 * (section header). Flag for disambiguation.
 */
const TEMPLATE_LOOKS_LIKE_TARGET: LintRule = {
  id: "template-looks-like-target",
  severity: "warning",
  description: "A line in the body-text-as-output template region is shaped like a target header (bare `<word>:` alone on its line, no content after colon, no following indented op-block). Parser treats it as template prose under the Pin 4 disambiguation rule, but the shape is ambiguous to a reader.",
  remediation: "If you meant a target, add an indented op-block on the next line. If you meant template prose (e.g. a section header), add content after the colon (`Summary: today's outlook`) or rephrase to disambiguate.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    for (const lineNum of ctx.parsed.templateAmbiguousLines) {
      findings.push({
        rule: "template-looks-like-target",
        severity: "warning",
        message: `Line ${lineNum}: a bare \`<word>:\` shape in the output template could read as a target header. Parser treats it as template prose (no following op-block), but the ambiguity is worth disambiguating: add content after the colon, rephrase, or indent an op-block to make it a real target.`,
        extras: { line: lineNum },
      });
    }
    return findings;
  },
};

/**
 * v0.19.4 — tier-3 advisory. Non-blank, non-`#` lines in the body-template
 * region detected, AND no `# Output:` declaration that consumes text, AND
 * no `${...}` interpolations in the template. Three-condition guard so
 * legitimate interpolating templates never fire. Catches the "I wrote
 * prose; it became template by accident" case.
 */
const BODY_TEMPLATE_DETECTED: LintRule = {
  id: "body-template-detected",
  severity: "info",
  description: "Non-blank, non-`#` lines between the frontmatter and the first target were captured as a body-text-as-output template, BUT the template has no `${...}` interpolations AND the skill declares no text-consuming `# Output:` kind. The lines may have been intended as informal documentation.",
  remediation: "If the lines are intentional output template, add at least one `${VAR}` interpolation OR an explicit `# Output: text` / `# Output: agent: <name>` declaration. If they were intended as documentation, prefix with `#` so the parser treats them as comments.",
  check: (ctx) => {
    if (ctx.parsed.outputTemplate === null) return [];
    if (/\$[({][A-Za-z_]/.test(ctx.parsed.outputTemplate)) return [];
    const hasTextConsumingDecl = ctx.parsed.outputs.some((d) => d.kind === "text" || d.kind === "agent" || d.kind === "template" || d.kind === "file");
    if (hasTextConsumingDecl) return [];
    return [{
      rule: "body-template-detected",
      severity: "info",
      message: "Body-text-as-output template captured, but it has no `${...}` interpolations and the skill declares no text-consuming `# Output:` kind. If the lines were intended as documentation, prefix them with `#` to mark as comments; otherwise add an interpolation or a `# Output:` declaration to confirm intent.",
    }];
  },
};

/**
 * v0.19.4 — tier-3 advisory. Skill has both a body template AND at least
 * one `emit(text=...)` call AND `# Output:` is `text` or absent. Warns the
 * author about the complementary-channels semantic (`c7ddfc50`): template
 * owns canonical output, emit() feeds transcript only. Silently changing
 * the channel semantics when an emit-based skill adds a template is the
 * surprise case Perry called out in `ad0b868e`.
 */
const EMIT_WITH_TEMPLATE: LintRule = {
  id: "emit-with-template",
  severity: "info",
  description: "Skill defines both a body-text-as-output template AND `emit(text=...)` calls. Under v0.19.4 complementary-channels semantics, the template owns canonical output (`outputs.text` / agent delivery payload); `emit()` entries feed the transcript only.",
  remediation: "Confirm intent: if you want emit() to populate canonical output, remove the body template. If you want the template to populate canonical output and emit() to keep populating the transcript (debug log, reasoning trace), no change needed — this is the intended semantic.",
  check: (ctx) => {
    if (ctx.parsed.outputTemplate === null) return [];
    // Filter to text-consuming kinds that route through canonical output.
    // `none` skips the canonical output channel; agent/template/file each
    // consume the template payload, so the emit-demotion is silent there.
    const outputKinds = ctx.parsed.outputs.length === 0 ? ["text"] : ctx.parsed.outputs.map((d) => d.kind);
    const hasTextLike = outputKinds.some((k) => k === "text" || k === "agent" || k === "template" || k === "file");
    if (!hasTextLike) return [];
    let hasEmit = false;
    for (const target of ctx.parsed.targets.values()) {
      walkOps(target.ops, (op) => {
        if (op.kind === "emit") hasEmit = true;
      });
      if (target.elseBlock !== undefined) walkOps(target.elseBlock, (op) => {
        if (op.kind === "emit") hasEmit = true;
      });
      if (hasEmit) break;
    }
    if (!hasEmit) return [];
    return [{
      rule: "emit-with-template",
      severity: "info",
      message: "Skill has both a body-text-as-output template and `emit(text=...)` calls. Under v0.19.4 complementary-channels semantics, the template owns canonical output (`outputs.text` / agent delivery payload); `emit()` entries feed the transcript only. If you want emit() to be the canonical output, remove the template; otherwise this is the intended pattern.",
    }];
  },
};

const TRANSCRIPT_FOOTGUN: LintRule = {
  id: "transcript-footgun",
  severity: "warning",
  description: "Substitution ref `${VAR.transcript}` against a composition-result var renders as a JSON-ish array string, not the human-readable text the field name suggests. The child skill's emissions are an array.",
  remediation: "Bind the value you need explicitly in the child skill (e.g., `$set RESULT_TEXT = ...` followed by access via `${R.final_vars.RESULT_TEXT}`). For joined text, use `${R.outputs.text}` (single-string output) or iterate `foreach LINE in ${R.transcript}:` to consume per-line.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    // Pattern: ${ANY.transcript} or $(ANY.transcript) — both legacy and canonical
    const re = /\$[({][A-Za-z_]\w*\.transcript[)}]/g;
    const scanString = (s: string, targetName: string): void => {
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) {
        const key = `${targetName}:${m[0]}`;
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push({
          rule: "transcript-footgun",
          severity: "warning",
          message: `Substitution ref \`${m[0]}\` in target '${targetName}' renders as a JSON-ish array, not human-readable text. \`transcript\` is the child skill's emissions array. Use \`final_vars.NAMED_VAR\` (bind explicitly in child), \`outputs.text\` (joined string), or iterate via \`foreach\`.`,
          block: targetName,
        });
      }
    };
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.body !== undefined) scanString(op.body, targetName);
        if (op.setValue !== undefined) scanString(op.setValue, targetName);
      });
    }
    return findings;
  },
};

const NUMERIC_SUBSCRIPT: LintRule = {
  id: "numeric-subscript",
  severity: "warning",
  description: "A `${VAR.N}` substitution ref uses a numeric segment (e.g. `${ARR.0}` or `${LATEST.items.0}`). Numeric subscripts are not a first-class language feature — `foreach IT in ${VAR}` is the canonical iteration pattern.",
  remediation: "Replace with `foreach IT in ${VAR}:` to iterate, or with `$set FIRST = ${VAR|first}` (when first-only is the intent). If a specific JSON-array element is unavoidable, bind it via an intermediary `$ json_parse` op + dotted descent against the parsed structure.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    // Pattern: `${X.0...}` or `${X.items.5}` etc — any segment that's
    // all-digits inside a brace-form substitution. Skip $(...) legacy
    // form since it's already tier-2 deprecated.
    const re = /\$\{([A-Za-z_]\w*(?:\.\w+)+)/g;
    const scanString = (s: string, targetName: string): void => {
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) {
        const ref = m[1]!;
        const segments = ref.split(".");
        // First segment is var name (can't be numeric); look at the rest
        const hasNumeric = segments.slice(1).some((seg) => /^\d+$/.test(seg));
        if (!hasNumeric) continue;
        const key = `${targetName}:${ref}`;
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push({
          rule: "numeric-subscript",
          severity: "warning",
          message: `Substitution ref \`\${${ref}}\` in target '${targetName}' uses a numeric segment. Numeric subscripts aren't first-class; use \`foreach\` iteration or bind via \`$ json_parse\` for indexed access against parsed JSON.`,
          block: targetName,
          extras: { ref },
        });
      }
    };
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        // Scan body + kwargs (which live in body for $ ops; in setValue for $set/$append)
        if (op.body !== undefined) scanString(op.body, targetName);
        if (op.setValue !== undefined) scanString(op.setValue, targetName);
      });
    }
    return findings;
  },
};

// v0.9.3 — P1.3 canonicalize `recipients=[...]` over `addressed_to="..."`
// for `$ data_write` dispatch. The bundled DataStoreMcpConnector only
// reads `args["recipients"]` (line 132 of data-store-mcp.ts), so
// `addressed_to=...` was always a doc-bug: it parsed but silently
// dropped. Help docs had it pre-v0.9.3 (`help({topic:"connectors"})`
// line 318) — fixed in this same ship. Lint catches any cold author
// who picked the wrong shape from older docs / muscle memory.
//
// Tier-2 warning, not tier-1 — adopter substrates may genuinely accept
// `addressed_to` if they wire a custom DataStoreMcpConnector. The
// lint nudges toward the bundled-canonical shape without breaking
// adopter freedom.
const DEPRECATED_ADDRESSED_TO: LintRule = {
  id: "deprecated-addressed-to",
  severity: "warning",
  description: "`$ data_write addressed_to=...` is not the canonical kwarg for the bundled DataStoreMcpConnector. The bundled bridge reads `recipients=[...]` (array). `addressed_to` may parse but silently drops in default deployments.",
  remediation: "Rewrite as `$ data_write content=\"...\" recipients=[<agent_id>, ...] -> R`. The bracket-array form is the canonical shape that the bundled `DataStoreMcpConnector` reads. Adopters with a custom memory bridge that genuinely accepts `addressed_to` can wire it; this lint is a nudge toward the default contract.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const reported = new Set<string>();
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "$") return;
        const m = /^([A-Za-z_][\w:-]*)/.exec(op.body);
        if (m === null) return;
        const toolName = m[1]!;
        // Only fire on data_write — adopters may have other tools that
        // legitimately accept addressed_to.
        if (toolName !== "data_write") return;
        if (!/\baddressed_to\s*=/.test(op.body)) return;
        const key = `${targetName}:${op.body}`;
        if (reported.has(key)) return;
        reported.add(key);
        findings.push({
          rule: "deprecated-addressed-to",
          severity: "warning",
          message: `\`$ data_write ... addressed_to=...\` in target '${targetName}' — the bundled DataStoreMcpConnector reads \`recipients=[...]\`, not \`addressed_to=\`. Use \`recipients=[<agent_id>, ...]\` (bracket-array form).`,
          block: targetName,
        });
      });
    }
    return findings;
  },
};

// v0.9.6 — legacy frontmatter header advisory per Perry's `ce41bd4d` signoff
// probe #4. `# Delivery-context:` was renamed to `# Event-type:` in v0.9.6
// (audit Q9). The parser silently ignores unknown headers; without this lint
// cold authors migrating from stale docs hit silent semantic drift — write
// `# Delivery-context:`, runtime drops it, then debug-loop on why
// `meta.event_type` is empty. Same silent-permissiveness anti-pattern that
// v0.9.5's fallback-demotion advisory landed against.
const LEGACY_FRONTMATTER_HEADER: LintRule = {
  id: "legacy-frontmatter-header",
  severity: "warning",
  description: "A frontmatter header was renamed in a previous version; the legacy name is silently ignored at runtime. Migrate to the current name.",
  remediation: "Rename the header per the message. The parser silently drops unknown headers, so this advisory is the only signal that the field isn't reaching its destination.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const lines = ctx.source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^#\s*Delivery-context:/i.test(line)) {
        findings.push({
          rule: "legacy-frontmatter-header",
          severity: "warning",
          message: "Header `# Delivery-context:` was renamed to `# Event-type:` in v0.9.6. The legacy header is silently ignored at runtime — migrate to `# Event-type:` so the value flows to `meta.event_type` on delivery.",
          extras: { legacy_header: "# Delivery-context:", new_header: "# Event-type:", line: i + 1 },
        });
      }
    }
    return findings;
  },
};

const OUTPUT_AGENT_TARGET_NO_CONNECTOR: LintRule = {
  id: "output-agent-target-no-connector",
  severity: "warning",
  description: "`# Output: agent: <name>` or `# Output: template: <name>` declared but no `AgentConnector` is wired; delivery silently no-ops via the NoOp default.",
  remediation: "Wire an AgentConnector implementation in your bootstrap (`registry.registerAgentConnector(name, instance)`). See `docs/adopter-playbook.md` for the contract.",
  check: (ctx) => {
    if (ctx.agentConnectorNames === undefined) return [];
    if (ctx.agentConnectorNames.length > 0) return [];
    const findings: LintFinding[] = [];
    const agentBoundOutputs = ctx.parsed.outputs.filter(
      (o) => (o.kind === "agent" || o.kind === "template") && o.target !== undefined,
    );
    for (const decl of agentBoundOutputs) {
      findings.push({
        rule: "output-agent-target-no-connector",
        severity: "warning",
        message: `\`# Output: ${decl.kind}: ${decl.target}\` declared but no AgentConnector is wired; delivery silently no-ops via the NoOp default.`,
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

/**
 * v0.5.0 item 2 — detect numeric/boolean/null/object literal inits.
 * `$append` permits list (push) and string (concat) targets; everything
 * else (number/bool/null/object) doesn't compose with append semantics
 * and should still error. Mirrors `coerceLiteralValue`'s type detection.
 */
function isNumericBooleanOrNullLiteral(raw: string): boolean {
  const t = raw.trim();
  if (t === "true" || t === "false" || t === "null") return true;
  if (/^-?\d+$/.test(t) || /^-?\d+\.\d+$/.test(t)) return true;
  // Object literal — JSON-shaped, not a string.
  if (t.startsWith("{") && t.endsWith("}")) return true;
  return false;
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
  description: "`$append VAR ...` where VAR's static initialization is a numeric, boolean, null, or object literal. $append v0.5.0 permits list (push) and string (concat) targets only.",
  remediation: "Initialize VAR with a list literal (`$set VAR = []` for list-append) or a string literal (`$set VAR = \"\"` for string-concat). Numeric/boolean/null/object targets don't compose with `$append`.",
  check: (ctx) => {
    const staticInits = new Map<string, string>();
    for (const v of ctx.parsed.vars) {
      if (v.default !== undefined) staticInits.set(v.name, v.default);
    }
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind === "$set" && op.setName !== undefined && op.setValue !== undefined && !/\$[(\{]/.test(op.setValue)) {
          staticInits.set(op.setName, op.setValue);
        }
      });
      walkOps(target.ops, (op) => {
        if (op.kind !== "$append" || op.setName === undefined) return;
        const init = staticInits.get(op.setName);
        if (init === undefined) return;
        // v0.5.0 item 2 — bash-shaped pair: permit string-typed targets
        // (concat) alongside list-typed targets (push). Only fire on
        // initializations that look numeric/boolean/null/object.
        if (isStaticListLiteral(init)) return;
        if (!isNumericBooleanOrNullLiteral(init)) return; // string-typed: allow
        findings.push({
          rule: "append-to-non-list",
          severity: "error",
          message: `\`$append ${op.setName} ...\` in target '${targetName}': ${op.setName} is initialized to a non-list, non-string value (\`${init.slice(0, 40)}${init.length > 40 ? "..." : ""}\`). $append requires a list-typed or string-typed target.`,
          block: targetName,
          extras: { var_name: op.setName, init_value: init },
        });
      });
    }
    return findings;
  },
};

// v0.5.0 item 1 — silent arg-truncation footgun: `$ tool key=$(VAR)`
// without surrounding quotes. If VAR resolves to a value with whitespace
// at runtime, the rendered string `key=value with spaces` gets re-
// tokenized by the MCP arg parser and only the first whitespace-delimited
// chunk binds to `key`. R3 minion 4: "the discipline 'always quote
// dynamic kwarg values' is folklore — nothing in lint, compile output, or
// docs warned me." This rule converts the folklore to lint discipline.
//
// Tier-2: emits a warning, not an error. The footgun is silent so the
// warning is high-leverage, but we don't want to block compilation on
// the false-positive cases (e.g. authors who DO know the kwarg value is
// safely single-token).
//
// Origin policy — fires when VAR's binding origin is "suspect":
//   - `# Vars: X=default` with whitespace in default
//   - `$set X = "literal"` with whitespace in the literal
//   - `$ ... -> X` (tool output, always potentially whitespace-containing)
//   - `~ ... -> X` (local-model output, always potentially whitespace)
//   - `> ... -> X` (retrieval, may bind multi-word query result echoes)
//   - foreach iterator (element shape unknown)
//
// Quiet when:
//   - Value is quoted (`key="$(VAR)"`)
//   - VAR's `# Vars:` default has no whitespace
//   - VAR's `$set X = "literal"` has no whitespace
//   - VAR is unresolved (no binding origin) — let other lints handle that
type BindingOrigin =
  | { kind: "vars"; rawDefault?: string }
  | { kind: "set-literal"; value: string }
  | { kind: "op-output"; op: "$" | "shell"; toolName?: string }
  | { kind: "foreach-iter" }
  | { kind: "set-ref" }; // $set X = $(REF) — propagate, treated as suspect

function buildBindingOrigins(parsed: ParsedSkill): Map<string, BindingOrigin> {
  const origins = new Map<string, BindingOrigin>();
  for (const v of parsed.vars) {
    origins.set(v.name, { kind: "vars", ...(v.default !== undefined ? { rawDefault: v.default } : {}) });
  }
  for (const [, target] of parsed.targets) {
    walkOps(target.ops, (op) => {
      if (op.kind === "$set" && op.setName !== undefined && op.setValue !== undefined) {
        // v0.5.0 item 3: $set RHS interpolates $(REF) at bind time. If the
        // RHS is a static literal (no $(REF)), record its value for the
        // whitespace check. If it contains $(REF), treat as suspect.
        if (/\$[(\{]/.test(op.setValue)) {
          origins.set(op.setName, { kind: "set-ref" });
        } else {
          origins.set(op.setName, { kind: "set-literal", value: op.setValue });
        }
      }
      if (op.outputVar !== undefined) {
        if (op.kind === "$") {
          // v0.16.8 — capture the source tool name so downstream lints
          // (e.g. object-iteration-advisory) can suppress when the tool
          // is known to return bare arrays. Named-form: tool name is
          // first whitespace-bounded token after the connector dot.
          // Bare-form: first token of op.body.
          const m = /^([A-Za-z_][\w:-]*)/.exec(op.body);
          const toolName = m !== null ? m[1] : undefined;
          origins.set(op.outputVar, { kind: "op-output", op: "$", ...(toolName !== undefined ? { toolName } : {}) });
        } else if (op.kind === "shell") {
          origins.set(op.outputVar, { kind: "op-output", op: "shell" });
        }
      }
      if (op.kind === "foreach" && op.foreachIter !== undefined) {
        origins.set(op.foreachIter, { kind: "foreach-iter" });
      }
    });
  }
  return origins;
}

function isOriginSuspect(origin: BindingOrigin | undefined): boolean {
  if (origin === undefined) return false; // unresolved — don't fire
  switch (origin.kind) {
    case "vars":
      if (origin.rawDefault === undefined) return false;
      return /\s/.test(origin.rawDefault);
    case "set-literal":
      return /\s/.test(origin.value);
    case "set-ref":
      return true; // RHS contains a ref — value shape unknown, treat as suspect
    case "op-output":
      return true; // tool/model/retrieval outputs are always suspect
    case "foreach-iter":
      return true; // element type unknown statically
  }
}

const UNQUOTED_SUBSTITUTION_IN_KWARG_VALUE: LintRule = {
  id: "unquoted-substitution-in-kwarg-value",
  severity: "warning",
  description: "A `$ tool key=$(VAR)` op kwarg OR a legacy `@ cmd ... $(VAR)` shell arg has an unquoted `$(VAR)` / `${VAR}` substitution where VAR may resolve to a value containing whitespace. Runtime renders into `key=value with spaces` then re-tokenizes on whitespace — only the first chunk binds to `key` (MCP) or first arg (shell). Silent arg truncation. v0.7.2 extends coverage from `$` ops to `@` ops per R4 minion 4 finding.",
  remediation: "Wrap the substitution in quotes: `key=\"$(VAR)\"` for MCP kwargs, `\"$(VAR)\"` for shell args. The arg tokenizer respects quoted regions, preventing the re-tokenization split.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const origins = buildBindingOrigins(ctx.parsed);
    const reported = new Set<string>();
    // v0.7.2: shared pattern matches both legacy `$(VAR)` and canonical
    // `${VAR}` substitution forms. Only the opening delimiter + var-name
    // are required to match (no closing `)`/`}`) so filter chains like
    // `$(VAR|trim)` and `${VAR|filter:"x"}` parse cleanly. The capture
    // groups (1 = paren-form name, 2 = brace-form name) get coalesced.
    const subStPattern = /\$(?:\(([^|)\s]+)|\{([^|}\s]+))/;
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind === "$") {
          // $ MCP dispatch — scan kwarg values for unquoted substitutions.
          const tokens = tokenizeKeywordArgs(op.body);
          for (const tok of tokens) {
            const eq = tok.indexOf("=");
            if (eq === -1) continue;
            const key = tok.slice(0, eq);
            const value = tok.slice(eq + 1);
            if (!(value.startsWith("$(") || value.startsWith("${"))) continue;
            const m = subStPattern.exec(value);
            if (m === null) continue;
            const varName = (m[1] ?? m[2])!;
            const rootVar = varName.split(".")[0]!;
            const origin = origins.get(rootVar);
            if (!isOriginSuspect(origin)) continue;
            const dedupKey = `${targetName}:$:${key}:${varName}`;
            if (reported.has(dedupKey)) continue;
            reported.add(dedupKey);
            findings.push({
              rule: "unquoted-substitution-in-kwarg-value",
              severity: "warning",
              message: `\`$ ... ${key}=\${${varName}}\` in target '${targetName}': unquoted substitution. ${describeOriginRisk(origin!)} Wrap as \`${key}="\${${varName}}"\` to prevent silent arg truncation if the value contains whitespace.`,
              block: targetName,
              extras: { kwarg: key, var_name: varName, origin: origin!.kind, op: "$" },
            });
          }
        } else if (op.kind === "shell") {
          // Tokenize the shell body the same way the runtime would
          // (whitespace-separated, quotes respected), then flag any token
          // that is a bare unquoted substitution. Quoted tokens
          // (`"${VAR}"` / `'${VAR}'`) are safe.
          const tokens = tokenizeKeywordArgs(op.body);
          for (const tok of tokens) {
            if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))) continue;
            if (!(tok.startsWith("$(") || tok.startsWith("${"))) continue;
            const m = subStPattern.exec(tok);
            if (m === null) continue;
            const varName = (m[1] ?? m[2])!;
            const rootVar = varName.split(".")[0]!;
            const origin = origins.get(rootVar);
            if (!isOriginSuspect(origin)) continue;
            const dedupKey = `${targetName}:shell:${varName}`;
            if (reported.has(dedupKey)) continue;
            reported.add(dedupKey);
            findings.push({
              rule: "unquoted-substitution-in-kwarg-value",
              severity: "warning",
              message: `\`shell(command="... \${${varName}} ...")\` in target '${targetName}': unquoted substitution. ${describeOriginRisk(origin!)} Wrap as \`"\${${varName}}"\` to prevent silent word-splitting if the value contains whitespace.`,
              block: targetName,
              extras: { var_name: varName, origin: origin!.kind, op: "shell" },
            });
          }
        }
      });
    }
    return findings;
  },
};

function describeOriginRisk(origin: BindingOrigin): string {
  switch (origin.kind) {
    case "vars":
      return `\`# Vars:\` default for this variable contains whitespace.`;
    case "set-literal":
      return `\`$set\` literal value contains whitespace.`;
    case "set-ref":
      return `\`$set\` RHS contains a \`$(REF)\` substitution — resolved value shape is unknown statically.`;
    case "op-output":
      return `Variable is bound from a \`${origin.op}\` op output — tool/model results may contain whitespace.`;
    case "foreach-iter":
      return `Variable is a \`foreach\` iterator — element type unknown statically.`;
  }
}

/**
 * v0.7.1 — tier-2 visibility nudge for legacy `$(VAR)` substitution form.
 * Canonical v0.7.0+ form is `${VAR}`. Parser/runtime accept both during
 * grace period. Dedupes per-var-per-target; one nudge per `$(VAR)` form
 * per scope.
 *
 * Skips the `$$(...)` escape (used in `@ unsafe` op bodies for shell
 * literal pass-through). Skips ops where the body is `$set` source
 * (because $set's RHS is its own substitution context and the lint would
 * double-fire).
 */
const DEPRECATED_SUBSTITUTION_SHAPE: LintRule = {
  id: "deprecated-substitution-shape",
  severity: "warning",
  description: "A `$(VAR)` substitution uses the legacy v0.6.x form deprecated in v0.7.0.",
  remediation: "Rewrite to `${VAR}` canonical form. Both forms produce identical results during the v0.7.x grace period; tier-1 promotion lands in v0.8/v0.9. The `$$(VAR)` escape (for `@ unsafe` shell literal pass-through) is unchanged.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    // Negative lookbehind blocks `$$(VAR)` escape form so the lint doesn't
    // fire on shell-escape sites authors deliberately wrote.
    const legacyRe = /(?<!\$)\$\(([^|)\s]+)/g;
    for (const [targetName, target] of ctx.parsed.targets) {
      const reported = new Set<string>();
      const scanOp = (op: SkillOp, scope: string): void => {
        const text = collectOpText(op);
        let m: RegExpExecArray | null;
        while ((m = legacyRe.exec(text)) !== null) {
          const varName = m[1]!;
          const key = `${targetName}:${scope}:${varName}`;
          if (reported.has(key)) continue;
          reported.add(key);
          findings.push({
            rule: "deprecated-substitution-shape",
            severity: "warning",
            message: `Substitution '$(${varName})' in target '${targetName}'${scope === "else" ? " (else block)" : ""} uses the legacy v0.6.x form. Rewrite as '\${${varName}}'.`,
            block: targetName,
            extras: { var_name: varName, legacy_form: `$(${varName})`, canonical_form: `\${${varName}}` },
          });
        }
        legacyRe.lastIndex = 0;
      };
      walkOps(target.ops, (op) => scanOp(op, "main"));
      if (target.elseBlock !== undefined) {
        walkOps(target.elseBlock, (op) => scanOp(op, "else"));
      }
    }
    return findings;
  },
};

/**
 * v0.7.2 — tier-3 advisory for the R4 cold-author footgun (4 of 5 minions).
 * `foreach IT in ${VAR}` where VAR's binding origin is a `$` MCP tool output
 * (and the iteration expression has no `.field` accessor). MCP tools commonly
 * wrap arrays in an envelope object (e.g., `{issuesPage: [...], hasNextPage}`,
 * `{items: [...]}`, `{results: [...]}`) — cold authors iterating the bare
 * bound var get silent stringification + a single-iteration loop with the
 * stringification as the iterator value. Downstream `${IT.field}` errors.
 *
 * Placeholder for the v0.8 tool-schema-introspection solution that catches
 * this precisely. Advisory hints at the common envelope-field names.
 */
// v0.16.8 — softened wording per Perry's `c497b479` finding 2 + warm-adopter's
// `1e1c9305` empirical observation. The original advisory PRESCRIBED `.items`
// access, which produced a runtime failure when authors trusted it against
// bare-array-returning tools. New wording acknowledges the shape ambiguity
// and asks the author to verify against the tool's response — no specific
// field name. Adopter-configurable `LintOptions.bareArrayReturnTools`
// suppresses the advisory entirely for tools known to return bare arrays.
const OBJECT_ITERATION_ADVISORY: LintRule = {
  id: "object-iteration-advisory",
  severity: "info",
  description: "A `foreach IT in ${VAR}` iterates a bound variable whose origin is a `$` MCP tool output, without a `.field` accessor. The tool may return a bare array OR an envelope-wrapped one — verify against the tool's actual response shape.",
  remediation: "Verify the tool's response shape. Some MCP tools return bare arrays (iterate directly: `foreach IT in ${VAR}` is correct); others wrap arrays in envelopes (e.g., `.items`, `.results`, `.data`) and need `foreach IT in ${VAR.items}` or the actual field. If your tool is known to return bare arrays, configure `LintOptions.bareArrayReturnTools` to suppress this advisory.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    const origins = buildBindingOrigins(ctx.parsed);
    const suppressedTools = new Set(ctx.bareArrayReturnTools);
    // Bare var ref pattern: `$(VAR)` or `${VAR}` — no dotted accessor, no filter chain.
    const bareRef = /^\s*\$(?:\(([A-Za-z_]\w*)\)|\{([A-Za-z_]\w*)\})\s*$/;
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "foreach" || op.foreachList === undefined) return;
        const m = bareRef.exec(op.foreachList);
        if (m === null) return;
        const varName = (m[1] ?? m[2])!;
        const origin = origins.get(varName);
        if (origin === undefined) return;
        if (origin.kind !== "op-output" || origin.op !== "$") return;
        // v0.16.8 — adopter-configurable suppression.
        if (origin.toolName !== undefined && suppressedTools.has(origin.toolName)) return;
        findings.push({
          rule: "object-iteration-advisory",
          severity: "info",
          message: `In target '${targetName}': \`foreach ${op.foreachIter} in \${${varName}}\` iterates a bare \`$\` op output without a \`.field\` accessor. The tool may return a bare array (in which case bare iteration is correct) OR an envelope shape (e.g., \`{items: [...]}\`) which needs \`foreach ${op.foreachIter} in \${${varName}.items}\`. Verify against the tool's actual response.`,
          block: targetName,
          extras: { var_name: varName, foreach_iter: op.foreachIter, ...(origin.toolName !== undefined ? { tool_name: origin.toolName } : {}) },
        });
      });
    }
    return findings;
  },
};

// v0.18.5 — address-routed `notify()` / `# Output: agent:` informational
// surfacing. Per Perry's design call (thread `c453afa2`): the `@session`
// suffix on the agent_id encodes wake-class dispatch; the runtime routes
// to `AgentConnector.wake()` instead of `deliver()`. The lint makes the
// implicit address-routing visible at author time without a redundant
// `wake=true` kwarg. Pure informational — runtime works either way.
const ADDRESS_ROUTED_WAKE_INFO: LintRule = {
  id: "address-routed-wake",
  severity: "info",
  description: "A `notify(agent=\"X@session\")` op or `# Output: agent: X@session` decl uses the address-routed wake-class form — the runtime routes to AgentConnector.wake() rather than deliver().",
  remediation: "This is informational, not an error. The `@session` suffix on the address is the wake signal (v0.18.5 — Perry thread c453afa2). To target a bare identity (mailbox-class deliver), drop the `@session` suffix; to target a specific live session (wake-class interrupt), keep it. Same rule across notify() + lifecycle hooks.",
  check: (ctx) => {
    const findings: LintFinding[] = [];
    for (const [targetName, target] of ctx.parsed.targets) {
      walkOps(target.ops, (op) => {
        if (op.kind !== "notify" || op.notifyParams === undefined) return;
        const addr = op.notifyParams.agent;
        if (!addr.includes("@")) return;
        findings.push({
          rule: "address-routed-wake",
          severity: "info",
          message: `In target '${targetName}': \`notify(agent=\"${addr}\")\` — the \`@session\` suffix routes this to AgentConnector.wake() (wake-class interrupt), not deliver(). Substrate sees the opaque composite agent_id; this is the canonical way to wake a specific live session.`,
          block: targetName,
          extras: { agent: addr, surface: "notify" },
        });
      });
    }
    for (const decl of ctx.parsed.outputs) {
      if (decl.kind !== "agent" && decl.kind !== "template") continue;
      const addr = decl.target;
      if (addr === undefined || !addr.includes("@")) continue;
      findings.push({
        rule: "address-routed-wake",
        severity: "info",
        message: `\`# Output: ${decl.kind}: ${addr}\` — the \`@session\` suffix routes this lifecycle-hook dispatch to AgentConnector.wake() (wake-class interrupt), not deliver(). Substrate sees the opaque composite agent_id.`,
        block: "(frontmatter)",
        extras: { agent: addr, surface: `output-${decl.kind}` },
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
  UNKNOWN_RETURNS_REF,
  UNKNOWN_FILTER,
  UNSET_TEMPLATE_VAR,
  MALFORMED_OP_GRAMMAR,
  INVALID_CONDITIONAL_SYNTAX,
  SINGLE_EQUALS,
  INDENTATION,
  RESERVED_KEYWORD,
  UNKNOWN_SKILL_REFERENCE,
  UNKNOWN_TEMPLATE_REFERENCE,
  UNKNOWN_CONNECTOR,
  UNKNOWN_CONNECTOR_CLASS,
  UNWIRED_PRIMARY_CONNECTOR,
  DISALLOWED_TOOL,
  UNKNOWN_TOOL_ON_CONNECTOR,
  UNVERIFIED_QUALIFIED_TOOL,
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
  DEPRECATED_SUBSTITUTION_SHAPE,
  UNSAFE_SHELL_AMBIGUOUS_SUBST,
  UNSAFE_SHELL_UNESCAPED_SUBST,
  UNSAFE_SHELL_OP,
  UNSAFE_SHELL_DISABLED,
  SHELL_BINARY_NOT_ALLOWED,
  UNCONFIRMED_MUTATION,
  UNQUOTED_SUBSTITUTION_IN_KWARG_VALUE,
  DRAFT_WITH_TRIGGER,
  REFERENCE_TO_DISABLED_SKILL,
  UNUSED_AUGMENTING_HEADER,
  OUTPUT_AGENT_TARGET_NO_EMIT,
  OUTPUT_AGENT_TARGET_NO_CONNECTOR,
  NUMERIC_SUBSCRIPT,
  DEPRECATED_ADDRESSED_TO,
  LEGACY_FRONTMATTER_HEADER,
  TRANSCRIPT_FOOTGUN,
  TEMPLATE_LOOKS_LIKE_TARGET,
  UNEXPORTED_FINAL_VAR_ACCESS,
  SET_JSON_LITERAL_ADVISORY,
  SKILL_NAME_COLLISION,
  UNKNOWN_LLM_MODEL,
  UNKNOWN_LLM_ARG,
  UNKNOWN_DATA_READ_ARG,
  // v0.9.2 — promoted from tier-3 info to tier-1 error (P0.9 in c9c667d2)
  NO_DEFAULT_TARGET,
  COLON_KWARG_SYNTAX,
  VARS_SPACE_SEPARATED,
  // Tier-3 (info)
  DUPLICATE_SKILL_NAME,
  PLUGIN_COLLISION,
  UNPARSED_JSON_FIELD_ACCESS,
  OBJECT_ITERATION_ADVISORY,
  ADDRESS_ROUTED_WAKE_INFO,
  BODY_TEMPLATE_DETECTED,
  EMIT_WITH_TEMPLATE,
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

interface CompositionRef { name: string; via: "inline" | "$ execute_skill"; }

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
    if (op.kind === "inline" && op.ampParams !== undefined) emit(op.ampParams.skillName, "inline");
    // `$ execute_skill` is also a composition primitive.
    if (op.kind === "$" && /^execute_skill\b/.test(op.body)) {
      // v0.15.2 — accept either `name` or `skill_name` (back-compat alias).
      const m = /\b(?:skill_name|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w-]*))/.exec(op.body);
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
  // v0.5.0 item 4: refs whose filter chain contains `|fallback:"..."` are
  // suppressed from undeclared-var. The author has explicitly opted into
  // "may not resolve at runtime" semantics — making this a lint error
  // would defeat the purpose.
  // v0.7.0: alternation matches both `$(REF|chain)` and `${REF|chain}`.
  // Capture groups: 1+2 = paren form, 3+4 = brace form.
  const re = /\$(?:\(([^|)\s]+)((?:\s*\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)\)|\{([^|}\s]+)((?:\s*\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)\})/g;
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1] ?? m[3];
    const chain = (m[2] ?? m[4]) ?? "";
    if (/\|\s*fallback(?:\s*:|[\s|)])/.test(chain)) continue;
    refs.push(name!);
  }
  return refs;
}

function extractVarRefsWithFilter(op: SkillOp): Array<{ name: string; filter?: string }> {
  const text = collectOpText(op);
  // v0.5.0 item 4: accept `:"arg"` after filter name so `|default:"X"` parses.
  // Multiple filters in a chain produce one entry per filter (preserves
  // the per-filter unknown-filter check that pre-existed for single-filter
  // refs).
  // v0.7.0: alternation matches both `$(REF|chain)` and `${REF|chain}`.
  // Capture groups: 1+2 = paren form, 3+4 = brace form.
  const re = /\$(?:\(([^|)\s]+)((?:\s*\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)\)|\{([^|}\s]+)((?:\s*\|\s*[A-Za-z_]\w*(?:\s*:\s*"[^"]*")?)*)\})/g;
  const out: Array<{ name: string; filter?: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = (m[1] ?? m[3])!;
    const chain = (m[2] ?? m[4]) ?? "";
    if (!chain) {
      out.push({ name });
      continue;
    }
    const filterRe = /\|\s*([A-Za-z_]\w*)(?:\s*:\s*"[^"]*")?/g;
    let fm: RegExpExecArray | null;
    while ((fm = filterRe.exec(chain)) !== null) {
      out.push({ name, filter: fm[1]! });
    }
  }
  return out;
}

function collectOpText(op: SkillOp): string {
  let text = op.body;
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
    ...registry.listDataStoreClasses(),
    ...registry.listLocalModelClasses(),
    ...registry.listMcpConnectorClasses(),
  ];
}

function collectMcpConnectorNamesFromRegistry(registry: Registry | undefined): string[] | undefined {
  if (registry === undefined) return undefined;
  return registry.listMcpConnectors().map((e) => e.name);
}

function collectAgentConnectorNamesFromRegistry(registry: Registry | undefined): string[] | undefined {
  if (registry === undefined) return undefined;
  // listAgentConnectors() excludes the implicit NoOp fallback (per
  // registry.ts) — empty array means "no real AgentConnector wired."
  return registry.listAgentConnectors().map((e) => e.name);
}

function collectLocalModelAliasesFromRegistry(registry: Registry | undefined): string[] | undefined {
  if (registry === undefined) return undefined;
  return registry.listLocalModels().map((e) => e.name);
}

// v0.16.4 — async sibling to collectLocalModelAliasesFromRegistry: probes each
// registered LocalModel's `manifest()` to harvest `models_available`. Used by
// the async `lint()` entry point so `unknown-llm-model` can validate against
// both registry aliases AND the underlying substrate's model surface (sharpened
// by Perry's `bfd776a9` audit insight — with manifest in capabilities, the lint
// has substrate-aware source of truth, not just alias names).
//
// Per-instance try/catch — a throwing `manifest()` (e.g., substrate unreachable
// at lint time) silently degrades to alias-only validation rather than failing
// the lint. Adopters whose LocalModel `manifest()` omits `models_available`
// (the contract permits absence) also gracefully fall through.
async function collectLocalModelInfoFromRegistry(
  registry: Registry | undefined,
): Promise<{ aliases: string[]; modelsAvailable: string[] } | undefined> {
  if (registry === undefined) return undefined;
  const entries = registry.listLocalModels();
  const aliases = entries.map((e) => e.name);
  const available = new Set<string>();
  for (const entry of entries) {
    try {
      const m = await entry.instance.manifest();
      const inner = m.manifest as { models_available?: string[] };
      if (Array.isArray(inner.models_available)) {
        for (const tag of inner.models_available) available.add(tag);
      }
    } catch {
      // Probe failure — degrade to alias-only for this instance.
    }
  }
  return { aliases, modelsAvailable: [...available] };
}

function collectMcpConnectorAllowedToolsFromRegistry(registry: Registry | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (registry === undefined) return out;
  for (const e of registry.listMcpConnectors()) {
    if (e.allowedTools !== undefined) out.set(e.name, e.allowedTools);
  }
  return out;
}

function collectMcpConnectorStaticToolsFromRegistry(registry: Registry | undefined): Map<string, string[] | null> {
  const out = new Map<string, string[] | null>();
  if (registry === undefined) return out;
  for (const e of registry.listMcpConnectors()) {
    const ctor = e.ctor as { staticTools?: () => string[] | null };
    if (ctor.staticTools !== undefined) {
      out.set(e.name, ctor.staticTools());
    } else {
      out.set(e.name, null);
    }
  }
  return out;
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
