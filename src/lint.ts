import { parse } from "./parser.js";
import type { StaticCapabilities } from "./connectors/types.js";
import type { Registry } from "./connectors/registry.js";

/**
 * Lint diagnostics. T2 baseline rules — the full 20-rule v1 set (tier-1
 * hard fails, tier-2 opt-in gates, tier-3 style nits) plus the adversarial
 * example library land in T4. Authors and tooling consume `LintFinding[]`;
 * CI gates on `severity === "error"`.
 *
 * ## Current baseline rules
 *
 *   parse-error          (error)    — any syntax error collected by the parser.
 *   no-targets           (error)    — the skill defines zero targets.
 *   no-entry-target      (error)    — targets exist but no `default:` line
 *                                     and no implicit fallback resolved.
 *   orphan-target        (warning)  — a target isn't reachable from the
 *                                     entry via the `needs:` DAG; surfaces
 *                                     the Make-style composition gotcha.
 *   unknown-capability   (error)    — a `# Requires:` capability clause
 *                                     names a feature flag that no
 *                                     registered connector class reports
 *                                     as true. The validation is OFFLINE:
 *                                     lint reads `Ctor.staticCapabilities()`
 *                                     for each provided class without
 *                                     constructing instances or touching
 *                                     the underlying substrate.
 *
 * T4 extends this. Contract for T4: every baseline rule keeps its rule ID
 * and severity (no renames, no severity demotions); T4 adds new rule IDs
 * alongside. Authors who consume baseline diagnostics today won't see
 * breakage when T4 lands.
 */
export type LintSeverity = "error" | "warning" | "info";

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  message: string;
  /** Optional location info (line numbers added in T4). */
  block?: string;
}

export interface LintResult {
  findings: LintFinding[];
  errorCount: number;
  warningCount: number;
}

/**
 * Options for `lint()`. Both `classes` and `registry` are optional; without
 * either, capability validation is skipped (the `unknown-capability` rule
 * just doesn't fire). When both are passed, `classes` wins — the caller
 * has signaled intent to use that specific class set.
 */
export interface LintOptions {
  /**
   * Connector classes whose `staticCapabilities()` provides the available
   * feature flags. The linter calls these directly — no instance
   * construction, no network, no substrate reachability required. This
   * is the offline-validation path.
   */
  classes?: Array<{ staticCapabilities(): StaticCapabilities }>;
  /** Convenience: derive `classes` from a Registry's registered instances. */
  registry?: Registry;
}

export function lint(source: string, options?: LintOptions): LintResult {
  const findings: LintFinding[] = [];
  const parsed = parse(source);

  for (const msg of parsed.parseErrors) {
    findings.push({
      rule: "parse-error",
      severity: "error",
      message: msg,
    });
  }

  if (parsed.targets.size === 0 && parsed.parseErrors.length === 0) {
    findings.push({
      rule: "no-targets",
      severity: "error",
      message: "Skill defines no targets. A skill needs at least one target with ops.",
    });
  }
  if (parsed.targets.size > 0 && parsed.entryTarget === null) {
    findings.push({
      rule: "no-entry-target",
      severity: "error",
      message: "Skill has no entry target. Declare one with `default: <target-name>`.",
    });
  }

  // Orphan-target warning — targets unreachable from the entry.
  if (parsed.entryTarget !== null && parsed.targets.has(parsed.entryTarget)) {
    const reached = new Set<string>();
    function walk(name: string): void {
      if (reached.has(name)) return;
      reached.add(name);
      const t = parsed.targets.get(name);
      if (!t) return;
      for (const dep of t.deps) walk(dep);
    }
    walk(parsed.entryTarget);
    for (const name of parsed.targets.keys()) {
      if (!reached.has(name)) {
        findings.push({
          rule: "orphan-target",
          severity: "warning",
          message: `Target '${name}' is not reachable from entry target '${parsed.entryTarget}'. ` +
            `Declare a dependency, change \`default:\`, or fold the steps into the entry target.`,
          block: name,
        });
      }
    }
  }

  // unknown-capability — offline validation against registered classes.
  if (parsed.requiredCapabilities.length > 0) {
    const classes = options?.classes ?? collectClassesFromRegistry(options?.registry);
    if (classes !== null) {
      const provided = buildFeatureSet(classes);
      for (const cap of parsed.requiredCapabilities) {
        if (!provided.has(cap)) {
          findings.push({
            rule: "unknown-capability",
            severity: "error",
            message:
              `Skill requires capability '${cap}', but no registered connector class provides it. ` +
              `Available: ${provided.size === 0 ? "(none)" : Array.from(provided).sort().join(", ")}.`,
          });
        }
      }
    }
  }

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  return { findings, errorCount, warningCount };
}

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

/**
 * Build the set of capability tokens (`connector_type.feature_flag`) that
 * any provided class reports as `true`. The set's name format mirrors the
 * skill author's `# Requires:` token shape so direct membership check works.
 */
function buildFeatureSet(
  classes: Array<{ staticCapabilities(): StaticCapabilities }>,
): Set<string> {
  const provided = new Set<string>();
  for (const Ctor of classes) {
    const caps = Ctor.staticCapabilities();
    for (const [flag, value] of Object.entries(caps.features)) {
      if (value === true) {
        provided.add(`${caps.connector_type}.${flag}`);
      }
    }
  }
  return provided;
}
