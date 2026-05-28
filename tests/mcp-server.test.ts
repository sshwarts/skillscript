import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore, TraceBuilder } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";

function withServer(): {
  server: McpServer;
  skillStore: FilesystemSkillStore;
  scheduler: Scheduler;
  traceStore: FilesystemTraceStore;
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), "skillscript-mcp-"));
  const skillStore = new FilesystemSkillStore(join(home, "skills"));
  const traceStore = new FilesystemTraceStore(join(home, "traces"));
  const scheduler = new Scheduler({
    registry: new Registry(),
    skillStore,
    traceStore,
  });
  const server = new McpServer({ skillStore, scheduler, traceStore });
  return { server, skillStore, scheduler, traceStore, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function rpc(method: string, params?: unknown, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
}

function parseToolResult<T = unknown>(resp: { result?: unknown }): T {
  // tools/call returns { content: [{ type: "text", text: "..." }] }
  const r = resp.result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0]!.text) as T;
}

describe("McpServer protocol", () => {
  it("initialize returns protocolVersion + capabilities + serverInfo", async () => {
    const { server, cleanup } = withServer();
    try {
      const resp = await server.handle(rpc("initialize"));
      expect("result" in resp).toBe(true);
      const r = (resp as { result: { protocolVersion: string; capabilities: object; serverInfo: { name: string } } }).result;
      expect(r.protocolVersion).toBe("2024-11-05");
      expect(r.capabilities).toEqual({ tools: {} });
      expect(r.serverInfo.name).toBe("skillscript-runtime");
    } finally {
      cleanup();
    }
  });

  it("tools/list returns 14 built-in tools (v0.9.0 added set_trigger_enabled)", async () => {
    const { server, cleanup } = withServer();
    try {
      const resp = await server.handle(rpc("tools/list"));
      const r = (resp as { result: { tools: Array<{ name: string }> } }).result;
      const names = r.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "compile_skill",
        "execute_skill",
        "health_metrics",
        "help",
        "lint_skill",
        "list_triggers",
        "register_trigger",
        "runtime_capabilities",
        "set_trigger_enabled",
        "skill_list",
        "skill_metadata",
        "skill_status",
        "skill_write",
        "unregister_trigger",
      ]);
    } finally {
      cleanup();
    }
  });

  it("unknown method returns -32601", async () => {
    const { server, cleanup } = withServer();
    try {
      const resp = await server.handle(rpc("foo/bar"));
      expect("error" in resp).toBe(true);
      expect((resp as { error: { code: number } }).error.code).toBe(-32601);
    } finally {
      cleanup();
    }
  });

  it("unknown tool returns -32601", async () => {
    const { server, cleanup } = withServer();
    try {
      const resp = await server.handle(rpc("tools/call", { name: "nonexistent", arguments: {} }));
      expect("error" in resp).toBe(true);
      expect((resp as { error: { code: number; message: string } }).error.message).toMatch(/not found/);
    } finally {
      cleanup();
    }
  });

  it("preserves request id in response", async () => {
    const { server, cleanup } = withServer();
    try {
      const resp = await server.handle({ jsonrpc: "2.0", id: "abc-123", method: "tools/list" });
      expect(resp.id).toBe("abc-123");
    } finally {
      cleanup();
    }
  });
});

describe("McpServer.skill_list / skill_metadata / skill_status", () => {
  it("skill_list returns empty SkillCatalog when store is empty (v0.9.8)", async () => {
    const { server, cleanup } = withServer();
    try {
      const resp = await server.handle(rpc("tools/call", { name: "skill_list", arguments: {} }));
      const catalog = parseToolResult<{ receives: unknown[]; skills: unknown[] }>(resp);
      expect(catalog.receives).toEqual([]);
      expect(catalog.skills).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("skill_list groups by audience-derived category (v0.9.8)", async () => {
    const { server, skillStore, cleanup } = withServer();
    try {
      // Augmenting (has agent output) → receives
      await skillStore.store("alpha-augment", "# Skill: alpha-augment\n# Status: Approved\n# Output: agent: oncall\nt:\n    emit(text=\"hi\")\ndefault: t\n");
      // Template (has template output) → skills
      await skillStore.store("beta-template", "# Skill: beta-template\n# Status: Approved\n# Output: template: assistant\nt:\n    emit(text=\"playbook\")\ndefault: t\n");
      const resp = await server.handle(rpc("tools/call", { name: "skill_list", arguments: {} }));
      const catalog = parseToolResult<{ receives: Array<{ name: string }>; skills: Array<{ name: string }> }>(resp);
      expect(catalog.receives.map((s) => s.name)).toEqual(["alpha-augment"]);
      expect(catalog.skills.map((s) => s.name)).toEqual(["beta-template"]);
    } finally {
      cleanup();
    }
  });

  it("skill_list with audience=all surfaces headless group (v0.9.8)", async () => {
    const { server, skillStore, cleanup } = withServer();
    try {
      // Headless (no agent/template output + autonomous trigger) — only visible in audience=all.
      // v0.9.8.1: trigger-presence disambiguates agent-invokable from autonomous.
      await skillStore.store("monitor",
        "# Skill: monitor\n# Status: Approved\n# Triggers: cron: */5 * * * *\nt:\n    emit(text=\"silent\")\ndefault: t\n",
      );
      const respAgent = await server.handle(rpc("tools/call", { name: "skill_list", arguments: { filter: { audience: "agent" } } }));
      const respAll = await server.handle(rpc("tools/call", { name: "skill_list", arguments: { filter: { audience: "all" } } }));
      const catalogAgent = parseToolResult<{ receives: unknown[]; skills: unknown[]; headless?: unknown[] }>(respAgent);
      const catalogAll = parseToolResult<{ receives: unknown[]; skills: unknown[]; headless: Array<{ name: string }> }>(respAll);
      expect(catalogAgent.headless).toBeUndefined();
      expect(catalogAll.headless.map((s) => s.name)).toEqual(["monitor"]);
    } finally {
      cleanup();
    }
  });

  it("skill_metadata returns metadata + version history", async () => {
    const { server, skillStore, cleanup } = withServer();
    try {
      await skillStore.store("hello", "# Skill: hello\n# Status: Draft\nt:\n    ! hi\ndefault: t\n");
      const resp = await server.handle(rpc("tools/call", { name: "skill_metadata", arguments: { name: "hello" } }));
      const result = parseToolResult<{ metadata: { name: string; status: string }; versions: unknown[] }>(resp);
      expect(result.metadata.name).toBe("hello");
      expect(result.metadata.status).toBe("Draft");
      expect(result.versions.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it("skill_status transitions Draft → Approved (write path)", async () => {
    const { server, skillStore, cleanup } = withServer();
    try {
      await skillStore.store("toggle", "# Skill: toggle\n# Status: Draft\nt:\n    ! hi\ndefault: t\n");
      const resp = await server.handle(rpc("tools/call", { name: "skill_status", arguments: { name: "toggle", new_state: "Approved" } }));
      const result = parseToolResult<{ status: string; previous_status: string }>(resp);
      expect(result.status).toBe("Approved");
      expect(result.previous_status).toBe("Draft");
      const meta = await skillStore.metadata("toggle");
      expect(meta.status).toBe("Approved");
    } finally {
      cleanup();
    }
  });
});

describe("McpServer.list_triggers / register_trigger / unregister_trigger", () => {
  it("register + list + unregister round-trip", async () => {
    const { server, cleanup } = withServer();
    try {
      const regResp = await server.handle(rpc("tools/call", {
        name: "register_trigger",
        arguments: { skill_name: "alpha", source: "cron", name: "0 9 * * *" },
      }));
      const reg = parseToolResult<{ id: string; skillName: string }>(regResp);
      expect(reg.id).toMatch(/^trig-/);
      expect(reg.skillName).toBe("alpha");

      const listResp = await server.handle(rpc("tools/call", { name: "list_triggers", arguments: {} }));
      const list = parseToolResult<Array<{ id: string }>>(listResp);
      expect(list.length).toBe(1);

      const unregResp = await server.handle(rpc("tools/call", {
        name: "unregister_trigger",
        arguments: { trigger_id: reg.id },
      }));
      const unreg = parseToolResult<{ removed: boolean }>(unregResp);
      expect(unreg.removed).toBe(true);

      const listAfter = parseToolResult<unknown[]>(await server.handle(rpc("tools/call", { name: "list_triggers", arguments: {} })));
      expect(listAfter).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("list_triggers filters by source", async () => {
    const { server, scheduler, cleanup } = withServer();
    try {
      scheduler.registerTrigger({ skillName: "a", source: "cron", name: "* * * * *", declarative: true });
      scheduler.registerTrigger({ skillName: "b", source: "session", name: "start", declarative: true });
      const resp = await server.handle(rpc("tools/call", { name: "list_triggers", arguments: { source: "cron" } }));
      const list = parseToolResult<unknown[]>(resp);
      expect(list.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("unregister_trigger returns removed=false for unknown id", async () => {
    const { server, cleanup } = withServer();
    try {
      const resp = await server.handle(rpc("tools/call", { name: "unregister_trigger", arguments: { trigger_id: "nope" } }));
      const result = parseToolResult<{ removed: boolean }>(resp);
      expect(result.removed).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("McpServer.health_metrics", () => {
  it("health_metrics returns aggregated data from trace records", async () => {
    const { server, traceStore, cleanup } = withServer();
    try {
      // Seed two traces via TraceBuilder + traceStore.write
      const base = 1_700_000_000_000;
      for (let i = 0; i < 2; i++) {
        const builder = new TraceBuilder("s", "v1", { source: "manual", name: "", fired_at_ms: base + i * 1000 }, {});
        await traceStore.write(builder.finalize([], {}, []));
      }
      const resp = await server.handle(rpc("tools/call", { name: "health_metrics", arguments: { since_ms: base - 1000 } }));
      const m = parseToolResult<{ totalFires: number; perSkill: Record<string, { fireCount: number }> }>(resp);
      expect(m.totalFires).toBe(2);
      expect(m.perSkill["s"]!.fireCount).toBe(2);
    } finally {
      cleanup();
    }
  });
});
