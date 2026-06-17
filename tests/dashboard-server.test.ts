import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "../src/mcp-server.js";
import { DashboardServer } from "../src/dashboard/server.js";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";

interface Ctx {
  server: DashboardServer;
  mcpServer: McpServer;
  skillStore: FilesystemSkillStore;
  baseUrl: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const home = mkdtempSync(join(tmpdir(), "skillscript-dash-"));
  const skillStore = new FilesystemSkillStore(join(home, "skills"));
  const traceStore = new FilesystemTraceStore(join(home, "traces"));
  const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
  const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
  // Pick a random high port so concurrent test files don't collide.
  const port = 30000 + Math.floor(Math.random() * 10000);
  const server = new DashboardServer({ mcpServer, port, bindAddress: "127.0.0.1" });
  await server.start();
  return {
    server,
    mcpServer,
    skillStore,
    baseUrl: `http://127.0.0.1:${port}`,
    cleanup: async () => {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe("DashboardServer static handler", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await ctx.cleanup(); });

  it("GET / serves index.html with text/html content-type", async () => {
    const r = await fetch(`${ctx.baseUrl}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    const body = await r.text();
    expect(body).toMatch(/skillscript-runtime/);
  });

  it("GET /app.js serves SPA JS", async () => {
    const r = await fetch(`${ctx.baseUrl}/app.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/javascript/);
    const body = await r.text();
    expect(body).toMatch(/POLL_INTERVAL_MS/);
  });

  it("GET /styles.css serves CSS", async () => {
    const r = await fetch(`${ctx.baseUrl}/styles.css`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/css/);
  });

  it("GET /unknown.txt returns 404", async () => {
    const r = await fetch(`${ctx.baseUrl}/unknown.txt`);
    expect(r.status).toBe(404);
  });

  it("GET /../etc/passwd is 403 (path traversal protection)", async () => {
    const r = await fetch(`${ctx.baseUrl}/../etc/passwd`);
    // Either 403 (path traversal caught) or 404 (URL normalization)
    expect([403, 404]).toContain(r.status);
  });
});

describe("DashboardServer /rpc endpoint", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await ctx.cleanup(); });

  it("POST /rpc routes initialize to McpServer", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.id).toBe(1);
    expect(json.result.protocolVersion).toBe("2024-11-05");
    expect(json.result.serverInfo.name).toBe("skillscript-runtime");
  });

  it("POST /rpc routes tools/list", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const json = await r.json();
    expect(json.result.tools.length).toBe(17);
  });

  it("POST /rpc routes tools/call (skill_list, v0.9.8 SkillCatalog)", async () => {
    // alpha is agent-invokable (no # Output:, no triggers) — surfaces in skills
    // per v0.9.8.1 inference branch.
    await ctx.skillStore.store("alpha", "# Skill: alpha\n# Status: Approved\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "skill_list", arguments: {} },
      }),
    });
    const json = await r.json();
    const catalog = JSON.parse(json.result.content[0].text);
    expect(catalog.skills.length).toBe(1);
    expect(catalog.skills[0].name).toBe("alpha");
  });

  it("POST /rpc with malformed JSON returns -32700 parse error", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(r.status).toBe(400);
    const json = await r.json();
    expect(json.error.code).toBe(-32700);
  });

  it("GET /rpc returns 405 (only POST allowed)", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`);
    expect(r.status).toBe(405);
  });
});

describe("DashboardServer auth gate (v0.20.1)", () => {
  // A server with the dashboard token set. Mirrors setup() but adds authToken.
  async function securedSetup(): Promise<Ctx & { token: string }> {
    const home = mkdtempSync(join(tmpdir(), "skillscript-dashauth-"));
    const skillStore = new FilesystemSkillStore(join(home, "skills"));
    const traceStore = new FilesystemTraceStore(join(home, "traces"));
    const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
    const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
    const port = 30000 + Math.floor(Math.random() * 10000);
    const token = "tok-secret-abc123";
    const server = new DashboardServer({ mcpServer, port, bindAddress: "127.0.0.1", authToken: token });
    await server.start();
    return {
      server, mcpServer, skillStore, token,
      baseUrl: `http://127.0.0.1:${port}`,
      cleanup: async () => { await server.stop(); rmSync(home, { recursive: true, force: true }); },
    };
  }

  let ctx: Ctx & { token: string };
  beforeEach(async () => { ctx = await securedSetup(); });
  afterEach(async () => { await ctx.cleanup(); });

  it("GET / with no token → 401", async () => {
    const r = await fetch(`${ctx.baseUrl}/`, { redirect: "manual" });
    expect(r.status).toBe(401);
  });

  it("GET /?token=<wrong> → 401", async () => {
    const r = await fetch(`${ctx.baseUrl}/?token=nope`);
    expect(r.status).toBe(401);
  });

  it("GET /?token=<correct> → 200 + sets the session cookie", async () => {
    const r = await fetch(`${ctx.baseUrl}/?token=${ctx.token}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/skillscript_dash=/);
    expect(r.headers.get("set-cookie")).toMatch(/HttpOnly/);
  });

  it("the session cookie alone authorizes follow-up requests", async () => {
    const r = await fetch(`${ctx.baseUrl}/app.js`, { headers: { cookie: `skillscript_dash=${ctx.token}` } });
    expect(r.status).toBe(200);
  });

  it("POST /rpc with a Bearer token → 200 (programmatic callers)", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(200);
  });

  it("POST /rpc with no token → 401", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
  });
});
