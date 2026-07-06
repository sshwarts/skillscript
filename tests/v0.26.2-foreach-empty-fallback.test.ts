import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.26.2 — two list/filter ergonomics fixes from Perry's `enter-project`
 * dogfood (thread 9ed7554b):
 *
 *   #2  foreach over an empty/whitespace STRING input iterates ZERO times,
 *       not once with an empty element. `RULE_IDS=""` used to run one pass
 *       with RID="" and blow up downstream (amp_get_memory("")).
 *
 *   #3  a `|fallback` rescues an undefined base regardless of chain position
 *       — an undefined value propagates lazily past intervening filters to
 *       the fallback (Jinja's `undefined|filter|default` contract). Gated on
 *       `undefined` ONLY: a value that resolves (incl. whitespace) flows
 *       through every filter unchanged, so no existing behavior shifts.
 */

async function runSkill(src: string, inputs?: Record<string, string>): Promise<{ emissions: string[]; errors: unknown[] }> {
  const home = mkdtempSync(join(tmpdir(), "v0262-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  const compiled = await compile(src, inputs ? { inputs } : undefined);
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
  return { emissions: result.emissions, errors: result.errors };
}

describe("v0.26.2 #2 — foreach over empty string input iterates zero times", () => {
  it("empty-string var → zero iterations", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: IDS=""\nrun:\n    foreach ID in $(IDS):\n        emit(text="pass=[$(ID)]")\n    emit(text="done")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    // No per-item emission — only the terminal "done".
    expect(result.emissions).toEqual(["done"]);
  });

  it("whitespace-only var → zero iterations", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: IDS="   "\nrun:\n    foreach ID in $(IDS):\n        emit(text="pass=[$(ID)]")\n    emit(text="done")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["done"]);
  });

  // --- Perry's deploy repro (2db95446): the BRACE form `${V}` + runtime INPUTS.
  // The original tests all used `$(IDS)` (paren) + `# Vars:` defaults, which hit
  // the guarded `$(REF)` branch. `${V}` does NOT match that regex — it falls
  // through to the substituteRuntime path, which lacked the guard. This is the
  // path an actual caller-supplied-list skill uses, so it's the one that must be
  // covered end-to-end via execute-with-inputs.
  it("brace form ${V} + empty runtime INPUT → zero iterations (deploy repro)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: V\nrun:\n    foreach A in \${V}:\n        emit(text="pass=[$(A)]")\n    emit(text="done")\ndefault: run\n`;
    const result = await runSkill(src, { V: "" });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["done"]);
  });

  it("brace form ${V} + whitespace runtime INPUT → zero iterations (deploy repro)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: V\nrun:\n    foreach A in \${V}:\n        emit(text="pass=[$(A)]")\n    emit(text="done")\ndefault: run\n`;
    const result = await runSkill(src, { V: "   " });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["done"]);
  });

  it("brace form ${V} + non-empty runtime INPUT → one iteration (control)", async () => {
    // Perry's control: proves inputs ARE applied and the value is exactly what
    // we set — so the zero-iteration result above is the guard firing, not a
    // harness artifact.
    const src = `# Skill: t\n# Status: Approved\n# Vars: V\nrun:\n    foreach A in \${V}:\n        emit(text="pass=[$(A)]")\ndefault: run\n`;
    const result = await runSkill(src, { V: "solo" });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["pass=[solo]"]);
  });

  it("brace form ${IDS} + empty # Vars default → zero iterations", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: IDS=""\nrun:\n    foreach ID in \${IDS}:\n        emit(text="pass=[$(ID)]")\n    emit(text="done")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["done"]);
  });

  it("JSON-array string input still iterates its elements (regression)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: IDS=["a","b"]\nrun:\n    foreach ID in $(IDS):\n        emit(text="pass=[$(ID)]")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["pass=[a]", "pass=[b]"]);
  });

  it("non-empty scalar string still wraps to a single iteration (regression)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: IDS="solo"\nrun:\n    foreach ID in $(IDS):\n        emit(text="pass=[$(ID)]")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["pass=[solo]"]);
  });
});

describe("v0.26.2 #3 — downstream |fallback rescues an undefined base", () => {
  it("filter-before-fallback: undefined base propagates to fallback", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="[$(MISSING|trim|fallback:"d")]")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["[d]"]);
  });

  it("length-before-fallback: undefined base → fallback (length skipped)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="[$(MISSING|length|fallback:"0")]")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["[0]"]);
  });

  it("fallback-first still works (unchanged)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="[$(MISSING|fallback:"d"|trim)]")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["[d]"]);
  });

  it("no fallback anywhere in chain → still throws at runtime (regression)", async () => {
    // Use a dotted access lint accepts (P is declared) but that resolves
    // undefined at runtime — exercises the runtime throw path, not compile
    // lint. Without a downstream fallback, `|trim` on undefined must throw.
    const src = `# Skill: t\n# Status: Approved\n# Vars: PAYLOAD={"name":"admin"}\nrun:\n    $ json_parse $(PAYLOAD) -> P\n    emit(text="[$(P.email|trim)]")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("REGRESSION: whitespace value flows through length unchanged (gated on undefined, not empty)", async () => {
    // WS resolves to "  " — NOT undefined — so `length` runs and yields 2.
    // The fix must not treat a resolved-but-empty value as skippable, else
    // this would flip to "0".
    const src = `# Skill: t\n# Status: Approved\n# Vars: WS="  "\nrun:\n    emit(text="[$(WS|length|fallback:"0")]")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["[2]"]);
  });

  it("REGRESSION: resolved value still runs every filter (fallback is a no-op)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: NAME="  abc  "\nrun:\n    emit(text="[$(NAME|trim|fallback:"d")]")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["[abc]"]);
  });
});
