/**
 * v1.0 runtime-semantics test battery — Lane (b): numeric coercion + if-chain.
 *
 * Pins the `<`/`>`/`<=`/`>=` comparison semantics (Number() coercion, not
 * lexicographic) + the if/elif/else branch dispatch + TypeMismatchError
 * surface for non-numeric operands. Closes the freeze gap where existing
 * tests are heavy on parse/compile coverage but light on assert-which-
 * branch-fired.
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

describe("v1.0 runtime — numeric comparison via Number() coercion", () => {
  it("string '10' > '9' compares numerically (not lexicographically)", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    if \${A} > \${B}:
        emit(text="numeric")
    else:
        emit(text="lexicographic")
default: run
`;
    const r = await run(src, { A: "10", B: "9" });
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["numeric"]);
  });

  it("|length on array piped through > comparison — true branch fires", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    if \${L|length} > \${THRESHOLD}:
        emit(text="over")
    else:
        emit(text="under")
default: run
`;
    const r = await run(src, { L: '["a","b","c","d","e"]', THRESHOLD: "3" });
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["over"]);
  });

  it("|length on array piped through > comparison — false branch fires", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    if \${L|length} > \${THRESHOLD}:
        emit(text="over")
    else:
        emit(text="under")
default: run
`;
    const r = await run(src, { L: '["only-one"]', THRESHOLD: "3" });
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["under"]);
  });

  it("non-numeric operand raises TypeMismatchError on > comparison", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    if \${X} > \${Y}:
        emit(text="ok")
default: run
`;
    const r = await run(src, { X: "hello", Y: "5" });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]!.class).toBe("TypeMismatchError");
  });
});

describe("v1.0 runtime — if/elif/else chain dispatch", () => {
  it("first matching branch fires, others skipped", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    if \${N} == "1":
        emit(text="one")
    elif \${N} == "2":
        emit(text="two")
    elif \${N} == "3":
        emit(text="three")
    else:
        emit(text="other")
default: run
`;
    for (const [input, expected] of [["1", "one"], ["2", "two"], ["3", "three"], ["7", "other"]]) {
      const r = await run(src, { N: input! });
      expect(r.errors, `N=${input}`).toEqual([]);
      expect(r.emissions, `N=${input}`).toEqual([expected]);
    }
  });

  it("elif chain stops at first match (does not fall through)", async () => {
    // Two predicates that BOTH match — second elif should NOT fire because
    // the first match wins. Tests the dispatch semantic, not just compile.
    const src = `# Skill: t
# Status: Approved
run:
    if \${N} > "1":
        emit(text="first")
    elif \${N} > "0":
        emit(text="second")
default: run
`;
    const r = await run(src, { N: "5" });
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["first"]);
  });
});

describe("v1.0 runtime — numeric edge cases", () => {
  it("equal values via > comparison → else branch", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    if \${A} > \${B}:
        emit(text="gt")
    else:
        emit(text="eq-or-lt")
default: run
`;
    const r = await run(src, { A: "5", B: "5" });
    expect(r.emissions).toEqual(["eq-or-lt"]);
  });

  it(">= comparison includes equality", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    if \${A} >= \${B}:
        emit(text="gte")
    else:
        emit(text="lt")
default: run
`;
    const r = await run(src, { A: "5", B: "5" });
    expect(r.emissions).toEqual(["gte"]);
  });

  it("negative numbers compare correctly", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    if \${A} > \${B}:
        emit(text="gt")
    else:
        emit(text="lte")
default: run
`;
    const r = await run(src, { A: "-3", B: "-10" });
    expect(r.emissions).toEqual(["gt"]);
  });
});
