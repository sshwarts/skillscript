import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";
import { parse } from "../src/parser.js";

/**
 * v0.16.7 — fix for `splitTopLevelCommas` not tracking triple-quote state.
 *
 * Triple-quote bodies can contain double-quote chars as literal content,
 * but `splitTopLevelCommas` (the parser's top-level comma splitter for
 * function-call kwarg lists) toggled `inQuote` on every `"`. Triple-quote
 * bodies with an odd-count of embedded `"` chars unbalanced the state,
 * which made top-level commas appear "outside a quote" mid-body and split
 * args prematurely. The closing `"""` then looked like malformed kwargs.
 *
 * Per Perry's `c497b479` finding. Fix mirrors the inTriple discipline
 * already present in `tokenizeKeywordArgs` and `extractParenBody`.
 */

describe("v0.16.7 — splitTopLevelCommas triple-quote awareness", () => {
  it("verbatim repro from Perry's c497b479 — passes after fix", async () => {
    const src = `# Skill: tq-quote-probe-2
# Status: Approved
run:
    emit(text="""
        Test 1: simple "two-word" phrase.
        Test 2: "multi-word phrase with spaces" inside quotes.
        Test 3: phrase ending with "comma inside, here".
        Test 4: "more native spelling pending," with the exact failing literal.
    """)
default: run
`;
    const result = await lint(src);
    const malformed = result.findings.find((f) => f.rule === "malformed-op-grammar");
    expect(malformed, "verbatim repro must parse cleanly post-fix").toBeUndefined();
  });

  it("triple-quote body with odd-count embedded quotes + top-level-shaped comma — single arg", () => {
    // Body content: `unbalanced "open quote` (one `"` only), then comma.
    // Pre-fix: inQuote toggles to '"' on the inner `"`, then the comma
    // appears at top-level because we mis-counted nesting; the body splits.
    const src = `# Skill: t
# Status: Approved
run:
    emit(text="""body with "unmatched open quote, then comma here""")
default: run
`;
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
  });

  it("triple-quote body with multiple comma-inside-quoted-phrase patterns", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    emit(text="""
        Line A: "comma, one" inside.
        Line B: "comma, two" inside.
        Line C: "comma, three" inside.
    """)
default: run
`;
    const result = await lint(src);
    const malformed = result.findings.find((f) => f.rule === "malformed-op-grammar");
    expect(malformed).toBeUndefined();
  });

  it("triple-quote body that ends mid-quote (closing \"\"\" right after a `,`)", async () => {
    // Edge case: comma immediately before the closing delimiter.
    const src = `# Skill: t
# Status: Approved
run:
    emit(text="""body, here""")
default: run
`;
    const result = await lint(src);
    const malformed = result.findings.find((f) => f.rule === "malformed-op-grammar");
    expect(malformed).toBeUndefined();
  });

  it("function-call with multi-kwarg + triple-quote arg — top-level commas still split correctly", async () => {
    // Genuine top-level comma BETWEEN kwargs (post triple-quote) must still
    // be honored. Tests the fix doesn't over-suppress.
    const src = `# Skill: t
# Status: Approved
run:
    file_write(path="/tmp/out.md", content="""line 1
line 2, with comma""", approved="manual")
default: run
`;
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    // The op should parse with 3 kwargs: path, content, approved.
    const target = parsed.targets.get("run")!;
    const fw = target.ops.find((o) => o.kind === "file_write");
    expect(fw).toBeDefined();
    expect(fw!.body).toContain("path");
    expect(fw!.body).toContain("content");
    expect(fw!.body).toContain("approved");
  });

  it("nested function-call args with embedded triple-quotes — no regression", async () => {
    // Sanity check: triple-quote inside execute_skill input still works.
    const src = `# Skill: t
# Status: Approved
run:
    execute_skill(skill_name="child", inputs={"prompt": """multi
line "quoted, with comma"
body"""}) -> R
default: run
`;
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
  });
});
