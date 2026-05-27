/**
 * v0.9.4 — cold-author cleanup cluster (N1–N8).
 *
 * Closes the next ring of issues surfaced by R8 + qwen re-validation
 * against v0.9.3 (memory 9086b3f8). Goal: push mean UX from 3.86/5
 * toward 4+/5 (v1.0 cold-author signoff threshold).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/parser.js";
import { lint } from "../src/lint.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { Registry } from "../src/connectors/registry.js";

describe("v0.9.4 — N1 approved= kwarg suppresses unconfirmed-mutation", () => {
  it("`$ memory_write content=... approved=...` suppresses the lint", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    $ memory_write content="hi" approved="cron deliverable" -> R

default: m
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "unconfirmed-mutation")).toBeUndefined();
  });

  it("bare `$ memory_write ...` (no approved=) still fires", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    $ memory_write content="hi" -> R

default: m
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "unconfirmed-mutation")).toBeDefined();
  });

  it("parser populates op.approved from $ op body", () => {
    const src = `# Skill: t
# Status: Approved

m:
    $ memory_write content="hi" approved="reason here" -> R

default: m
`;
    const parsed = parse(src);
    const op = parsed.targets.get("m")?.ops[0];
    expect(op?.approved).toBe("reason here");
  });
});

describe("v0.9.4 — N2 $append STRING_VAR strips operator chars", () => {
  it("`$append REPORT <\"line\">` against string target concatenates without literal `<>`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v094-N2-"));
    const registry = new Registry();
    registry.registerSkillStore("primary", new FilesystemSkillStore(join(dir, "skills")));
    const src = `# Skill: t
# Status: Approved

m:
    $set REPORT = ""
    $append REPORT <"line 1">
    $append REPORT <"line 2">
    emit(text="\${REPORT}")

default: m
`;
    try {
      const compiled = await compile(src);
      const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
      expect(result.errors).toEqual([]);
      expect(result.emissions.join("\n")).toBe("line 1line 2");
      // Confirm no literal `<` or `>` characters in the output
      expect(result.emissions.join("\n")).not.toContain("<");
      expect(result.emissions.join("\n")).not.toContain(">");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list-append `$append LIST <item>` still works (back-compat)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v094-N2list-"));
    const registry = new Registry();
    registry.registerSkillStore("primary", new FilesystemSkillStore(join(dir, "skills")));
    const src = `# Skill: t
# Status: Approved

m:
    $set ITEMS = []
    $append ITEMS <"a">
    $append ITEMS <"b">
    emit(text="\${ITEMS|length}")

default: m
`;
    try {
      const compiled = await compile(src);
      const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
      expect(result.errors).toEqual([]);
      expect(result.emissions.join("\n")).toBe("2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v0.9.4 — N3 transcript-footgun lint", () => {
  it("fires on `${R.transcript}` substitution", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    $ execute_skill skill_name="child" -> R
    emit(text="child said: \${R.transcript}")

default: m
`;
    const r = await lint(src);
    const finding = r.findings.find((f) => f.rule === "transcript-footgun");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("does NOT fire on `${R.final_vars.X}` (canonical)", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    $ execute_skill skill_name="child" -> R
    emit(text="result: \${R.final_vars.RESULT}")

default: m
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "transcript-footgun")).toBeUndefined();
  });
});

describe("v0.9.4 — N5 set-json-literal-advisory", () => {
  it("fires on `$set X = [{...}]`", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    $set ISSUES = [{"id":"X","status":"open"}]

default: m
`;
    const r = await lint(src);
    const finding = r.findings.find((f) => f.rule === "set-json-literal-advisory");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
  });

  it("does NOT fire on `$set X = []` (empty list — canonical init)", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    $set ITEMS = []

default: m
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "set-json-literal-advisory")).toBeUndefined();
  });
});

describe("v0.9.4 — N8 skill-name-collision advisory", () => {
  let dir: string;
  let store: FilesystemSkillStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v094-N8-"));
    store = new FilesystemSkillStore(join(dir, "skills"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fires when a skill with the same name already exists in the store", async () => {
    await store.store("existing", `# Skill: existing
# Status: Approved

m:
    emit(text="hi")

default: m
`);
    const newSource = `# Skill: existing
# Status: Approved

m:
    emit(text="updated")

default: m
`;
    const r = await lint(newSource, { skillStore: store });
    const finding = r.findings.find((f) => f.rule === "skill-name-collision");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
  });

  it("does NOT fire when no skill with that name exists", async () => {
    const src = `# Skill: brand-new
# Status: Approved

m:
    emit(text="hi")

default: m
`;
    const r = await lint(src, { skillStore: store });
    expect(r.findings.find((f) => f.rule === "skill-name-collision")).toBeUndefined();
  });
});
