/**
 * v0.40.1 — filter chains evaluate identically in every context.
 *
 * Ticket `84f0780e`. Two chain appliers exist — `substituteRuntime`'s inline
 * loop and `applyFilterChainCondition` — and they were supposed to agree.
 * They had diverged in FOUR ways, all silent, all found within a day:
 *
 *   1. `|fallback:` fired in comparisons, inert in bare-truthy   (v0.40.0)
 *   2. undefined coerced to "" mid-chain, so a LATER `|fallback:` never fired
 *      — `${X.missing|trim|fallback:"D"}` gave "D" in a substitution and ""
 *      in a condition, with NO raise. The one silent path left after v0.40.0,
 *      reached by the ordering authors most naturally write.
 *   3. `fallback`'s emptiness predicate: substitution fired on
 *      undefined|null|""|[] , conditions on undefined only.
 *   4. `in`'s LHS used a third applier that skips `fallback` outright.
 *
 * (2) is the dangerous one: it is not a new bug but a HOLE in v0.40.0's
 * guarantee, and the shipped language guide printed that exact ordering as
 * the working form — so the docs were a generator for the failure the release
 * existed to remove.
 *
 * THIS FILE IS THE SEAM TEST. Every chain shape is run through every context
 * and asserted to produce the same answer. Individual behaviour tests would
 * not have caught any of the four: each applier was self-consistent, and the
 * defect lived only in the comparison between them. Add a context here before
 * adding one to the runtime.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";

/** Render `${<expr>}` through a substitution (emit) and through a condition. */
async function bothContexts(expr: string) {
  const src = `# Skill: t
# Vars: L=[D, other]
# Status: Approved
run:
    $ json_parse {"ok":1,"empty":"","blank":"   ","list":[]} -> X
    emit(text="SUB[\${${expr}}]")
    if \${${expr}} == "D":
        emit(text="COND[D]")
    else:
        emit(text="COND[not-D]")
default: run
`;
  const compiled = await compile(src, { skipLintPreflight: true });
  const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
    registry: new Registry(),
  });
  const sub = (r.emissions[0] ?? "").replace(/^SUB\[|\]$/g, "");
  const cond = (r.emissions[1] ?? "") === "COND[D]";
  return { sub, cond, errors: r.errors, agree: (sub === "D") === cond };
}

// Every one of these resolves to "D" in a substitution. A condition comparing
// the same chain against "D" must therefore take the true branch. Before
// v0.40.1 rows 2 and 4 disagreed.
const SHAPES = [
  ["fallback only",                 `X.missing|fallback:"D"`],
  ["fallback AFTER a transform",    `X.missing|trim|fallback:"D"`],
  ["fallback BEFORE a transform",   `X.missing|fallback:"D"|trim`],
  ["empty string + fallback",       `X.empty|fallback:"D"`],
  ["whitespace string + fallback",  `X.blank|fallback:"D"`],
  ["empty array + fallback",        `X.list|fallback:"D"`],
  ["fallback between transforms",   `X.missing|trim|fallback:"D"|trim`],
];

describe("v0.40.1 — chain semantics are identical in substitution and condition context", () => {
  for (const [name, expr] of SHAPES) {
    it(`${name}: both contexts agree`, async () => {
      const { sub, cond, errors, agree } = await bothContexts(expr!);
      expect(errors).toEqual([]);
      expect(sub).toBe("D");
      expect(cond).toBe(true);
      expect(agree).toBe(true);
    });
  }

  // Guard the fix's own boundary: a chain with NO fallback must still raise on
  // an unresolved ref. If propagation ever leaks past that, v0.40.0's whole
  // guarantee silently reverts and every test above still passes.
  it("a chain with no fallback still raises — propagation must not leak", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ json_parse {"ok":1} -> X\n    if \${X.missing|trim} == "a":\n        emit(text="taken")\ndefault: run\n`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: new Registry() });
    expect(r.errors[0]!.class).toBe("UnresolvedConditionRefError");
  });

  // A value that genuinely resolves must be untouched by any of this.
  it("a resolved value flows through transforms unchanged in both contexts", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ json_parse {"v":"  hi  "} -> X\n    emit(text="SUB[\${X.v|trim}]")\n    if \${X.v|trim} == "hi":\n        emit(text="COND[hi]")\ndefault: run\n`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: new Registry() });
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["SUB[hi]", "COND[hi]"]);
  });

  // Divergence 4: `in`'s LHS used applyFilterChain, which skips `fallback`
  // outright — a third set of chain semantics inside the same evaluator.
  it("`in` LHS honours fallback like every other operand", async () => {
    const src = `# Skill: t\n# Vars: L=[D, other]\n# Status: Approved\nrun:\n    $ json_parse {"ok":1} -> X\n    if \${X.missing|fallback:"D"} in \${L}:\n        emit(text="found")\n    else:\n        emit(text="not-found")\ndefault: run\n`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: new Registry() });
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["found"]);
  });
});
