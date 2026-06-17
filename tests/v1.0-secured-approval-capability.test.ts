import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";
import {
  setSecuredMode,
  setApprovalPublicKey,
  generateApprovalKeypair,
} from "../src/approval.js";

/**
 * v1.0 Gate #7 — `runtime_capabilities` must surface secured-approval state so
 * the dashboard approval queue can choose its UX: in secured mode there is NO
 * in-page approve button (the runtime holds no private key — approval is the
 * out-of-band `skillfile approve` command); unsecured mode keeps the self-stamp
 * button. The SPA reads `securedApproval.{enabled,public_key_present}` to decide.
 */

const homes: string[] = [];
function withServer(): { server: McpServer; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "secapproval-"));
  homes.push(home);
  const skillStore = new FilesystemSkillStore(join(home, "skills"));
  const traceStore = new FilesystemTraceStore(join(home, "traces"));
  const registry = new Registry();
  registry.registerSkillStore("primary", skillStore);
  const scheduler = new Scheduler({ registry, skillStore, traceStore });
  const server = new McpServer({ skillStore, scheduler, traceStore, registry });
  return { server, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function rpc(name: string, args: Record<string, unknown> = {}): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

async function securedApproval(server: McpServer): Promise<{ enabled: boolean; public_key_present: boolean }> {
  const resp = (await server.handle(rpc("runtime_capabilities", { include: ["securedApproval"] }))) as {
    result?: { content?: Array<{ text?: string }> };
  };
  const text = resp.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text).securedApproval;
}

// Module-global secured state leaks across tests — reset after each.
afterEach(() => {
  setSecuredMode(false);
  setApprovalPublicKey(null);
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("runtime_capabilities — securedApproval surface", () => {
  it("reports disabled + no-key in the default (unsecured) runtime", async () => {
    const { server } = withServer();
    const sa = await securedApproval(server);
    expect(sa).toEqual({ enabled: false, public_key_present: false });
  });

  it("reports enabled + key-present when armed (secured + public key wired)", async () => {
    const { server } = withServer();
    const { publicKeyPem } = generateApprovalKeypair();
    setApprovalPublicKey(publicKeyPem);
    setSecuredMode(true);
    const sa = await securedApproval(server);
    expect(sa).toEqual({ enabled: true, public_key_present: true });
  });

  it("reports enabled + NO key when secured-but-unkeyed (misconfiguration the banner warns on)", async () => {
    const { server } = withServer();
    setSecuredMode(true); // armed but never wired a verifier
    const sa = await securedApproval(server);
    expect(sa).toEqual({ enabled: true, public_key_present: false });
  });
});
