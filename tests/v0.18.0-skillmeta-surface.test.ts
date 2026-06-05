import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";

/**
 * v0.18.0 — `SkillMeta` surface population.
 *
 * Pre-v0.18.0, `SkillMeta` declared `vars?: string[]` + (new in
 * v0.18.0) `returns?: string[]`, but `FilesystemSkillStore.buildMeta`
 * only populated `description`. Dashboard composition expansion needs
 * the contract surface — description + vars + returns — to render
 * called-skill panels without an extra source-parse client-side.
 * This ring fills the gap.
 */

describe("v0.18.0 — FilesystemSkillStore.buildMeta populates vars + returns", () => {
  let home: string;
  let store: FilesystemSkillStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0180-meta-"));
    store = new FilesystemSkillStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("populates description from # Description: header", async () => {
    await store.store("with-desc",
      "# Skill: with-desc\n# Status: Draft\n# Description: A worked example\n\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    const meta = await store.metadata("with-desc");
    expect(meta.description).toBe("A worked example");
  });

  it("populates vars from # Vars: header (just the names, not defaults)", async () => {
    await store.store("with-vars",
      "# Skill: with-vars\n# Status: Draft\n# Vars: LOCATION=\"Valdese\", UNITS=imperial\n\nt:\n    emit(text=\"\")\ndefault: t\n");
    const meta = await store.metadata("with-vars");
    expect(meta.vars).toEqual(["LOCATION", "UNITS"]);
  });

  it("populates required-only vars (those without `=default`) when declared FIRST", async () => {
    // Parser semantics: once a vars-entry has `=`, subsequent commas
    // stay value-internal unless the next IDENT also has `=`. Required
    // vars (bare names, no `=`) work cleanly when declared at the
    // front of the list. Documented quirk of the v0.16-era splitVarsLine
    // — not specific to v0.18.0 changes.
    await store.store("with-required",
      "# Skill: with-required\n# Status: Draft\n# Vars: REQUIRED, LOCATION=Valdese\n\nt:\n    emit(text=\"\")\ndefault: t\n");
    const meta = await store.metadata("with-required");
    expect(meta.vars).toEqual(["REQUIRED", "LOCATION"]);
  });

  it("populates returns from # Returns: header", async () => {
    await store.store("with-returns",
      "# Skill: with-returns\n# Status: Draft\n# Returns: SUMMARY, TEMP_F\n\nt:\n    $set SUMMARY = \"x\"\n    $set TEMP_F = \"42\"\ndefault: t\n");
    const meta = await store.metadata("with-returns");
    expect(meta.returns).toEqual(["SUMMARY", "TEMP_F"]);
  });

  it("populates all three surfaces together (full contract)", async () => {
    await store.store("contract-skill",
      "# Skill: contract-skill\n# Status: Draft\n# Description: Full contract example\n# Vars: INPUT_A, INPUT_B=default\n# Returns: OUTPUT_X, OUTPUT_Y\n\nt:\n    $set OUTPUT_X = \"x\"\n    $set OUTPUT_Y = \"y\"\ndefault: t\n");
    const meta = await store.metadata("contract-skill");
    expect(meta.description).toBe("Full contract example");
    expect(meta.vars).toEqual(["INPUT_A", "INPUT_B"]);
    expect(meta.returns).toEqual(["OUTPUT_X", "OUTPUT_Y"]);
  });

  it("vars/returns omitted (not empty array) when header absent — keeps the surface honest", async () => {
    await store.store("bare",
      "# Skill: bare\n# Status: Draft\n\nt:\n    emit(text=\"x\")\ndefault: t\n");
    const meta = await store.metadata("bare");
    expect(meta.vars).toBeUndefined();
    expect(meta.returns).toBeUndefined();
  });

  it("query() surfaces vars + returns for every skill", async () => {
    await store.store("a",
      "# Skill: a\n# Status: Approved\n# Vars: X\n# Returns: A\n\nt:\n    $set A = \"1\"\ndefault: t\n");
    await store.store("b",
      "# Skill: b\n# Status: Approved\n# Vars: Y, Z\n\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    const list = await store.query();
    const a = list.find((s) => s.name === "a");
    const b = list.find((s) => s.name === "b");
    expect(a?.vars).toEqual(["X"]);
    expect(a?.returns).toEqual(["A"]);
    expect(b?.vars).toEqual(["Y", "Z"]);
    expect(b?.returns).toBeUndefined();
  });
});
