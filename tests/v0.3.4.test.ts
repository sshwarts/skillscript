import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { compile } from "../src/compile.js";
import { execute, evalCondition } from "../src/runtime.js";
import { lint } from "../src/lint.js";
import { bootstrap } from "../src/bootstrap.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.3.4 — conditional multi-filter chain + parse-error dedup.
 * Spec approved at `221982fc` (Perry); kickoff at `7bafcc8c`.
 * Item 1 closes the recurring "feature works in substitution but lags
 * in conditional grammar" pattern named in dev-log §14 — third
 * occurrence in the v0.3.x arc.
 */

async function runSkill(src: string): Promise<{ emissions: string[]; errors: unknown[] }> {
  const home = mkdtempSync(join(tmpdir(), "v034-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  const compiled = await compile(src);
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
  return { emissions: result.emissions, errors: result.errors };
}

describe("v0.3.4 item 1 — conditional multi-filter chain (parser)", () => {
  it("parses `if $(X|trim|length) > \"0\":` cleanly", () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: X="  hello  "\nrun:\n    if $(X|trim|length) > "0":\n        emit(text="non-empty")\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });

  it("parses `not in` with chain on LHS", () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: X="a", L=["a","b"]\nrun:\n    if $(X|trim) not in $(L):\n        emit(text="missing")\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });

  it("parses `==` with chain on both sides (EQ_REF)", () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: A=" foo ", B="foo"\nrun:\n    if $(A|trim) == $(B|trim):\n        emit(text="equal")\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });

  it("parses compound condition with chains on both sides", () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: A=" 1 ", B=" 2 "\nrun:\n    if $(A|trim|length) > "0" and $(B|trim|length) > "0":\n        emit(text="both nonempty")\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });

  it("regression: single-filter conditions still parse", () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: COLOR="yellow "\nrun:\n    if $(COLOR|trim) == "yellow":\n        emit(text="matched")\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });

  it("regression: filterless conditions still parse", () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: X="ok"\nrun:\n    if $(X) == "ok":\n        emit(text="matched")\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });
});

describe("v0.3.4 item 1 — conditional multi-filter chain (runtime)", () => {
  it("evaluates chain in CMP: `|trim|length > \"0\"` on whitespace value", () => {
    const vars = new Map<string, unknown>([["X", "  hello  "]]);
    expect(evalCondition(`$(X|trim|length) > "0"`, vars)).toBe(true);
    expect(evalCondition(`$(X|trim|length) > "100"`, vars)).toBe(false);
  });

  it("evaluates chain in EQ: `|trim == \"foo\"`", () => {
    const vars = new Map<string, unknown>([["X", "  foo  "]]);
    expect(evalCondition(`$(X|trim) == "foo"`, vars)).toBe(true);
  });

  it("evaluates chain on both sides of EQ_REF: `|trim == |trim`", () => {
    const vars = new Map<string, unknown>([["A", " foo "], ["B", "foo"]]);
    expect(evalCondition(`$(A|trim) == $(B|trim)`, vars)).toBe(true);
  });

  it("evaluates chain on LHS of IN: `|trim in $(L)`", () => {
    const vars = new Map<string, unknown>([["X", "  a "], ["L", ["a", "b", "c"]]]);
    expect(evalCondition(`$(X|trim) in $(L)`, vars)).toBe(true);
    expect(evalCondition(`$(X|trim) not in $(L)`, vars)).toBe(false);
  });

  it("evaluates chain inside compound condition (cross-feature interaction)", () => {
    const vars = new Map<string, unknown>([["A", " 1 "], ["B", " 2 "]]);
    expect(evalCondition(`$(A|trim|length) > "0" and $(B|trim|length) > "0"`, vars)).toBe(true);
    expect(evalCondition(`$(A|trim|length) > "0" and $(B|trim|length) > "100"`, vars)).toBe(false);
  });

  it("regression: single-filter conditions evaluate as before", () => {
    const vars = new Map<string, unknown>([["COLOR", "yellow "]]);
    expect(evalCondition(`$(COLOR|trim) == "yellow"`, vars)).toBe(true);
  });

  it("end-to-end: emit fires when chain condition holds", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: X="  hello  "\nrun:\n    if $(X|trim|length) > "0":\n        emit(text="non-empty")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toContain("non-empty");
  });
});

describe("v0.3.4 item 2 — parse-error / invalid-conditional-syntax dedup", () => {
  it("rejected condition produces exactly one error (invalid-conditional-syntax, not parse-error echo)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    if defined($(X)):\n        emit(text="ok")\ndefault: run\n`;
    const r = await lint(src);
    const condErrs = r.findings.filter((f) => f.rule === "invalid-conditional-syntax");
    const parseErrs = r.findings.filter((f) => f.rule === "parse-error");
    expect(condErrs.length).toBe(1);
    expect(parseErrs.length).toBe(0);
  });

  it("single-= condition produces single-equals only (no parse-error echo)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    if $(X) = "ok":\n        emit(text="ok")\ndefault: run\n`;
    const r = await lint(src);
    const singleEq = r.findings.filter((f) => f.rule === "single-equals");
    const parseErrs = r.findings.filter((f) => f.rule === "parse-error");
    expect(singleEq.length).toBe(1);
    expect(parseErrs.length).toBe(0);
  });

  it("regression: parse-error still fires on non-conditional parse failures", async () => {
    // Legacy `>` op — produces a parse-error (categorized to malformed-op-grammar
    // via the legacy-form filter). Verifies the parse-error categorizer still
    // fires after the conditional/parse-error dedup fold.
    const src = `# Skill: t\n# Status: Approved\nrun:\n    > legacy retrieval op\ndefault: run\n`;
    const r = await lint(src);
    expect(r.errorCount).toBeGreaterThan(0);
  });
});

describe("v0.3.4 fold — broader parse-error dedup (Perry's adjacent finding)", () => {
  // PARSE_ERROR catch-all double-echoed five tier-1 rules pre-fold:
  // invalid-conditional-syntax + single-equals (caught in original v0.3.4),
  // plus malformed-op-grammar + reserved-keyword + indentation. Same shape
  // for all five; fold extended the dedup regex to cover the trio.

  it("malformed-op-grammar fires alone (no parse-error echo)", async () => {
    // Bare `$append` triggers Malformed `$append` op diagnostic.
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $append\n    emit(text="ok")\ndefault: run\n`;
    const r = await lint(src);
    const malformed = r.findings.filter((f) => f.rule === "malformed-op-grammar");
    const parseErrs = r.findings.filter((f) => f.rule === "parse-error");
    expect(malformed.length).toBeGreaterThan(0);
    expect(parseErrs.length).toBe(0);
  });

  it("reserved-keyword fires alone (no parse-error echo)", async () => {
    // Using `if` as a variable name triggers reserved-keyword diagnostic.
    const src = `# Skill: t\n# Status: Approved\n# Vars: if="oops"\nrun:\n    emit(text="$(if)")\ndefault: run\n`;
    const r = await lint(src);
    const reserved = r.findings.filter((f) => f.rule === "reserved-keyword");
    const parseErrs = r.findings.filter((f) => f.rule === "parse-error");
    expect(reserved.length).toBeGreaterThan(0);
    expect(parseErrs.length).toBe(0);
  });

  it("indentation (mid-block indent change) fires alone (no parse-error echo)", async () => {
    // Mismatched indent within a target body triggers indentation
    // diagnostic. Note: this fires AFTER the parser builds the AST, so
    // op-level parsing succeeds first.
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="line1")\n      emit(text="mismatched indent")\ndefault: run\n`;
    const r = await lint(src);
    const indent = r.findings.filter((f) => f.rule === "indentation");
    const parseErrs = r.findings.filter((f) => f.rule === "parse-error");
    expect(indent.length).toBeGreaterThan(0);
    expect(parseErrs.length).toBe(0);
  });
});
