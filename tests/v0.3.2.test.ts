import { describe, it, expect } from "vitest";
import { applyFilter } from "../src/filters.js";
import { parse } from "../src/parser.js";
import { compile } from "../src/compile.js";
import { execute, evalCondition } from "../src/runtime.js";
import { lint } from "../src/lint.js";
import { helpResponse } from "../src/help-content.js";
import { bootstrap } from "../src/bootstrap.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.3.2 — `|json_parse` filter + `and`/`or`/`not` boolean connectives.
 * Spec drafted in `d01c9ab9`, refined for recursive structural
 * decomposition (not a full parser) in `08759d74`. The 80% case is two
 * simple conditions joined by a connective; 20% is parenthesized
 * sub-expressions and `not` prefix.
 */

describe("v0.3.2 — |json_parse filter (removed in v0.3.3)", () => {
  // Filter yanked in v0.3.3 in favor of `$ json_parse $(VAR) -> OUT` op.
  // Keep negative-coverage so regression catches any reintroduction.
  it("|json_parse filter rejects with unknown-filter error", () => {
    expect(() => applyFilter('{"a":1}', "json_parse")).toThrow(/Unknown filter/);
  });
});

describe("v0.3.2 — and/or/not boolean connectives", () => {
  const vars = new Map<string, unknown>([["X", "foo"], ["Y", "bar"], ["EMPTY", ""], ["N", 5]]);

  it("AND evaluates both operands when LHS true", () => {
    expect(evalCondition('$(X) == "foo" and $(Y) == "bar"', vars)).toBe(true);
    expect(evalCondition('$(X) == "foo" and $(Y) == "wrong"', vars)).toBe(false);
  });

  it("OR — first true wins", () => {
    expect(evalCondition('$(X) == "wrong" or $(Y) == "bar"', vars)).toBe(true);
    expect(evalCondition('$(X) == "wrong" or $(Y) == "wrong"', vars)).toBe(false);
  });

  it("NOT flips the result", () => {
    expect(evalCondition("not $(X)", vars)).toBe(false);
    expect(evalCondition("not $(EMPTY)", vars)).toBe(true);
    expect(evalCondition('not $(X) == "wrong"', vars)).toBe(true);
  });

  it("standard precedence: comparison > not > and > or", () => {
    // `a and b or c` parses as `(a and b) or c`
    expect(evalCondition('$(X) == "foo" and $(Y) == "wrong" or $(Y) == "bar"', vars)).toBe(true);
    // `a or b and c` parses as `a or (b and c)`
    expect(evalCondition('$(X) == "wrong" or $(X) == "foo" and $(Y) == "bar"', vars)).toBe(true);
  });

  it("parentheses override precedence", () => {
    expect(evalCondition('($(X) == "wrong" or $(Y) == "bar") and $(X) == "foo"', vars)).toBe(true);
    expect(evalCondition('($(X) == "wrong" or $(Y) == "wrong") and $(X) == "foo"', vars)).toBe(false);
  });

  it("short-circuit: AND skips RHS if LHS false", () => {
    // RHS would throw if eagerly evaluated (unresolved ref); LHS-false short-circuit avoids it.
    expect(evalCondition('$(X) == "wrong" and $(UNRESOLVED) == "bar"', vars)).toBe(false);
  });

  it("short-circuit: OR skips RHS if LHS true", () => {
    // Same shape, LHS-true short-circuit.
    expect(evalCondition('$(X) == "foo" or $(UNRESOLVED) == "bar"', vars)).toBe(true);
  });

  it("quote-aware splitting: doesn't split on `and` inside a quoted literal", () => {
    const vars2 = new Map<string, unknown>([["MSG", "wait and see"]]);
    expect(evalCondition('$(MSG) == "wait and see"', vars2)).toBe(true);
  });

  it("3-term AND chain works", () => {
    const vars3 = new Map<string, unknown>([["A", "1"], ["B", "1"], ["C", "1"]]);
    expect(evalCondition('$(A) == "1" and $(B) == "1" and $(C) == "1"', vars3)).toBe(true);
  });

  it("not combined with and/or", () => {
    expect(evalCondition('not $(X) == "wrong" and $(Y) == "bar"', vars)).toBe(true);
    expect(evalCondition('not ($(X) == "wrong" or $(Y) == "wrong")', vars)).toBe(true);
  });
});

describe("v0.3.2 — compound conditions in elif chains", () => {
  it("elif uses same compound grammar as if", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: X=foo, Y=bar\nrun:\n    if $(X) == "wrong" and $(Y) == "wrong":\n        ! impossible\n    elif $(X) == "foo" or $(Y) == "wrong":\n        ! elif-hit\n    else:\n        ! fallthrough\ndefault: run\n`;
    const home = mkdtempSync(join(tmpdir(), "v032-elif-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toContain("elif-hit");
    expect(result.emissions).not.toContain("fallthrough");
  });
});

describe("v0.3.2 — parser accepts compound conditions", () => {
  it("if with `and` parses cleanly", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    if $(X) == "a" and $(Y) == "b":\n        ! both\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });

  it("if with `or` parses cleanly", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    if $(X) == "a" or $(Y) == "b":\n        ! either\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });

  it("if with `not` parses cleanly", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    if not $(X):\n        ! falsy\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });

  it("if with parenthesized compound parses cleanly", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    if ($(A) == "1" or $(B) == "2") and $(C) == "3":\n        ! ok\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });
});

describe("v0.3.2 — help surface", () => {
  it("ops topic does not list |json_parse filter (removed v0.3.3)", () => {
    const r = helpResponse("ops", "0.3.2") as { content: string };
    expect(r.content).not.toMatch(/\| `json_parse` \|/);
  });

  it("ops topic documents and/or/not compound conditions", () => {
    const r = helpResponse("ops", "0.3.2") as { content: string };
    expect(r.content).toMatch(/Compound conditions/);
    expect(r.content).toMatch(/[Ss]hort-circuit/);
    expect(r.content).toMatch(/Precedence/);
  });

  it("ops topic shows compound examples", () => {
    const r = helpResponse("ops", "0.3.2") as { content: string };
    expect(r.content).toMatch(/and \$\(B\) == "ok"/);
    expect(r.content).toMatch(/or \$\(B\)/);
    expect(r.content).toMatch(/not \$\(VAR\)/);
  });
});

describe("v0.3.2 — undeclared-var lint walks compound conditions", () => {
  it("catches undeclared ref on either side of and/or", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: X=foo\nrun:\n    if $(X) == "foo" and $(UNDECLARED) == "ok":\n        ! ok\ndefault: run\n`;
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "undeclared-var" && /UNDECLARED/.test(x.message));
    expect(f).toBeDefined();
  });

  it("catches undeclared ref inside not prefix", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    if not $(UNDECLARED_NOT):\n        ! ok\ndefault: run\n`;
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "undeclared-var" && /UNDECLARED_NOT/.test(x.message));
    expect(f).toBeDefined();
  });
});
