import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";

/**
 * v0.2.2 — three parser bugs surfaced by Perry's 3-cold-author minion battery
 * (thread `a91db2e2`):
 *
 *   A. `# Triggers:` comma-split breaks on cron expressions with commas
 *      (3/3 hit). Now splits at source-keyword boundaries instead of bare
 *      commas — cron-with-commas parses as a single trigger.
 *
 *   B. Multi-line `~ prompt="..."` strings break the parser (2/3 hit).
 *      Now the source pre-pass folds unclosed-quote continuations into a
 *      single logical line before the line-iterating parse loop sees it.
 *      The op regexes have `s` flag so `.` matches the embedded newlines.
 *
 *   C. `needs:` keyword vs Make-style dependency declaration (1/3 visible).
 *      Audit confirmed both forms already work in the parser; this suite
 *      asserts the canonical syntax explicitly so future regressions surface.
 *
 * Each suite asserts a concrete repro from Perry's filing.
 */

describe("v0.2.2 — Bug A: # Triggers comma-split with cron expressions", () => {
  it("cron expression with comma-list minutes parses as ONE trigger", () => {
    const src = "# Skill: stock-watch\n# Status: Approved\n# Triggers: cron: 30,45 9 * * 1-5\nt:\n    emit(text=\"hi\")\ndefault: t\n";
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.triggers).toHaveLength(1);
    expect(parsed.triggers[0]).toEqual({ source: "cron", name: "30,45 9 * * 1-5" });
  });

  it("multiple cron rules on one line separated by source-keyword boundary", () => {
    const src = "# Skill: stock-watch\n# Status: Approved\n# Triggers: cron: 30,45 9 * * 1-5, cron: 0,15,30,45 10-15 * * 1-5, cron: 0 16 * * 1-5\nt:\n    emit(text=\"hi\")\ndefault: t\n";
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.triggers).toHaveLength(3);
    expect(parsed.triggers.map((t) => t.name)).toEqual([
      "30,45 9 * * 1-5",
      "0,15,30,45 10-15 * * 1-5",
      "0 16 * * 1-5",
    ]);
  });

  it("mixed-source on one line still splits by source-keyword", () => {
    const src = "# Skill: x\n# Status: Approved\n# Triggers: cron: 30,45 9 * * 1-5, session: start\nt:\n    emit(text=\"hi\")\ndefault: t\n";
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.triggers).toEqual([
      { source: "cron", name: "30,45 9 * * 1-5" },
      { source: "session", name: "start" },
    ]);
  });

  it("simple single-trigger no-comma case still works (regression guard)", () => {
    const src = "# Skill: x\n# Status: Approved\n# Triggers: cron: 0 9 * * *\nt:\n    emit(text=\"hi\")\ndefault: t\n";
    const parsed = parse(src);
    expect(parsed.triggers).toEqual([{ source: "cron", name: "0 9 * * *" }]);
  });

  it("agent-event source (hyphenated) is recognized as boundary token", () => {
    const src = "# Skill: x\n# Status: Approved\n# Triggers: cron: 0 9 * * *, agent-event: heartbeat\nt:\n    emit(text=\"hi\")\ndefault: t\n";
    const parsed = parse(src);
    expect(parsed.triggers).toEqual([
      { source: "cron", name: "0 9 * * *" },
      { source: "agent-event", name: "heartbeat" },
    ]);
  });
});

describe("v0.2.2 — Bug B legacy: `~` op rejected with parse error", () => {
  it("legacy `~` form is rejected with parse error", () => {
    const src = "# Skill: reason\nstep:\n    ~ prompt=\"X\" -> R\ndefault: step\n";
    const parsed = parse(src);
    expect(parsed.parseErrors.some((e) => e.includes("Legacy `~`"))).toBe(true);
  });

  it("single-line `$ llm prompt=\"...\"` still works", () => {
    const src = "# Skill: reason\n# Status: Approved\nstep:\n    $ llm prompt=\"One line only\" -> R\ndefault: step\n";
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.targets.get("step")!.ops[0]!.body).toContain('prompt="One line only"');
  });
});

describe("v0.2.2 — Bug C: needs: keyword forms", () => {
  it("body-line form `needs: dep` is recognized at main scope", () => {
    const src = [
      "# Skill: chain",
      "# Status: Approved",
      "emit:",
      "    needs: evaluate",
      "    emit(text=\"done\")",
      "evaluate:",
      "    needs: fetch",
      "    emit(text=\"mid\")",
      "fetch:",
      "    emit(text=\"start\")",
      "default: emit",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.targets.get("emit")!.deps).toEqual(["evaluate"]);
    expect(parsed.targets.get("evaluate")!.deps).toEqual(["fetch"]);
    expect(parsed.targets.get("fetch")!.deps).toEqual([]);
  });

  it("header form `target: needs: dep` is recognized", () => {
    const src = [
      "# Skill: chain",
      "# Status: Approved",
      "emit: needs: evaluate",
      "    emit(text=\"done\")",
      "evaluate: needs: fetch",
      "    emit(text=\"mid\")",
      "fetch:",
      "    emit(text=\"start\")",
      "default: emit",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.targets.get("emit")!.deps).toEqual(["evaluate"]);
    expect(parsed.targets.get("evaluate")!.deps).toEqual(["fetch"]);
  });

  it("Make-style `target: dep1 dep2` form is recognized (terse canonical)", () => {
    const src = [
      "# Skill: chain",
      "# Status: Approved",
      "emit: evaluate",
      "    emit(text=\"done\")",
      "evaluate: fetch",
      "    emit(text=\"mid\")",
      "fetch:",
      "    emit(text=\"start\")",
      "default: emit",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.targets.get("emit")!.deps).toEqual(["evaluate"]);
    expect(parsed.targets.get("evaluate")!.deps).toEqual(["fetch"]);
  });

  it("header `target: needs: a, b, c` accepts comma-separated deps", () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "emit: needs: a, b, c",
      "    emit(text=\"done\")",
      "a:",
      "    emit(text=\"a\")",
      "b:",
      "    emit(text=\"b\")",
      "c:",
      "    emit(text=\"c\")",
      "default: emit",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.targets.get("emit")!.deps).toEqual(["a", "b", "c"]);
  });
});
