import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { buildSkillCatalog } from "../src/skill-catalog.js";

/**
 * v0.18.6 — author surfaced on skill discovery + author filter on
 * skill_list. Closes Perry's `1f278e5e` spec request: generic,
 * connector-implemented, substrate-neutral; graceful degradation on
 * substrates that don't track authorship.
 */

async function writeSkill(store: FilesystemSkillStore, name: string, author: string): Promise<void> {
  await store.store(
    name,
    `# Skill: ${name}
# Status: Approved
# Description: skill owned by ${author}
m:
    emit(text="hi from ${name}")
default: m
`,
    { author },
  );
}

describe("v0.18.6 — SkillEntry.author surfaces on catalog output", () => {
  it("entries carry author when SkillStore populates it", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0186-author-"));
    try {
      const store = new FilesystemSkillStore(join(home, "skills"));
      await writeSkill(store, "alice-skill-a", "alice");
      await writeSkill(store, "bob-skill", "bob");

      const catalog = await buildSkillCatalog(store);
      const all = [...(catalog.receives ?? []), ...(catalog.skills ?? []), ...(catalog.headless ?? [])];
      const alice = all.find((e) => e.name === "alice-skill-a");
      const bob = all.find((e) => e.name === "bob-skill");

      expect(alice?.author).toBe("alice");
      expect(bob?.author).toBe("bob");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("v0.18.6 — skill_list filter.author narrows results", () => {
  it("filter.author=\"alice\" returns only alice's skills (AND-composed with other filters)", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0186-filter-"));
    try {
      const store = new FilesystemSkillStore(join(home, "skills"));
      await writeSkill(store, "alice-1", "alice");
      await writeSkill(store, "alice-2", "alice");
      await writeSkill(store, "bob-1", "bob");
      await writeSkill(store, "carol-1", "carol");

      const catalog = await buildSkillCatalog(store, { author: "alice" });
      const all = [...(catalog.receives ?? []), ...(catalog.skills ?? []), ...(catalog.headless ?? [])];
      const names = all.map((e) => e.name).sort();

      expect(names).toEqual(["alice-1", "alice-2"]);
      // Author surfaced on every returned entry
      expect(all.every((e) => e.author === "alice")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("filter.author with no matches returns empty catalog (not error)", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0186-empty-"));
    try {
      const store = new FilesystemSkillStore(join(home, "skills"));
      await writeSkill(store, "alice-1", "alice");

      const catalog = await buildSkillCatalog(store, { author: "no-one-by-this-name" });
      const all = [...(catalog.receives ?? []), ...(catalog.skills ?? []), ...(catalog.headless ?? [])];
      expect(all).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("filter.author AND-composes with name_prefix", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0186-and-"));
    try {
      const store = new FilesystemSkillStore(join(home, "skills"));
      await writeSkill(store, "morning-alice", "alice");
      await writeSkill(store, "evening-alice", "alice");
      await writeSkill(store, "morning-bob", "bob");

      const catalog = await buildSkillCatalog(store, { author: "alice", name_prefix: "morning-" });
      const all = [...(catalog.receives ?? []), ...(catalog.skills ?? []), ...(catalog.headless ?? [])];
      expect(all.map((e) => e.name)).toEqual(["morning-alice"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("works for substrates that don't honor the filter natively (in-memory graceful degradation)", async () => {
    // FilesystemSkillStore.query() doesn't natively understand the
    // `author` filter — it returns all status-matching metas. The
    // catalog-layer in-memory filter still narrows correctly. This
    // verifies the graceful-degradation path Perry's spec requires.
    const home = mkdtempSync(join(tmpdir(), "v0186-gracedegrade-"));
    try {
      const store = new FilesystemSkillStore(join(home, "skills"));
      await writeSkill(store, "skill-a", "alice");
      await writeSkill(store, "skill-b", "bob");

      // Confirm substrate doesn't filter — query() returns both
      const metas = await store.query({ status: "Approved" });
      expect(metas.length).toBe(2);

      // Catalog-layer narrows correctly
      const catalog = await buildSkillCatalog(store, { author: "bob" });
      const all = [...(catalog.receives ?? []), ...(catalog.skills ?? []), ...(catalog.headless ?? [])];
      expect(all.map((e) => e.name)).toEqual(["skill-b"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("v0.18.6 — author is null on entries when substrate doesn't populate", () => {
  it("entry.author === null when SkillMeta.author is undefined (substrate-neutral graceful degradation)", async () => {
    // Mock SkillStore that genuinely doesn't track authorship — e.g.,
    // an adopter substrate where ownership isn't a first-class concept.
    // Bundled stores like FilesystemSkillStore auto-populate from
    // os.userInfo() so we can't test the null path against them.
    const authorless: Parameters<typeof buildSkillCatalog>[0] = {
      async query() {
        return [{
          name: "no-author-skill",
          status: "Approved" as const,
          description: "no authorship tracked by substrate",
          version: "deadbeef",
          content_hash: "deadbeef",
          created_at: 0,
        }];
      },
      async load() {
        return {
          name: "no-author-skill",
          source: `# Skill: no-author-skill
# Status: Approved
# Description: no authorship
m:
    emit(text="hi")
default: m
`,
          version: "deadbeef",
          status: "Approved" as const,
        };
      },
      async metadata() { throw new Error("not impl"); },
      async store() { throw new Error("not impl"); },
      async update_status() { throw new Error("not impl"); },
      async delete() { throw new Error("not impl"); },
      async versions() { return []; },
      staticCapabilities() {
        return { supports_writes: true, supports_versioning: false, supports_tag_filter: false };
      },
    } as Parameters<typeof buildSkillCatalog>[0];

    const catalog = await buildSkillCatalog(authorless);
    const all = [...(catalog.receives ?? []), ...(catalog.skills ?? []), ...(catalog.headless ?? [])];
    const entry = all.find((e) => e.name === "no-author-skill");
    expect(entry?.author).toBeNull();
  });
});
