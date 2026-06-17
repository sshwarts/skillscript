/**
 * Tests for SqliteSkillStore. Uses `:memory:` SQLite databases as fixtures —
 * no filesystem temp dir needed. Each test gets a fresh instance.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteSkillStore } from "../src/connectors/sqlite-skill-store.js";
import { SkillStoreConformance } from "../src/testing/conformance.js";
import { SkillNotFoundError, VersionNotFoundError } from "../src/errors.js";
import { setSecuredMode, setApprovalPublicKey, generateApprovalKeypair, stampApprovalEd25519 } from "../src/approval.js";

const SAMPLE_SKILL = `# Skill: hello
# Status: Draft
# Description: Says hi
t:
    emit(text="hi")
default: t
`;

const APPROVED_SKILL = `# Skill: hello-approved
# Status: Approved
t:
    emit(text="hi")
default: t
`;

describe("SqliteSkillStore — basic round-trip", () => {
  let store: SqliteSkillStore;
  beforeEach(() => { store = new SqliteSkillStore({ dbPath: ":memory:" }); });
  afterEach(() => store.close());

  it("store + load round-trips body bytes", async () => {
    await store.store("hello", SAMPLE_SKILL);
    const src = await store.load("hello");
    expect(src.name).toBe("hello");
    expect(src.source).toBe(SAMPLE_SKILL);
    expect(src.content_hash.length).toBeGreaterThan(0);
    expect(src.metadata.status).toBe("Draft");
    expect(src.metadata.description).toBe("Says hi");
  });

  it("load returns SkillNotFoundError on missing", async () => {
    await expect(store.load("nope")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("load with version returns historical bytes", async () => {
    const v1 = await store.store("hello", SAMPLE_SKILL);
    const modified = SAMPLE_SKILL.replace("Says hi", "Says hello");
    const v2 = await store.store("hello", modified);
    expect(v1.version).not.toBe(v2.version);
    const back = await store.load("hello", v1.version);
    expect(back.source).toBe(SAMPLE_SKILL);
  });

  it("load with unknown version throws VersionNotFoundError", async () => {
    await store.store("hello", SAMPLE_SKILL);
    await expect(store.load("hello", "ffffffffffff")).rejects.toBeInstanceOf(VersionNotFoundError);
  });

  it("load with version on missing skill throws SkillNotFoundError, not VersionNotFoundError", async () => {
    await expect(store.load("nope", "ffffffffffff")).rejects.toBeInstanceOf(SkillNotFoundError);
  });
});

describe("SqliteSkillStore — query", () => {
  let store: SqliteSkillStore;
  beforeEach(() => { store = new SqliteSkillStore({ dbPath: ":memory:" }); });
  afterEach(() => store.close());

  it("returns [] on empty store", async () => {
    const r = await store.query();
    expect(r).toEqual([]);
  });

  it("returns all skills sorted by name", async () => {
    await store.store("zebra", SAMPLE_SKILL);
    await store.store("alpha", SAMPLE_SKILL);
    await store.store("mango", SAMPLE_SKILL);
    const r = await store.query();
    expect(r.map((m) => m.name)).toEqual(["alpha", "mango", "zebra"]);
  });

  it("filters by single status", async () => {
    await store.store("draft-a", SAMPLE_SKILL);
    await store.store("approved-b", SAMPLE_SKILL);
    await store.update_status("approved-b", "Approved");
    const approved = await store.query({ status: "Approved" });
    expect(approved.length).toBe(1);
    expect(approved[0]!.name).toBe("approved-b");
  });

  it("filters by status array", async () => {
    await store.store("a", SAMPLE_SKILL);
    await store.store("b", SAMPLE_SKILL);
    await store.store("c", SAMPLE_SKILL);
    await store.update_status("b", "Approved");
    await store.update_status("c", "Disabled");
    const r = await store.query({ status: ["Approved", "Disabled"] });
    expect(r.map((m) => m.name).sort()).toEqual(["b", "c"]);
  });

  it("filters by tag using JSON-extract", async () => {
    await store.store("a", SAMPLE_SKILL, { metadata_bag: { tags: ["foo", "bar"] } });
    await store.store("b", SAMPLE_SKILL, { metadata_bag: { tags: ["baz"] } });
    await store.store("c", SAMPLE_SKILL, { metadata_bag: { tags: ["foo"] } });
    const r = await store.query({ tag: "foo" });
    expect(r.map((m) => m.name).sort()).toEqual(["a", "c"]);
  });

  it("filters by multiple tags (AND semantic)", async () => {
    await store.store("a", SAMPLE_SKILL, { metadata_bag: { tags: ["foo", "bar"] } });
    await store.store("b", SAMPLE_SKILL, { metadata_bag: { tags: ["foo"] } });
    const r = await store.query({ tag: ["foo", "bar"] });
    expect(r.map((m) => m.name)).toEqual(["a"]);
  });

  it("filters by author via metadata", async () => {
    await store.store("a", SAMPLE_SKILL, { author: "alice" });
    await store.store("b", SAMPLE_SKILL, { author: "bob" });
    const r = await store.query({ author: "alice" });
    expect(r.map((m) => m.name)).toEqual(["a"]);
  });

  it("applies limit + offset", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) await store.store(n, SAMPLE_SKILL);
    const r = await store.query({ limit: 2, offset: 1 });
    expect(r.map((m) => m.name)).toEqual(["b", "c"]);
  });

  it("filters by name_pattern (JS-regex fallback)", async () => {
    await store.store("alpha-x", SAMPLE_SKILL);
    await store.store("alpha-y", SAMPLE_SKILL);
    await store.store("beta", SAMPLE_SKILL);
    const r = await store.query({ name_pattern: "^alpha-" });
    expect(r.map((m) => m.name).sort()).toEqual(["alpha-x", "alpha-y"]);
  });
});

describe("SqliteSkillStore — metadata + versions", () => {
  let store: SqliteSkillStore;
  beforeEach(() => { store = new SqliteSkillStore({ dbPath: ":memory:" }); });
  afterEach(() => store.close());

  it("metadata returns shape without source", async () => {
    await store.store("hello", SAMPLE_SKILL);
    const m = await store.metadata("hello");
    expect(m.name).toBe("hello");
    expect(m.status).toBe("Draft");
    expect(m.description).toBe("Says hi");
    expect("source" in m).toBe(false);
  });

  it("metadata throws SkillNotFoundError on missing", async () => {
    await expect(store.metadata("nope")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("versions returns history in chronological order", async () => {
    await store.store("hello", SAMPLE_SKILL);
    await store.update_status("hello", "Approved");
    await store.update_status("hello", "Disabled");
    const vs = await store.versions("hello");
    expect(vs.length).toBe(3);
    expect(vs[0]!.status).toBe("Draft");
    expect(vs[1]!.status).toBe("Approved");
    expect(vs[1]!.previous_status).toBe("Draft");
    expect(vs[2]!.status).toBe("Disabled");
    expect(vs[2]!.previous_status).toBe("Approved");
  });

  it("versions throws SkillNotFoundError on missing skill", async () => {
    await expect(store.versions("nope")).rejects.toBeInstanceOf(SkillNotFoundError);
  });
});

describe("SqliteSkillStore — update_status", () => {
  let store: SqliteSkillStore;
  beforeEach(() => { store = new SqliteSkillStore({ dbPath: ":memory:" }); });
  afterEach(() => store.close());

  it("populates previous_status (audit trail)", async () => {
    await store.store("hello", SAMPLE_SKILL);
    const v = await store.update_status("hello", "Approved");
    expect(v.status).toBe("Approved");
    expect(v.previous_status).toBe("Draft");
  });

  it("Approved transition lands a bare header (unkeyed; v1 retired)", async () => {
    await store.store("hello", SAMPLE_SKILL);
    await store.update_status("hello", "Approved");
    const src = await store.load("hello");
    expect(src.source).toMatch(/^# Status: Approved\s*$/m);
  });

  it("strips approval token on transition away from Approved", async () => {
    await store.store("hello", SAMPLE_SKILL);
    await store.update_status("hello", "Approved");
    await store.update_status("hello", "Draft");
    const src = await store.load("hello");
    expect(src.source).toMatch(/^# Status: Draft$/m);
    expect(src.source).not.toMatch(/v\d+:/);
  });

  it("throws SkillNotFoundError on missing skill", async () => {
    await expect(store.update_status("nope", "Approved")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  // v0.13.7 — defense in depth against the silent-corruption bug Phase 2
  // dogfood surfaced. Direct API callers (bypassing the MCP handler) must
  // also be rejected when status is invalid.
  it("rejects undefined status (v0.13.7 defense in depth)", async () => {
    await store.store("guard", SAMPLE_SKILL);
    await expect(
      store.update_status("guard", undefined as unknown as "Draft"),
    ).rejects.toThrow(/Draft.*Approved.*Disabled|status must be one of/);
    // Body untouched — no `# Status: undefined` corruption.
    const src = await store.load("guard");
    expect(src.source).toContain("# Status: Draft");
    expect(src.source).not.toContain("# Status: undefined");
  });

  it("rejects invalid status string (v0.13.7 defense in depth)", async () => {
    await store.store("guard2", SAMPLE_SKILL);
    await expect(
      store.update_status("guard2", "Bogus" as unknown as "Draft"),
    ).rejects.toThrow(/Draft.*Approved.*Disabled|status must be one of/);
    const src = await store.load("guard2");
    expect(src.source).toContain("# Status: Draft");
    expect(src.source).not.toContain("# Status: Bogus");
  });
});

describe("SqliteSkillStore — delete (hard cascade)", () => {
  let store: SqliteSkillStore;
  beforeEach(() => { store = new SqliteSkillStore({ dbPath: ":memory:" }); });
  afterEach(() => store.close());

  it("removes both skills row and skill_versions rows", async () => {
    await store.store("hello", SAMPLE_SKILL);
    await store.update_status("hello", "Approved");
    await store.delete("hello");
    await expect(store.load("hello")).rejects.toBeInstanceOf(SkillNotFoundError);
    await expect(store.versions("hello")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it("allows skill name reuse after delete (no orphan history)", async () => {
    await store.store("hello", SAMPLE_SKILL);
    await store.update_status("hello", "Approved");
    await store.delete("hello");
    // Re-create with the same name; previous version history must be gone.
    await store.store("hello", SAMPLE_SKILL);
    const vs = await store.versions("hello");
    expect(vs.length).toBe(1);
    expect(vs[0]!.status).toBe("Draft");
  });

  it("throws SkillNotFoundError on missing", async () => {
    await expect(store.delete("nope")).rejects.toBeInstanceOf(SkillNotFoundError);
  });
});

describe("SqliteSkillStore — auto-stamp on store()", () => {
  let store: SqliteSkillStore;
  beforeEach(() => { store = new SqliteSkillStore({ dbPath: ":memory:" }); });
  afterEach(() => store.close());

  it("lands a bare Approved header when body declares # Status: Approved (unkeyed; v1 retired)", async () => {
    await store.store("hello", APPROVED_SKILL);
    const src = await store.load("hello");
    expect(src.source).toMatch(/^# Status: Approved\s*$/m);
    expect(src.metadata.status).toBe("Approved");
  });

  it("leaves Draft bodies untouched", async () => {
    await store.store("hello", SAMPLE_SKILL);
    const src = await store.load("hello");
    expect(src.source).toBe(SAMPLE_SKILL);
  });
});

describe("SqliteSkillStore — secured-mode parity (v1.0 Gate #7)", () => {
  let store: SqliteSkillStore;
  beforeEach(() => { store = new SqliteSkillStore({ dbPath: ":memory:" }); });
  afterEach(async () => { setSecuredMode(false); setApprovalPublicKey(null); store.close(); });

  it("forces an unsigned Approved write to Draft in secured mode (cannot self-approve)", async () => {
    setApprovalPublicKey(generateApprovalKeypair().publicKeyPem);
    setSecuredMode(true);
    const info = await store.store("hello", APPROVED_SKILL, { status: "Approved" });
    expect(info.status).toBe("Draft");
    const src = await store.load("hello");
    expect(src.metadata.status).toBe("Draft");
  });

  it("update_status → Approved on an unsigned body is refused in secured mode", async () => {
    await store.store("hello", SAMPLE_SKILL); // Draft
    setApprovalPublicKey(generateApprovalKeypair().publicKeyPem);
    setSecuredMode(true);
    await expect(store.update_status("hello", "Approved")).rejects.toThrow(/no valid signature|cannot promote/i);
  });

  it("honors a genuine v3-signed Approved write in secured mode", async () => {
    const { publicKeyPem, privateKeyPem } = generateApprovalKeypair();
    setApprovalPublicKey(publicKeyPem);
    setSecuredMode(true);
    const signed = stampApprovalEd25519(APPROVED_SKILL, privateKeyPem);
    const info = await store.store("hello", signed, { status: "Approved" });
    expect(info.status).toBe("Approved");
  });
});

describe("SqliteSkillStore — manifest + staticCapabilities", () => {
  it("manifest reports kind=sqlite", async () => {
    const store = new SqliteSkillStore({ dbPath: ":memory:" });
    try {
      const m = await store.manifest();
      expect(m.capabilities_version).toBe("1");
      expect(m.manifest.kind).toBe("sqlite");
      // v0.13.0 — capability flags moved out of manifest. Source of truth
      // is `staticCapabilities().features`; see next test.
    } finally {
      store.close();
    }
  });

  it("staticCapabilities declares atomic + audit-trail support", () => {
    const caps = SqliteSkillStore.staticCapabilities();
    expect(caps.connector_type).toBe("skill_store");
    expect(caps.implementation).toBe("SqliteSkillStore");
    expect(caps.features["supports_atomic_status_transitions"]).toBe(true);
    expect(caps.features["supports_audit_trail"]).toBe(true);
    expect(caps.features["supports_tag_filter"]).toBe(true);
  });
});

describe("SqliteSkillStore — contract conformance", () => {
  // Run the framework-agnostic SkillStore conformance suite.
  const stores: SqliteSkillStore[] = [];
  const tests = SkillStoreConformance.buildTests({
    build: () => {
      const s = new SqliteSkillStore({ dbPath: ":memory:" });
      stores.push(s);
      return s;
    },
    ctor: SqliteSkillStore,
    teardown: async (instance) => {
      (instance as SqliteSkillStore).close();
    },
  });
  for (const t of tests) {
    it(`[${t.category}] ${t.name}`, async () => { await t.run(); });
  }
  afterEach(() => {
    while (stores.length > 0) {
      try { stores.pop()?.close(); } catch { /* already closed */ }
    }
  });
});
