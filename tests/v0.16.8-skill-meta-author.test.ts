import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userInfo } from "node:os";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { StorageConflictError } from "../src/errors.js";

/**
 * v0.16.8 — `SkillMeta.author` capture at SkillStore write boundary.
 *
 * The SkillStore IS the trust boundary: whoever's authenticated to write
 * IS the owner. First-write captures the author; subsequent overwrites
 * preserve it. Transfer of ownership is a substrate-specific privileged
 * operation, not a side-effect of an authoring rewrite.
 *
 * Per the consolidated charter `9af842f7` + warm-agent's `1e1c9305`
 * recommendation to reuse the existing `SkillMeta.author` field rather
 * than add a new `metadata.owner`. Per Perry's `9d9aef14`: locked at
 * first-write, trust-boundary-slip is the load-bearing concern.
 *
 * v0.16.8 ships the capture only. Runtime threading of `author` into
 * dispatch ctx + connector honoring is v0.16.9+ propagation work.
 */

const SAMPLE_SKILL = `# Skill: meta-author-probe
# Status: Draft

t:
    emit(text="probe")
default: t
`;

describe("v0.16.8 — FilesystemSkillStore captures author at first-write", () => {
  it("defaults `author` to `os.userInfo().username` when metadata.author is not supplied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0168-author-default-"));
    const store = new FilesystemSkillStore(dir);
    const info = await store.store("p1", SAMPLE_SKILL);
    expect(info.changed_by).toBe(userInfo().username);
    const meta = await store.metadata("p1");
    expect(meta.author).toBe(userInfo().username);
  });

  it("honors explicit `metadata.author` at first-write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0168-author-explicit-"));
    const store = new FilesystemSkillStore(dir);
    const info = await store.store("p2", SAMPLE_SKILL, { author: "alice" });
    expect(info.changed_by).toBe("alice");
    const meta = await store.metadata("p2");
    expect(meta.author).toBe("alice");
  });

  it("preserves original author on overwrite when no `metadata.author` supplied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0168-author-overwrite-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("p3", SAMPLE_SKILL, { author: "alice" });
    // Subsequent store(): no author argument. Original alice should win.
    const info = await store.store("p3", SAMPLE_SKILL + "\n");
    expect(info.changed_by).toBe("alice");
    const meta = await store.metadata("p3");
    expect(meta.author).toBe("alice");
  });

  it("preserves original author on overwrite when `metadata.author` matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0168-author-match-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("p4", SAMPLE_SKILL, { author: "alice" });
    const info = await store.store("p4", SAMPLE_SKILL + "\n", { author: "alice" });
    expect(info.changed_by).toBe("alice");
  });

  it("throws on overwrite when explicit `metadata.author` disagrees with first-write author", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0168-author-conflict-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("p5", SAMPLE_SKILL, { author: "alice" });
    // The load-bearing trust-boundary check: bob can't claim alice's skill.
    await expect(store.store("p5", SAMPLE_SKILL + "\n", { author: "bob" })).rejects.toThrow(
      StorageConflictError,
    );
    await expect(store.store("p5", SAMPLE_SKILL + "\n", { author: "bob" })).rejects.toThrow(
      /locked at first-write.*alice.*bob/,
    );
  });

  it("query() returns author for every skill that has versions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0168-author-query-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("a-skill", SAMPLE_SKILL.replace("meta-author-probe", "a-skill"), { author: "alice" });
    await store.store("b-skill", SAMPLE_SKILL.replace("meta-author-probe", "b-skill"), { author: "bob" });
    const metas = await store.query();
    const aSkill = metas.find((m) => m.name === "a-skill")!;
    const bSkill = metas.find((m) => m.name === "b-skill")!;
    expect(aSkill.author).toBe("alice");
    expect(bSkill.author).toBe("bob");
  });

  it("load() returns author in metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0168-author-load-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("loadme", SAMPLE_SKILL.replace("meta-author-probe", "loadme"), { author: "carol" });
    const loaded = await store.load("loadme");
    expect(loaded.metadata.author).toBe("carol");
  });

  it("status transitions preserve author (update_status doesn't re-attribute)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0168-author-status-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("statskill", SAMPLE_SKILL.replace("meta-author-probe", "statskill"), { author: "dave" });
    await store.update_status("statskill", "Approved");
    const meta = await store.metadata("statskill");
    expect(meta.author).toBe("dave");
  });

  it("author field absent for legacy skills with no version log (graceful)", async () => {
    // Edge case: a SkillStore that pre-dated v0.16.8 (no versions.jsonl)
    // shouldn't error on metadata reads — author just stays undefined.
    const dir = mkdtempSync(join(tmpdir(), "v0168-author-legacy-"));
    const store = new FilesystemSkillStore(dir);
    // Write the skill file directly without going through store() — simulates
    // a legacy filesystem state where author wasn't captured.
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "legacy.skill.md"), SAMPLE_SKILL.replace("meta-author-probe", "legacy"), "utf8");
    const meta = await store.metadata("legacy");
    expect(meta.author).toBeUndefined();
  });
});
