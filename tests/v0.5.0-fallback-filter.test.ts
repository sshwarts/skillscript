import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { lint } from "../src/lint.js";
import { parseFilterChain } from "../src/filters.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.5.0 item 4 — `|fallback:"value"` filter for missing-field defaulting.
 *
 * Cold-author UX: lets authors write `$(PARSED.optional_field|fallback:"none")`
 * without having to gate on existence first. Bash analogue: `${VAR:-default}`.
 * Positional within the chain; later filters can compose on top of the
 * defaulted value.
 *
 * Naming note (Perry/CC thread 15a50e29): named `fallback` (not `default`)
 * to align vocabulary with op-level `(fallback:)`. Adjacent concept
 * (coalesce-on-missing-ref) shares the universal word "fallback" without
 * conflating the syntactic site.
 */

async function runSkill(src: string): Promise<{ emissions: string[]; errors: unknown[]; vars: Map<string, unknown> }> {
  const home = mkdtempSync(join(tmpdir(), "v050-fb-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  const compiled = await compile(src);
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
  return { emissions: result.emissions, errors: result.errors, vars: result.vars };
}

describe("v0.5.0 item 4 — parseFilterChain helper", () => {
  it("parses bare filter chain", () => {
    expect(parseFilterChain("|trim|upper")).toEqual([
      { name: "trim" },
      { name: "upper" },
    ]);
  });

  it("parses fallback with arg", () => {
    expect(parseFilterChain("|fallback:\"none\"")).toEqual([{ name: "fallback", arg: "none" }]);
  });

  it("parses mixed chain", () => {
    expect(parseFilterChain("|trim|fallback:\"none\"|length")).toEqual([
      { name: "trim" },
      { name: "fallback", arg: "none" },
      { name: "length" },
    ]);
  });

  it("returns [] for empty/undefined chain", () => {
    expect(parseFilterChain("")).toEqual([]);
    expect(parseFilterChain(undefined)).toEqual([]);
  });

  it("tolerates whitespace", () => {
    expect(parseFilterChain(" | trim | fallback : \"x\" ")).toEqual([
      { name: "trim" },
      { name: "fallback", arg: "x" },
    ]);
  });
});

describe("v0.5.0 item 4 — runtime substitution with |fallback", () => {
  it("resolved ref → fallback is no-op", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: NAME=admin\nrun:\n    emit(text="Hello $(NAME|fallback:"stranger")!")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["Hello admin!"]);
  });

  it("undeclared field on parsed JSON → fallback substitutes", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: PAYLOAD={"name":"admin"}\nrun:\n    $ json_parse $(PAYLOAD) -> P\n    emit(text="Hello $(P.email|fallback:"<no email>")!")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["Hello <no email>!"]);
  });

  it("nested field on parsed JSON, missing → fallback", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: PAYLOAD={"user":{"name":"admin"}}\nrun:\n    $ json_parse $(PAYLOAD) -> P\n    emit(text="tier=$(P.user.tier|fallback:"free")")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["tier=free"]);
  });

  it("fallback value with subsequent filter (length on defaulted string)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="len=$(MISSING|fallback:"hello"|length)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["len=5"]);
  });

  it("fallback + upstream filter (trim before fallback)", async () => {
    // Author chain trims first; when ref is missing, fallback substitutes
    // its arg (with spaces preserved — the trim already ran in chain
    // position, and won't reapply post-fallback).
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="result=[$(MISSING|fallback:"  has space  "|trim)]")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["result=[has space]"]);
  });

  it("fallback empty string arg works", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="result=[$(MISSING|fallback:"")]")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["result=[]"]);
  });

  it("without fallback, missing ref throws (regression)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: PAYLOAD={"name":"admin"}\nrun:\n    $ json_parse $(PAYLOAD) -> P\n    emit(text="$(P.email)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("v0.5.0 item 4 — lint", () => {
  it("undeclared-var suppressed when |fallback appears", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="Hello $(TOTALLY_UNDECLARED|fallback:"world")!")\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "undeclared-var")).toBeUndefined();
  });

  it("undeclared-var fires when |fallback absent (regression)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="Hello $(TOTALLY_UNDECLARED)!")\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "undeclared-var")).toBeDefined();
  });

  it("unknown-filter does NOT fire on |fallback", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: X=admin\nrun:\n    emit(text="$(X|fallback:"none")")\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "unknown-filter")).toBeUndefined();
  });

  it("unknown-filter still fires on unknown filter alongside |fallback", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: X=admin\nrun:\n    emit(text="$(X|fallback:"none"|nosuchfilter)")\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "unknown-filter")).toBeDefined();
  });

  it("old name |default: is now an unknown filter (vocabulary alignment fence)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: X=admin\nrun:\n    emit(text="$(X|default:"none")")\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "unknown-filter")).toBeDefined();
  });
});

describe("v0.5.0 item 4 — condition contexts", () => {
  it("if $(MISSING|fallback:\"yes\") == \"yes\" works", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    if $(MAYBE|fallback:"yes") == "yes":\n        emit(text="matched")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["matched"]);
  });
});
