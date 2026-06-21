import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { SkillNotFoundError, VersionNotFoundError } from "../src/errors.js";

let dir: string;
let store: FilesystemSkillStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skillscript-store-"));
  store = new FilesystemSkillStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SAMPLE = `# Skill: hello
# Description: greets
# Status: Draft

greet:
    emit(text="hi")

default: greet
`;

describe("FilesystemSkillStore", () => {
  it("store + load round-trips with stable content_hash", async () => {
    const v = await store.store("hello", SAMPLE);
    expect(v.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(v.version).toBe(v.content_hash.slice(0, 12));
    expect(v.status).toBe("Draft");

    const loaded = await store.load("hello");
    expect(loaded.source).toBe(SAMPLE);
    expect(loaded.content_hash).toBe(v.content_hash);
    expect(loaded.metadata.status).toBe("Draft");
  });

  it("load throws SkillNotFoundError for missing skill", async () => {
    await expect(store.load("missing")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("load with mismatched version throws VersionNotFoundError", async () => {
    await store.store("hello", SAMPLE);
    await expect(store.load("hello", "deadbeef0000")).rejects.toBeInstanceOf(VersionNotFoundError);
  });

  it("query returns metadata for all skills, sorted by name", async () => {
    await store.store("alpha", SAMPLE.replace("hello", "alpha"));
    await store.store("beta", SAMPLE.replace("hello", "beta"));
    const all = await store.query();
    expect(all.map((m) => m.name)).toEqual(["alpha", "beta"]);
  });

  it("query filter narrows by status", async () => {
    await store.store("a", SAMPLE);
    await store.store("b", SAMPLE.replace("# Status: Draft", "# Status: Approved"));
    const drafts = await store.query({ status: "Draft" });
    expect(drafts.map((m) => m.name)).toEqual(["a"]);
    const approved = await store.query({ status: "Approved" });
    expect(approved.map((m) => m.name)).toEqual(["b"]);
  });

  it("update_status records previous_status in VersionInfo", async () => {
    await store.store("hello", SAMPLE);
    const v = await store.update_status("hello", "Approved");
    expect(v.previous_status).toBe("Draft");
    expect(v.status).toBe("Approved");

    // Verify the file's body was updated.
    const reloaded = await store.load("hello");
    expect(reloaded.metadata.status).toBe("Approved");
  });

  it("versions() returns the audit chain", async () => {
    await store.store("hello", SAMPLE);
    await store.update_status("hello", "Approved");
    await store.update_status("hello", "Disabled");
    const hist = await store.versions("hello");
    expect(hist).toHaveLength(3);
    expect(hist[0]!.status).toBe("Draft");
    expect(hist[1]!.previous_status).toBe("Draft");
    expect(hist[1]!.status).toBe("Approved");
    expect(hist[2]!.previous_status).toBe("Approved");
    expect(hist[2]!.status).toBe("Disabled");
  });

  it("versions() throws SkillNotFoundError for missing skill", async () => {
    await expect(store.versions("missing")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("delete removes both .skill and .versions.jsonl", async () => {
    await store.store("hello", SAMPLE);
    await store.update_status("hello", "Approved");
    await store.delete("hello");
    await expect(store.load("hello")).rejects.toBeInstanceOf(SkillNotFoundError);
    await expect(store.versions("hello")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("delete throws SkillNotFoundError when nothing to remove", async () => {
    await expect(store.delete("missing")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("soft-delete: excludes from query() + retains the file under .trash (recoverable)", async () => {
    await store.store("hello", SAMPLE);
    await store.update_status("hello", "Approved");
    expect((await store.query()).map((m) => m.name)).toContain("hello");
    await store.delete("hello");
    expect((await store.query()).map((m) => m.name)).not.toContain("hello");
    // Body retained under .trash for recovery, not unlinked.
    const trashed = readdirSync(join(dir, ".trash"));
    expect(trashed.some((f) => f.endsWith("hello.skill.md"))).toBe(true);
    // Name reclaimable with clean history.
    await store.store("hello", SAMPLE);
    expect((await store.versions("hello")).length).toBe(1);
  });

  it("metadata returns SkillMeta without the body", async () => {
    await store.store("hello", SAMPLE);
    const meta = await store.metadata("hello");
    expect(meta.name).toBe("hello");
    expect(meta.status).toBe("Draft");
    expect(meta.description).toBe("greets");
    expect(meta.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("staticCapabilities is callable without instantiation", () => {
    const caps = FilesystemSkillStore.staticCapabilities();
    expect(caps.connector_type).toBe("skill_store");
    expect(caps.features["supports_versioning"]).toBe(true);
    expect(caps.features["supports_audit_trail"]).toBe(true);
  });
});
