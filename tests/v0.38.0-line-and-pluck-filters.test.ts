import { describe, it, expect } from "vitest";
import { applyFilter } from "../src/filters.js";
import { substituteRuntime, evalCondition, execute } from "../src/runtime.js";
import { compile } from "../src/compile.js";
import { Registry } from "../src/connectors/registry.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";
import { lint } from "../src/lint.js";

/**
 * v0.38.0 — line-slice family (`head:"N"` / `tail:"N"` / `lines:"M-N"`) and
 * `pluck:"field"`. Perry build spec 9ee1d8ee, signoff fe394ac1.
 *
 * Line family: string-in, split on `\n`, CRLF-tolerant, drop the single
 * terminal-newline empty line, clamp-or-empty, NEVER throws on a bad arg.
 * Security payoff: `file_read(spool) | tail:"N"` tails a log fs-read-only with
 * NO shell-binary allowlist grant.
 *
 * pluck: array-of-objects → JSON array string of each element's field. Omits an
 * element whose field is absent/null or that isn't an object. Non-array input
 * throws (a content-parse check — the one type guard detectable from the
 * stringified value). Its string-out contract is why it composes with
 * `in`/`not in`/`length`/`contains` where json_parse-as-filter couldn't.
 */

describe("v0.38.0 — head filter (unit)", () => {
  it("returns the first N lines", () => {
    expect(applyFilter("a\nb\nc\nd", "head", "2")).toBe("a\nb");
    expect(applyFilter("a\nb\nc", "head", "1")).toBe("a");
  });
  it("clamps N over the line count to what exists", () => {
    expect(applyFilter("a\nb\nc", "head", "10")).toBe("a\nb\nc");
  });
  it("N=0 → empty; negative → empty; non-numeric → empty; no arg → empty (never throws)", () => {
    expect(applyFilter("a\nb\nc", "head", "0")).toBe("");
    expect(applyFilter("a\nb\nc", "head", "-1")).toBe("");
    expect(applyFilter("a\nb\nc", "head", "abc")).toBe("");
    expect(applyFilter("a\nb\nc", "head")).toBe("");
  });
  it("empty input → empty; single-line input", () => {
    expect(applyFilter("", "head", "3")).toBe("");
    expect(applyFilter("only", "head", "1")).toBe("only");
  });
});

describe("v0.38.0 — tail filter (unit)", () => {
  it("returns the last N lines", () => {
    expect(applyFilter("a\nb\nc\nd", "tail", "2")).toBe("c\nd");
  });
  it("drops the single trailing empty line from a terminal newline (the bite)", () => {
    // tail:"1" of "a\nb\n" is "b", NOT "".
    expect(applyFilter("a\nb\n", "tail", "1")).toBe("b");
    expect(applyFilter("a\nb\n", "tail", "2")).toBe("a\nb");
  });
  it("is CRLF-tolerant: strips a trailing \\r per line, rejoins with \\n", () => {
    expect(applyFilter("a\r\nb\r\n", "tail", "1")).toBe("b");
    expect(applyFilter("a\r\nb\r\nc", "tail", "2")).toBe("b\nc");
  });
  it("input with NO trailing newline", () => {
    expect(applyFilter("a\nb", "tail", "1")).toBe("b");
  });
  it("clamps N over the line count; N=0 → empty; empty input → empty", () => {
    expect(applyFilter("a\nb", "tail", "5")).toBe("a\nb");
    expect(applyFilter("a\nb\nc", "tail", "0")).toBe("");
    expect(applyFilter("", "tail", "1")).toBe("");
  });
  it("preserves a genuine interior blank line (only the terminal-newline one drops)", () => {
    // "a\n\n" → content lines ["a", ""] after dropping the terminal-newline
    // empty; the middle blank line survives, so tail:"1" is that blank line.
    expect(applyFilter("a\n\n", "tail", "1")).toBe("");
  });
});

describe("v0.38.0 — lines filter (unit)", () => {
  it("returns the 1-indexed inclusive M-N range", () => {
    expect(applyFilter("a\nb\nc\nd\ne", "lines", "2-4")).toBe("b\nc\nd");
    expect(applyFilter("a\nb\nc", "lines", "2-2")).toBe("b");
  });
  it("clamps N over the line count", () => {
    expect(applyFilter("a\nb\nc", "lines", "2-10")).toBe("b\nc");
  });
  it("clamps M below 1 up to the first line", () => {
    expect(applyFilter("a\nb\nc", "lines", "0-2")).toBe("a\nb");
  });
  it("M>N → empty; N<1 → empty", () => {
    expect(applyFilter("a\nb\nc", "lines", "5-2")).toBe("");
    expect(applyFilter("a\nb\nc", "lines", "1-0")).toBe("");
  });
  it("malformed args → empty (never throws): non-numeric, open range, no dash, no arg", () => {
    expect(applyFilter("a\nb\nc", "lines", "abc")).toBe("");
    expect(applyFilter("a\nb\nc", "lines", "2-")).toBe("");
    expect(applyFilter("a\nb\nc", "lines", "2")).toBe("");
    expect(applyFilter("a\nb\nc", "lines", "-1-3")).toBe("");
    expect(applyFilter("a\nb\nc", "lines")).toBe("");
  });
});

describe("v0.38.0 — pluck filter (unit)", () => {
  it("projects a field from each element → JSON array string", () => {
    expect(applyFilter('[{"id":"a"},{"id":"b"}]', "pluck", "id")).toBe('["a","b"]');
  });
  it("preserves non-string scalar field values", () => {
    expect(applyFilter('[{"n":1},{"n":2}]', "pluck", "n")).toBe("[1,2]");
  });
  it("omits an element whose field is absent", () => {
    expect(applyFilter('[{"id":"a"},{"x":1},{"id":"c"}]', "pluck", "id")).toBe('["a","c"]');
  });
  it("omits an element whose field is null (or undefined)", () => {
    expect(applyFilter('[{"id":"a"},{"id":null},{"id":"c"}]', "pluck", "id")).toBe('["a","c"]');
  });
  it("omits a non-object element (`pluck:\"id\"` on [1,2,{id}])", () => {
    expect(applyFilter('[1,2,{"id":"a"}]', "pluck", "id")).toBe('["a"]');
    expect(applyFilter('[["a"],{"id":"b"}]', "pluck", "id")).toBe('["b"]');
  });
  it("empty array → empty array", () => {
    expect(applyFilter("[]", "pluck", "id")).toBe("[]");
  });
  it("throws on non-array input (content-parse type guard)", () => {
    expect(() => applyFilter('{"id":"a"}', "pluck", "id")).toThrow(/not an array/i);
    expect(() => applyFilter("hello", "pluck", "id")).toThrow(/pluck/i);
  });
  it("throws when the field arg is omitted", () => {
    expect(() => applyFilter("[]", "pluck")).toThrow(/requires.*field/i);
  });
});

describe("v0.38.0 — filters through the runtime substituter (e2e)", () => {
  it("tails a bound multi-line string var, dropping the terminal newline", () => {
    // The `file_read(spool) -> LOG` then `${LOG|tail:"N"}` shape — proven here
    // against a bound string so it runs fs-read-only, no shell `tail` grant.
    const vars = new Map<string, unknown>([["LOG", "line1\nline2\nline3\n"]]);
    expect(substituteRuntime('${LOG|tail:"2"}', vars)).toBe("line2\nline3");
    expect(substituteRuntime('${LOG|head:"1"}', vars)).toBe("line1");
    expect(substituteRuntime('${LOG|lines:"2-3"}', vars)).toBe("line2\nline3");
  });

  it("plucks a bound array-of-objects var → JSON array string, and composes", () => {
    const vars = new Map<string, unknown>([
      ["ITEMS", [{ id: "a", t: 1 }, { id: "b", t: 2 }, { id: "c", t: 3 }]],
    ]);
    expect(substituteRuntime('${ITEMS|pluck:"id"}', vars)).toBe('["a","b","c"]');
    // Chains onto the array-aware filters (the reason string-out is correct).
    expect(substituteRuntime('${ITEMS|pluck:"id"|length}', vars)).toBe("3");
    expect(substituteRuntime('${ITEMS|pluck:"id"|contains:"b"}', vars)).toBe("true");
  });

  it("drives the structural-dedup pattern: pluck to a bound var, then `in`", () => {
    // brand-monitor's use — is this id already in the seen set? The `in`
    // condition RHS does NOT accept an inline filter chain (the IN regex
    // captures a chain on the LHS only), so the supported shape binds the
    // projection first: `$set IDS = "${SEEN|pluck:"id"}"` then `in ${IDS}`.
    // The bound value is the JSON-array string pluck emits, which the `in`
    // RHS already JSON-parses (runtime.ts:2861). Asymmetry flagged to Perry.
    const projected = substituteRuntime('${ITEMS|pluck:"id"}', new Map([["ITEMS", [{ id: "a" }, { id: "b" }]]]));
    const vars = new Map<string, unknown>([
      ["IDS", projected], // what `$set IDS = "${ITEMS|pluck:"id"}"` binds
      ["NEW", "a"],
      ["FRESH", "z"],
    ]);
    expect(evalCondition("${NEW} in ${IDS}", vars)).toBe(true);
    expect(evalCondition("${FRESH} in ${IDS}", vars)).toBe(false);
    expect(evalCondition("${FRESH} not in ${IDS}", vars)).toBe(true);
  });
});

describe("v0.38.0 — driver e2e: connector object-array → pluck → dedup", () => {
  // The real brand-monitor shape: a connector (`$ data_read`) returns a genuine
  // array of objects; pluck projects the ids; `in` dedups. Bypasses every
  // input-construction quirk ($set object-literals, --input comma-coercion) —
  // the connector binds a real JS array, exactly what pluck is meant to consume.
  const skill = `# Skill: dedup
# Status: Approved
# Vars: NEW

run:
    $ src.fetch -> SEEN
    $set IDS = "\${SEEN|pluck:"id"}"
    if \${NEW} not in \${IDS}:
        emit(text="fresh:\${NEW} ids=\${IDS}")
    else:
        emit(text="dup:\${NEW} ids=\${IDS}")
default: run
`;

  async function runDedup(newVal: string): Promise<string[]> {
    const registry = new Registry();
    registry.registerMcpConnector("src", new CallbackMcpConnector(async () => [{ id: "a" }, { id: "b" }]));
    const compiled = await compile(skill, { skipLintPreflight: true, inputs: { NEW: newVal } });
    const result = await execute(
      compiled.parsed,
      compiled.resolvedVariables,
      compiled.targetOrder,
      { registry },
    );
    expect(result.errors).toEqual([]);
    return result.emissions;
  }

  it("a NOVEL id is fresh (pluck projected [a,b]; z not in it)", async () => {
    const em = await runDedup("z");
    expect(em.join("\n")).toContain('fresh:z ids=["a","b"]');
  });

  it("a SEEN id is a dup (a IS in the pluck projection)", async () => {
    const em = await runDedup("a");
    expect(em.join("\n")).toContain('dup:a ids=["a","b"]');
  });
});

describe("v0.38.0 — new filters are known to lint", () => {
  const skill = (line: string): string => `# Skill: probe\n# Status: Draft\n\nt:\n    ${line}\ndefault: t\n`;

  it("does not fire unknown-filter for head/tail/lines/pluck", async () => {
    for (const line of [
      `$set X = "\${SRC|head:"3"}"`,
      `$set X = "\${SRC|tail:"3"}"`,
      `$set X = "\${SRC|lines:"2-4"}"`,
      `$set X = "\${SRC|pluck:"id"}"`,
    ]) {
      const res = await lint(skill(line));
      expect(res.findings.map((f) => f.rule)).not.toContain("unknown-filter");
    }
  });

  it("still fires unknown-filter on a genuine typo", async () => {
    const res = await lint(skill(`$set X = "\${SRC|taill:"3"}"`));
    expect(res.findings.map((f) => f.rule)).toContain("unknown-filter");
  });
});
