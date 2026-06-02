import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";

// Sub-charter 4b: closes audit finding #7. The "parser never throws on
// bad input" contract requires resource discipline — adversarial input
// would otherwise crash the host (stack overflow via deeply-chained AND;
// CPU exhaustion via REF_PATTERN backtracking). Length + depth caps
// upstream of the recursive descent + regex application. Length cap is
// the cheaper close on REF_PATTERN ReDoS attack vector; regex refactor
// deferred.

const buildAndChain = (depth: number, leaf = "$(X)"): string =>
  Array.from({ length: depth }, () => leaf).join(" and ");

describe("parser resource caps (audit finding #7)", () => {
  it("rejects condition longer than MAX_CONDITION_LENGTH (4096 chars)", () => {
    const longCond = "$(X) == \"" + "a".repeat(5000) + "\"";
    const src = `# Skill: t\n# Vars: X=ok\nt:\n    if ${longCond}:\n        emit(text="ok")\ndefault: t\n`;
    const p = parse(src);
    expect(p.parseErrors.some((e) => /Unsupported condition/.test(e))).toBe(true);
  });

  it("rejects condition with depth > MAX_CONDITION_DEPTH (64 levels)", () => {
    // 100 ANDs → 100 nested recursive calls; depth cap should reject.
    const chain = buildAndChain(100);
    const src = `# Skill: t\n# Vars: X=ok\nt:\n    if ${chain}:\n        emit(text="ok")\ndefault: t\n`;
    const p = parse(src);
    // Without depth cap, this would either (a) succeed in O(N^2) time (slow but
    // not crash), or (b) succeed with no detectable issue. With cap, the deep
    // chain is rejected as "Unsupported condition" — parser returns cleanly.
    expect(p.parseErrors.some((e) => /Unsupported condition/.test(e))).toBe(true);
  });

  it("accepts condition under the cap (regression guard)", () => {
    // 60 ANDs → under the 64 cap; should succeed.
    const chain = buildAndChain(60);
    const src = `# Skill: t\n# Vars: X=ok\nt:\n    if ${chain}:\n        emit(text="ok")\ndefault: t\n`;
    const p = parse(src);
    expect(p.parseErrors.some((e) => /Unsupported condition/.test(e))).toBe(false);
  });

  it("doesn't throw on pathological REF_PATTERN backtrack input (length cap absorbs)", () => {
    // Pre-cap: REF_PATTERN's nested `*` quantifiers could backtrack
    // exponentially on near-valid input ending without close-brace.
    // Length cap rejects upfront → no regex application → no ReDoS.
    const adversarial = "$(REF" + ".X".repeat(2000);
    const src = `# Skill: t\nt:\n    if ${adversarial}:\n        emit(text="x")\ndefault: t\n`;
    const start = Date.now();
    const p = parse(src);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // <500ms confirms no catastrophic backtrack
    // Parser returns cleanly with errors — never throws.
    expect(p.parseErrors.length).toBeGreaterThan(0);
  });

  it("parser remains never-throws on all-dots-and-pipes adversarial input", () => {
    const adversarial = "$(VAR" + "|trim".repeat(1000) + ")";
    const src = `# Skill: t\nt:\n    if ${adversarial}:\n        emit(text="x")\ndefault: t\n`;
    // The key assertion: parse() returns; doesn't throw.
    expect(() => parse(src)).not.toThrow();
  });
});
