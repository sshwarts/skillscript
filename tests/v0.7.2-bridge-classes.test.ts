import { describe, it, expect } from "vitest";
import { LocalModelMcpConnector } from "../src/connectors/local-model-mcp.js";
import { DataStoreMcpConnector } from "../src/connectors/data-store-mcp.js";
import { KNOWN_CONNECTOR_CLASSES } from "../src/connectors/config.js";
import type { LocalModel, DataStore, PortableData } from "../src/connectors/types.js";

// v0.7.2 — bridge classes that expose LocalModel + DataStore as
// McpConnector instances. Canonical contract per architectural decision:
//   $ llm prompt="..." [maxTokens=N] [model="..."] -> R (R = string)
//   $ data_read mode=... query=... limit=N -> R (R = {items: [...]})

class FakeLocalModel implements LocalModel {
  public lastCall: { prompt: string; opts: { maxTokens?: number; model?: string } } | null = null;
  async run(prompt: string, opts: { maxTokens?: number; model?: string }): Promise<string> {
    this.lastCall = { prompt, opts };
    return `echo:${prompt}`;
  }
  async manifest(): Promise<{ capabilities_version: string; manifest: Record<string, unknown> }> {
    return { capabilities_version: "1", manifest: { kind: "fake-local-model" } };
  }
}

class FakeDataStore implements DataStore {
  public lastQuery: Record<string, unknown> | null = null;
  async query(filters: Record<string, unknown> & { query: string; limit: number; mode: string }): Promise<PortableData[]> {
    this.lastQuery = filters;
    return [
      { id: "m1", summary: "first", confidence: 0.9, agentId: "test", vault: "private" } as unknown as PortableData,
      { id: "m2", summary: "second", confidence: 0.8, agentId: "test", vault: "private" } as unknown as PortableData,
    ];
  }
  async manifest(): Promise<{ capabilities_version: string; manifest: Record<string, unknown> }> {
    // v0.14.1 — declare `supported_filters` so v0.14.1 strict-filters
    // enforcement at the bridge boundary passes `domain_tags` through.
    // Tests exercising other extras (e.g., `vault`) opt out per-call via
    // `permissive_filters: true`.
    return {
      capabilities_version: "1",
      manifest: { kind: "fake-data-store", supported_filters: ["domain_tags"] },
    };
  }
}

describe("v0.7.2 — LocalModelMcpConnector bridge", () => {
  it("dispatches `prompt` kwarg to wrapped LocalModel.run", async () => {
    const lm = new FakeLocalModel();
    const bridge = new LocalModelMcpConnector(lm);
    const result = await bridge.call("llm", { prompt: "hello world" });
    expect(result).toBe("echo:hello world");
    expect(lm.lastCall?.prompt).toBe("hello world");
  });

  it("forwards maxTokens + model kwargs to LocalModel.run opts", async () => {
    const lm = new FakeLocalModel();
    const bridge = new LocalModelMcpConnector(lm);
    await bridge.call("llm", { prompt: "x", maxTokens: 100, model: "qwen" });
    expect(lm.lastCall?.opts).toEqual({ maxTokens: 100, model: "qwen" });
  });

  it("accepts maxTokens as string and parses to int", async () => {
    const lm = new FakeLocalModel();
    const bridge = new LocalModelMcpConnector(lm);
    await bridge.call("llm", { prompt: "x", maxTokens: "200" });
    expect(lm.lastCall?.opts.maxTokens).toBe(200);
  });

  it("throws on missing prompt", async () => {
    const lm = new FakeLocalModel();
    const bridge = new LocalModelMcpConnector(lm);
    await expect(bridge.call("llm", {})).rejects.toThrow(/prompt/);
  });

  it("manifest() reports kind=local-model-bridge + wraps the underlying manifest", async () => {
    const lm = new FakeLocalModel();
    const bridge = new LocalModelMcpConnector(lm);
    const m = await bridge.manifest();
    expect(m.manifest).toMatchObject({ kind: "local-model-bridge" });
  });

  it("staticCapabilities reports implementation = LocalModelMcpConnector", () => {
    const caps = LocalModelMcpConnector.staticCapabilities();
    expect(caps.implementation).toBe("LocalModelMcpConnector");
    expect(caps.connector_type).toBe("mcp_connector");
  });
});

describe("v0.7.2 — DataStoreMcpConnector bridge", () => {
  it("dispatches mode/query/limit to wrapped DataStore.query", async () => {
    const ms = new FakeDataStore();
    const bridge = new DataStoreMcpConnector(ms);
    const result = await bridge.call("data_read", { mode: "fts", query: "incidents", limit: 5 });
    expect(ms.lastQuery).toMatchObject({ mode: "fts", query: "incidents", limit: 5 });
    expect(result).toHaveProperty("items");
    expect((result as { items: PortableData[] }).items).toHaveLength(2);
  });

  it("wraps return in {items: [...]} envelope (consistent with object-iteration-advisory)", async () => {
    const ms = new FakeDataStore();
    const bridge = new DataStoreMcpConnector(ms);
    const result = await bridge.call("data_read", { mode: "fts", query: "x", limit: 10 });
    expect(result).toEqual({
      items: expect.arrayContaining([expect.objectContaining({ id: "m1" }), expect.objectContaining({ id: "m2" })]),
    });
  });

  it("defaults mode to 'fts' if not provided", async () => {
    const ms = new FakeDataStore();
    const bridge = new DataStoreMcpConnector(ms);
    await bridge.call("data_read", { query: "x" });
    expect(ms.lastQuery?.mode).toBe("fts");
  });

  it("defaults limit to 10 if not provided", async () => {
    const ms = new FakeDataStore();
    const bridge = new DataStoreMcpConnector(ms);
    await bridge.call("data_read", { query: "x" });
    expect(ms.lastQuery?.limit).toBe(10);
  });

  it("passes declared-supported extras through to query filters (domain_tags)", async () => {
    const ms = new FakeDataStore();
    const bridge = new DataStoreMcpConnector(ms);
    await bridge.call("data_read", { query: "x", domain_tags: ["a", "b"] });
    expect(ms.lastQuery).toMatchObject({ query: "x", domain_tags: ["a", "b"] });
  });

  it("v0.14.1 — undeclared extras pass through under permissive_filters: true", async () => {
    const ms = new FakeDataStore();
    const bridge = new DataStoreMcpConnector(ms);
    await bridge.call("data_read", { query: "x", vault: "team", permissive_filters: true });
    expect(ms.lastQuery).toMatchObject({ query: "x", vault: "team", permissive_filters: true });
  });

  it("throws on missing query", async () => {
    const ms = new FakeDataStore();
    const bridge = new DataStoreMcpConnector(ms);
    await expect(bridge.call("data_read", { mode: "fts", limit: 5 })).rejects.toThrow(/query/);
  });

  it("staticCapabilities reports implementation = DataStoreMcpConnector", () => {
    const caps = DataStoreMcpConnector.staticCapabilities();
    expect(caps.implementation).toBe("DataStoreMcpConnector");
    expect(caps.connector_type).toBe("mcp_connector");
  });
});

describe("v0.7.2 — closed-set class registry includes bridges", () => {
  it("LocalModelMcpConnector is registered", () => {
    expect(KNOWN_CONNECTOR_CLASSES.has("LocalModelMcpConnector")).toBe(true);
  });

  it("DataStoreMcpConnector is registered", () => {
    expect(KNOWN_CONNECTOR_CLASSES.has("DataStoreMcpConnector")).toBe(true);
  });

  it("bridges have no fromConfig — wire via embedder code only", () => {
    const lm = KNOWN_CONNECTOR_CLASSES.get("LocalModelMcpConnector");
    const ms = KNOWN_CONNECTOR_CLASSES.get("DataStoreMcpConnector");
    expect(lm?.fromConfig).toBeUndefined();
    expect(ms?.fromConfig).toBeUndefined();
  });
});
