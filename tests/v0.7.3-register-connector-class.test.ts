import { describe, it, expect, afterEach } from "vitest";
import {
  loadConnectorsConfig,
  registerConnectorClass,
  unregisterConnectorClass,
  getConnectorClass,
  listKnownConnectorClasses,
} from "../src/connectors/config.js";
import type { McpConnector, ManifestInfo, StaticCapabilities, McpDispatchCtx } from "../src/connectors/types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// v0.7.3 — `registerConnectorClass` public API. Closes the merge-conflict
// bait of adopters editing `KNOWN_CONNECTOR_CLASSES` directly. Adopter
// bootstrap registers their custom classes via this API; loader reads
// the union of bundled + adopter-registered maps.

class FakeAdopterConnector implements McpConnector {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "mcp_connector",
      implementation: "FakeAdopterConnector",
      contract_version: "1.0.0",
      features: {},
    };
  }
  constructor(public readonly config: Record<string, unknown>) {}
  async call(_toolName: string, _args: Record<string, unknown>, _ctx?: McpDispatchCtx): Promise<unknown> {
    return { called: true, config: this.config };
  }
  async manifest(): Promise<ManifestInfo> {
    return { capabilities_version: "1", manifest: { kind: "fake-adopter" } };
  }
}

describe("v0.7.3 — registerConnectorClass public API", () => {
  afterEach(() => {
    // Clean up adopter registrations between tests so they don't leak.
    unregisterConnectorClass("FakeAdopterConnector");
    unregisterConnectorClass("OverrideMe");
  });

  it("registered classes are reachable via getConnectorClass + listKnownConnectorClasses", () => {
    expect(getConnectorClass("FakeAdopterConnector")).toBeUndefined();
    registerConnectorClass("FakeAdopterConnector", {
      ctor: FakeAdopterConnector as never,
      fromConfig: (cfg) => new FakeAdopterConnector(cfg),
    });
    expect(getConnectorClass("FakeAdopterConnector")).toBeDefined();
    expect(listKnownConnectorClasses()).toContain("FakeAdopterConnector");
  });

  it("loadConnectorsConfig wires adopter-registered classes from JSON", () => {
    registerConnectorClass("FakeAdopterConnector", {
      ctor: FakeAdopterConnector as never,
      fromConfig: (cfg) => new FakeAdopterConnector(cfg),
    });

    const home = mkdtempSync(join(tmpdir(), "v073-reg-"));
    try {
      const configPath = join(home, "connectors.json");
      writeFileSync(configPath, JSON.stringify({
        my_adopter: {
          class: "FakeAdopterConnector",
          config: { foo: "bar", count: 42 },
        },
      }));

      const { connectors, errors } = loadConnectorsConfig({ path: configPath });
      expect(errors).toEqual([]);
      expect(connectors).toHaveLength(1);
      expect(connectors[0]!.name).toBe("my_adopter");
      expect(connectors[0]!.className).toBe("FakeAdopterConnector");
      expect(connectors[0]!.instance).toBeInstanceOf(FakeAdopterConnector);
      expect((connectors[0]!.instance as FakeAdopterConnector).config).toEqual({ foo: "bar", count: 42 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("adopter overrides bundled set on name collision", () => {
    // `RemoteMcpConnector` is in the bundled closed set with its own fromConfig.
    // Adopter can override by registering under the same name — useful for a
    // hardened variant or for swapping out a bundled class entirely.
    class HardenedRemoteMcp implements McpConnector {
      static staticCapabilities(): StaticCapabilities {
        return {
          connector_type: "mcp_connector",
          implementation: "HardenedRemoteMcp",
          contract_version: "1.0.0",
          features: {},
        };
      }
      async call(): Promise<unknown> { return null; }
      async manifest(): Promise<ManifestInfo> {
        return { capabilities_version: "1", manifest: { kind: "hardened-remote" } };
      }
    }
    registerConnectorClass("OverrideMe", {
      ctor: HardenedRemoteMcp as never,
      fromConfig: () => new HardenedRemoteMcp(),
    });
    expect(getConnectorClass("OverrideMe")?.ctor).toBe(HardenedRemoteMcp);
    unregisterConnectorClass("OverrideMe");
    expect(getConnectorClass("OverrideMe")).toBeUndefined();
  });

  it("unknown class error message points adopters at registerConnectorClass", () => {
    const home = mkdtempSync(join(tmpdir(), "v073-reg-"));
    try {
      const configPath = join(home, "connectors.json");
      writeFileSync(configPath, JSON.stringify({
        my_thing: {
          class: "NotRegisteredAnywhere",
          config: {},
        },
      }));
      const { errors } = loadConnectorsConfig({ path: configPath });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/unknown connector class 'NotRegisteredAnywhere'/);
      expect(errors[0]).toMatch(/registerConnectorClass/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects empty name with a clear error", () => {
    expect(() => registerConnectorClass("", { ctor: FakeAdopterConnector as never })).toThrow(/name must be non-empty/);
  });

  it("re-registration is idempotent (bootstrap re-run safe)", () => {
    registerConnectorClass("FakeAdopterConnector", {
      ctor: FakeAdopterConnector as never,
      fromConfig: (cfg) => new FakeAdopterConnector(cfg),
    });
    // Same name, same entry shape — should not throw.
    expect(() => registerConnectorClass("FakeAdopterConnector", {
      ctor: FakeAdopterConnector as never,
      fromConfig: (cfg) => new FakeAdopterConnector(cfg),
    })).not.toThrow();
    expect(getConnectorClass("FakeAdopterConnector")).toBeDefined();
  });
});
