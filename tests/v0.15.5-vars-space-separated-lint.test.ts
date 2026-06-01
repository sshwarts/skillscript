import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

// v0.15.5 — Perry's 1b9d83a7 finding. The `# Vars:` parser splits on commas
// only; whitespace is not a declaration boundary. A line like
// `# Vars: A=1 B=2` parses as a single var `A` with default `1 B=2`,
// silently dropping `B`. Downstream `$(B)` references fire `undeclared-var`
// (the symptom) — this rule surfaces the cause (`# Vars:` shape) so the
// fix is one step away from the lint output.

const SKILL_HEAD = "# Skill: t\n# Status: Approved\n";
const SKILL_BODY = "\nrun:\n    emit(text=\"ok\")\ndefault: run\n";

async function findVarsLint(src: string): Promise<string[]> {
  const result = await lint(src);
  return result.findings
    .filter((f) => f.rule === "vars-space-separated")
    .map((f) => f.message);
}

describe("v0.15.5 — `vars-space-separated` lint (Perry 1b9d83a7)", async () => {
  it("FIRES on `# Vars: A=1 B=2` (space-separated two-kwarg pattern)", async () => {
    const messages = await findVarsLint(`${SKILL_HEAD}# Vars: A=1 B=2${SKILL_BODY}`);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/space-separated additional declaration/);
    expect(messages[0]).toMatch(/B=/);
    expect(messages[0]).toMatch(/comma-separated/);
  });

  it("FIRES on three space-separated declarations (catches the first suspect, not all)", async () => {
    // Pattern: A absorbs `1 B=2 C=3` as its default; lint fires on B.
    const messages = await findVarsLint(`${SKILL_HEAD}# Vars: A=1 B=2 C=3${SKILL_BODY}`);
    expect(messages).toHaveLength(1);
    // Heuristic picks the first IDENT= shape after whitespace; should be B.
    expect(messages[0]).toMatch(/ B=/);
  });

  it("does NOT fire on canonical comma-separated `# Vars: A=1, B=2`", async () => {
    expect(await findVarsLint(`${SKILL_HEAD}# Vars: A=1, B=2${SKILL_BODY}`)).toHaveLength(0);
  });

  it("does NOT fire on `# Vars: NAME=\"Bob Jones\"` (whitespace inside quoted value)", async () => {
    // The heuristic strips quoted regions before scanning, so internal
    // whitespace in a quoted string doesn't trip the rule.
    expect(await findVarsLint(`${SKILL_HEAD}# Vars: NAME="Bob Jones"${SKILL_BODY}`)).toHaveLength(0);
  });

  it("does NOT fire on `# Vars: EXPR=\"a = b\"` (whitespace + equals inside quoted value)", async () => {
    expect(await findVarsLint(`${SKILL_HEAD}# Vars: EXPR="a = b"${SKILL_BODY}`)).toHaveLength(0);
  });

  it("does NOT fire on `# Vars: GREETING=\"Hello World\", AGE=42` (mixed: quoted whitespace + canonical comma)", async () => {
    expect(await findVarsLint(`${SKILL_HEAD}# Vars: GREETING="Hello World", AGE=42${SKILL_BODY}`)).toHaveLength(0);
  });

  it("does NOT fire on `# Vars: A` (required var, no default)", async () => {
    expect(await findVarsLint(`${SKILL_HEAD}# Vars: A${SKILL_BODY}`)).toHaveLength(0);
  });

  it("does NOT fire on `# Vars: A=hello world` (value with space but no IDENT= follow-on)", async () => {
    expect(await findVarsLint(`${SKILL_HEAD}# Vars: A=hello world${SKILL_BODY}`)).toHaveLength(0);
  });

  it("does NOT fire on `# Vars: URL=https://example.com` (no whitespace at all)", async () => {
    expect(await findVarsLint(`${SKILL_HEAD}# Vars: URL=https://example.com${SKILL_BODY}`)).toHaveLength(0);
  });

  it("severity is warning (not error) — the parser-silent-drop is the bug class but the dropped var produces a real downstream error already", async () => {
    const result = await lint(`${SKILL_HEAD}# Vars: A=1 B=2${SKILL_BODY}`);
    const finding = result.findings.find((f) => f.rule === "vars-space-separated");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });
});
