import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { SqliteDataStore } from "../src/connectors/data-store.js";
import { FilesystemTraceStore, TraceBuilder } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";

function withServer(): {
  server: McpServer;
  skillStore: FilesystemSkillStore;
  dataStore: SqliteDataStore;
  registry: Registry;
  scheduler: Scheduler;
  traceStore: FilesystemTraceStore;
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), "skillscript-mcp-"));
  const skillStore = new FilesystemSkillStore(join(home, "skills"));
  const dataStore = new SqliteDataStore({ dbPath: ":memory:" });
  const traceStore = new FilesystemTraceStore(join(home, "traces"));
  const registry = new Registry();
  registry.registerSkillStore("primary", skillStore);
  registry.registerDataStore("primary", dataStore);
  const scheduler = new Scheduler({
    registry,
    skillStore,
    traceStore,
  });
  // v0.13.8 — registry now wired into McpServer so data_read can resolve the
  // registered DataStore. runtime_capabilities also benefits (was returning
  // empty arrays per the optional-registry guard).
  const server = new McpServer({ skillStore, scheduler, traceStore, registry });
  return {
    server,
    skillStore,
    dataStore,
    registry,
    scheduler,
    traceStore,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
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

  it("tools/list returns 17 built-in tools (v0.18.9 added blocked_shell_attempts)", async () => {
    const { server, cleanup } = withServer();
    try {
      const resp = await server.handle(rpc("tools/list"));
      const r = (resp as { result: { tools: Array<{ name: string }> } }).result;
      const names = r.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "blocked_shell_attempts",
        "compile_skill",
        "data_read",
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
        "skill_read",
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

  it("skill_metadata returns metadata + version history (no source — see skill_read)", async () => {
    const { server, skillStore, cleanup } = withServer();
    try {
      await skillStore.store("hello", "# Skill: hello\n# Status: Draft\nt:\n    emit(text=\"hi\")\ndefault: t\n");
      const resp = await server.handle(rpc("tools/call", { name: "skill_metadata", arguments: { name: "hello" } }));
      const result = parseToolResult<Record<string, unknown>>(resp);
      const meta = result["metadata"] as { name: string; status: string };
      expect(meta.name).toBe("hello");
      expect(meta.status).toBe("Draft");
      expect((result["versions"] as unknown[]).length).toBeGreaterThanOrEqual(1);
      // v0.13.3 — source removed from skill_metadata; callers use skill_read instead.
      expect(result).not.toHaveProperty("source");
    } finally {
      cleanup();
    }
  });

  it("skill_read returns {name, version, status, source} (v0.13.3)", async () => {
    const { server, skillStore, cleanup } = withServer();
    try {
      const src = "# Skill: hello\n# Status: Draft\nt:\n    emit(text=\"hi\")\ndefault: t\n";
      await skillStore.store("hello", src);
      const resp = await server.handle(rpc("tools/call", { name: "skill_read", arguments: { name: "hello" } }));
      const result = parseToolResult<{ name: string; version: string; status: string; source: string }>(resp);
      expect(result.name).toBe("hello");
      expect(typeof result.version).toBe("string");
      expect(result.status).toBe("Draft");
      expect(result.source).toBe(src);
      // Shape discipline: only these four keys.
      expect(Object.keys(result).sort()).toEqual(["name", "source", "status", "version"]);
    } finally {
      cleanup();
    }
  });

  it("skill_read on missing skill propagates error (v0.13.3)", async () => {
    const { server, cleanup } = withServer();
    try {
      const resp = await server.handle(rpc("tools/call", { name: "skill_read", arguments: { name: "does-not-exist" } }));
      expect("error" in resp).toBe(true);
    } finally {
      cleanup();
    }
  });

  // v0.13.8 — data_read mirrors skill_read shape but on DataStore. Returns
  // null on miss (per DataStore's empty-set convention, vs SkillStore which
  // throws SkillNotFoundError). No data_write MCP by design: writes are
  // skill-context-only via `$ data_write` op (Perry thread 4b58c283 Q1C).
  it("data_read returns PortableData for known id (v0.13.8)", async () => {
    const { server, dataStore, cleanup } = withServer();
    try {
      const written = await dataStore.write({ content: "phase 3 probe", tags: ["probe"] });
      const resp = await server.handle(rpc("tools/call", { name: "data_read", arguments: { id: written.id } }));
      const result = parseToolResult<{ id: string; summary: string; detail?: string }>(resp);
      expect(result).not.toBeNull();
      expect(result.id).toBe(written.id);
      expect(result.summary).toBe("phase 3 probe");
    } finally {
      cleanup();
    }
  });

  it("data_read returns null for unknown id (v0.13.8)", async () => {
    const { server, cleanup } = withServer();
    try {
      const resp = await server.handle(rpc("tools/call", { name: "data_read", arguments: { id: "nonexistent-id-12345" } }));
      const result = parseToolResult<unknown>(resp);
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("data_read errors cleanly when no DataStore registered (v0.13.8)", async () => {
    // Build a server WITHOUT a registry to verify the guard fires correctly.
    const home = mkdtempSync(join(tmpdir(), "skillscript-mcp-no-mem-"));
    const skillStore = new FilesystemSkillStore(join(home, "skills"));
    const traceStore = new FilesystemTraceStore(join(home, "traces"));
    const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
    const server = new McpServer({ skillStore, scheduler, traceStore });  // no registry
    try {
      const resp = await server.handle(rpc("tools/call", { name: "data_read", arguments: { id: "anything" } }));
      expect("error" in resp).toBe(true);
      const errResp = resp as { error: { message: string } };
      expect(errResp.error.message).toMatch(/DataStore/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skill_status transitions Draft → Approved (write path)", async () => {
    const { server, skillStore, cleanup } = withServer();
    try {
      await skillStore.store("toggle", "# Skill: toggle\n# Status: Draft\nt:\n    emit(text=\"hi\")\ndefault: t\n");
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

  // v0.13.7 — Phase 2 dogfood found that omitting/misnaming `new_state`
  // silently corrupted the skill body with `# Status: undefined` because the
  // dispatcher doesn't enforce inputSchema and the handler cast a missing arg
  // as SkillStatus. Now: clean structured error, body untouched.
  it("skill_status with missing new_state returns clean error (v0.13.7)", async () => {
    const { server, skillStore, cleanup } = withServer();
    try {
      const original = "# Skill: guard\n# Status: Draft\nt:\n    emit(text=\"hi\")\ndefault: t\n";
      await skillStore.store("guard", original);
      const resp = await server.handle(rpc("tools/call", { name: "skill_status", arguments: { name: "guard" } }));
      expect("error" in resp).toBe(true);
      const errResp = resp as { error: { message: string } };
      expect(errResp.error.message).toMatch(/new_state/);
      // Body MUST NOT have been rewritten to `# Status: undefined`.
      const loaded = await skillStore.load("guard");
      expect(loaded.source).toContain("# Status: Draft");
      expect(loaded.source).not.toContain("# Status: undefined");
    } finally {
      cleanup();
    }
  });

  it("skill_status with invalid new_state value returns clean error (v0.13.7)", async () => {
    const { server, skillStore, cleanup } = withServer();
    try {
      const original = "# Skill: guard2\n# Status: Draft\nt:\n    emit(text=\"hi\")\ndefault: t\n";
      await skillStore.store("guard2", original);
      const resp = await server.handle(rpc("tools/call", { name: "skill_status", arguments: { name: "guard2", new_state: "Bogus" } }));
      expect("error" in resp).toBe(true);
      const errResp = resp as { error: { message: string } };
      expect(errResp.error.message).toMatch(/new_state/);
      expect(errResp.error.message).toMatch(/Draft|Approved|Disabled/);
      const loaded = await skillStore.load("guard2");
      expect(loaded.source).toContain("# Status: Draft");
      expect(loaded.source).not.toContain("# Status: Bogus");
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
