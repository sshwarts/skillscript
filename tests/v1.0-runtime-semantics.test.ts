/**
 * v1.0 runtime-semantics test battery — Lane (a): filter runtime behavior.
 *
 * Closes the gap Perry flagged in f6b479f5 #2: existing test suite is heavy
 * on compile/lint and light on execute-and-assert-output for the frozen-
 * surface primitives. This file pins runtime semantics for each filter via
 * compile + execute, asserting on the emitted output (not on the filter
 * impl directly), so v1.0 freeze cannot drift without a red test.
 *
 * Filters covered (all eight in KNOWN_FILTERS): |length, |trim, |json,
 * |fallback:, |contains:, |url, |shell, |isodate.
 *
 * Pattern: compile + execute a small skill source that uses the filter,
 * assert on result.emissions. Skips lint preflight where the fixture
 * intentionally exercises edge cases.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";

async function run(source: string, inputs: Record<string, string> = {}) {
  const compiled = await compile(source, { skipLintPreflight: true });
  return execute(compiled.parsed, { ...compiled.resolvedVariables, ...inputs }, compiled.targetOrder, {
    registry: new Registry(),
  });
}

function skill(body: string): string {
  return `# Skill: t
# Status: Approved

run:
${body}

default: run
`;
}

describe("v1.0 runtime — |length filter", () => {
  it("JSON array → element count", async () => {
    const r = await run(skill(`    emit(text="\${L|length}")`), { L: '["a","b","c"]' });
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["3"]);
  });

  it("string → char count (the 90% case)", async () => {
    const r = await run(skill(`    emit(text="\${S|length}")`), { S: "hello" });
    expect(r.emissions).toEqual(["5"]);
  });

  it("JSON-parseable non-array (object) → char count, not field count", async () => {
    const r = await run(skill(`    emit(text="\${O|length}")`), { O: '{"a":1,"b":2}' });
    expect(r.emissions).toEqual([String('{"a":1,"b":2}'.length)]);
  });

  it("empty string → 0", async () => {
    const r = await run(skill(`    emit(text="\${S|length}")`), { S: "" });
    expect(r.emissions).toEqual(["0"]);
  });

  it("empty array → 0", async () => {
    const r = await run(skill(`    emit(text="\${L|length}")`), { L: "[]" });
    expect(r.emissions).toEqual(["0"]);
  });
});

describe("v1.0 runtime — |trim filter", () => {
  it("strips leading + trailing whitespace", async () => {
    const r = await run(skill(`    emit(text="[\${S|trim}]")`), { S: "  hello  " });
    expect(r.emissions).toEqual(["[hello]"]);
  });

  it("whitespace-only string → empty string", async () => {
    const r = await run(skill(`    emit(text="[\${S|trim}]")`), { S: "   \t  " });
    expect(r.emissions).toEqual(["[]"]);
  });

  it("no-whitespace string passes through", async () => {
    const r = await run(skill(`    emit(text="[\${S|trim}]")`), { S: "hello" });
    expect(r.emissions).toEqual(["[hello]"]);
  });
});

describe("v1.0 runtime — |json filter", () => {
  it("idempotent on already-JSON value (parseable string passes through)", async () => {
    const r = await run(skill(`    emit(text="\${V|json}")`), { V: '{"id":"abc"}' });
    expect(r.emissions).toEqual(['{"id":"abc"}']);
  });

  it("wraps non-JSON plain string in quotes", async () => {
    const r = await run(skill(`    emit(text="\${V|json}")`), { V: "hello world" });
    expect(r.emissions).toEqual(['"hello world"']);
  });

  it("JSON-parseable primitives pass through unchanged", async () => {
    const cases: Array<[string, string]> = [
      ["42", "42"],
      ["true", "true"],
      ["null", "null"],
    ];
    for (const [input, expected] of cases) {
      const r = await run(skill(`    emit(text="\${V|json}")`), { V: input });
      expect(r.emissions, `input ${JSON.stringify(input)}`).toEqual([expected]);
    }
  });
});

describe("v1.0 runtime — |fallback: empty-aware unified predicate", () => {
  it("empty string → fallback fires", async () => {
    const r = await run(skill(`    emit(text="\${V|fallback:\\"DEFAULT\\"}")`), { V: "" });
    expect(r.emissions).toEqual(["DEFAULT"]);
  });

  it("whitespace-only string → fallback fires", async () => {
    const r = await run(skill(`    emit(text="\${V|fallback:\\"DEFAULT\\"}")`), { V: "   \t  " });
    expect(r.emissions).toEqual(["DEFAULT"]);
  });

  it("empty array → fallback fires", async () => {
    const r = await run(skill(`    emit(text="\${V|fallback:\\"DEFAULT\\"}")`), { V: "[]" });
    expect(r.emissions).toEqual(["DEFAULT"]);
  });

  it("non-empty value → fallback does not fire", async () => {
    const r = await run(skill(`    emit(text="\${V|fallback:\\"DEFAULT\\"}")`), { V: "actual" });
    expect(r.emissions).toEqual(["actual"]);
  });
});

describe("v1.0 runtime — |contains: filter", () => {
  it("substring match on string LHS", async () => {
    const r = await run(skill(`    emit(text="\${S|contains:\\"urgent\\"}")`), { S: "this is urgent now" });
    expect(r.emissions).toEqual(["true"]);
  });

  it("substring miss on string LHS returns empty (falsy)", async () => {
    const r = await run(skill(`    emit(text="[\${S|contains:\\"urgent\\"}]")`), { S: "all quiet here" });
    expect(r.emissions).toEqual(["[]"]);
  });

  it("element membership on JSON array LHS", async () => {
    const r = await run(skill(`    emit(text="\${L|contains:\\"a\\"}")`), { L: '["a","b","c"]' });
    expect(r.emissions).toEqual(["true"]);
  });

  it("array path rejects partial-string false positives (alphabet ≠ a)", async () => {
    const r = await run(skill(`    emit(text="[\${L|contains:\\"a\\"}]")`), { L: '["alphabet","bravo"]' });
    expect(r.emissions).toEqual(["[]"]);
  });
});

describe("v1.0 runtime — |url filter", () => {
  it("encodes special chars (space, ?, &, =)", async () => {
    const r = await run(skill(`    emit(text="\${Q|url}")`), { Q: "hello world&x=1" });
    expect(r.emissions).toEqual(["hello%20world%26x%3D1"]);
  });

  it("safe chars pass through unchanged", async () => {
    const r = await run(skill(`    emit(text="\${Q|url}")`), { Q: "abc-DEF_123.~" });
    expect(r.emissions).toEqual(["abc-DEF_123.~"]);
  });
});

describe("v1.0 runtime — |shell filter", () => {
  it("wraps value in single quotes", async () => {
    const r = await run(skill(`    emit(text="\${V|shell}")`), { V: "hello world" });
    expect(r.emissions).toEqual(["'hello world'"]);
  });

  it("escapes embedded single quote", async () => {
    const r = await run(skill(`    emit(text="\${V|shell}")`), { V: "it's fine" });
    expect(r.emissions).toEqual(["'it'\\''s fine'"]);
  });
});

describe("v1.0 runtime — |isodate filter", () => {
  it("epoch seconds → ISO-8601", async () => {
    const r = await run(skill(`    emit(text="\${T|isodate}")`), { T: "1700000000" });
    expect(r.emissions).toEqual(["2023-11-14T22:13:20.000Z"]);
  });

  it("epoch milliseconds → ISO-8601 (>= 1e12 disambiguation)", async () => {
    const r = await run(skill(`    emit(text="\${T|isodate}")`), { T: "1700000000000" });
    expect(r.emissions).toEqual(["2023-11-14T22:13:20.000Z"]);
  });

  it("ISO-8601 string passes through (round-trip)", async () => {
    const r = await run(skill(`    emit(text="\${T|isodate}")`), { T: "2026-01-15T12:00:00.000Z" });
    expect(r.emissions).toEqual(["2026-01-15T12:00:00.000Z"]);
  });
});
