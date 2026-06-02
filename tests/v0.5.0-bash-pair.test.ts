import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { lint } from "../src/lint.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.5.0 items 2 + 3 — bash-shaped string composition pair.
 *
 * Item 2: $append permits string-typed targets (concat) alongside list.
 * Item 3: $set interpolates $(REF) at bind time (reverses v0.2.6
 *         literals-only spec per `dc824ee4` lesson option 1).
 *
 * Spec: R3 harness (minion 4 yt-to-memory-carrier) hit the
 * string-composition gap; lesson `dc824ee4` proposed the fix shape;
 * v0.5.0 ships it.
 */

async function runSkill(src: string): Promise<{ emissions: string[]; errors: unknown[]; vars: Map<string, unknown> }> {
  const home = mkdtempSync(join(tmpdir(), "v050-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  const compiled = await compile(src);
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
  return { emissions: result.emissions, errors: result.errors, vars: result.vars };
}

describe("v0.5.0 item 3 — $set bind-time interpolation", () => {
  it("$set X = \"$(REF)\" resolves REF at bind time", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: USER=admin\nrun:\n    $set GREETING = "Hello, $(USER)!"\n    emit(text="$(GREETING)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["Hello, admin!"]);
  });

  it("$set X = \"plain literal\" still works", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $set X = "static-value"\n    emit(text="$(X)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["static-value"]);
  });

  it("$set X interpolates multiple refs in one string", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: A=foo, B=bar\nrun:\n    $set COMBINED = "$(A) and $(B)"\n    emit(text="$(COMBINED)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["foo and bar"]);
  });

  it("$set X interpolates dotted field refs", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: PAYLOAD={"name":"admin","email":"x@y.com"}\nrun:\n    $ json_parse $(PAYLOAD) -> P\n    $set GREETING = "Hello $(P.name) (<$(P.email)>)"\n    emit(text="$(GREETING)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["Hello admin (<x@y.com>)"]);
  });

  it("$set X = \"$(MISSING)\" is caught at lint (undeclared-var) — even better than runtime error", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $set GREETING = "Hello, $(NOT_DEFINED)!"\n    emit(text="$(GREETING)")\ndefault: run\n`;
    // Bind-time substitution means the ref is now a real ref the linter
    // sees — tier-1 lint catches it before compile, mirroring how $(REF)
    // typos are caught elsewhere. This is the intended UX.
    await expect(runSkill(src)).rejects.toThrow(/undeclared-var/);
  });

  it("$set X = integer literal still binds as number", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $set COUNT = 42\n    emit(text="count: $(COUNT)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["count: 42"]);
  });

  it("$set X = [list] still binds as list", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $set ITEMS = [a, b, c]\n    foreach I in $(ITEMS):\n        emit(text="item $(I)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["item a", "item b", "item c"]);
  });
});

describe("v0.5.0 item 2 — string-typed $append", () => {
  it("$append to empty string concatenates", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $set BUF = ""\n    $append BUF "hello"\n    $append BUF " world"\n    emit(text="$(BUF)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["hello world"]);
  });

  it("$append builds multi-line string via foreach (R3 minion 4 pattern)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: ITEMS=[apple, banana, cherry]\nrun:\n    $set REPORT = "Fruits:\\n"\n    foreach I in $(ITEMS):\n        $append REPORT "- $(I)\\n"\n    emit(text="$(REPORT)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    // v0.7.2 — escape interpretation in double-quoted strings means \n
    // becomes an actual newline at parse time. The emitted string contains
    // real line breaks. (Pre-v0.7.2 this stored literal "\n" bytes — the
    // R4 minion 4 footgun. Now closed.)
    expect(result.emissions[0]).toBe("Fruits:\n- apple\n- banana\n- cherry\n");
  });

  it("$append to list still pushes (regression)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $set ITEMS = []\n    $append ITEMS "first"\n    $append ITEMS "second"\n    emit(text="count: $(ITEMS|length)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["count: 2"]);
  });

  it("$append to numeric target throws clear error", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $set X = 42\n    $append X "more"\ndefault: run\n`;
    // Lint catches it at compile preflight (append-to-non-list).
    const lintResult = await lint(src);
    expect(lintResult.findings.find((f) => f.rule === "append-to-non-list")).toBeDefined();
  });
});

describe("v0.5.0 — bash-shaped composition cross-feature", () => {
  it("$set with interpolation + $append concat closes the R3 minion-4 pattern", async () => {
    // Build a multi-line detail string from a list of issues, mirroring
    // the YouTrack morning-sweep authoring shape.
    const src = `# Skill: t\n# Status: Approved\n# Vars: USER=admin, ISSUES=[BUG-1, BUG-2, BUG-3]\nrun:\n    $set DETAIL = "Open issues for $(USER):\\n"\n    foreach I in $(ISSUES):\n        $append DETAIL "- $(I)\\n"\n    emit(text="$(DETAIL)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toContain("Open issues for admin:");
    expect(result.emissions[0]).toContain("- BUG-1");
    expect(result.emissions[0]).toContain("- BUG-2");
    expect(result.emissions[0]).toContain("- BUG-3");
  });
});
