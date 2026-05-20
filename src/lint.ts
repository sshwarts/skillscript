import { parse } from "./parser.js";

/**
 * Lint diagnostics. T1 baseline rules — the full 20-rule v1 set (Tier-1
 * hard fails, Tier-2 opt-in gates, Tier-3 style nits) plus the adversarial
 * example library land in T4. Authors and tooling consume `LintFinding[]`;
 * CI gates on `severity === "error"`.
 *
 * ## T1 baseline rules
 *
 *   parse-error       (error)    — any syntax error collected by the parser.
 *                                  Covers every grammar rule the parser
 *                                  validates (op shape, conditional grammar,
 *                                  header well-formedness, indent/dedent
 *                                  consistency, target structure).
 *   no-targets        (error)    — the skill defines zero targets.
 *   no-entry-target   (error)    — targets exist but no `default:` line and
 *                                  no implicit fallback resolved.
 *   orphan-target     (warning)  — a target isn't reachable from the entry
 *                                  via the `needs:` DAG; surfaces the
 *                                  Make-style composition gotcha.
 *
 * T4 extends this. The contract for T4: every rule in the baseline keeps
 * its rule ID and severity (no renames, no severity demotions); T4 adds
 * new rule IDs alongside. Authors who consume the baseline diagnostics
 * today shouldn't see breakage when T4 lands.
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

export function lint(source: string): LintResult {
  const findings: LintFinding[] = [];
  const parsed = parse(source);

  for (const msg of parsed.parseErrors) {
    findings.push({
      rule: "parse-error",
      severity: "error",
      message: msg,
    });
  }

  // Structural sanity. These are conditions the compiler also fails on,
  // but the lint surface lets authors discover them without invoking compile.
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

  // Orphan-target warning — targets that aren't reachable from the entry.
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

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  return { findings, errorCount, warningCount };
}
