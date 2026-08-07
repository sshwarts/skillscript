import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

/**
 * unquoted-substitution-in-kwarg-value — SHELL-ONLY as of v0.39.2 (ticket 7ca043f9).
 *
 * Originally (v0.5.0) this rule warned that `$ tool key=$(VAR)` with a
 * whitespace-bearing VAR silently truncated the MCP arg at the tokenizer. That
 * class was CURED in v0.39.2: `$` kwargs are now parsed BEFORE substitution, so
 * an unquoted `${VAR}` binds the whole value regardless of whitespace OR embedded
 * quotes. The `$` branch of the lint was therefore removed — it would only be a
 * false positive on now-safe code (behavior covered in
 * v0.39.2-dispatch-arg-substitution.test.ts).
 *
 * The shell path still word-splits (the runtime spawns on a whitespace-tokenized
 * command), so the warning stays there and only there — same binding-origin
 * awareness as before.
 */

const R = "unquoted-substitution-in-kwarg-value";

describe("v0.39.2 — $ dispatch substitution no longer warns (fixed, not linted)", () => {
  // The whole suspect-origin matrix that used to warn on `$` ops now binds the
  // value whole, so no warning should fire on any of these.
  const cases: Array<[string, string]> = [
    ["# Vars: whitespace default", `# Skill: t\n# Status: Approved\n# Vars: QUERY=state: -Resolved sort by: updated\nrun:\n    $ search_issues query=$(QUERY) -> R\ndefault: run\n`],
    ["~ op output", `# Skill: t\n# Status: Approved\nrun:\n    $ llm prompt="Pick a topic" -> TOPIC\n    $ search_issues query=$(TOPIC) -> R\ndefault: run\n`],
    ["$ op output", `# Skill: t\n# Status: Approved\nrun:\n    $ pick_topic -> TOPIC\n    $ search_issues query=$(TOPIC) -> R\ndefault: run\n`],
    ["retrieval output", `# Skill: t\n# Status: Approved\nrun:\n    $ data_read mode=fts query="topic" limit=1 -> MEMS\n    $ summarize text=$(MEMS) -> R\ndefault: run\n`],
    ["foreach iterator", `# Skill: t\n# Status: Approved\n# Vars: ITEMS=[a, b, c]\nrun:\n    foreach I in $(ITEMS):\n        $ process item=$(I) -> R\ndefault: run\n`],
    ["$set whitespace value", `# Skill: t\n# Status: Approved\nrun:\n    $set Q = "multi word query"\n    $ search query=$(Q) -> R\ndefault: run\n`],
    ["dotted ref", `# Skill: t\n# Status: Approved\nrun:\n    $ fetch -> PAYLOAD\n    $ submit body=$(PAYLOAD.text) -> R\ndefault: run\n`],
    ["filter chain", `# Skill: t\n# Status: Approved\n# Vars: Q=multi word\nrun:\n    $ search query=$(Q|trim) -> R\ndefault: run\n`],
  ];
  for (const [label, src] of cases) {
    it(`no warning on $ op: ${label}`, async () => {
      const r = await lint(src);
      expect(r.findings.find((x) => x.rule === R)).toBeUndefined();
    });
  }
});

describe("v0.39.2 — shell(...) args still warn (word-splitting is real there)", () => {
  it("fires on an unquoted suspect-origin substitution in a shell command", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: QUERY=multi word query\nrun:\n    shell(command="grep $(QUERY) file.txt") -> R\ndefault: run\n`;
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === R);
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.message).toMatch(/QUERY/);
    expect(f!.message).toMatch(/whitespace|word-split/);
  });

  it("fires on a var bound from an op output used unquoted in a shell command", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ llm prompt="pick" -> TOPIC\n    shell(command="grep $(TOPIC) file.txt") -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeDefined();
  });

  it("silent on a QUOTED shell substitution", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: QUERY=multi word query\nrun:\n    shell(command="grep \\"$(QUERY)\\" file.txt") -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeUndefined();
  });
});

describe("v0.39.2 — silent on safe origins (unchanged)", () => {
  it("quoted `$` substitution never warns", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: QUERY=multi word query\nrun:\n    $ search_issues query="$(QUERY)" -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeUndefined();
  });

  it("literal kwarg (no substitution) never warns", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ search query="hello world" -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeUndefined();
  });

  it("a single-word shell substitution does not warn (no whitespace risk)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: ID=42\nrun:\n    shell(command="fetch $(ID)") -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === R)).toBeUndefined();
  });
});
