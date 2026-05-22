import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { evalCondition } from "../src/runtime.js";
import { applyFilter, KNOWN_FILTERS } from "../src/filters.js";
import { compile } from "../src/compile.js";
import { TypeMismatchError } from "../src/errors.js";

/**
 * v0.2.5 Item 1 — comparison operators + |length filter (the orchestration
 * carve-out, per Perry's thread f75477a4).
 *
 * Comparison is orchestration; arithmetic + aggregates are tool computation.
 * This patch only extends conditions with `<` / `>` / `<=` / `>=` for
 * thresholds and counts. Non-numeric operands raise TypeMismatchError
 * rather than silently fall back to lexicographic comparison.
 *
 * `|length` returns array element count when the value JSON-parses as an
 * array, otherwise character count. Pairs with the new comparisons for
 * skills like `if $(ITEMS|length) > "0":`.
 */

const vars = (entries: Record<string, unknown>): Map<string, unknown> => new Map(Object.entries(entries));

describe("v0.2.5 — parser accepts new comparison conditions", () => {
  it.each([
    ["$(N) < \"10\"", true],
    ["$(N) > \"10\"", true],
    ["$(N) <= \"10\"", true],
    ["$(N) >= \"10\"", true],
    ["$(A) < $(B)", true],
    ["$(A|trim) > $(B|trim)", true],
    ["$(COUNT|length) >= \"3\"", true],
  ])("parses `%s` as a valid condition", (cond) => {
    const src = `# Skill: x\n# Status: Approved\nt:\n    if ${cond}:\n        ! match\ndefault: t\n`;
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
  });

  it("rejects a malformed comparison", () => {
    const src = `# Skill: x\n# Status: Approved\nt:\n    if 5 < 10:\n        ! match\ndefault: t\n`;
    const parsed = parse(src);
    expect(parsed.parseErrors.length).toBeGreaterThan(0);
  });
});

describe("v0.2.5 — evalCondition: ref vs literal numeric comparison", () => {
  it.each([
    ["$(N) < \"10\"", { N: "5" }, true],
    ["$(N) < \"10\"", { N: "15" }, false],
    ["$(N) > \"10\"", { N: "15" }, true],
    ["$(N) > \"10\"", { N: "5" }, false],
    ["$(N) <= \"10\"", { N: "10" }, true],
    ["$(N) <= \"10\"", { N: "11" }, false],
    ["$(N) >= \"10\"", { N: "10" }, true],
    ["$(N) >= \"10\"", { N: "9" }, false],
  ])("evaluates `%s` with vars %o → %s", (cond, vs, expected) => {
    expect(evalCondition(cond, vars(vs))).toBe(expected);
  });

  it("numeric coercion handles float values", () => {
    expect(evalCondition("$(DELTA) > \"0.5\"", vars({ DELTA: "0.75" }))).toBe(true);
    expect(evalCondition("$(DELTA) > \"0.5\"", vars({ DELTA: "0.25" }))).toBe(false);
  });

  it("uses NUMERIC comparison, not lexicographic (regression guard for the carve-out)", () => {
    // Lexicographic would say "9" < "10" is FALSE (because '9' > '1'). Numeric says TRUE.
    expect(evalCondition("$(N) < \"10\"", vars({ N: "9" }))).toBe(true);
  });

  it("throws TypeMismatchError on non-numeric operand", () => {
    expect(() => evalCondition("$(X) > \"5\"", vars({ X: "abc" }))).toThrow(TypeMismatchError);
    expect(() => evalCondition("$(X) < \"foo\"", vars({ X: "5" }))).toThrow(TypeMismatchError);
  });

  it("TypeMismatchError carries the operator + both operands + ref description", () => {
    try {
      evalCondition("$(X) > \"5\"", vars({ X: "abc" }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TypeMismatchError);
      const e = err as TypeMismatchError;
      expect(e.operator).toBe(">");
      expect(e.lhs).toBe("abc");
      expect(e.rhs).toBe("5");
      expect(e.refDesc).toMatch(/X/);
      expect(e.remediation).toMatch(/numeric/i);
    }
  });
});

describe("v0.2.5 — evalCondition: ref vs ref numeric comparison", () => {
  it("compares two refs numerically", () => {
    expect(evalCondition("$(A) < $(B)", vars({ A: "5", B: "10" }))).toBe(true);
    expect(evalCondition("$(A) < $(B)", vars({ A: "10", B: "5" }))).toBe(false);
    expect(evalCondition("$(A) >= $(B)", vars({ A: "10", B: "10" }))).toBe(true);
  });

  it("filters apply BEFORE comparison on both sides", () => {
    // |trim strips whitespace; comparison then numeric.
    expect(evalCondition("$(A|trim) > $(B|trim)", vars({ A: "  5\n", B: "  3\n" }))).toBe(true);
  });
});

describe("v0.2.5 — |length filter", () => {
  it("is registered in KNOWN_FILTERS", () => {
    expect(KNOWN_FILTERS).toContain("length");
  });

  it("returns array element count for JSON arrays", () => {
    expect(applyFilter("[1, 2, 3]", "length")).toBe("3");
    expect(applyFilter("[]", "length")).toBe("0");
    expect(applyFilter('["a","b","c","d"]', "length")).toBe("4");
  });

  it("returns character count for plain strings", () => {
    expect(applyFilter("hello", "length")).toBe("5");
    expect(applyFilter("", "length")).toBe("0");
    expect(applyFilter("Don't", "length")).toBe("5");
  });

  it("returns character count when JSON parses but isn't an array", () => {
    // Object → falls through to string length.
    expect(applyFilter('{"foo":"bar"}', "length")).toBe("13");
  });

  it("pairs with numeric comparison: `$(LIST|length) > \"0\"` works end-to-end", () => {
    expect(evalCondition('$(L|length) > "0"', vars({ L: "[1,2,3]" }))).toBe(true);
    expect(evalCondition('$(L|length) > "0"', vars({ L: "[]" }))).toBe(false);
    expect(evalCondition('$(L|length) >= "5"', vars({ L: "hello" }))).toBe(true);
  });
});

describe("v0.2.5 — end-to-end: skill with comparison conditions compiles + runs", () => {
  it("threshold skill (the canonical stock-monitor shape) compiles clean", async () => {
    const src = [
      "# Skill: stock-watch",
      "# Description: Alert when delta exceeds threshold",
      "# Status: Approved",
      "# Vars: DELTA=0.0, THRESHOLD=0.05",
      "",
      "evaluate:",
      "    if $(DELTA) >= $(THRESHOLD):",
      "        ! ALERT: $(DELTA) breached $(THRESHOLD)",
      "    else:",
      "        ! ok",
      "",
      "default: evaluate",
      "",
    ].join("\n");
    const result = await compile(src);
    expect(result.skillName).toBe("stock-watch");
    expect(result.targetOrder).toEqual(["evaluate"]);
  });

  it("count-based skill using |length compiles clean", async () => {
    const src = [
      "# Skill: queue-watch",
      "# Status: Approved",
      "# Vars: ITEMS=[]",
      "",
      "check:",
      "    if $(ITEMS|length) > \"0\":",
      "        ! processing $(ITEMS|length) items",
      "    else:",
      "        ! queue empty",
      "",
      "default: check",
      "",
    ].join("\n");
    const result = await compile(src);
    expect(result.skillName).toBe("queue-watch");
  });
});
