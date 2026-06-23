/**
 * v0.23.0 — connector schema discovery surfaces (phase 1).
 *
 * runtime_capabilities({ tool }) — selective on-demand fetch of one tool's full
 * inputSchema (kept out of the default compact menu). skill_preflight surfaces
 * the input schema for ONLY the connector tools a skill calls (selective).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";
import { Scheduler } from "../src/scheduler.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import type { McpConnector, McpToolDescriptor, ManifestInfo } from "../src/connectors/types.js";

const SEARCH: McpToolDescriptor = {
  name: "search",
  description: "Web search.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
  },
};

const ADMIN: McpToolDescriptor = {
  name: "admin_delete",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
};

class FakeMcpConnector implements McpConnector {
  static staticCapabilities() {
    return { connector_type: "mcp_connector" as const, implementation: "FakeMcpConnector", contract_version: "1.0.0", features: {} };
  }
  async call(): Promise<unknown> { return null; }
  async manifest(): Promise<ManifestInfo> {
    return { capabilities_version: "1", manifest: { kind: "fake" } } as ManifestInfo;
  }
  // Downstream server exposes BOTH tools; the operator may gate one off via allowed_tools.
  async describeTools(): Promise<McpToolDescriptor[]> { return [SEARCH, ADMIN]; }
}

function rpc(method: string, params: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method, params } as JsonRpcRequest;
}
async function callTool(srv: McpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await srv.handle(rpc("tools/call", { name, arguments: args }));
  if ("error" in resp) throw new Error((resp as { error: { message: string } }).error.message);
  const r = resp as { result: { content: Array<{ text: string }> } };
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

describe("v0.23.0 — connector schema discovery surfaces", () => {
  let dir: string;
  let registry: Registry;
  let skillStore: FilesystemSkillStore;
  let srv: McpServer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v0.23.0-disc-"));
    skillStore = new FilesystemSkillStore(join(dir, "skills"));
    const traceStore = new FilesystemTraceStore(join(dir, "traces"));
    registry = new Registry();
    registry.registerSkillStore("primary", skillStore);
    registry.registerMcpConnector("ddg", new FakeMcpConnector());
    const scheduler = new Scheduler({ registry, skillStore, traceStore });
    srv = new McpServer({ skillStore, scheduler, traceStore, registry });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runtime_capabilities({tool}) returns one tool's full input schema on demand", async () => {
    const out = await callTool(srv, "runtime_capabilities", { tool: "ddg.search" });
    const ts = out["toolSchema"] as Record<string, unknown> | null;
    expect(ts).not.toBeNull();
    expect(ts!["connector"]).toBe("ddg");
    expect(ts!["name"]).toBe("search");
    expect(ts!["input_schema"]).toMatchObject({ properties: { query: {}, limit: {} } });
  });

  it("runtime_capabilities({tool}) resolves a bare tool name across connectors", async () => {
    const out = await callTool(srv, "runtime_capabilities", { tool: "search" });
    expect((out["toolSchema"] as Record<string, unknown>)["connector"]).toBe("ddg");
  });

  it("runtime_capabilities({tool}) returns null for an unknown tool", async () => {
    const out = await callTool(srv, "runtime_capabilities", { tool: "ddg.nope" });
    expect(out["toolSchema"]).toBeNull();
  });

  it("the default runtime_capabilities response stays the compact menu (no toolSchema)", async () => {
    const out = await callTool(srv, "runtime_capabilities", {});
    expect(out["toolSchema"]).toBeUndefined();
  });

  it("skill_preflight surfaces input schema for the connector tools the skill calls", async () => {
    await skillStore.store(
      "searcher",
      `# Skill: searcher\n# Status: Approved\n# Vars: TOPIC\n\nrun:\n    $ ddg.search query="\${TOPIC}" -> R\n    emit(text="\${R}")\ndefault: run\n`,
      { status: "Approved" },
    );
    const out = await callTool(srv, "skill_preflight", { name: "searcher" });
    const tools = out["connector_tools"] as Array<Record<string, unknown>> | null;
    expect(tools).not.toBeNull();
    expect(tools!.length).toBe(1);
    expect(tools![0]!["connector"]).toBe("ddg");
    expect(tools![0]!["name"]).toBe("search");
    expect(tools![0]!["input_schema"]).toMatchObject({ required: ["query"] });
  });

  it("skill_preflight connector_tools is null when the skill calls no connector tools", async () => {
    await skillStore.store(
      "plain",
      `# Skill: plain\n# Status: Approved\n# Vars: WHO\n\nrun:\n    emit(text="hi \${WHO}")\ndefault: run\n`,
      { status: "Approved" },
    );
    const out = await callTool(srv, "skill_preflight", { name: "plain" });
    expect(out["connector_tools"]).toBeNull();
  });

  it("respects the per-connector allowed_tools gate — gated tools aren't surfaced", async () => {
    // A second connector exposing both tools, but the operator gates to search only.
    registry.registerMcpConnector("gated", new FakeMcpConnector(), ["search"]);
    const allowed = await callTool(srv, "runtime_capabilities", { tool: "gated.search" });
    expect((allowed["toolSchema"] as Record<string, unknown>)["name"]).toBe("search");
    const gatedOff = await callTool(srv, "runtime_capabilities", { tool: "gated.admin_delete" });
    expect(gatedOff["toolSchema"]).toBeNull(); // schema NOT surfaced for a gated-off tool
  });
});
