import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { McpServer } from "../src/mcp-server.js";
import type { JsonRpcRequest, McpRequestCtx } from "../src/mcp-server.js";
import { DashboardServer } from "../src/dashboard/server.js";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";

/**
 * v0.17.0 — MCP-caller identity propagation. Inbound mirror of v0.16.9's
 * outbound identity-propagation work, one layer up. The runtime accepts
 * host-attested caller identity via a configurable HTTP header, threads
 * it as `McpRequestCtx.callerIdentity` into `McpServer.handle()`, and
 * the `skill_write` handler stamps `SkillMeta.author` from it.
 *
 * Three-test discipline per `feedback_three_test_discipline_per_dispatch_shape`:
 *   - Runtime unit: McpServer.handle(req, ctx) threads callerIdentity to skillWrite → store({author})
 *   - E2E: HTTP request with header → DashboardServer reads → skill_write stamps author
 *   - E2E multi-agent: two callers with distinct headers → distinct stored authors
 *
 * Charter: Perry's `3f47b16e` (Gap 1 finding) + warm-adopter's `6ce97894`
 * (validated prototype against live AMP) + Perry's `2a9c234a` (4-point
 * spec ack with `McpDispatchCtx` symmetry direction).
 */

const SAMPLE_SKILL = `# Skill: identity-probe
# Status: Draft

t:
    emit(text="probe")
default: t
`;

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

describe("v0.17.0 — McpServer.handle threads callerIdentity into skill_write", () => {
  let home: string;
  let skillStore: FilesystemSkillStore;
  let mcpServer: McpServer;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0170-mcp-unit-"));
    skillStore = new FilesystemSkillStore(join(home, "skills"));
    const traceStore = new FilesystemTraceStore(join(home, "traces"));
    const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
    mcpServer = new McpServer({ skillStore, scheduler, traceStore });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function writeSkill(name: string, ctx: McpRequestCtx = {}): Promise<void> {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "skill_write", arguments: { name, source: SAMPLE_SKILL } },
    };
    const resp = await mcpServer.handle(req, ctx);
    if ("error" in resp) {
      throw new Error(`skill_write failed: ${JSON.stringify(resp.error)}`);
    }
  }

  it("ctx.callerIdentity stamps SkillMeta.author (overriding runtime default)", async () => {
    const name = uniqueName("probe");
    await writeSkill(name, { callerIdentity: "alice" });
    const meta = await skillStore.metadata(name);
    expect(meta.author).toBe("alice");
  });

  it("ctx without callerIdentity → store falls back to runtime default (existing v0.16.8 behavior preserved)", async () => {
    const name = uniqueName("probe");
    await writeSkill(name);  // ctx = {}, no callerIdentity
    const meta = await skillStore.metadata(name);
    expect(meta.author).toBe(userInfo().username);
  });

  it("two callers with distinct ctx → distinct stored authors", async () => {
    const aliceName = uniqueName("alice-skill");
    const bobName = uniqueName("bob-skill");
    await writeSkill(aliceName, { callerIdentity: "alice" });
    await writeSkill(bobName, { callerIdentity: "bob" });
    const aliceMeta = await skillStore.metadata(aliceName);
    const bobMeta = await skillStore.metadata(bobName);
    expect(aliceMeta.author).toBe("alice");
    expect(bobMeta.author).toBe("bob");
  });

  it("author is locked at first-write — subsequent overwrites preserve the original even when ctx.callerIdentity changes", async () => {
    // Sibling property to v0.16.8's first-write-locking. v0.17.0 inbound
    // identity threading does NOT bypass this — Bob can't grab a skill
    // by overwriting it. Per Perry's `9d9aef14` first-write-locks
    // discipline + warm-adopter's `9af842f7` Q on transfer.
    const name = uniqueName("locked");
    await writeSkill(name, { callerIdentity: "alice" });
    // Second write under bob — should preserve alice.
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "skill_write", arguments: { name, source: SAMPLE_SKILL + "\n# touched\n", overwrite: true } },
    };
    const resp = await mcpServer.handle(req, { callerIdentity: "bob" });
    if ("error" in resp) {
      // SkillStore throws StorageConflictError when explicit author disagrees.
      // That's the locked-at-first-write contract firing — expected behavior.
      expect(JSON.stringify(resp.error)).toMatch(/locked|conflict|first-write/i);
      const meta = await skillStore.metadata(name);
      expect(meta.author).toBe("alice");
      return;
    }
    // If the overwrite succeeded (substrate may interpret silently), author
    // must still be alice — the SkillStore contract enforces it.
    const meta = await skillStore.metadata(name);
    expect(meta.author).toBe("alice");
  });
});

interface E2eCtx {
  server: DashboardServer;
  skillStore: FilesystemSkillStore;
  baseUrl: string;
  cleanup: () => Promise<void>;
}

async function setupE2e(opts: { mcpCallerIdentityHeader?: string }): Promise<E2eCtx> {
  const home = mkdtempSync(join(tmpdir(), "v0170-e2e-"));
  const skillStore = new FilesystemSkillStore(join(home, "skills"));
  const traceStore = new FilesystemTraceStore(join(home, "traces"));
  const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
  const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
  const port = 30000 + Math.floor(Math.random() * 10000);
  const server = new DashboardServer({
    mcpServer,
    port,
    bindAddress: "127.0.0.1",
    mountSpa: false,
    ...(opts.mcpCallerIdentityHeader !== undefined ? { mcpCallerIdentityHeader: opts.mcpCallerIdentityHeader } : {}),
  });
  await server.start();
  return {
    server,
    skillStore,
    baseUrl: `http://127.0.0.1:${port}`,
    cleanup: async () => {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function postRpc(baseUrl: string, body: JsonRpcRequest, headers: Record<string, string> = {}): Promise<unknown> {
  const r = await fetch(`${baseUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return r.json();
}

describe("v0.17.0 — DashboardServer reads caller-identity header end-to-end", () => {
  it("multi-agent: distinct X-Agent-Id values → distinct stored authors (the load-bearing empirical case for (A) over (C))", async () => {
    const ctx = await setupE2e({ mcpCallerIdentityHeader: "X-Agent-Id" });
    try {
      const aliceName = uniqueName("alice-e2e");
      const bobName = uniqueName("bob-e2e");
      await postRpc(ctx.baseUrl, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "skill_write", arguments: { name: aliceName, source: SAMPLE_SKILL } },
      }, { "X-Agent-Id": "alice" });
      await postRpc(ctx.baseUrl, {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "skill_write", arguments: { name: bobName, source: SAMPLE_SKILL } },
      }, { "X-Agent-Id": "bob" });
      const aliceMeta = await ctx.skillStore.metadata(aliceName);
      const bobMeta = await ctx.skillStore.metadata(bobName);
      expect(aliceMeta.author).toBe("alice");
      expect(bobMeta.author).toBe("bob");
    } finally {
      await ctx.cleanup();
    }
  });

  it("header lookup is case-insensitive (Node lowercases inbound names)", async () => {
    const ctx = await setupE2e({ mcpCallerIdentityHeader: "X-Agent-Id" });
    try {
      const name1 = uniqueName("case1");
      const name2 = uniqueName("case2");
      // Send with all caps; configured name is mixed-case. Should still
      // resolve via Node's lowercased headers map.
      await postRpc(ctx.baseUrl, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "skill_write", arguments: { name: name1, source: SAMPLE_SKILL } },
      }, { "X-AGENT-ID": "perry" });
      await postRpc(ctx.baseUrl, {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "skill_write", arguments: { name: name2, source: SAMPLE_SKILL } },
      }, { "x-agent-id": "scott" });
      expect((await ctx.skillStore.metadata(name1)).author).toBe("perry");
      expect((await ctx.skillStore.metadata(name2)).author).toBe("scott");
    } finally {
      await ctx.cleanup();
    }
  });

  it("header configured but absent on this request → author falls back to runtime default (backwards-compat)", async () => {
    const ctx = await setupE2e({ mcpCallerIdentityHeader: "X-Agent-Id" });
    try {
      const name = uniqueName("absent-hdr");
      await postRpc(ctx.baseUrl, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "skill_write", arguments: { name, source: SAMPLE_SKILL } },
      }, {});  // no X-Agent-Id
      const meta = await ctx.skillStore.metadata(name);
      expect(meta.author).toBe(userInfo().username);
    } finally {
      await ctx.cleanup();
    }
  });

  it("header NOT configured → header is ignored, runtime default wins (simple-substrate adopter path — existing v0.16.8 behavior)", async () => {
    const ctx = await setupE2e({});  // mcpCallerIdentityHeader unset
    try {
      const name = uniqueName("no-config");
      // Even with a header on the request, runtime ignores it because the
      // adopter didn't opt in to the convention.
      await postRpc(ctx.baseUrl, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "skill_write", arguments: { name, source: SAMPLE_SKILL } },
      }, { "X-Agent-Id": "alice" });
      const meta = await ctx.skillStore.metadata(name);
      // Runtime default — NOT alice. Single-user / single-tenant adopters
      // get this behavior with zero configuration.
      expect(meta.author).toBe(userInfo().username);
    } finally {
      await ctx.cleanup();
    }
  });

  it("empty-string header value → treated as absent (falls back to runtime default)", async () => {
    const ctx = await setupE2e({ mcpCallerIdentityHeader: "X-Agent-Id" });
    try {
      const name = uniqueName("empty-hdr");
      await postRpc(ctx.baseUrl, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "skill_write", arguments: { name, source: SAMPLE_SKILL } },
      }, { "X-Agent-Id": "" });
      const meta = await ctx.skillStore.metadata(name);
      expect(meta.author).toBe(userInfo().username);
    } finally {
      await ctx.cleanup();
    }
  });
});
