import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { parse } from "../src/parser.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// v0.7.0 — function-call op grammar: `verb(kwarg=value, ...) [-> BINDING]`.
// Closed runtime-intrinsic set: emit, ask, inline, execute_skill, shell,
// file_read, file_write. Per Perry's locked spec `783a10a4`.

async function runSkill(src: string): Promise<{ emissions: string[]; errors: unknown[]; vars: Map<string, unknown> }> {
  const home = mkdtempSync(join(tmpdir(), "v070fn-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  const compiled = await compile(src);
  // v0.18.8 — permissive shell allowlist for tests in this file (covers
  // the binaries the fixtures exercise: echo, true, etc.).
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
    registry: wired.registry,
    shellAllowlist: ["echo", "true", "false", "bash", "sh"],
  });
  return { emissions: result.emissions, errors: result.errors, vars: result.vars };
}

describe("v0.7.0 — emit(text=...) function-call form", () => {
  it("parses + executes as ! op", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="hello world")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["hello world"]);
  });

  it("emit with ${VAR} substitution", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: NAME=Scott\nrun:\n    emit(text="hi \${NAME}")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["hi Scott"]);
  });
});

describe("v0.7.0 — shell(command=...) function-call form", () => {
  it("shell executes command and binds output", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    shell(command="echo hi") -> OUT\n    emit(text="\${OUT}")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["hi"]);
  });

  it("shell with unsafe=true requires enableUnsafeShell", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    shell(command="echo unsafe-hi", unsafe=true) -> OUT\n    emit(text="\${OUT}")\ndefault: run\n`;
    const result = await runSkill(src);
    // Default context has enableUnsafeShell undefined → UnsafeShellDisabledError fires.
    expect(result.errors.length).toBe(1);
    expect(result.emissions).toEqual([]);
  });
});

describe("v0.7.0 — file_read / file_write function-call ops", () => {
  it("file_write then file_read round-trip", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "v070fw-"));
    const path = join(tmp, "subdir", "test.txt");
    const src = [
      `# Skill: t`,
      `# Status: Approved`,
      `# Autonomous: true`,
      `# Vars: PATH=${path}`,
      `run:`,
      `    file_write(path="\${PATH}", content="hello from skill")`,
      `    file_read(path="\${PATH}") -> CONTENT`,
      `    emit(text="\${CONTENT}")`,
      `default: run`,
      ``,
    ].join("\n");
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    // v0.9.2 — file_write emits a confirmation transcript line on success.
    expect(result.emissions).toEqual([
      expect.stringMatching(/^\[file_write\] wrote 16 bytes to /),
      "hello from skill",
    ]);
    // Verify the file was actually written
    expect(readFileSync(path, "utf8")).toBe("hello from skill");
  });

  it("file_read with fallback handles missing path", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "v070fr-"));
    const missingPath = join(tmp, "does-not-exist.txt");
    const src = [
      `# Skill: t`,
      `# Status: Approved`,
      `# Vars: P=${missingPath}`,
      `run:`,
      `    file_read(path="\${P}") -> C (fallback: "missing")`,
      `    emit(text="\${C}")`,
      `default: run`,
      ``,
    ].join("\n");
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["missing"]);
  });

  it("file_write creates parent directories", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "v070mkdir-"));
    const path = join(tmp, "a", "b", "c", "deep.txt");
    const src = [
      `# Skill: t`,
      `# Status: Approved`,
      `# Autonomous: true`,
      `# Vars: P=${path}`,
      `run:`,
      `    file_write(path="\${P}", content="nested")`,
      `default: run`,
      ``,
    ].join("\n");
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("nested");
  });
});

describe("v0.7.0 — function-call (approved:) kwarg captured", () => {
  it("file_write with approved=... parses; kwarg recorded on AST", () => {
    const src = [
      `# Skill: t`,
      `# Status: Approved`,
      `run:`,
      `    file_write(path="/tmp/x", content="y", approved="test reason")`,
      `default: run`,
      ``,
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    const op = parsed.targets.get("run")?.ops[0];
    expect(op?.kind).toBe("file_write");
    expect(op?.approved).toBe("test reason");
  });

  it("emit with approved=... carries through", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="hi", approved="logged")\ndefault: run\n`;
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    const op = parsed.targets.get("run")?.ops[0];
    expect(op?.approved).toBe("logged");
  });
});

describe("v0.7.0 — parser rejects unknown function-call ops", () => {
  it("unknown name produces parse error with remediation", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    youtrack_search(query="x") -> R\ndefault: run\n`;
    const parsed = parse(src);
    expect(parsed.parseErrors.length).toBeGreaterThan(0);
    expect(parsed.parseErrors[0]).toMatch(/Unknown function-call op 'youtrack_search\(/);
    expect(parsed.parseErrors[0]).toMatch(/\$ youtrack_search args -> R/);
  });
});

describe("v0.16.0 — legacy `!` symbol form rejected", () => {
  it("legacy `! text` produces parse error", async () => {
    const src = [
      `# Skill: t`,
      `# Status: Approved`,
      `run:`,
      `    emit(text="from-fn")`,
      `    ! from-symbol`,
      `default: run`,
      ``,
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors.some((e) => e.includes("Legacy `!`"))).toBe(true);
  });
});

describe("v0.7.0 — function-call grammar edge cases", () => {
  it("multi-line kwargs across newlines (single-line for now)", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="single line works fine")\ndefault: run\n`;
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
  });

  it("nested parens in kwarg value (paren-balanced extraction)", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="(parens) inside")\ndefault: run\n`;
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
  });

  it("trailing -> VAR captures binding", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    shell(command="echo x") -> R\n    emit(text="\${R}")\ndefault: run\n`;
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    const shellOp = parsed.targets.get("run")?.ops[0];
    expect(shellOp?.outputVar).toBe("R");
  });

  it("unbalanced parens reported", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="oops"\ndefault: run\n`;
    const parsed = parse(src);
    expect(parsed.parseErrors.length).toBeGreaterThan(0);
    expect(parsed.parseErrors[0]).toMatch(/unbalanced parens/);
  });
});
