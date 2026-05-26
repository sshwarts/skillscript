import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { compile } from "../src/compile.js";

/**
 * v0.2.10 — three high-severity bug fixes from Perry's wild-and-crazy
 * harness (thread b6176e02). 6 fresh sub-agents, ~60 skills, 8 real
 * bugs filed. This patch addresses the top three:
 *
 *   Bug 1: `-> VAR` binding rendered as `$(<target>.output)` in compile
 *     artifact (4 observers). Now renders as `$(VAR)` when explicit.
 *
 *   Bug 2: `# Vars: LOCATION=Asheville,NC` parsed as TWO declarations
 *     (2 observers). Now treats commas inside values as value-internal
 *     unless followed by IDENT-with-= which signals a new declaration.
 *
 *   Bug 3: Nested control flow (if inside elif followed by sibling
 *     else) failed with mid-block-indent-change error (3 observers).
 *     Now the elif/else continuation walks DOWN the scope stack to
 *     find the matching if-frame, popping inner frames as it goes.
 */

describe("v0.2.10 Bug 1 — `-> VAR` renders as $(VAR) in compile artifact", () => {
  it("@ op with -> VAR renders the bound variable name", async () => {
    const src = "# Skill: t\n# Status: Approved\nfetch:\n    @ echo hi -> GREETING\ndefault: fetch\n";
    const r = await compile(src);
    expect(r.output).toMatch(/bind output to \$\(GREETING\)/);
    expect(r.output).not.toMatch(/\$\(fetch\.output\)/);
  });

  it("$ op with -> VAR renders the bound variable name", async () => {
    const src = "# Skill: t\n# Status: Approved\ncall:\n    $ some.tool arg=1 -> RESULT\ndefault: call\n";
    const r = await compile(src);
    expect(r.output).toMatch(/bind output to \$\(RESULT\)/);
  });

  it("@ op WITHOUT -> binding falls back to $(<target>.output)", async () => {
    const src = "# Skill: t\n# Status: Approved\nfetch:\n    @ echo hi\ndefault: fetch\n";
    const r = await compile(src);
    expect(r.output).toMatch(/bind output to \$\(fetch\.output\)/);
  });
});

describe("v0.2.10 Bug 2 — `# Vars:` doesn't split mid-value on commas", () => {
  it("Perry's repro: LOCATION=Asheville,NC, UNITS=metric → 2 vars", () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: LOCATION=Asheville,NC, UNITS=metric\nm:\n    ! hi\ndefault: m\n";
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    expect(r.vars).toEqual([
      { name: "LOCATION", default: "Asheville,NC", required: false },
      { name: "UNITS", default: "metric", required: false },
    ]);
  });

  it("chains of bare-required vars still split (A, B, C → 3 vars)", () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: A, B, C\nm:\n    ! hi\ndefault: m\n";
    const r = parse(src);
    expect(r.vars).toEqual([
      { name: "A", required: true },
      { name: "B", required: true },
      { name: "C", required: true },
    ]);
  });

  it("mixed: bare-required + defaulted-with-comma + bare-defaulted", () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: NC, LOCATION=Asheville,NC, UNITS=metric\nm:\n    ! hi\ndefault: m\n";
    const r = parse(src);
    expect(r.vars).toEqual([
      { name: "NC", required: true },
      { name: "LOCATION", default: "Asheville,NC", required: false },
      { name: "UNITS", default: "metric", required: false },
    ]);
  });

  it("# Templates: with hyphenated skill names still splits (regression guard from v0.2.6)", () => {
    const src = "# Skill: t\n# Status: Approved\n# Templates: queue-drain-procedure, ops-page\n# Output: agent: oncall\nm:\n    ! hi\ndefault: m\n";
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    expect(r.templates).toEqual(["queue-drain-procedure", "ops-page"]);
  });
});

describe("v0.2.10 Bug 3 — nested control flow parses correctly", () => {
  it("if-in-if (two levels of nesting)", () => {
    const src = "# Skill: t\n# Status: Approved\nmain:\n    if $(A):\n        if $(B):\n            ! both\ndefault: main\n";
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    const op = r.targets.get("main")!.ops[0]!;
    expect(op.kind).toBe("if");
    expect(op.ifBranches![0]!.body[0]!.kind).toBe("if");
  });

  it("foreach inside if", () => {
    const src = "# Skill: t\n# Status: Approved\nmain:\n    if $(A):\n        foreach M in $(LIST):\n            ! $(M)\ndefault: main\n";
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    const op = r.targets.get("main")!.ops[0]!;
    expect(op.ifBranches![0]!.body[0]!.kind).toBe("foreach");
  });

  it("if-then-sibling op at same target level", () => {
    const src = "# Skill: t\n# Status: Approved\nmain:\n    if $(A):\n        ! inside\n    ! after\ndefault: main\n";
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    const ops = r.targets.get("main")!.ops;
    expect(ops).toHaveLength(2);
    expect(ops[0]!.kind).toBe("if");
    expect(ops[1]!.kind).toBe("!");
  });

  it("the load-bearing case: elif with nested-if then sibling else", () => {
    // Was: "Mid-block indent change... enclosing block expects 4."
    // Now: parses cleanly — the elif/else continuation walks DOWN the
    // scope stack to find the matching if-frame.
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Vars: A=1, B=2",
      "main:",
      `    if $(A) > "5":`,
      "        ! high",
      `    elif $(A) > "0":`,
      `        if $(B) > "0":`,
      "            ! medium-both",
      "    else:",
      "        ! default",
      "default: main",
      "",
    ].join("\n");
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    const ifOp = r.targets.get("main")!.ops[0]!;
    expect(ifOp.kind).toBe("if");
    expect(ifOp.ifBranches).toHaveLength(2); // outer if + elif
    expect(ifOp.ifElseBody).toBeDefined();
  });

  it("deeply nested: if > foreach > if", () => {
    const src = "# Skill: t\n# Status: Approved\nmain:\n    if $(A):\n        foreach M in $(LIST):\n            if $(M.urgent):\n                ! flagged\ndefault: main\n";
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
  });
});
