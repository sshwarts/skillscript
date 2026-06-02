import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute, substituteRuntime } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { parse } from "../src/parser.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// v0.7.0 — `${VAR}` substitution canonical form, additive alongside `$(VAR)`.
// Per Perry's locked spec `783a10a4`, both forms have identical semantics during
// the deprecation grace period; tier-1 lint promotion lands in v0.8/v0.9.
// Migration tool rewrites legacy → canonical.

async function runSkill(src: string): Promise<{ emissions: string[]; errors: unknown[]; vars: Map<string, unknown> }> {
  const home = mkdtempSync(join(tmpdir(), "v070-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  const compiled = await compile(src);
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
  return { emissions: result.emissions, errors: result.errors, vars: result.vars };
}

describe("v0.7.0 — ${VAR} substitution at runtime", () => {
  it("substituteRuntime resolves ${VAR}", () => {
    const vars = new Map<string, unknown>([["NAME", "Scott"]]);
    expect(substituteRuntime("Hello, ${NAME}!", vars)).toBe("Hello, Scott!");
  });

  it("substituteRuntime resolves $(VAR) legacy form", () => {
    const vars = new Map<string, unknown>([["NAME", "Scott"]]);
    expect(substituteRuntime("Hello, $(NAME)!", vars)).toBe("Hello, Scott!");
  });

  it("substituteRuntime mixed forms in same string", () => {
    const vars = new Map<string, unknown>([["A", "one"], ["B", "two"]]);
    expect(substituteRuntime("${A} and $(B)", vars)).toBe("one and two");
  });

  it("substituteRuntime ${VAR.field} dotted access", () => {
    const vars = new Map<string, unknown>([["ISSUE", { id: "INFRA-247", title: "auth 503" }]]);
    expect(substituteRuntime("${ISSUE.id}: ${ISSUE.title}", vars)).toBe("INFRA-247: auth 503");
  });

  it("substituteRuntime ${VAR|filter} chain", () => {
    const vars = new Map<string, unknown>([["TEXT", "  padded  "]]);
    expect(substituteRuntime("${TEXT|trim}", vars)).toBe("padded");
  });

  it("substituteRuntime ${VAR|fallback:\"default\"} for missing ref", () => {
    const vars = new Map<string, unknown>();
    expect(substituteRuntime("${MISSING|fallback:\"n/a\"}", vars)).toBe("n/a");
  });
});

describe("v0.7.0 — ${VAR} in conditions", () => {
  it("if ${VAR} == \"value\" parses + executes", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: MODE=production\nrun:\n    if \${MODE} == "production":\n        emit(text="prod-mode")\n    else:\n        emit(text="dev-mode")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["prod-mode"]);
  });

  it("if ${VAR.field} == \"value\" with dotted field", async () => {
    // Build the JSON via a heredoc-style assignment to dodge escape complexity in template literals.
    const jsonLit = '{"sev": "P0"}';
    const src = [
      `# Skill: t`,
      `# Status: Approved`,
      `# Vars: ISSUE_JSON=${jsonLit}`,
      `run:`,
      `    $ json_parse $(ISSUE_JSON) -> P`,
      `    if \${P.sev} == "P0":`,
      `        emit(text="showstopper")`,
      `default: run`,
      ``,
    ].join("\n");
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["showstopper"]);
  });

  it("mixed ${VAR} and $(VAR) in same condition", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: A=x, B=x\nrun:\n    if \${A} == $(B):\n        emit(text="match")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["match"]);
  });
});

describe("v0.7.0 — ${VAR} in $set/$append/op args", () => {
  it("$set X = \"${REF}\" bind-time interp with new form", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: USER=admin\nrun:\n    $set GREETING = "Hello, \${USER}!"\n    emit(text="\${GREETING}")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["Hello, admin!"]);
  });

  it("$append uses ${REF} in value", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: WHO=world\nrun:\n    $set MSG = "hello"\n    $append MSG " \${WHO}"\n    emit(text="\${MSG}")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["hello world"]);
  });

  it("emit body resolves ${VAR}", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: NAME=Perry\nrun:\n    emit(text="Hi \${NAME}")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["Hi Perry"]);
  });
});

describe("v0.7.0 — parser accepts ${VAR} in defer-int contexts", () => {
  it("# Timeout: ${SECS} defers to runtime resolution", () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: SECS=30\n# Timeout: \${SECS}\nrun:\n    emit(text="ok")\ndefault: run\n`;
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.timeout).toBe("${SECS}");
  });

  it("> limit=${MAX} defers to runtime resolution", () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: MAX=10\nrun:\n    $ data_read mode=fts query="x" limit=\${MAX} connector=primary -> R\ndefault: run\n`;
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
  });
});

describe("v0.7.0 — ${VAR} field access via single-equals diagnostic", () => {
  it("if ${VAR} = \"x\" emits single-= diagnostic with ${} rewrite", () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: A=x\nrun:\n    if \${A} = "x":\n        emit(text="ok")\ndefault: run\n`;
    const parsed = parse(src);
    expect(parsed.parseErrors.length).toBeGreaterThan(0);
    expect(parsed.parseErrors[0]).toMatch(/use `==` for equality/);
    expect(parsed.parseErrors[0]).toMatch(/\$\{A\} == "x"/);
  });
});
