import { describe, it, expect } from "vitest";
import { Registry } from "../src/connectors/registry.js";
import { OllamaLocalModel } from "../src/connectors/local-model.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";

describe("Registry — class tracking for offline linter lookup", () => {
  it("getAllStaticCapabilities dedupes by class identity", () => {
    const registry = new Registry();
    // Two named instances of the same class — should appear once in the
    // class-level capability set (linter doesn't care which instance, only
    // which class is wired).
    registry.registerLocalModel("default", new OllamaLocalModel({ defaultModelTag: "gemma2:9b" }));
    registry.registerLocalModel("qwen", new OllamaLocalModel({ defaultModelTag: "qwen2.5:7b" }));

    const caps = registry.getAllStaticCapabilities();
    const localModelCaps = caps.filter((c) => c.connector_type === "local_model");
    expect(localModelCaps).toHaveLength(1);
    expect(localModelCaps[0]!.implementation).toBe("OllamaLocalModel");
  });

  it("getAllStaticCapabilities returns one entry per distinct class across kinds", () => {
    const registry = new Registry();
    registry.registerLocalModel("default", new OllamaLocalModel({ defaultModelTag: "gemma2:9b" }));
    registry.registerMcpConnector("primary", new CallbackMcpConnector(async () => null));

    const caps = registry.getAllStaticCapabilities();
    const kinds = new Set(caps.map((c) => c.connector_type));
    expect(kinds).toContain("local_model");
    expect(kinds).toContain("mcp_connector");
    expect(caps).toHaveLength(2);
  });

  it("list*Classes returns the constructor (linter can call staticCapabilities directly)", () => {
    const registry = new Registry();
    registry.registerLocalModel("default", new OllamaLocalModel({ defaultModelTag: "gemma2:9b" }));

    const classes = registry.listLocalModelClasses();
    expect(classes).toHaveLength(1);
    // Linter's offline path: call staticCapabilities without ever constructing.
    const caps = classes[0]!.staticCapabilities();
    expect(caps.implementation).toBe("OllamaLocalModel");
    expect(caps.features["supports_max_tokens"]).toBe(true);
  });

  it("getInstance throws clean error when not registered", () => {
    const registry = new Registry();
    expect(() => registry.getLocalModel("missing")).toThrow(/LocalModel 'missing' not registered/);
  });

  it("hasInstance returns false when not registered", () => {
    const registry = new Registry();
    expect(registry.hasLocalModel("missing")).toBe(false);
  });
});
