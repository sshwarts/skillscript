import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { lint } from "../src/lint.js";

const ADVERSARIAL_DIR = resolve(import.meta.dirname, "adversarial");

/**
 * Adversarial library conformance: every `<rule-id>/positive-*.skill`
 * fixture MUST fire the rule; every `<rule-id>/negative-*.skill` fixture
 * MUST NOT fire it. Rules that depend on SkillStore state (unknown-skill-
 * reference, disabled-skill-reference, reference-to-disabled-skill,
 * duplicate-skill-name) are covered by unit tests, not file fixtures.
 */

const ruleDirs = readdirSync(ADVERSARIAL_DIR)
  .filter((entry) => {
    const full = join(ADVERSARIAL_DIR, entry);
    return statSync(full).isDirectory();
  })
  .sort();

describe("adversarial library conformance", () => {
  for (const ruleId of ruleDirs) {
    const ruleDir = join(ADVERSARIAL_DIR, ruleId);
    const fixtures = readdirSync(ruleDir)
      .filter((f) => f.endsWith(".skill"))
      .sort();

    if (fixtures.length === 0) continue;

    describe(ruleId, () => {
      for (const fixture of fixtures) {
        const isPositive = fixture.startsWith("positive-");
        const isNegative = fixture.startsWith("negative-");
        if (!isPositive && !isNegative) {
          throw new Error(`Adversarial fixture '${ruleId}/${fixture}' must be prefixed positive- or negative-`);
        }
        it(`${fixture}: ${isPositive ? "fires" : "doesn't fire"} ${ruleId}`, async () => {
          const source = readFileSync(join(ruleDir, fixture), "utf8");
          const result = await lint(source);
          const fired = result.findings.some((f) => f.rule === ruleId);
          if (isPositive) {
            expect(fired, `expected rule '${ruleId}' to fire on ${fixture}; findings: ${result.findings.map((f) => f.rule).join(", ") || "(none)"}`).toBe(true);
          } else {
            expect(fired, `expected rule '${ruleId}' NOT to fire on ${fixture}; findings: ${result.findings.map((f) => f.rule).join(", ")}`).toBe(false);
          }
        });
      }
    });
  }
});
