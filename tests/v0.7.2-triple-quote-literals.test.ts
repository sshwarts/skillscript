import { describe, it, expect } from "vitest";
import { parse, processSetValue } from "../src/parser.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// v0.7.2 — triple-quote `"""..."""` multi-line string literals.
// Prose-shaped content (long-form emit text, file_write content, $set
// reports). Single `"` doesn't terminate; spans line breaks naturally.

async function runSkill(src: string): Promise<{ emissions: string[]; errors: unknown[] }> {
  const home = mkdtempSync(join(tmpdir(), "v072tq-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  const compiled = await compile(src);
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
  return { emissions: result.emissions, errors: result.errors };
}

describe("v0.7.2 — processSetValue triple-quote handling", () => {
  it("strips outer triple-quotes", () => {
    expect(processSetValue('"""hello"""')).toBe("hello");
  });

  it("preserves embedded single quotes (single \" doesn't terminate)", () => {
    expect(processSetValue('"""he said "hi" to her"""')).toBe('he said "hi" to her');
  });

  it("interprets escape sequences inside triple-quote", () => {
    expect(processSetValue('"""line1\\nline2\\ttab"""')).toBe("line1\nline2\ttab");
  });

  it("empty triple-quote", () => {
    expect(processSetValue('""""""')).toBe("");
  });

  it("triple-quote with real newline character", () => {
    expect(processSetValue('"""first\nsecond\nthird"""')).toBe("first\nsecond\nthird");
  });

  it("falls back to regular processing when not triple-quoted", () => {
    expect(processSetValue('"hello"')).toBe("hello");
    expect(processSetValue('hello')).toBe("hello");
  });
});

describe("v0.7.2 — triple-quote in $set", () => {
  it("$set with single-line triple-quote", () => {
    const src = `# Skill: t\nrun:\n    $set X = """hello world"""\ndefault: run\n`;
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    const op = parsed.targets.get("run")?.ops[0];
    expect(op?.kind).toBe("$set");
    expect(op?.setValue).toBe("hello world");
  });

  it("$set with multi-line triple-quote", () => {
    const src = [
      "# Skill: t",
      "run:",
      '    $set REPORT = """',
      "    First line.",
      "    Second line.",
      '    """',
      "default: run",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    const op = parsed.targets.get("run")?.ops[0];
    expect(op?.kind).toBe("$set");
    expect(op?.setValue).toContain("First line.");
    expect(op?.setValue).toContain("Second line.");
  });

  it("$set with triple-quote containing embedded single quotes", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $set X = """he said "hi" then left"""\n    emit(text="\${X}")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe('he said "hi" then left');
  });
});

describe("v0.7.2 — triple-quote in function-call kwargs", () => {
  it("emit(text=\"\"\"...\"\"\") single-line", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="""hello "quoted" world""")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe('hello "quoted" world');
  });

  it("file_write(content=\"\"\"...\"\"\") with multi-line prose", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "v072tqw-"));
    const path = join(tmp, "report.md");
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Autonomous: true",
      `# Vars: P=${path}`,
      "run:",
      '    file_write(path="${P}", content="""# Report',
      "",
      "Daily summary:",
      "- Item A",
      "- Item B",
      '""")',
      "default: run",
      "",
    ].join("\n");
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    const written = readFileSync(path, "utf8");
    expect(written).toContain("# Report");
    expect(written).toContain("Daily summary:");
    expect(written).toContain("- Item A");
    expect(written).toContain("- Item B");
  });

  it("execute_skill kwarg can use triple-quote for large JSON-blob arg", () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "run:",
      '    execute_skill(skill_name="child", config="""{"a": 1, "b": "embedded \\"quotes\\""}""") -> R',
      "default: run",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
  });
});

describe("v0.7.2 — triple-quote vs single-quote disambiguation", () => {
  it("regular single-quote string still works", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="just a string")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe("just a string");
  });

  it("string ending in literal \" (escape) parses correctly", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="ends with \\"quote\\"")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe('ends with "quote"');
  });
});
