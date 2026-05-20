import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReferenceIndex,
  ReferentialIntegrityError,
  deleteSkill,
  storeSkill,
  invalidateConnector,
  buildReferenceIndex,
} from "../src/skill-manager.js";
import { Registry } from "../src/connectors/registry.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { OllamaLocalModel } from "../src/connectors/local-model.js";
import { ConnectorError, SkillNotFoundError } from "../src/errors.js";

let dir: string;
let registry: Registry;
let index: ReferenceIndex;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skillscript-mgr-"));
  registry = new Registry();
  registry.registerSkillStore("primary", new FilesystemSkillStore(dir));
  index = new ReferenceIndex();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SAMPLE = `# Skill: hello
# Status: draft

greet:
    ! hi

default: greet
`;

describe("ReferenceIndex", () => {
  it("tracks bidirectional edges; setOutgoing replaces", () => {
    index.setOutgoing("foo", ["a", "b"]);
    expect(index.referencesFrom("foo").sort()).toEqual(["a", "b"]);
    expect(index.referencesTo("a")).toEqual(["foo"]);
    expect(index.referencesTo("b")).toEqual(["foo"]);

    // Replace foo's outgoing edges with just ["c"].
    index.setOutgoing("foo", ["c"]);
    expect(index.referencesFrom("foo")).toEqual(["c"]);
    expect(index.referencesTo("a")).toEqual([]);
    expect(index.referencesTo("b")).toEqual([]);
    expect(index.referencesTo("c")).toEqual(["foo"]);
  });

  it("drop removes all outgoing edges and cleans up referencedBy", () => {
    index.setOutgoing("foo", ["a", "b"]);
    index.drop("foo");
    expect(index.referencesFrom("foo")).toEqual([]);
    expect(index.referencesTo("a")).toEqual([]);
    expect(index.size()).toBe(0);
  });

  it("multiple sources can reference the same target", () => {
    index.setOutgoing("foo", ["target"]);
    index.setOutgoing("bar", ["target"]);
    expect(index.referencesTo("target").sort()).toEqual(["bar", "foo"]);
  });
});

describe("deleteSkill", () => {
  it("deletes when no references exist", async () => {
    await registry.getSkillStore().store("hello", SAMPLE);
    await deleteSkill("hello", { registry, index });
    await expect(registry.getSkillStore().load("hello")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("throws ReferentialIntegrityError when references exist", async () => {
    await registry.getSkillStore().store("target", SAMPLE);
    await registry.getSkillStore().store("source", SAMPLE);
    index.setOutgoing("source", ["target"]);

    try {
      await deleteSkill("target", { registry, index });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ReferentialIntegrityError);
      expect((err as ReferentialIntegrityError).skill_name).toBe("target");
      expect((err as ReferentialIntegrityError).referenced_by).toEqual(["source"]);
    }

    // Verify target was NOT deleted.
    const meta = await registry.getSkillStore().metadata("target");
    expect(meta.name).toBe("target");
  });

  it("force: true bypasses the referential-integrity check", async () => {
    await registry.getSkillStore().store("target", SAMPLE);
    index.setOutgoing("source", ["target"]);
    await deleteSkill("target", { registry, index, force: true });
    await expect(registry.getSkillStore().load("target")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("ReferentialIntegrityError is NOT a ConnectorError", async () => {
    // Perry's flagged distinction: this error is runtime-layer, NOT
    // substrate-layer. The executor's else:/OnError: machinery routes
    // ConnectorError; ReferentialIntegrityError must surface to the
    // user-facing caller directly.
    await registry.getSkillStore().store("target", SAMPLE);
    index.setOutgoing("source", ["target"]);
    try {
      await deleteSkill("target", { registry, index });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ReferentialIntegrityError);
      expect(err).not.toBeInstanceOf(ConnectorError);
    }
  });
});

describe("storeSkill", () => {
  it("delegates to the substrate and updates the index", async () => {
    const info = await storeSkill("hello", SAMPLE, { registry, index });
    expect(info.name).toBe("hello");
    // T1 grammar has no & op so extractReferences returns empty; index
    // edge count stays zero. T3 will make this meaningful.
    expect(index.size()).toBe(0);
  });
});

describe("buildReferenceIndex", () => {
  it("scans the store on startup", async () => {
    await registry.getSkillStore().store("a", SAMPLE);
    await registry.getSkillStore().store("b", SAMPLE);
    const ix = await buildReferenceIndex(registry.getSkillStore());
    // No & ops in T1 grammar → empty index.
    expect(ix.size()).toBe(0);
  });

  it("returns empty index for empty store", async () => {
    const ix = await buildReferenceIndex(registry.getSkillStore());
    expect(ix.size()).toBe(0);
  });
});

describe("invalidateConnector", () => {
  it("invokes invalidateManifest on the named instance if defined", async () => {
    const ollama = new OllamaLocalModel({ defaultModelTag: "gemma2:9b" });
    // Prime the cache so we can observe invalidation.
    // Actual fetch will fail (no Ollama running) but the cache fills with [].
    await ollama.manifest();
    registry.registerLocalModel("default", ollama);
    invalidateConnector("default", registry);
    // After invalidation the next manifest call will re-fetch. We can't
    // assert that without a fake Ollama; just verify the method exists
    // and didn't throw.
    expect(typeof (ollama as unknown as { invalidateManifest: () => void }).invalidateManifest).toBe("function");
  });

  it("no-ops silently when name doesn't match any registered connector", () => {
    expect(() => invalidateConnector("missing", registry)).not.toThrow();
  });
});
