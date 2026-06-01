import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDataStore } from "../src/connectors/data-store.js";

// v0.15.5 — `domain_tags` filter accepts both `string` (single, exact match)
// and `string[]` (any-of match). The typed contract documents both shapes in
// DataStoreTemplate/README.md ("array match (any-of)"); pre-v0.15.5 the
// bundled `SqliteDataStore` only honored the string shape and silently
// dropped arrays — a discipline-only-contract gap that bit the v0.15.4
// data-store-roundtrip demo when it switched from FTS-marker to tag-filter
// for substrate-portable determinism.

describe("v0.15.5 — SqliteDataStore.query honors domain_tags as string or string[]", () => {
  let home: string;
  let store: SqliteDataStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0155-tagfilter-"));
    store = new SqliteDataStore({ dbPath: join(home, "data.db") });
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function seed(): Promise<void> {
    await store.write({ content: "alpha record", tags: ["alpha", "shared"] });
    await store.write({ content: "beta record", tags: ["beta", "shared"] });
    await store.write({ content: "gamma record", tags: ["gamma"] });
  }

  it("string filter — exact single-tag match (existing behavior preserved)", async () => {
    await seed();
    const rows = await store.query({ query: "record", mode: "fts", limit: 10, domain_tags: "alpha" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toMatch(/alpha record/);
  });

  it("string[] filter — any-of match across multiple tags", async () => {
    await seed();
    const rows = await store.query({ query: "record", mode: "fts", limit: 10, domain_tags: ["alpha", "beta"] });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.summary).sort()).toEqual(["alpha record", "beta record"]);
  });

  it("string[] filter — single-element array (the data-store-roundtrip demo shape)", async () => {
    await seed();
    const rows = await store.query({ query: "record", mode: "fts", limit: 10, domain_tags: ["gamma"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toMatch(/gamma record/);
  });

  it("string[] filter — empty array is treated as no-filter (no rows excluded)", async () => {
    // Per the contract: empty array filter is the same as omitting the filter
    // (matches everything). Avoids the trap where a generated empty list
    // silently zeroes results.
    await seed();
    const rows = await store.query({ query: "record", mode: "fts", limit: 10, domain_tags: [] });
    expect(rows).toHaveLength(3);
  });

  it("string[] filter — non-matching tag returns zero rows", async () => {
    await seed();
    const rows = await store.query({ query: "record", mode: "fts", limit: 10, domain_tags: ["nonexistent"] });
    expect(rows).toHaveLength(0);
  });

  it("string[] filter — combined with FTS query narrows on both axes", async () => {
    await seed();
    // FTS query "alpha" matches only the alpha record (FTS5 doesn't substring-match);
    // tag filter ["alpha","beta"] would otherwise broaden to 2 records.
    // The combination is AND across both filters, so result is the alpha record only.
    const rows = await store.query({ query: "alpha", mode: "fts", limit: 10, domain_tags: ["alpha", "beta"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toMatch(/alpha record/);
  });
});

describe("v0.15.5 — DataWrite.expires_at accepts null as portable durable-forever opt-in", () => {
  let home: string;
  let store: SqliteDataStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0155-expires-"));
    store = new SqliteDataStore({ dbPath: join(home, "data.db") });
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("write({expires_at: null}) succeeds — bundled substrate treats as durable no-op", async () => {
    // The bundled SqliteDataStore is durable by default; `null` is a no-op
    // (the contract verb says "exempt from substrate-level sweep"; sqlite
    // has no sweep). Substrates with default TTL (AMP, hosted memory APIs)
    // map `null` to their pin / no-decay flag.
    const result = await store.write({ content: "durable record", expires_at: null, tags: ["test"] });
    expect(result.id).toBeTruthy();
    expect(typeof result.created_at).toBe("number");
    // Round-trip reads cleanly.
    const rows = await store.query({ query: "durable", mode: "fts", limit: 5 });
    expect(rows).toHaveLength(1);
  });

  it("write({expires_at: 1234567890}) preserves the finite-expiry shape", async () => {
    // Verify the existing number-form path still works alongside the new null form.
    const result = await store.write({ content: "ephemeral record", expires_at: 1234567890, tags: ["test"] });
    expect(result.id).toBeTruthy();
    const rows = await store.query({ query: "ephemeral", mode: "fts", limit: 5 });
    expect(rows).toHaveLength(1);
  });

  it("write({}) omitting expires_at defers to substrate default", async () => {
    // Sanity: the omit case still works (no change in behavior from prior versions).
    const result = await store.write({ content: "default record", tags: ["test"] });
    expect(result.id).toBeTruthy();
  });
});
