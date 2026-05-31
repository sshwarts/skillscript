import { describe, it, expect } from "vitest";
import { DataStoreMcpConnector } from "../src/connectors/data-store-mcp.js";
import type { DataStore, PortableData, DataWrite, DataWriteRecord } from "../src/connectors/types.js";

// v0.14.1 — Substrate-side strict-filters enforcement at the
// DataStoreMcpConnector boundary. Closes the silent-scope-leak class
// from Phase 1 v4 cold-adopter dogfood: filter keys outside the
// substrate's declared `supported_filters` manifest now throw
// `UnsupportedFilterError`. Adopters opt out per-call via
// `permissive_filters: true`.
//
// Pattern: defaults-over-knobs for security-relevant surfaces (sibling
// to the F1 mutation-gate runtime enforcement). Aware adopters opt out;
// naive adopters get protection.

class StrictDataStore implements DataStore {
  public lastQuery: Record<string, unknown> | null = null;
  constructor(private readonly supportedFilters: string[]) {}
  async query(filters: Record<string, unknown> & { query: string; limit: number; mode: string }): Promise<PortableData[]> {
    this.lastQuery = filters;
    return [];
  }
  async write(_entry: DataWrite): Promise<DataWriteRecord> {
    return { id: "x", created_at: 0 };
  }
  async manifest(): Promise<{ capabilities_version: string; manifest: Record<string, unknown> }> {
    return {
      capabilities_version: "1",
      manifest: { kind: "strict-fake", supported_filters: this.supportedFilters },
    };
  }
}

describe("v0.14.1 — strict-filters substrate-side enforcement", () => {
  it("unknown filter key throws UnsupportedFilterError + does NOT reach the substrate", async () => {
    const store = new StrictDataStore(["domain_tags"]);
    const bridge = new DataStoreMcpConnector(store);
    await expect(
      bridge.call("data_read", { query: "x", vault: "team" }),
    ).rejects.toThrow(/UnsupportedFilterError|unsupported filter key/i);
    // Substrate never received the query — silent-scope-leak avoided.
    expect(store.lastQuery).toBeNull();
  });

  it("error names the unsupported key(s) + the supported set", async () => {
    const store = new StrictDataStore(["domain_tags", "payload_type"]);
    const bridge = new DataStoreMcpConnector(store);
    try {
      await bridge.call("data_read", { query: "x", vault: "team", confidence_min: 0.5 });
      throw new Error("expected throw");
    } catch (err) {
      const e = err as Error;
      expect(e.name).toBe("UnsupportedFilterError");
      expect(e.message).toContain("'vault'");
      expect(e.message).toContain("'confidence_min'");
      expect(e.message).toContain("'domain_tags'");
      expect(e.message).toContain("'payload_type'");
    }
  });

  it("`permissive_filters: true` bypasses enforcement; unknowns flow through", async () => {
    const store = new StrictDataStore(["domain_tags"]);
    const bridge = new DataStoreMcpConnector(store);
    await bridge.call("data_read", {
      query: "x",
      vault: "team",
      confidence_min: 0.5,
      permissive_filters: true,
    });
    expect(store.lastQuery).toMatchObject({
      query: "x",
      vault: "team",
      confidence_min: 0.5,
    });
  });

  it("base shape keys (mode/query/limit) are never flagged even with empty supported_filters", async () => {
    const store = new StrictDataStore([]);
    const bridge = new DataStoreMcpConnector(store);
    await bridge.call("data_read", { query: "x", mode: "fts", limit: 5 });
    expect(store.lastQuery).toMatchObject({ query: "x", mode: "fts", limit: 5 });
  });

  it("declared-supported key passes through (matches the contract)", async () => {
    const store = new StrictDataStore(["domain_tags"]);
    const bridge = new DataStoreMcpConnector(store);
    await bridge.call("data_read", { query: "x", domain_tags: ["a", "b"] });
    expect(store.lastQuery).toMatchObject({ query: "x", domain_tags: ["a", "b"] });
  });

  it("substrate with no supported_filters manifest rejects EVERY non-base key (fail-closed default)", async () => {
    const store = new StrictDataStore([]);
    const bridge = new DataStoreMcpConnector(store);
    await expect(
      bridge.call("data_read", { query: "x", domain_tags: ["a"] }),
    ).rejects.toThrow(/UnsupportedFilterError|unsupported filter key/i);
    expect(store.lastQuery).toBeNull();
  });

  it("supported_filters cache: manifest fetched once across multiple queries", async () => {
    const store = new StrictDataStore(["domain_tags"]);
    let manifestCalls = 0;
    const origManifest = store.manifest.bind(store);
    store.manifest = async () => {
      manifestCalls += 1;
      return origManifest();
    };
    const bridge = new DataStoreMcpConnector(store);
    await bridge.call("data_read", { query: "a", domain_tags: ["x"] });
    await bridge.call("data_read", { query: "b", domain_tags: ["y"] });
    await bridge.call("data_read", { query: "c", domain_tags: ["z"] });
    expect(manifestCalls).toBe(1);
  });
});
