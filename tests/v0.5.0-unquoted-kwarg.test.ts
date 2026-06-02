import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

/**
 * v0.5.0 item 1 — unquoted-substitution-in-kwarg-value tier-2 lint.
 *
 * R3 minion 4 finding: `$ tool key=$(VAR)` where VAR resolves to a
 * value containing whitespace silently truncates at the MCP arg
 * tokenizer. The rendered string `key=foo bar baz` re-tokenizes into
 * {key:"foo"} + dropped "bar" + dropped "baz". Folklore says "always
 * quote dynamic kwarg values" but pre-v0.5.0 nothing surfaced it.
 *
 * The rule is binding-origin-aware:
 *   - `# Vars: VAR=multi word` → fires
 *   - `# Vars: VAR=singleword` → silent
 *   - `~ ... -> VAR` (always-suspect) → fires
 *   - `$ ... -> VAR` (always-suspect) → fires
 *   - `> ... -> VAR` → fires
 *   - foreach iterator → fires
 *   - `$set VAR = "no whitespace"` → silent
 *   - `$set VAR = "has whitespace"` → fires
 *   - Quoted `key="$(VAR)"` → silent always
 */

const R = "unquoted-substitution-in-kwarg-value";

describe("v0.5.0 item 1 — fires on suspect binding origins", () => {
  it("FAIL: # Vars: default contains whitespace", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: QUERY=state: -Resolved sort by: updated\nrun:\n    $ search_issues query=$(QUERY) -> R\ndefault: run\n`;
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === R);
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.message).toMatch(/QUERY/);
    expect(f!.message).toMatch(/whitespace/);
  });

  it("FAIL: var bound from `~` op output (always suspect)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ llm prompt="Pick a topic" -> TOPIC\n    $ search_issues query=$(TOPIC) -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeDefined();
  });

  it("FAIL: var bound from `$` op output (always suspect)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ pick_topic -> TOPIC\n    $ search_issues query=$(TOPIC) -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeDefined();
  });

  it("FAIL: var bound from `>` op (retrieval) — multi-word results", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ data_read mode=fts query="topic" limit=1 -> MEMS\n    $ summarize text=$(MEMS) -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeDefined();
  });

  it("FAIL: var is foreach iterator (element shape unknown)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: ITEMS=[a, b, c]\nrun:\n    foreach I in $(ITEMS):\n        $ process item=$(I) -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeDefined();
  });

  it("FAIL: $set value contains whitespace", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $set Q = "multi word query"\n    $ search query=$(Q) -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeDefined();
  });

  it("FAIL: $set RHS contains a $(REF) — shape unknown", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: PREFIX=foo bar\nrun:\n    $set Q = "$(PREFIX)-suffix"\n    $ search query=$(Q) -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeDefined();
  });
});

describe("v0.5.0 item 1 — silent on safe origins", () => {
  it("OK: quoted substitution `key=\"$(VAR)\"` regardless of origin", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: QUERY=multi word query\nrun:\n    $ search_issues query="$(QUERY)" -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeUndefined();
  });

  it("OK: # Vars: default has no whitespace", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: ID=42\nrun:\n    $ fetch_issue id=$(ID) -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeUndefined();
  });

  it("OK: $set value with no whitespace", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $set ID = "BUG-42"\n    $ fetch_issue id=$(ID) -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeUndefined();
  });

  it("OK: undeclared variable — not our concern (other rule handles it)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ search query=$(NOT_DECLARED) -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeUndefined();
  });

  it("OK: literal kwarg (no substitution)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ search query="hello world" -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeUndefined();
  });

  it("OK: $ op with no kwargs", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ current_user -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeUndefined();
  });
});

describe("v0.5.0 item 1 — dotted refs + filter chains", () => {
  it("FAIL: dotted ref resolves to root var origin", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ fetch -> PAYLOAD\n    $ submit body=$(PAYLOAD.text) -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeDefined();
  });

  it("FAIL: ref with filter chain still triggers (suspect origin)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: Q=multi word\nrun:\n    $ search query=$(Q|trim) -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeDefined();
  });
});

describe("v0.5.0 item 1 — dedupes per (target, kwarg, var)", () => {
  it("repeated unsafe op in same target only reports once per kwarg+var", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: Q=multi word query\nrun:\n    $ search query=$(Q) -> R1\n    $ search query=$(Q) -> R2\ndefault: run\n`;
    const r = await lint(src);
    const matches = r.findings.filter((x) => x.rule === R);
    expect(matches).toHaveLength(1);
  });

  it("different kwarg names → separate findings", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: Q=multi word\nrun:\n    $ search query=$(Q) other=$(Q) -> R\ndefault: run\n`;
    const r = await lint(src);
    const matches = r.findings.filter((x) => x.rule === R);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
