import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { lint } from "../src/lint.js";

/**
 * v0.17.4 — `unexported-final-var-access` (tier-2 advisory).
 *
 * Sibling consumer-side rule to v0.17.3's tier-1 `unknown-returns-ref`:
 * catches `${R.final_vars.X}` references where R was bound by
 * `$ execute_skill skill_name="<child>" -> R` and `X` isn't in
 * `<child>`'s `# Returns:` declaration. The runtime filter drops X
 * silently — substitution renders empty without the lint nudge.
 *
 * Forward-reference deferred: missing child skills are flagged by
 * `unknown-skill-reference` (tier-2); this rule skips them.
 */

const CHILD_WITH_RETURNS = `# Skill: child-with-returns
# Status: Approved
# Returns: PUBLIC_A, PUBLIC_B

run:
    $set INTERNAL_SCRATCH = "not exported"
    $set PUBLIC_A = "alpha"
    $set PUBLIC_B = "beta"
    emit(text="\${PUBLIC_A}")
default: run
`;

const CHILD_WITHOUT_RETURNS = `# Skill: child-no-returns
# Status: Approved

run:
    $set ANYTHING = "all internal — no declared exports"
    emit(text="hi")
default: run
`;

describe("v0.17.4 — `unexported-final-var-access` lint", () => {
  let home: string;
  let skillStore: FilesystemSkillStore;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "v0174-lint-"));
    skillStore = new FilesystemSkillStore(home);
    await skillStore.store("child-with-returns", CHILD_WITH_RETURNS);
    await skillStore.store("child-no-returns", CHILD_WITHOUT_RETURNS);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("fires tier-2 when caller reaches a name not in the called skill's # Returns:", async () => {
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="child-with-returns" -> R
    emit(text="\${R.final_vars.NEVER_DECLARED}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hit = findings.find((f) => f.rule === "unexported-final-var-access");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("warning");
    expect(hit?.message).toMatch(/NEVER_DECLARED/);
    expect(hit?.message).toMatch(/child-with-returns/);
    expect(hit?.message).toMatch(/PUBLIC_A.*PUBLIC_B|PUBLIC_B.*PUBLIC_A/);
  });

  it("does NOT fire when the name IS in # Returns:", async () => {
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="child-with-returns" -> R
    emit(text="\${R.final_vars.PUBLIC_A} and \${R.final_vars.PUBLIC_B}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hits = findings.filter((f) => f.rule === "unexported-final-var-access");
    expect(hits).toEqual([]);
  });

  it("fires when caller reaches ANY final_vars name on a child with no # Returns: at all", async () => {
    // Child has no Returns header → final_vars is empty post-filter.
    // ANY access into final_vars is unexported.
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="child-no-returns" -> R
    emit(text="\${R.final_vars.ANYTHING}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hit = findings.find((f) => f.rule === "unexported-final-var-access");
    expect(hit).toBeDefined();
    expect(hit?.message).toMatch(/none — skill has no `# Returns:` header/);
  });

  it("does NOT fire on always-exported accessors (outputs, transcript, etc.)", async () => {
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="child-with-returns" -> R
    emit(text="\${R.outputs.text} and \${R.transcript}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hits = findings.filter((f) => f.rule === "unexported-final-var-access");
    expect(hits).toEqual([]);
  });

  it("does NOT fire when the called skill is missing from SkillStore (forward-reference deferred)", async () => {
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="not-stored-yet" -> R
    emit(text="\${R.final_vars.WHATEVER}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hits = findings.filter((f) => f.rule === "unexported-final-var-access");
    expect(hits).toEqual([]);
    // unknown-skill-reference fires instead (tier-2).
    const fwd = findings.find((f) => f.rule === "unknown-skill-reference");
    expect(fwd).toBeDefined();
  });

  it("does NOT fire when SkillStore isn't provided (lint with no store skips reference rules)", async () => {
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="child-with-returns" -> R
    emit(text="\${R.final_vars.NEVER_DECLARED}")
default: compose
`;
    const { findings } = await lint(source, {});
    const hits = findings.filter((f) => f.rule === "unexported-final-var-access");
    expect(hits).toEqual([]);
  });

  it("handles multiple execute_skill bindings independently", async () => {
    const source = `# Skill: multi-compose
# Status: Draft

compose:
    $ execute_skill skill_name="child-with-returns" -> R1
    $ execute_skill skill_name="child-no-returns" -> R2
    emit(text="\${R1.final_vars.PUBLIC_A}")
    emit(text="\${R2.final_vars.ANYTHING}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hits = findings.filter((f) => f.rule === "unexported-final-var-access");
    // R1.PUBLIC_A is declared → fine. R2.ANYTHING isn't (no Returns) → flag.
    expect(hits).toHaveLength(1);
    expect(hits[0]?.message).toMatch(/ANYTHING/);
    expect(hits[0]?.message).toMatch(/child-no-returns/);
  });

  it("accepts both $(R.final_vars.X) and ${R.final_vars.X} substitution forms", async () => {
    const source = `# Skill: dual-form
# Status: Draft

compose:
    $ execute_skill skill_name="child-with-returns" -> R
    emit(text="brace \${R.final_vars.NOPE_BRACE} and paren $(R.final_vars.NOPE_PAREN)")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hits = findings.filter((f) => f.rule === "unexported-final-var-access");
    expect(hits).toHaveLength(2);
    const messages = hits.map((h) => h.message).join("|");
    expect(messages).toMatch(/NOPE_BRACE/);
    expect(messages).toMatch(/NOPE_PAREN/);
  });

  it("deduplicates per (target, ref) — one finding per unique reference per target", async () => {
    const source = `# Skill: dup-test
# Status: Draft

compose:
    $ execute_skill skill_name="child-with-returns" -> R
    emit(text="\${R.final_vars.MISSING}")
    emit(text="again: \${R.final_vars.MISSING}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hits = findings.filter((f) => f.rule === "unexported-final-var-access");
    expect(hits).toHaveLength(1);
  });

  // v1.0 (fix list 33bf53d3 P2.3): the message must reflect the LOUD runtime
  // behavior. CC verified all contexts: unexported access raises
  // UnresolvedVariableError at runtime (op + body-template), it does NOT
  // silently render empty. The message previously taught the false "renders
  // empty" model — corrected so the lint doesn't read as a silent-footgun.
  it("message reflects the loud runtime behavior (UnresolvedVariableError, not silent-empty)", async () => {
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="child-with-returns" -> R
    emit(text="\${R.final_vars.NEVER_DECLARED}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hit = findings.find((f) => f.rule === "unexported-final-var-access");
    expect(hit).toBeDefined();
    expect(hit?.message.includes("UnresolvedVariableError")).toBe(true);
    expect(hit?.message.includes("renders empty")).toBe(false);
  });
});
