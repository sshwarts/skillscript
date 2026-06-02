import { describe, it, expect } from "vitest";
import { processSetValue } from "../src/parser.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// v0.7.2 — interpret \n, \t, \\, \" in double-quoted string literals.
// Closes R4 minion 4 footgun where literal \n bytes shipped to disk.
// Bash/Python/JS/Go all interpret these escapes; skillscript joins the
// prior. Single-quoted strings reserved for v0.8+ literal-pass-through.

async function runSkill(src: string): Promise<{ emissions: string[]; errors: unknown[] }> {
  const home = mkdtempSync(join(tmpdir(), "v072-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  const compiled = await compile(src);
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
  return { emissions: result.emissions, errors: result.errors };
}

describe("v0.7.2 — processSetValue escape interpretation", () => {
  it("interprets \\n in double-quoted strings", () => {
    expect(processSetValue('"line1\\nline2"')).toBe("line1\nline2");
  });

  it("interprets \\t", () => {
    expect(processSetValue('"col1\\tcol2"')).toBe("col1\tcol2");
  });

  it("interprets \\\\ as literal backslash", () => {
    expect(processSetValue('"path\\\\to\\\\file"')).toBe("path\\to\\file");
  });

  it("interprets \\\" as literal quote", () => {
    expect(processSetValue('"he said \\"hi\\""')).toBe('he said "hi"');
  });

  it("leaves unrecognized \\X escapes verbatim", () => {
    expect(processSetValue('"a\\xb"')).toBe("a\\xb");
    expect(processSetValue('"a\\rc"')).toBe("a\\rc");
  });

  it("does NOT interpret escapes in single-quoted strings (literal pass-through)", () => {
    expect(processSetValue("'line1\\nline2'")).toBe("line1\\nline2");
  });

  it("does NOT interpret escapes in unquoted values", () => {
    expect(processSetValue("line1\\nline2")).toBe("line1\\nline2");
  });

  it("multi-escape combos", () => {
    expect(processSetValue('"a\\nb\\tc\\\\d\\"e"')).toBe('a\nb\tc\\d"e');
  });
});

describe("v0.7.2 — escape interpretation in skill execution", () => {
  it("$set with \\n produces real newlines in emit output", async () => {
    const src = '# Skill: t\n# Status: Approved\nrun:\n    $set REPORT = "line1\\nline2"\n    emit(text=\"${REPORT}\")\ndefault: run\n';
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe("line1\nline2");
  });

  it("emit(text=\"\\n\") emits a literal newline", async () => {
    const src = '# Skill: t\n# Status: Approved\nrun:\n    emit(text="a\\nb")\ndefault: run\n';
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe("a\nb");
  });

  it("file_write(content=\"...\\n...\") writes real newlines", async () => {
    const home = mkdtempSync(join(tmpdir(), "v072fw-"));
    const path = join(home, "report.txt");
    const src = `# Skill: t\n# Status: Approved\n# Autonomous: true\n# Vars: P=${path}\nrun:\n    file_write(path="\${P}", content="line one\\nline two\\nline three")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path, "utf8")).toBe("line one\nline two\nline three");
  });

  it("nested \" escape in emit(text=\"...\") closes R4 finding", async () => {
    const src = '# Skill: t\n# Status: Approved\nrun:\n    emit(text="he said \\"hello\\"")\ndefault: run\n';
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe('he said "hello"');
  });
});
