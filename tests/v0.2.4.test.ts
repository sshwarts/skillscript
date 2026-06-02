import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { compile } from "../src/compile.js";

/**
 * v0.2.4 — two more parser bugs surfaced by Perry's 6-minion battery
 * over `compile_skill` (thread `e609a448`):
 *
 *   D. Apostrophe in `# Description:` (or anywhere outside a kwarg value)
 *      regression-introduced by the v0.2.2 fold-quoted-continuations
 *      pre-pass. The unclosed-single-quote tracker engaged on natural
 *      English prose ("symbol's", "user's") and swallowed targets into
 *      a phantom string scope, producing `[no-targets]`. Fix: limit fold
 *      to kwarg-bearing op lines (`~`, `>`, `&`).
 *
 *   F. `(fallback: ...)` after `-> VAR` broke binding on `@` and `&` ops.
 *      $/~/> ops had explicit fallback support; @/& didn't. The trailing
 *      `(fallback: ...)` clause prevented the -> VAR extractor from
 *      matching, leaving outputVar unbound → downstream $(VAR) fired
 *      undeclared-var diagnostics. Fix: extend both regexes + thread
 *      fallback into the op record.
 */

describe("v0.2.4 — Bug D: apostrophe in plain text doesn't swallow targets", () => {
  it("apostrophe in # Description: parses cleanly; targets survive", async () => {
    const src = [
      "# Skill: foo",
      "# Description: skill that handles symbol's intraday drops",
      "",
      "main:",
      "    emit(text=\"hello\")",
      "",
      "default: main",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.targets.size).toBe(1);
    expect(parsed.targets.has("main")).toBe(true);
    expect(parsed.entryTarget).toBe("main");
  });

  it("multiple apostrophes across frontmatter + body don't engage fold", async () => {
    const src = [
      "# Skill: bar",
      "# Description: agent's runtime-orchestration helper for user's tasks",
      "# Status: Approved",
      "",
      "fetch:",
      "    emit(text=\"It's working\")",
      "",
      "process:",
      "    needs: fetch",
      "    emit(text=\"Don't break\")",
      "",
      "default: process",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.targets.size).toBe(2);
    expect(parsed.targets.has("fetch")).toBe(true);
    expect(parsed.targets.has("process")).toBe(true);
  });

  it("legacy `~` form is rejected", () => {
    const src = "# Skill: x\nstep:\n    ~ prompt=\"X\" -> R\ndefault: step\n";
    const parsed = parse(src);
    expect(parsed.parseErrors.some((e) => e.includes("Legacy `~`"))).toBe(true);
  });

  it("apostrophe inside ! literal body does not engage fold", () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "step:",
      "    emit(text=\"Don't worry about this\")",
      "    emit(text=\"It's fine\")",
      "default: step",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    const ops = parsed.targets.get("step")!.ops;
    expect(ops).toHaveLength(2);
    expect(ops[0]!.body).toBe("Don't worry about this");
    expect(ops[1]!.body).toBe("It's fine");
  });

  it("Perry minion-3 repro: # Description with apostrophe + body compiles clean", async () => {
    const src = [
      "# Skill: stock-drop-monitor",
      "# Description: Detect intraday stock drops in symbol's price",
      "# Status: Approved",
      "",
      "fetch:",
      "    shell(command=\"curl -s https://example.com\")",
      "",
      "default: fetch",
      "",
    ].join("\n");
    const result = await compile(src);
    expect(result.skillName).toBe("stock-drop-monitor");
    expect(result.targetOrder).toEqual(["fetch"]);
  });
});

describe("v0.2.4 — Bug F: (fallback: ...) on shell + inline ops binds outputVar correctly", () => {
  it("shell op with -> VAR (fallback: ...) sets outputVar and fallback", () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "fetch:",
      "    shell(command=\"curl -s https://example.com\") -> RAW (fallback: \"\")",
      "use:",
      "    needs: fetch",
      "    emit(text=\"$(RAW)\")",
      "default: use",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    const fetchOp = parsed.targets.get("fetch")!.ops[0]!;
    expect(fetchOp.kind).toBe("shell");
    expect(fetchOp.outputVar).toBe("RAW");
    expect(fetchOp.fallback).toBe("");
  });

  it("shell op binding flows into lint: $(RAW) is declared, no undeclared-var error", async () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "fetch:",
      "    shell(command=\"curl -s https://example.com\") -> RAW (fallback: \"fallback-value\")",
      "use:",
      "    needs: fetch",
      "    emit(text=\"$(RAW)\")",
      "default: use",
      "",
    ].join("\n");
    const compiled = await compile(src);
    expect(compiled.skillName).toBe("x");
    expect(compiled.targetOrder).toEqual(["fetch", "use"]);
  });

  it("shell(unsafe=true) with -> VAR (fallback: ...) still binds correctly", () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "fetch:",
      "    shell(command=\"echo hello\", unsafe=true) -> R (fallback: \"\")",
      "use:",
      "    needs: fetch",
      "    emit(text=\"$(R)\")",
      "default: use",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    const op = parsed.targets.get("fetch")!.ops[0]!;
    expect(op.outputVar).toBe("R");
    expect(op.policy).toBe("unsafe");
    expect(op.fallback).toBe("");
  });

  it("regression: shell op without fallback still binds outputVar", () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "fetch:",
      "    shell(command=\"curl -s https://example.com\") -> RAW",
      "use:",
      "    needs: fetch",
      "    emit(text=\"$(RAW)\")",
      "default: use",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    const op = parsed.targets.get("fetch")!.ops[0]!;
    expect(op.outputVar).toBe("RAW");
    expect(op.fallback).toBeUndefined();
  });
});
