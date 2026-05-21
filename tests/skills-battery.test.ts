import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "../src/parser.js";
import { lint } from "../src/lint.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { LintFailureError } from "../src/errors.js";

/**
 * Cold-agent skills battery.
 *
 * `tests/skills/` is a directory of `.skill.md` artifacts authored by
 * agents whose only context is the language reference (memory
 * `50fcecc8`). Authors must not have read the implementation, the ERD,
 * or any of the test suites — the discipline is "if a sub-agent can
 * compile and run this from the language ref alone, the reference is
 * sound; if they can't, the reference (or the impl) has a gap."
 *
 * Failures here surface doc-impl mismatches that neither the spec
 * author nor the implementor would catch alone. Per the dogfood
 * discipline (`a046164f`), this category catches gaps the structured
 * adversarial fixtures miss.
 *
 * Convention: every fixture in this directory should pass all four
 * stages cleanly:
 *   1. Parse — `parseErrors` empty
 *   2. Lint — no tier-1 (error-severity) findings
 *   3. Compile — no `LintFailureError` thrown
 *   4. Mechanical execute — `result.errors` empty
 *
 * Mechanical execute (`ctx.mechanical: true`) skips `$`/`~`/`>` dispatch
 * and binds placeholders so the battery doesn't need real connectors
 * wired (no Ollama, no MCP servers, no MemoryStore). Control-flow
 * (foreach, if/elif/else), `@`/`!`/`??`/`$set`, variable substitution,
 * and error propagation still run end-to-end.
 *
 * Skills that intentionally violate a lint rule belong in
 * `tests/adversarial/<rule-id>/positive-*.skill.md` (the rule-conformance
 * surface), not here. This directory is the "should pass" battery.
 */

const SKILLS_DIR = resolve(import.meta.dirname, "skills");

function discoverSkills(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(SKILLS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".skill.md"))
    .filter((f) => {
      const full = join(SKILLS_DIR, f);
      return statSync(full).isFile();
    })
    .sort();
}

const fixtures = discoverSkills();

describe("cold-agent skills battery", () => {
  if (fixtures.length === 0) {
    it.skip("(no fixtures present in tests/skills/ — battery is empty)", () => {
      // Intentionally skipped. When sub-agents drop .skill.md files in
      // tests/skills/, the battery activates automatically.
    });
    return;
  }

  for (const fixture of fixtures) {
    describe(fixture, () => {
      const source = readFileSync(join(SKILLS_DIR, fixture), "utf8");

      it("parses without errors", () => {
        const parsed = parse(source);
        expect(
          parsed.parseErrors,
          `parser rejected ${fixture} — first error: ${parsed.parseErrors[0] ?? "(none)"}`,
        ).toEqual([]);
      });

      it("lints clean (no tier-1 errors)", async () => {
        const result = await lint(source);
        const errors = result.findings.filter((f) => f.severity === "error");
        expect(
          errors,
          `lint errors in ${fixture}: ${errors.map((e) => `${e.rule}: ${e.message}`).join(" | ")}`,
        ).toEqual([]);
      });

      it("compiles without LintFailureError", async () => {
        try {
          await compile(source);
        } catch (err) {
          if (err instanceof LintFailureError) {
            throw new Error(`compile preflight rejected ${fixture}: ${err.message}`);
          }
          throw err;
        }
      });

      it("executes cleanly in mechanical mode", async () => {
        const compiled = await compile(source);
        const result = await execute(
          compiled.parsed,
          compiled.resolvedVariables,
          compiled.targetOrder,
          { registry: new Registry(), mechanical: true },
        );
        expect(
          result.errors,
          `runtime errors in ${fixture}: ${result.errors.map((e) => `${e.target}/${e.opKind}: ${e.message}`).join(" | ")}`,
        ).toEqual([]);
      });
    });
  }
});
