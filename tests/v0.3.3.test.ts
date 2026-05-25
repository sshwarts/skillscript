import { describe, it, expect } from "vitest";
import { applyFilter, KNOWN_FILTERS } from "../src/filters.js";
import { parse } from "../src/parser.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { lint } from "../src/lint.js";
import { helpResponse } from "../src/help-content.js";
import { bootstrap } from "../src/bootstrap.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.3.3 — `$ json_parse $(VAR) -> OUT` op + `|json_parse` filter removal.
 * Closes the spec promise from `af14b7d8` that `|json_parse` couldn't
 * satisfy (string-in/string-out signature can't propagate `.field` access).
 * The op binds the parsed structure so resolveRef's dotted descent works
 * in conditions + emit without grammar/filter surface change.
 */

describe("v0.3.3 — |json_parse filter removed", () => {
  it("KNOWN_FILTERS no longer includes json_parse", () => {
    expect(KNOWN_FILTERS).not.toContain("json_parse");
  });

  it("applyFilter rejects json_parse with unknown-filter error", () => {
    expect(() => applyFilter('{"a":1}', "json_parse")).toThrow(/Unknown filter 'json_parse'/);
  });

  it("error message lists current supported set (no json_parse in supported list)", () => {
    try {
      applyFilter('{"a":1}', "json_parse");
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/url, shell, json, trim, length/);
      // json_parse appears in the "Unknown filter 'json_parse'" prefix but
      // must NOT appear in the "supported:" list.
      const supportedSegment = msg.split("supported:")[1] ?? "";
      expect(supportedSegment).not.toMatch(/json_parse/);
    }
  });
});

describe("v0.3.3 — $ json_parse op (parser)", () => {
  it("parses `$ json_parse $(VAR) -> P` as $ op with outputVar", () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: PAYLOAD={"status":"ok"}\nrun:\n    $ json_parse $(PAYLOAD) -> P\n    ! status: $(P.status)\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    const run = r.targets.get("run")!;
    const op = run.ops[0]!;
    expect(op.kind).toBe("$");
    expect(op.outputVar).toBe("P");
  });

  it("parses with literal JSON argument", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ json_parse "{\\"x\\":1}" -> P\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });
});

async function runSkill(src: string): Promise<{ emissions: string[]; errors: unknown[] }> {
  const home = mkdtempSync(join(tmpdir(), "v033-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  const compiled = await compile(src);
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
  return { emissions: result.emissions, errors: result.errors };
}

describe("v0.3.3 — $ json_parse op (runtime)", () => {
  it("binds parsed object; dotted descent in emit works", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: PAYLOAD={"status":"ok","count":3}\nrun:\n    $ json_parse $(PAYLOAD) -> P\n    ! status: $(P.status), count: $(P.count)\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toContain("status: ok, count: 3");
  });

  it("binds parsed object; dotted descent in conditions works (Perry's spec test case)", async () => {
    // af14b7d8: `if $(P.status) == "ok" and $(P.other)` — short-circuit aware.
    const src = `# Skill: t\n# Status: Approved\n# Vars: PAYLOAD={"status":"ok","other":"yes"}\nrun:\n    $ json_parse $(PAYLOAD) -> P\n    if $(P.status) == "ok" and $(P.other) == "yes":\n        ! both checks passed\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toContain("both checks passed");
  });

  it("binds parsed array; iteration works", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: RAW=[1,2,3]\nrun:\n    $ json_parse $(RAW) -> ITEMS\n    ! count: $(ITEMS|length)\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toContain("count: 3");
  });

  it("throws structured error on malformed JSON input", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: BAD={bad\nrun:\n    $ json_parse $(BAD) -> P\n    ! shouldn't reach\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors.length).toBeGreaterThan(0);
    const msg = JSON.stringify(result.errors[0]);
    expect(msg).toMatch(/not valid JSON/);
  });

  it("throws when input expression is empty", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ json_parse  -> P\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors.length).toBeGreaterThan(0);
    const msg = JSON.stringify(result.errors[0]);
    expect(msg).toMatch(/requires an input expression/);
  });
});

describe("v0.3.3 — unparsed-json-field-access advisory", () => {
  it("fires on `$(VAR|json_parse).field` in emit body", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: PAYLOAD={"status":"ok"}\nrun:\n    ! status: $(PAYLOAD|json_parse).status\ndefault: run\n`;
    const r = await lint(src);
    const finding = r.findings.find((f) => f.rule === "unparsed-json-field-access");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
    expect(finding!.message).toMatch(/`\$ json_parse \$\(VAR\) -> P`/);
  });

  it("in-condition bad shape is caught by parser invalid-conditional-syntax (with $ json_parse remediation)", async () => {
    // The parser rejects the condition before lint walks the AST; the
    // remediation path is the updated invalid-conditional-syntax message
    // (Bug B), not the advisory. The advisory targets non-condition
    // contexts (emit, $set RHS, etc.) where the parser doesn't reject.
    const src = `# Skill: t\n# Status: Approved\n# Vars: PAYLOAD={"status":"ok"}\nrun:\n    if $(PAYLOAD|json_parse).status == "ok":\n        ! ok\ndefault: run\n`;
    const r = await lint(src);
    const condErr = r.findings.find((f) => f.rule === "invalid-conditional-syntax");
    expect(condErr).toBeDefined();
    expect(condErr!.message).toMatch(/\$ json_parse/);
  });

  it("does not fire on `$(VAR|json_parse)` without `.field`", async () => {
    // Bare `$(X|json_parse)` is a separate concern — runtime applyFilter
    // will throw unknown-filter. The advisory targets the field-access
    // shape specifically.
    const src = `# Skill: t\n# Status: Approved\nrun:\n    ! raw: $(PAYLOAD|json_parse)\ndefault: run\n`;
    const r = await lint(src);
    const finding = r.findings.find((f) => f.rule === "unparsed-json-field-access");
    expect(finding).toBeUndefined();
  });
});

describe("v0.3.3 — invalid-conditional-syntax message updates", () => {
  it("dropped stale 'v1 excludes AND/OR' text", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    if $(X|wat):\n        ! ok\ndefault: run\n`;
    const r = parse(src);
    // not a v0.3.3-introduced rejection; just sanity that the old text isn't there
    const allErrs = r.parseErrors.join(" ");
    expect(allErrs).not.toMatch(/v1 explicitly excludes/);
  });

  it("error text points at `$ json_parse` for the bad shape", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: P={"x":1}\nrun:\n    if $(P|json_parse).x == "1":\n        ! ok\ndefault: run\n`;
    const r = parse(src);
    const errs = r.parseErrors.join(" ");
    expect(errs).toMatch(/Unsupported condition/);
    expect(errs).toMatch(/\$ json_parse/);
  });
});

describe("v0.3.3 — compile_skill warnings/advisories surface (Bug C)", () => {
  it("CompileResult carries tier-2 lint findings on warnings", async () => {
    // `?` op triggers deprecated-question (tier-2 warning).
    const src = `# Skill: t\n# Status: Approved\nrun:\n    ? what should I do\n    ! decided\ndefault: run\n`;
    const result = await compile(src);
    expect(result.warnings.some((w) => w.startsWith("deprecated-question:"))).toBe(true);
  });

  it("CompileResult.advisories is an array (empty for clean skills)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="hello")\ndefault: run\n`;
    const result = await compile(src);
    expect(Array.isArray(result.advisories)).toBe(true);
    expect(result.advisories).toEqual([]);
  });

  it("CompileResult.warnings stays empty for clean skills", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="hello")\ndefault: run\n`;
    const result = await compile(src);
    expect(result.warnings).toEqual([]);
  });
});

describe("v0.3.3 — indent cascade sanity (Bug D)", () => {
  // When validateCondition rejects an `if` line, the body lines remain
  // correctly-indented relative to the rejected `if`. Confirm the parser
  // doesn't emit a spurious "Mid-block indent change" cascade for these
  // shapes — only the real condition error should surface.
  const expectCondErrorOnly = (src: string): void => {
    const r = parse(src);
    const condErrs = r.parseErrors.filter((m) => /Unsupported condition/.test(m));
    const indentErrs = r.parseErrors.filter((m) => /Mid-block indent change/.test(m));
    expect(condErrs.length).toBeGreaterThan(0);
    expect(indentErrs).toEqual([]);
  };

  it("no indent cascade on rejected `$(X|filter).field == \"v\"` shape", () => {
    expectCondErrorOnly(`# Skill: t\n# Status: Approved\n# Vars: P={"a":1}\nrun:\n    if $(P|json_parse).a == "1":\n        ! ok\ndefault: run\n`);
  });

  it("no indent cascade on rejected `defined($(X))` shape", () => {
    expectCondErrorOnly(`# Skill: t\n# Status: Approved\nrun:\n    if defined($(X)):\n        ! ok\ndefault: run\n`);
  });

  it("no indent cascade on rejected numeric-literal-LHS shape", () => {
    expectCondErrorOnly(`# Skill: t\n# Status: Approved\nrun:\n    if "5" == $(N):\n        ! ok\ndefault: run\n`);
  });
});

describe("v0.3.3 — help surface", () => {
  it("ops topic documents $ json_parse op with worked example", () => {
    const r = helpResponse("ops", "0.3.3") as { content: string };
    // v0.7.2: ${VAR} canonical substitution in worked examples
    expect(r.content).toMatch(/\$ json_parse \$\{VAR\}/);
    expect(r.content).toMatch(/binds the structured value/);
  });

  it("ops topic does not list json_parse as a filter", () => {
    const r = helpResponse("ops", "0.3.3") as { content: string };
    expect(r.content).not.toMatch(/\| `json_parse` \|/);
  });

  it("lint-codes topic includes unparsed-json-field-access", () => {
    const r = helpResponse("lint-codes", "0.3.3") as { content: string };
    expect(r.content).toMatch(/`unparsed-json-field-access`/);
  });
});
