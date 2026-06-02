import { describe, it, expect } from "vitest";
import { applyFilter } from "../src/filters.js";
import { evalCondition } from "../src/runtime.js";
import { lint } from "../src/lint.js";

/**
 * v0.16.6 — `|contains:"X"` filter.
 *
 * Boolean substring/membership check. Type-aware with JSON-string
 * tolerance — mirrors the `in` / `not in` conditional operators per
 * Perry's `4235ef2b` pushback. The first filter to operate on structured
 * types because the conditional primitives already do; filter-as-
 * conditional-primitive is the design line.
 *
 * Return convention: "true" on match, "" (empty string) on miss. Matches
 * runtime.ts `isTruthy` — empty string falsy, non-empty truthy. Authors
 * write `if ${R|contains:"X"}:` and it works the way the syntax suggests.
 */

describe("v0.16.6 — |contains: filter (unit-level)", () => {
  it("returns 'true' when LHS string contains substring", () => {
    expect(applyFilter("hello world", "contains", "world")).toBe("true");
    expect(applyFilter("hello world", "contains", "hello")).toBe("true");
  });

  it("returns '' when LHS string does not contain substring", () => {
    expect(applyFilter("hello world", "contains", "xyz")).toBe("");
  });

  it("type-aware: LHS resolves to JSON-array string → element membership (not substring)", () => {
    // The structural close from Perry's pushback. Pure-substring would
    // silently match "a" inside the stringified '["alphabet"]'; type-aware
    // checks element membership instead.
    expect(applyFilter('["alphabet"]', "contains", "a")).toBe("");
    expect(applyFilter('["alphabet"]', "contains", "alphabet")).toBe("true");
    expect(applyFilter('["a","b","c"]', "contains", "a")).toBe("true");
    expect(applyFilter('["a","b","c"]', "contains", "z")).toBe("");
  });

  it("element-membership uses stringify-then-compare (mirror of `in` operator)", () => {
    // `["1","2","3"]` contains "1" (string match)
    expect(applyFilter('["1","2","3"]', "contains", "1")).toBe("true");
    // [1,2,3] (JSON numbers) → stringified elements → "1" matches
    expect(applyFilter("[1,2,3]", "contains", "1")).toBe("true");
    // Numeric 1 doesn't match string "x"
    expect(applyFilter("[1,2,3]", "contains", "x")).toBe("");
  });

  it("substring match on non-JSON-parseable strings (the legacy filter shape)", () => {
    expect(applyFilter("yes urgent here", "contains", "urgent")).toBe("true");
    expect(applyFilter("YES URGENT HERE", "contains", "urgent")).toBe("");  // case-sensitive
  });

  it("empty-arg matches any non-empty string but no array element (unless array has empty-string element)", () => {
    expect(applyFilter("hello", "contains", "")).toBe("true");  // every string contains ""
    expect(applyFilter('["a","b"]', "contains", "")).toBe("");  // no empty-string element
    expect(applyFilter('["","a"]', "contains", "")).toBe("true");  // has empty-string element
  });

  it("throws when arg is omitted (`|contains` without ':\"X\"')", () => {
    expect(() => applyFilter("anything", "contains")).toThrow(/requires.*arg/i);
  });

  it("non-array JSON value falls through to substring semantics", () => {
    // JSON-parseable but not an array → substring path
    expect(applyFilter("42", "contains", "4")).toBe("true");
    expect(applyFilter('{"x":1}', "contains", "x")).toBe("true");
    expect(applyFilter("null", "contains", "u")).toBe("true");
  });
});

describe("v0.16.6 — |contains: in conditional context", () => {
  it("`if ${R|contains:\"X\"}:` evaluates as expected truthy-path", () => {
    const vars = new Map<string, unknown>([["R", "Reply: urgent — ticket TR-1234"]]);
    expect(evalCondition('${R|contains:"urgent"}', vars)).toBe(true);
    expect(evalCondition('${R|contains:"quiet"}', vars)).toBe(false);
  });

  it("on a list-shaped value: element membership matches `in` semantics", () => {
    const vars = new Map<string, unknown>([
      ["L", ["a", "b", "c"]],
      ["A", "a"],
      ["Z", "z"],
    ]);
    expect(evalCondition('${L|contains:"a"}', vars)).toBe(true);
    expect(evalCondition('${L|contains:"z"}', vars)).toBe(false);
    // Cognitive symmetry: `if ${A} in ${L}:` returns the same answer as
    // `if ${L|contains:"a"}:` because the LHS resolves to "a" either way.
    expect(evalCondition('${A} in ${L}', vars)).toBe(true);
    expect(evalCondition('${Z} in ${L}', vars)).toBe(false);
  });

  it("JSON-string-of-list tolerance: list arriving as JSON string is treated as list", () => {
    // Common pattern: $ llm prompts for a JSON array and the string parses cleanly
    const vars = new Map<string, unknown>([["JSON_LIST", '["alphabet"]']]);
    // Element membership, not substring — "a" is NOT in the list
    expect(evalCondition('${JSON_LIST|contains:"a"}', vars)).toBe(false);
    // "alphabet" IS in the list
    expect(evalCondition('${JSON_LIST|contains:"alphabet"}', vars)).toBe(true);
  });

  it("composes with `not` and `==` shapes", () => {
    const vars = new Map<string, unknown>([["R", "urgent"]]);
    // `not` short-circuit
    expect(evalCondition('not ${R|contains:"quiet"}', vars)).toBe(true);
    expect(evalCondition('not ${R|contains:"urgent"}', vars)).toBe(false);
    // Explicit equality form
    expect(evalCondition('${R|contains:"urgent"} == "true"', vars)).toBe(true);
    expect(evalCondition('${R|contains:"quiet"} == "true"', vars)).toBe(false);
  });
});

describe("v0.16.6 — |contains: + lint integration", () => {
  it("is in KNOWN_FILTERS — `unknown-filter` lint passes on a contains usage", async () => {
    const source = `# Skill: probe
# Status: Draft
t:
    $ llm prompt="Reply with one word: urgent or quiet" -> VERDICT
    if \${VERDICT|contains:"urgent"}:
        emit(text="paged")
default: t
`;
    const result = await lint(source);
    const f = result.findings.find((x) => x.rule === "unknown-filter");
    expect(f).toBeUndefined();
  });

  it("typo'd filter name (`|containss:`) fires unknown-filter", async () => {
    const source = `# Skill: probe
# Status: Draft
t:
    $ llm prompt="x" -> R
    if \${R|containss:"urgent"}:
        emit(text="bad")
default: t
`;
    const result = await lint(source);
    const f = result.findings.find((x) => x.rule === "unknown-filter");
    expect(f).toBeDefined();
  });
});
