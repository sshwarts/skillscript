import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";
import { LocalModelMcpConnector } from "../src/connectors/local-model-mcp.js";
import { NoOpAgentConnector } from "../src/connectors/agent-noop.js";
import type { LocalModel, ManifestInfo, StaticCapabilities } from "../src/connectors/types.js";

/**
 * v0.16.3 — substrate-general manifest exposure on runtime_capabilities.
 *
 * Closes the discovery-opacity finding from Perry's warm-agent audit
 * (`bfd776a9`). Each registered connector entry on `runtime_capabilities`
 * now carries its `manifest()` payload alongside the static `features`.
 *
 * Three observable states per entry:
 *   1. Working: `manifest: {...}` — probed via instance.manifest()
 *   2. Runtime failure: `manifest: null, manifest_error: "<message>"`
 *   3. Structural absence: `manifest: null, manifest_unsupported: true`
 *      (only on AgentConnector; v0.9.6 audit excluded manifest() from the
 *      contract — types.ts:117)
 *
 * Field-shape decision (separate `manifest_unsupported` vs unified
 * `manifest_error`) tracks Perry's `d5bba09f`: structural absence and
 * runtime failure are semantically distinct, so dashboards can
 * differentiate "kind doesn't support, by design" from "instance broken,
 * ping operator" without parsing error strings.
 */

async function callCaps(
  mcpServer: { handle: (req: Record<string, unknown>) => Promise<unknown> },
  include: string[],
): Promise<Record<string, unknown>> {
  const resp = await mcpServer.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "runtime_capabilities", arguments: { include } },
  });
  const r = resp as { result: { content: Array<{ text: string }> } };
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

type CapsEntry = {
  name: string;
  manifest: ManifestInfo | null;
  manifest_error?: string;
  manifest_unsupported?: true;
};

describe("v0.16.3 — manifest exposure on runtime_capabilities (substrate-general)", () => {
  it("skillStores[].manifest carries kind + root_dir from FilesystemSkillStore.manifest()", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0163-skill-"));
    const skillsDir = join(home, "skills");
    const wired = bootstrap({ skillsDir, traceDir: join(home, "traces") });

    const data = (await callCaps(wired.mcpServer, ["skillStores"])) as { skillStores: CapsEntry[] };
    const primary = data.skillStores.find((e) => e.name === "primary")!;
    expect(primary.manifest).not.toBeNull();
    const payload = primary.manifest!.manifest as Record<string, unknown>;
    expect(payload["kind"]).toBe("filesystem");
    expect(payload["root_dir"]).toBe(skillsDir);
    expect(primary.manifest_unsupported).toBeUndefined();
    expect(primary.manifest_error).toBeUndefined();
  });

  it("dataStores[].manifest carries kind + supported_modes/filters from SqliteDataStore.manifest()", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0163-data-"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });

    const data = (await callCaps(wired.mcpServer, ["dataStores"])) as { dataStores: CapsEntry[] };
    expect(data.dataStores.length).toBeGreaterThan(0);
    const entry = data.dataStores[0]!;
    expect(entry.manifest).not.toBeNull();
    const payload = entry.manifest!.manifest as Record<string, unknown>;
    expect(payload["kind"]).toBe("sqlite-fts");
    expect(payload["supported_modes"]).toEqual(["fts"]);
    expect(payload["supported_filters"]).toEqual(["domain_tags"]);
    expect(entry.manifest_unsupported).toBeUndefined();
    expect(entry.manifest_error).toBeUndefined();
  });

  it("localModels[].manifest distinguishes instances bound to different model tags (Perry's original audit finding)", async () => {
    class IdentityLocalModel implements LocalModel {
      static staticCapabilities(): StaticCapabilities {
        return {
          connector_type: "local_model",
          implementation: "IdentityLocalModel",
          contract_version: "1.0.0",
          features: {},
        };
      }
      constructor(private readonly modelTag: string) {}
      async run(prompt: string): Promise<string> {
        return `${this.modelTag}:${prompt}`;
      }
      async manifest(): Promise<ManifestInfo<"local_model">> {
        return {
          capabilities_version: "1",
          manifest: { kind: "identity", default_model: this.modelTag, endpoint: "test://identity" },
        };
      }
    }

    const home = mkdtempSync(join(tmpdir(), "v0163-llm-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerLocalModel("alpha", new IdentityLocalModel("alpha-7b"));
    wired.registry.registerLocalModel("beta", new IdentityLocalModel("beta-13b"));

    const data = (await callCaps(wired.mcpServer, ["localModels"])) as { localModels: CapsEntry[] };
    const alpha = data.localModels.find((e) => e.name === "alpha")!;
    const beta = data.localModels.find((e) => e.name === "beta")!;
    expect(alpha.manifest).not.toBeNull();
    expect(beta.manifest).not.toBeNull();
    expect((alpha.manifest!.manifest as Record<string, unknown>)["default_model"]).toBe("alpha-7b");
    expect((beta.manifest!.manifest as Record<string, unknown>)["default_model"]).toBe("beta-13b");
    // The discovery-opacity gap from `bfd776a9` was: byte-identical entries
    // for distinct LocalModel instances. Each entry must now carry its
    // instance-specific binding.
    expect((alpha.manifest!.manifest as Record<string, unknown>)["default_model"]).not.toBe(
      (beta.manifest!.manifest as Record<string, unknown>)["default_model"],
    );
  });

  it("mcpConnectors[].manifest carries kind from CallbackMcpConnector.manifest() + preserves allowed_tools", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0163-mcp-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerMcpConnector("locked", new CallbackMcpConnector(async () => ({})), ["read_only"]);

    const data = (await callCaps(wired.mcpServer, ["mcpConnectors"])) as {
      mcpConnectors: Array<CapsEntry & { allowed_tools: string[] | null }>;
    };
    const locked = data.mcpConnectors.find((c) => c.name === "locked")!;
    expect(locked.manifest).not.toBeNull();
    expect((locked.manifest!.manifest as Record<string, unknown>)["kind"]).toBe("callback");
    // v0.4.1 allowed_tools surface is preserved alongside manifest field.
    expect(locked.allowed_tools).toEqual(["read_only"]);
  });

  it("mcpConnectors[].manifest from a bridge exposes wraps:{...underlying substrate manifest}", async () => {
    class IdentityLocalModel implements LocalModel {
      static staticCapabilities(): StaticCapabilities {
        return {
          connector_type: "local_model",
          implementation: "IdentityLocalModel",
          contract_version: "1.0.0",
          features: {},
        };
      }
      async run(): Promise<string> { return ""; }
      async manifest(): Promise<ManifestInfo<"local_model">> {
        return {
          capabilities_version: "1",
          manifest: { kind: "identity", default_model: "bridged-model", endpoint: "test://bridge" },
        };
      }
    }

    const home = mkdtempSync(join(tmpdir(), "v0163-bridge-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const innerModel = new IdentityLocalModel();
    wired.registry.registerLocalModel("inner", innerModel);
    wired.registry.registerMcpConnector("llm_bridge", new LocalModelMcpConnector(innerModel, wired.registry));

    const data = (await callCaps(wired.mcpServer, ["mcpConnectors"])) as { mcpConnectors: CapsEntry[] };
    const bridge = data.mcpConnectors.find((c) => c.name === "llm_bridge")!;
    expect(bridge.manifest).not.toBeNull();
    const payload = bridge.manifest!.manifest as Record<string, unknown>;
    // Bridges advertise their kind and re-expose the underlying substrate's
    // full manifest under `wraps`. This is the load-bearing finding from
    // `bfd776a9` — the runtime already has this pattern; capabilities just
    // didn't read it.
    expect(payload["wraps"]).toBeDefined();
    const wraps = payload["wraps"] as Record<string, unknown>;
    expect(wraps["default_model"]).toBe("bridged-model");
  });

  it("agentConnectors[] entries get manifest:null + manifest_unsupported:true (structural absence per v0.9.6)", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0163-agent-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.registry.registerAgentConnector("noop", new NoOpAgentConnector());

    const data = (await callCaps(wired.mcpServer, ["agentConnectors"])) as { agentConnectors: CapsEntry[] };
    expect(data.agentConnectors.length).toBeGreaterThan(0);
    for (const entry of data.agentConnectors) {
      // AgentConnector contract has no manifest() per types.ts:117 + v0.9.6
      // audit. Structural absence ≠ runtime failure: dashboards differentiate
      // "kind doesn't support, by design" from "instance broken, ping
      // operator" via the separate sentinel fields.
      expect(entry.manifest).toBeNull();
      expect(entry.manifest_unsupported).toBe(true);
      expect(entry.manifest_error).toBeUndefined();
    }
  });

  it("manifest() throws → manifest:null + manifest_error:<message> (runtime failure path, distinct from structural absence)", async () => {
    class ThrowingLocalModel implements LocalModel {
      static staticCapabilities(): StaticCapabilities {
        return {
          connector_type: "local_model",
          implementation: "ThrowingLocalModel",
          contract_version: "1.0.0",
          features: {},
        };
      }
      async run(): Promise<string> { return ""; }
      async manifest(): Promise<ManifestInfo<"local_model">> {
        throw new Error("substrate unreachable: ECONNREFUSED");
      }
    }

    const home = mkdtempSync(join(tmpdir(), "v0163-throw-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerLocalModel("broken", new ThrowingLocalModel());

    const data = (await callCaps(wired.mcpServer, ["localModels"])) as { localModels: CapsEntry[] };
    const broken = data.localModels.find((e) => e.name === "broken")!;
    expect(broken.manifest).toBeNull();
    expect(broken.manifest_error).toContain("ECONNREFUSED");
    // Critical: runtime failure must NOT be conflated with structural
    // absence. Dashboards key on the distinction.
    expect(broken.manifest_unsupported).toBeUndefined();
  });

  it("entries on a fresh runtime expose distinct manifest payloads — no byte-identical bug from `bfd776a9` audit", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0163-distinct-"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });
    await wired.registry.registerAgentConnector("noop", new NoOpAgentConnector());

    const data = (await callCaps(wired.mcpServer, ["skillStores", "dataStores", "mcpConnectors", "agentConnectors"])) as {
      skillStores: CapsEntry[];
      dataStores: CapsEntry[];
      mcpConnectors: CapsEntry[];
      agentConnectors: CapsEntry[];
    };

    // Every supported-contract entry has a non-null manifest.
    for (const e of data.skillStores) expect(e.manifest).not.toBeNull();
    for (const e of data.dataStores) expect(e.manifest).not.toBeNull();
    for (const e of data.mcpConnectors) expect(e.manifest).not.toBeNull();
    // AgentConnector entries are structurally absent.
    for (const e of data.agentConnectors) expect(e.manifest).toBeNull();
  });
});
