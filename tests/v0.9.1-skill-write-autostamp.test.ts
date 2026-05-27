/**
 * v0.9.1 — `skill_write` auto-stamp (P0.4).
 *
 * Closes the headless-adopter unblock: bodies declaring `# Status: Approved`
 * land in the SkillStore with a valid v1:<token> stamp automatically.
 * No dashboard round-trip needed. Per thread `dec3ca8a` R8 minion #6.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { Registry } from "../src/connectors/registry.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { extractStatusFromBody, evaluateApprovalGate } from "../src/approval.js";

function rpc(method: string, params: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method, params } as JsonRpcRequest;
}

async function callTool(srv: McpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await srv.handle(rpc("tools/call", { name, arguments: args }));
  if ("error" in resp) throw new Error((resp as { error: { message: string } }).error.message);
  const r = resp as { result: { content: Array<{ text: string }> } };
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

describe("v0.9.1 — skill_write auto-stamp", () => {
  let dir: string;
  let store: FilesystemSkillStore;
  let mcpServer: McpServer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v0.9.1-skill-write-"));
    store = new FilesystemSkillStore(join(dir, "skills"));
    const registry = new Registry();
    registry.registerSkillStore("primary", store);
    mcpServer = new McpServer({
      skillStore: store,
      registry,
      traceStore: new FilesystemTraceStore(join(dir, "traces")),
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("store() auto-stamps body declaring bare `# Status: Approved`", async () => {
    const body = `# Skill: auto-stamp-test
# Status: Approved

go:
    emit(text="ran via auto-stamp")

default: go
`;
    // Bypass the test setup hook by calling store directly — it has the
    // production code path's behavior on Approved bodies.
    await store.store("auto-stamp-test", body);
    const loaded = await store.load("auto-stamp-test");
    const extracted = extractStatusFromBody(loaded.source);
    expect(extracted?.status).toBe("Approved");
    expect(extracted?.approvalToken).toMatch(/^v1:[a-f0-9]{8}$/);
    expect(evaluateApprovalGate(loaded.source).ok).toBe(true);
  });

  it("store() does NOT stamp Draft bodies", async () => {
    const body = `# Skill: draft-skill
# Status: Draft

go:
    emit(text="hi")

default: go
`;
    await store.store("draft-skill", body);
    const loaded = await store.load("draft-skill");
    const extracted = extractStatusFromBody(loaded.source);
    expect(extracted?.status).toBe("Draft");
    expect(extracted?.approvalToken).toBeNull();
  });

  it("store() does NOT stamp Disabled bodies", async () => {
    const body = `# Skill: disabled-skill
# Status: Disabled

go:
    emit(text="hi")

default: go
`;
    await store.store("disabled-skill", body);
    const loaded = await store.load("disabled-skill");
    const extracted = extractStatusFromBody(loaded.source);
    expect(extracted?.status).toBe("Disabled");
    expect(extracted?.approvalToken).toBeNull();
  });

  it("MCP skill_write + execute_skill — headless flow works without dashboard round-trip", async () => {
    const body = `# Skill: headless-flow
# Status: Approved

go:
    emit(text="headless adopter can run this")

default: go
`;
    await callTool(mcpServer, "skill_write", { name: "headless-flow", source: body, overwrite: true });

    // No status round-trip; execute directly.
    const r = await callTool(mcpServer, "execute_skill", { skill_name: "headless-flow" });
    expect((r["errors"] as unknown[]).length).toBe(0);
    expect((r["transcript"] as string[]).join("\n")).toMatch(/headless adopter can run this/);

    // Confirm metadata.approval reports gate_ok
    const meta = await callTool(mcpServer, "skill_metadata", { name: "headless-flow" });
    expect((meta["approval"] as { gate_ok: boolean }).gate_ok).toBe(true);
  });

  it("store() re-stamps when body already carries a token (idempotent)", async () => {
    const body = `# Skill: pre-stamped
# Status: Approved v1:deadbeef

go:
    emit(text="re-stamp on store")

default: go
`;
    await store.store("pre-stamped", body);
    const loaded = await store.load("pre-stamped");
    const extracted = extractStatusFromBody(loaded.source);
    // Stamped fresh; the deadbeef token gets replaced with the actual CRC32
    expect(extracted?.approvalToken).toMatch(/^v1:[a-f0-9]{8}$/);
    expect(extracted?.approvalToken).not.toBe("v1:deadbeef");
    expect(evaluateApprovalGate(loaded.source).ok).toBe(true);
  });

  it("file on disk matches the stamped body (write-through)", async () => {
    const body = `# Skill: disk-check
# Status: Approved

go:
    emit(text="on disk")

default: go
`;
    await store.store("disk-check", body);
    const raw = readFileSync(join(dir, "skills", "disk-check.skill.md"), "utf8");
    expect(raw).toMatch(/^# Status: Approved v1:[a-f0-9]{8}$/m);
  });
});
