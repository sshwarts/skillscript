/**
 * v0.9.0 — `execute_skill(source=...)` inline-source carve-out.
 *
 * Per thread 10746795: ad-hoc inline execution NEVER crosses the
 * SkillStore boundary, so the hash-token gate doesn't engage. The
 * caller wrote/saw the source they're handing in — invocation IS
 * the review. Same intuition as `bash -c "..."`.
 *
 * Child references via `& <name>` or `$ execute_skill skill_name=...`
 * still go through the gate — only the top-level inline body is ungated.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { Registry } from "../src/connectors/registry.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { FilesystemTraceStore } from "../src/trace.js";

function rpc(method: string, params: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method, params } as JsonRpcRequest;
}

async function callTool(srv: McpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await srv.handle(rpc("tools/call", { name, arguments: args }));
  if ("error" in resp) throw new Error((resp as { error: { message: string } }).error.message);
  const r = resp as { result: { content: Array<{ text: string }> } };
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

describe("v0.9.0 — execute_skill(source=...) inline carve-out", () => {
  let dir: string;
  let store: FilesystemSkillStore;
  let registry: Registry;
  let mcpServer: McpServer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v0.9-inline-"));
    store = new FilesystemSkillStore(join(dir, "skills"));
    registry = new Registry();
    registry.registerSkillStore("primary", store);
    mcpServer = new McpServer({
      skillStore: store,
      registry,
      traceStore: new FilesystemTraceStore(join(dir, "traces")),
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runs ad-hoc source without ANY Status header (no gate engaged)", async () => {
    const adhoc = `# Skill: ad-hoc
greet:
    emit(text="Hello, inline!")
default: greet
`;
    const r = await callTool(mcpServer, "execute_skill", { source: adhoc });
    expect((r["errors"] as unknown[]).length).toBe(0);
    expect((r["transcript"] as string[]).join("\n")).toMatch(/Hello, inline!/);
    expect(r["skill_name"]).toBe("ad-hoc");
  });

  it("runs source with Draft status (gate would refuse if stored)", async () => {
    const draft = `# Skill: draft-script
# Status: Draft
greet:
    emit(text="Drafts still run inline.")
default: greet
`;
    const r = await callTool(mcpServer, "execute_skill", { source: draft });
    expect((r["errors"] as unknown[]).length).toBe(0);
    expect((r["transcript"] as string[]).join("\n")).toMatch(/Drafts still run inline/);
  });

  it("runs source with no approval token (gate would refuse if stored)", async () => {
    const naked = `# Skill: naked-approved
# Status: Approved
m:
    emit(text="No token needed for inline execution.")
default: m
`;
    const r = await callTool(mcpServer, "execute_skill", { source: naked });
    expect((r["errors"] as unknown[]).length).toBe(0);
    expect((r["transcript"] as string[]).join("\n")).toMatch(/No token needed/);
  });

  it("rejects when both source and skill_name are provided", async () => {
    await expect(callTool(mcpServer, "execute_skill", {
      source: "# Skill: x\nm:\n    emit(text=\"hi\")\ndefault: m\n",
      skill_name: "also-here",
    })).rejects.toThrow(/exactly one/);
  });

  it("rejects when neither source nor skill_name is provided", async () => {
    await expect(callTool(mcpServer, "execute_skill", {}))
      .rejects.toThrow(/exactly one/);
  });

  it("inline body referencing a Draft child via $ execute_skill — child is gated", async () => {
    // Store a Draft child skill (will refuse to execute via the gate)
    await store.store("child", `# Skill: child
# Status: Draft
m:
    emit(text="child ran")
default: m
`);
    const parent = `# Skill: parent
m:
    $ execute_skill skill_name="child" -> R
    emit(text="parent ran")
default: m
`;
    const r = await callTool(mcpServer, "execute_skill", { source: parent });
    // Parent ran (inline ungated) but the child reference hit the gate.
    // The `$` op dispatcher wraps the ApprovalRejectedError; the structured
    // class label gets generic-wrapped to "Error" but the message preserves
    // the rejection reason verbatim.
    const errors = r["errors"] as Array<{ class: string; message: string }>;
    expect(errors.some((e) => /Approval rejected/.test(e.message))).toBe(true);
  });

  it("inline body referencing an Approved child — both run", async () => {
    // Setup hook auto-stamps Approved
    await store.store("child-ok", `# Skill: child-ok
# Status: Approved
m:
    emit(text="child ok")
default: m
`);
    const parent = `# Skill: parent
m:
    $ execute_skill skill_name="child-ok" -> R
    emit(text="parent ok")
default: m
`;
    const r = await callTool(mcpServer, "execute_skill", { source: parent });
    expect((r["errors"] as unknown[]).length).toBe(0);
    expect((r["transcript"] as string[]).join("\n")).toMatch(/parent ok/);
  });

  it("ad-hoc source isn't persisted to the SkillStore", async () => {
    const adhoc = `# Skill: never-persisted
m:
    emit(text="ephemeral")
default: m
`;
    await callTool(mcpServer, "execute_skill", { source: adhoc });
    const skills = await store.query();
    expect(skills.find((s) => s.name === "never-persisted")).toBeUndefined();
  });
});
