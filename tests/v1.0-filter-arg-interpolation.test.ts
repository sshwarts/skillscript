import { describe, it, expect } from "vitest";
import { substituteRuntime, evalCondition, execute } from "../src/runtime.js";
import { compile } from "../src/compile.js";
import { lint } from "../src/lint.js";
import { Registry } from "../src/connectors/registry.js";

/**
 * v1.0 (fix list 33bf53d3 P1.1) — filter arguments interpolate ${VAR} / $(VAR).
 *
 * Round-1 cold-author finding (the ONE true silent-failure of the testing ring):
 * `${TITLE|contains:"${KW}"}` took the literal string "${KW}" as the filter arg
 * and silently failed to match — `errors:[]`, no diagnostic. It broke
 * `cold-feed-filter`'s KEYWORD parameterization (the author gave up and hardcoded
 * "AI", making the var decorative).
 *
 * Fix: interpolate the filter arg against the var scope at every apply surface —
 * substitution (`substituteRuntime`), conditions (`applyFilterChain[Condition]`),
 * and a compile-time defer guard so a ref-bearing arg is never baked with the
 * wrong (literal-arg) result. FAIL-LOUD: an unresolved ref inside the arg now
 * raises `UnresolvedVariableError` like any other ref, never a silent literal.
 */

const NO_SHELL: string[] = [];

async function run(source: string, inputs: Record<string, string> = {}) {
  const compiled = await compile(source, { skipLintPreflight: true });
  return execute(compiled.parsed, { ...compiled.resolvedVariables, ...inputs }, compiled.targetOrder, {
    registry: new Registry(),
    shellAllowlist: NO_SHELL,
    enableUnsafeShell: false,
  });
}

describe("v1.0 — filter-arg ${VAR} interpolation (substitution surface)", () => {
  it("interpolates the ref inside the filter arg (positive match)", () => {
    const vars = new Map<string, unknown>([["TITLE", "a story about AI safety"], ["KW", "AI"]]);
    expect(substituteRuntime('${TITLE|contains:"${KW}"}', vars)).toBe("true");
  });

  it("interpolated arg yields a correct NEGATIVE (not always-true)", () => {
    const vars = new Map<string, unknown>([["TITLE", "a story about cats"], ["KW", "AI"]]);
    expect(substituteRuntime('${TITLE|contains:"${KW}"}', vars)).toBe("");
  });

  it("changing the ref value changes the match — real parameterization", () => {
    const hit = new Map<string, unknown>([["T", "learning python"], ["KW", "python"]]);
    const miss = new Map<string, unknown>([["T", "learning python"], ["KW", "rust"]]);
    expect(substituteRuntime('${T|contains:"${KW}"}', hit)).toBe("true");
    expect(substituteRuntime('${T|contains:"${KW}"}', miss)).toBe("");
  });

  it("literal (ref-free) filter arg still works unchanged — no regression", () => {
    const vars = new Map<string, unknown>([["TITLE", "a story about AI"]]);
    expect(substituteRuntime('${TITLE|contains:"AI"}', vars)).toBe("true");
    expect(substituteRuntime('${TITLE|contains:"zzz"}', vars)).toBe("");
  });

  it("legacy $(VAR) ref inside the arg also interpolates", () => {
    const vars = new Map<string, unknown>([["TITLE", "a story about AI"], ["KW", "AI"]]);
    expect(substituteRuntime('$(TITLE|contains:"$(KW)")', vars)).toBe("true");
  });

  it("|fallback arg interpolates the ref", () => {
    const vars = new Map<string, unknown>([["MISSING", ""], ["DEF", "backup-value"]]);
    expect(substituteRuntime('${MISSING|fallback:"${DEF}"}', vars)).toBe("backup-value");
  });

  it("FAIL-LOUD: unresolved ref inside the arg raises (never a silent literal)", () => {
    const vars = new Map<string, unknown>([["TITLE", "x"]]);
    expect(() => substituteRuntime('${TITLE|contains:"${NOPE}"}', vars)).toThrow();
  });
});

describe("v1.0 — filter-arg ${VAR} interpolation (condition surface)", () => {
  it("if ${T|contains:\"${KW}\"} interpolates in conditions (positive)", () => {
    const vars = new Map<string, unknown>([["T", "learning python today"], ["KW", "python"]]);
    expect(evalCondition('${T|contains:"${KW}"}', vars)).toBe(true);
  });

  it("condition is false when the interpolated arg is absent", () => {
    const vars = new Map<string, unknown>([["T", "learning rust today"], ["KW", "python"]]);
    expect(evalCondition('${T|contains:"${KW}"}', vars)).toBe(false);
  });

  it("== comparison with an interpolated filter arg on the LHS", () => {
    const vars = new Map<string, unknown>([["T", "abc"], ["KW", "b"]]);
    expect(evalCondition('${T|contains:"${KW}"} == "true"', vars)).toBe(true);
  });
});

describe("v1.0 — filter-arg interpolation: lint stays clean", () => {
  it("a filter arg containing ${...} does not raise a tier-1 diagnostic", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      '# Vars: TITLE="x about AI", KW="AI"',
      "run:",
      '    emit(text="${TITLE|contains:\\"${KW}\\"}")',
      "default: run",
      "",
    ].join("\n");
    const result = await lint(src);
    expect(result.errorCount).toBe(0);
  });
});

describe("v1.0 — filter-arg interpolation: end-to-end (compile-defer guard)", () => {
  // Declared-static LHS means the compile-time substituter would resolve TITLE
  // and (pre-fix) bake `contains(TITLE, "${KW}")` = "" into the op body. The
  // defer guard must pass the ref-bearing arg through to runtime instead.
  it("declared-LHS op body interpolates at runtime, not baked wrong at compile (positive)", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Output: text",
      '# Vars: TITLE="a story about AI safety", KW="AI"',
      "run:",
      '    emit(text="hit=${TITLE|contains:\\"${KW}\\"}")',
      "default: run",
      "",
    ].join("\n");
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.outputs?.["text"]).toBe("hit=true");
  });

  it("end-to-end negative — wrong keyword yields empty, proving real interpolation", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Output: text",
      '# Vars: TITLE="a story about cats", KW="AI"',
      "run:",
      '    emit(text="hit=${TITLE|contains:\\"${KW}\\"}")',
      "default: run",
      "",
    ].join("\n");
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.outputs?.["text"]).toBe("hit=");
  });
});

describe("v1.0 — filter-arg interpolation: injection / special-char safety", () => {
  // The key injection guard: interpolation is SINGLE-PASS. If the resolved
  // arg value itself contains `${...}`, it must NOT be re-expanded — otherwise
  // a runtime-controlled value could expand a ref the author never wrote
  // (data → code). Discriminating case: KW resolves to the literal "${SECRET}";
  // a double-expand would leak SECRET's value and match "...leaked...".
  it("does NOT recursively expand a ref that appears in the resolved arg value", () => {
    const vars = new Map<string, unknown>([
      ["KW", "${SECRET}"],
      ["SECRET", "leaked"],
      ["TITLE", "contains leaked marker"],
    ]);
    // Single-pass: arg becomes the literal "${SECRET}", which the title does
    // not contain → "". A vulnerable double-expand would yield "true".
    expect(substituteRuntime('${TITLE|contains:"${KW}"}', vars)).toBe("");
  });

  it("matches the literal ${...} text when that IS what the title contains", () => {
    const vars = new Map<string, unknown>([
      ["KW", "${SECRET}"],
      ["SECRET", "leaked"],
      ["TITLE", "contains ${SECRET} marker"],
    ]);
    expect(substituteRuntime('${TITLE|contains:"${KW}"}', vars)).toBe("true");
  });

  it("treats quote / pipe / brace chars in the resolved arg as literal (no breakout)", () => {
    const quote = new Map<string, unknown>([["Q", 'a"b'], ["T", 'x a"b y']]);
    expect(substituteRuntime('${T|contains:"${Q}"}', quote)).toBe("true");
    const pipe = new Map<string, unknown>([["Q", "p|shell"], ["T", "has p|shell inside"]]);
    expect(substituteRuntime('${T|contains:"${Q}"}', pipe)).toBe("true");
    const brace = new Map<string, unknown>([["Q", "}{"], ["T", "weird }{ chars"]]);
    expect(substituteRuntime('${T|contains:"${Q}"}', brace)).toBe("true");
  });
});

describe("v1.0 — filter-arg interpolation: cold-feed-filter artifact (the original repro)", () => {
  // Reproduces the shape that broke cold-feed-filter: foreach over parsed JSON,
  // filter each item's title by an interpolated KEYWORD var. Pre-fix the author
  // had to hardcode "AI" because ${ITEM.title|contains:"${KEYWORD}"} silently
  // never matched; now the KEYWORD var actually parameterizes the filter.
  // Flat-string array isolates the fix under test (filter-arg interpolation
  // inside a foreach condition) from the orthogonal dotted-field-access-on-
  // foreach-iterator behavior (`${ITEM.title}` resolves empty — separate issue,
  // flagged to Perry).
  const SRC = [
    "# Skill: feed-filter-pattern",
    "# Status: Approved",
    "# Output: text",
    '# Vars: KEYWORD="AI"',
    "run:",
    '    $set RAW = """["AI breakthrough","rust release","more AI news"]"""',
    "    $ json_parse ${RAW} -> ITEMS",
    "    foreach ITEM in ${ITEMS}:",
    '        if ${ITEM|contains:"${KEYWORD}"}:',
    '            emit(text="match: ${ITEM}")',
    "default: run",
    "",
  ].join("\n");

  it("KEYWORD=AI matches the AI items (default)", async () => {
    const r = await run(SRC);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["match: AI breakthrough", "match: more AI news"]);
  });

  it("KEYWORD=rust matches the rust item — the var actually parameterizes now", async () => {
    const r = await run(SRC, { KEYWORD: "rust" });
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["match: rust release"]);
  });
});
