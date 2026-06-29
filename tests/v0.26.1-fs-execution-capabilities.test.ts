/**
 * v0.26.1 — runtime_capabilities.fsExecution (adopter finding 35f669cb).
 *
 * The shell allowlist was discoverable via runtime_capabilities.shellExecution,
 * but the FS allowlist (which roots file_read/file_write may touch) was not —
 * an author had to guess or ask the operator. fsExecution mirrors shellExecution:
 * it reports the runtime-side allowed roots (or default-deny when unset).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/connectors/registry.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";

async function caps(server: McpServer, want?: string[]): Promise<Record<string, unknown>> {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "runtime_capabilities", arguments: want !== undefined ? { include: want } : {} },
  };
  const reply = await server.handle(req);
  const content = (reply.result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function makeServer(home: string, fsAllowlist?: string[]): McpServer {
  const skillStore = new FilesystemSkillStore(join(home, "skills"));
  const traceStore = new FilesystemTraceStore(join(home, "traces"));
  const registry = new Registry();
  registry.registerSkillStore("primary", skillStore);
  return new McpServer({
    registry,
    skillStore,
    traceStore,
    ...(fsAllowlist !== undefined ? { fsAllowlist } : {}),
  });
}

describe("v0.26.1 — runtime_capabilities.fsExecution", () => {
  it("reports the allowed roots when fsAllowlist is set", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0261-fs-"));
    try {
      const roots = ["/srv/skillscript/workspace", "/var/skillscript/events"];
      const server = makeServer(home, roots);
      const out = await caps(server, ["fsExecution"]);
      const fs = out["fsExecution"] as Record<string, unknown>;
      expect(fs["allowlist"]).toEqual(roots);
      expect(fs["description"]).toMatch(/SKILLSCRIPT_FS_ALLOWLIST/);
      expect(fs["description"]).toMatch(/RUNTIME's filesystem namespace/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports default-deny when fsAllowlist is unset", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0261-fs-"));
    try {
      const server = makeServer(home); // no fsAllowlist
      const out = await caps(server, ["fsExecution"]);
      const fs = out["fsExecution"] as Record<string, unknown>;
      expect(fs["allowlist"]).toMatch(/unset — default-deny/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is included in the default (unfiltered) response, alongside shellExecution", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0261-fs-"));
    try {
      const server = makeServer(home, ["/tmp/x"]);
      const out = await caps(server); // no include filter → all sections
      expect(out["fsExecution"]).toBeDefined();
      expect(out["shellExecution"]).toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
