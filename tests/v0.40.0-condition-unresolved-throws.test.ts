/**
 * v0.40.0 — an unresolved reference in an `if` condition raises.
 *
 * Ruling `c0b8e814`, from GitHub issue #3. A condition operand that could not
 * be resolved used to collapse to `""` and compare false, so "the field is
 * missing" and "the field says no" were the same answer. That is what turned
 * the reporter's corrupted-array bug into twelve days of "0 processed, no
 * errors" — every branch of his loop body sat behind such a condition.
 *
 * Two things these tests exist to pin that the rest of the suite does not:
 *
 * 1. POLARITY. `not` and `!=` FIRE a branch on absence rather than skipping
 *    it, so the old behaviour could invent work, not merely suppress it. The
 *    error has to say which way it would have fallen.
 * 2. THE ESCAPE HATCH IN ALL THREE CONTEXTS. `|fallback:` worked in
 *    comparisons and was a silent no-op in bare-truthy — so the migration
 *    advice we publish did nothing at the single most common existence-check
 *    shape. Fixed here; the truthy cases below are the regression guard.
 *
 * Note the suite passed 2380/2380 before this file existed: the old silent
 * behaviour had NO coverage at all, which is why it survived. These are the
 * only tests standing between that behaviour and a regression.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { lint } from "../src/lint.js";

async function run(body: string, inputs: Record<string, string> = {}) {
  const src = `# Skill: t\n# Status: Approved\nrun:\n    $ json_parse {"ok":1,"n":5} -> X\n${body}\ndefault: run\n`;
  const compiled = await compile(src, { skipLintPreflight: true });
  return execute(compiled.parsed, { ...compiled.resolvedVariables, ...inputs }, compiled.targetOrder, {
    registry: new Registry(),
  });
}

const condErr = (r: { errors: { message: string; class?: string }[] }) => r.errors[0]?.message ?? "";

describe("v0.40.0 — unresolved condition operand raises", () => {
  it("bare truthy: raises instead of evaluating false, and says absence would SKIP", async () => {
    const r = await run(`    if \${X.missing}:\n        emit(text="taken")`);
    expect(r.emissions).toEqual([]);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.class).toBe("UnresolvedConditionRefError");
    expect(condErr(r)).toContain("$(X.missing)");
    expect(condErr(r)).toContain("SKIPPED");
  });

  // The polarity half. Absence here INVENTS work rather than suppressing it,
  // which is the failure the reporter's own case did not cover.
  it("`not`: raises, and says absence would have FIRED the branch", async () => {
    const r = await run(`    if not \${X.missing}:\n        emit(text="taken")`);
    expect(r.emissions).toEqual([]);
    expect(condErr(r)).toContain("FIRED");
  });

  it("`!=`: raises, and says absence would have FIRED the branch", async () => {
    const r = await run(`    if \${X.missing} != "a":\n        emit(text="taken")`);
    expect(r.emissions).toEqual([]);
    expect(condErr(r)).toContain("FIRED");
  });

  it("`==`: raises, and says absence would have SKIPPED the branch", async () => {
    const r = await run(`    if \${X.missing} == "a":\n        emit(text="taken")`);
    expect(condErr(r)).toContain("SKIPPED");
  });

  it("numeric comparison raises too (it was silent, not just falsy)", async () => {
    const r = await run(`    if \${X.missing} > "1200":\n        emit(text="taken")`);
    expect(r.errors[0]!.class).toBe("UnresolvedConditionRefError");
  });

  // Asked once per REFERENCE, not once per condition: a compound predicate has
  // as many failure sites as operands, and checking only the first makes the
  // whole line look handled.
  it("ref-to-ref comparison: an unresolved RHS raises even when the LHS resolves", async () => {
    const r = await run(`    if \${X.n} != \${X.missing}:\n        emit(text="taken")`);
    expect(r.errors[0]!.class).toBe("UnresolvedConditionRefError");
    expect(condErr(r)).toContain("$(X.missing)");
  });

  it("`in` LHS raises — it used to return false silently", async () => {
    const src = `# Skill: t\n# Vars: L=[a, b]\n# Status: Approved\nrun:\n    $ json_parse {"ok":1} -> X\n    if \${X.missing} in \${L}:\n        emit(text="taken")\ndefault: run\n`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: new Registry() });
    expect(r.errors[0]!.class).toBe("UnresolvedConditionRefError");
  });

  // Both strings were ruled on (`c0b8e814`) and the anti-suppression line
  // matters MORE here than in lint: a lint warning is non-blocking and can be
  // ignored, but a raise has stopped the work, so the reader's incentive is to
  // make it stop by the shortest route — and the shortest route is the
  // fallback token sitting in the same message. Asserted so a reword can't
  // quietly drop it.
  it("runtime remediation leads with the upstream-fault reading and forbids suppression", async () => {
    const r = await run(`    if \${X.missing}:\n        emit(text="taken")`);
    const rem = (r.errors[0] as { remediation?: string }).remediation ?? "";
    expect(rem).toContain("REAL FAULT UPSTREAM");
    expect(rem).toContain("Do not add one solely to clear this error");
    // the diagnostic reading must come BEFORE the fallback form
    expect(rem.indexOf("REAL FAULT UPSTREAM")).toBeLessThan(rem.indexOf("fallback"));
    // the two outcomes must stay visually forked, not flowed into one paragraph
    expect(rem).toContain("\n");
  });

  it("a resolvable reference is untouched — no false positives on the happy path", async () => {
    const r = await run(`    if \${X.n} > "1":\n        emit(text="taken")`);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["taken"]);
  });
});

describe("v0.40.0 — |fallback: is the escape hatch in ALL THREE contexts", () => {
  // The blocker Perry found: this one silently did nothing before, so the
  // migration advice we publish was inert at the commonest shape.
  it("bare truthy: |fallback: consumes the absence and the branch evaluates", async () => {
    const r = await run(`    if \${X.missing|fallback:"yes"}:\n        emit(text="taken")`);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["taken"]);
  });

  it("bare truthy: a falsy fallback yields false rather than raising", async () => {
    const r = await run(`    if \${X.missing|fallback:""}:\n        emit(text="taken")\n    else:\n        emit(text="else")`);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["else"]);
  });

  it("`not` + |fallback: — the shape with no hatch at all before this release", async () => {
    const r = await run(`    if not \${X.missing|fallback:""}:\n        emit(text="taken")`);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["taken"]);
  });

  it("comparison: |fallback: still works (v0.5.0 behaviour preserved)", async () => {
    const r = await run(`    if \${X.missing|fallback:"none"} != "none":\n        emit(text="taken")\n    else:\n        emit(text="absent")`);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["absent"]);
  });

  // A non-fallback filter must NOT count as a guard — otherwise `|trim` would
  // silently license an unresolved operand and we would have moved the bug.
  it("a non-fallback filter does not suppress the raise", async () => {
    const r = await run(`    if \${X.missing|trim} == "a":\n        emit(text="taken")`);
    expect(r.errors[0]!.class).toBe("UnresolvedConditionRefError");
  });
});

describe("v0.40.0 — unguarded-dotted-ref-in-condition lint", () => {
  const lintOf = async (body: string) => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ json_parse {"ok":1} -> X\n${body}\ndefault: run\n`;
    return (await lint(src)).findings.filter((f) => f.rule === "unguarded-dotted-ref-in-condition");
  };

  it("flags an unguarded dotted operand, at warning severity, naming the polarity", async () => {
    const f = await lintOf(`    if not \${X.missing}:\n        emit(text="t")`);
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.message).toContain("FIRE this branch");
  });

  it("does not flag a guarded operand", async () => {
    const f = await lintOf(`    if \${X.missing|fallback:"err"} != "err":\n        emit(text="t")`);
    expect(f).toEqual([]);
  });

  // brand-monitor:20's real shape. The dotted ref is inside a filter ARGUMENT,
  // which already raises today via substituteRuntime — flagging it would be
  // noise about a solved case, and the operand itself is undotted.
  it("does not flag a dotted ref that lives inside a filter argument", async () => {
    const src = `# Skill: t\n# Vars: SEEN=x\n# Status: Approved\nrun:\n    $ json_parse [{"url":"u"}] -> G\n    foreach IT in \${G}:\n        if not \${SEEN|contains:"\${IT.url}"}:\n            emit(text="t")\ndefault: run\n`;
    const f = (await lint(src)).findings.filter((x) => x.rule === "unguarded-dotted-ref-in-condition");
    expect(f).toEqual([]);
  });

  it("flags per REFERENCE — a compound with one guarded and one bare operand yields exactly one", async () => {
    const f = await lintOf(`    if \${X.idle|fallback:"0"} > "10" and not \${X.asleep}:\n        emit(text="t")`);
    expect(f.length).toBe(1);
    expect(f[0]!.message).toContain("$(X.asleep)");
  });

  it("does not flag an undotted reference", async () => {
    const src = `# Skill: t\n# Vars: FLAG=on\n# Status: Approved\nrun:\n    if \${FLAG} == "on":\n        emit(text="t")\ndefault: run\n`;
    expect((await lint(src)).findings.filter((x) => x.rule === "unguarded-dotted-ref-in-condition")).toEqual([]);
  });

  // The remediation was ruled on. It must never read as "add a fallback to fix
  // this" — at ~6 of 7 real sites the correct action is to change nothing, and
  // a rule that recommends suppressing the raise reintroduces the silence this
  // release removes. Asserted so a well-meaning reword cannot quietly undo it.
  it("remediation leads with leave-it-raising and forbids quieting", async () => {
    const f = await lintOf(`    if \${X.missing}:\n        emit(text="t")`);
    const rem = f[0]!.remediation ?? "";
    expect(rem).toContain("NO CHANGE IS NEEDED");
    expect(rem).toContain("Do not add one to quiet this warning");
    // leave-it guidance must come BEFORE the fallback form, not after
    expect(rem.indexOf("NO CHANGE IS NEEDED")).toBeLessThan(rem.indexOf("fallback"));
    // the fork must stay visually separated — flowed into one paragraph, the
    // only actionable-looking token is the one we don't want taken by default
    expect(rem).toContain("\n");
  });
});

// Perry's pre-tag probe (`c0b8e814`): the runtime raises on an `in` left-hand
// side, so lint must warn there too. If the two surfaces shipping in the SAME
// release disagreed about which sites are at risk, the lint rule would fail at
// the one job it has — being the pre-runtime signal.
describe("v0.40.0 — lint and runtime agree on the at-risk set", () => {
  it("lint flags an `in`-LHS dotted ref, matching the runtime raise", async () => {
    const src = `# Skill: t\n# Vars: L=[a, b]\n# Status: Approved\nrun:\n    $ json_parse {"ok":1} -> X\n    if \${X.missing} in \${L}:\n        emit(text="t")\ndefault: run\n`;
    const f = (await lint(src)).findings.filter((x) => x.rule === "unguarded-dotted-ref-in-condition");
    expect(f.length).toBe(1);
    expect(f[0]!.message).toContain("$(X.missing)");
  });
});
