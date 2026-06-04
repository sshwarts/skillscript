import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";

/**
 * v0.17.2 — `# Vars:` default value quote-strip.
 *
 * Per Perry's `1ea3d625` dogfood finding: `# Vars: LOCATION="Valdese"`
 * was binding the literal 9-char string `"Valdese"` (quotes included),
 * not the 7-char `Valdese`. URL-encoded with the quotes downstream, broke
 * wttr.in lookup (geolocation fell back to Berlin).
 *
 * Fix: strip one layer of matched surrounding quotes from `# Vars:`
 * defaults at parse time. Bare values pass through unchanged. Mismatched
 * / unbalanced quotes pass through. Quotes doing real delimiting (e.g.,
 * spaced values) disappear and the inner content binds correctly.
 */

const HEAD = `# Skill: probe\n# Status: Draft\n`;
const BODY = `\nt:\n    emit(text="probe")\ndefault: t\n`;

function parseVarsLine(varsLine: string): { name: string; default: string | undefined; required: boolean }[] {
  const source = `${HEAD}# Vars: ${varsLine}${BODY}`;
  const parsed = parse(source);
  return parsed.vars.map((v) => ({ name: v.name, default: v.default, required: v.required }));
}

describe("v0.17.2 — `# Vars:` default value quote-strip", () => {
  it("strips one layer of matched double quotes (the load-bearing case from Perry's dogfood)", () => {
    const vars = parseVarsLine(`LOCATION="Valdese"`);
    expect(vars).toEqual([{ name: "LOCATION", default: "Valdese", required: false }]);
  });

  it("strips one layer of matched single quotes", () => {
    const vars = parseVarsLine(`NAME='alice'`);
    expect(vars).toEqual([{ name: "NAME", default: "alice", required: false }]);
  });

  it("strips quotes around empty string default (`get-weather` LOCATION=\"\" pattern)", () => {
    const vars = parseVarsLine(`LOCATION=""`);
    expect(vars).toEqual([{ name: "LOCATION", default: "", required: false }]);
  });

  it("preserves spaced values delimited by quotes (the quotes were doing real work)", () => {
    const vars = parseVarsLine(`MSG="hello world"`);
    expect(vars).toEqual([{ name: "MSG", default: "hello world", required: false }]);
  });

  it("leaves bare values unchanged", () => {
    const vars = parseVarsLine(`WHO=world`);
    expect(vars).toEqual([{ name: "WHO", default: "world", required: false }]);
  });

  it("strips outer layer of nested quotes (one-layer-only, not recursive)", () => {
    // Inner quotes survive — single strip only.
    const vars = parseVarsLine(`Q='"x"'`);
    expect(vars).toEqual([{ name: "Q", default: `"x"`, required: false }]);
  });

  it("leaves mismatched quotes unchanged (\"x' is not a matched pair)", () => {
    const vars = parseVarsLine(`X="x'`);
    expect(vars[0]?.default).toBe(`"x'`);
  });

  it("leaves single-char quote untouched (just a quote, not a delimiter pair)", () => {
    const vars = parseVarsLine(`X="`);
    expect(vars[0]?.default).toBe(`"`);
  });

  it("handles multiple declarations with mixed quoting", () => {
    const vars = parseVarsLine(`A="quoted", B=bare, C='single', D="with space"`);
    expect(vars).toEqual([
      { name: "A", default: "quoted", required: false },
      { name: "B", default: "bare", required: false },
      { name: "C", default: "single", required: false },
      { name: "D", default: "with space", required: false },
    ]);
  });

  it("required-no-default vars are unaffected", () => {
    const vars = parseVarsLine(`MANDATORY`);
    expect(vars).toEqual([{ name: "MANDATORY", default: undefined, required: true }]);
  });

  it("preserves JSON-array literals as-is (square brackets aren't stripped)", () => {
    const vars = parseVarsLine(`TAGS=["a","b"]`);
    expect(vars[0]?.default).toBe(`["a","b"]`);
  });

  it("preserves JSON-object literals as-is (curly braces aren't stripped)", () => {
    const vars = parseVarsLine(`CFG={"k":"v"}`);
    expect(vars[0]?.default).toBe(`{"k":"v"}`);
  });
});
