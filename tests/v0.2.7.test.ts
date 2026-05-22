import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { DashboardServer } from "../src/dashboard/server.js";

/**
 * v0.2.7 — runtime ergonomics. Two items from Perry's kickoff (thread
 * `2d3d461c`), shipped bundled:
 *
 *   Item 4: skillfile serve / skillfile dashboard split. DashboardServer
 *     gains a `mountSpa` flag; cmdServe + cmdDashboard set it accordingly.
 *     runtime_capabilities now reports `runtimeMode: "serve" | "dashboard"`.
 *
 *   Item 5: persistent trigger registry. Imperative triggers (via MCP
 *     register_trigger) write through to $SKILLSCRIPT_HOME/triggers.json
 *     and hydrate at bootstrap. Declarative triggers (# Triggers: headers)
 *     stay live-derived from the SkillStore — unchanged behavior. Expired
 *     imperative triggers prune at boot.
 *
 * Acceptance criteria from Perry's kickoff: 9 bullets. Each maps to one
 * or more fixtures below.
 */

function rpc(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) };
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const resp = await server.handle(rpc("tools/call", { name, arguments: args }));
  if ("error" in resp) throw new Error((resp as { error: { message: string } }).error.message);
  const r = resp as { result: { content: Array<{ text: string }> } };
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

describe("v0.2.7 Item 5 — persistent trigger registry", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v027-trig-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("imperative register writes triggers.json synchronously", () => {
    const triggersPath = join(home, "triggers.json");
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      triggersFilePath: triggersPath,
    });
    expect(existsSync(triggersPath)).toBe(false);
    wired.scheduler.registerTrigger({
      skillName: "hello",
      source: "cron",
      name: "* * * * *",
      declarative: false,
    });
    expect(existsSync(triggersPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(triggersPath, "utf8"));
    expect(parsed.schema_version).toBe(1);
    expect(parsed.triggers).toHaveLength(1);
    expect(parsed.triggers[0].skill_name).toBe("hello");
    expect(parsed.triggers[0].source).toBe("cron");
    expect(parsed.triggers[0].declarative).toBe(false);
  });

  it("unregister removes the row from disk", () => {
    const triggersPath = join(home, "triggers.json");
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      triggersFilePath: triggersPath,
    });
    const reg = wired.scheduler.registerTrigger({
      skillName: "x",
      source: "cron",
      name: "0 9 * * *",
      declarative: false,
    });
    expect(JSON.parse(readFileSync(triggersPath, "utf8")).triggers).toHaveLength(1);
    const removed = wired.scheduler.unregisterTrigger(reg.id);
    expect(removed).toBe(true);
    expect(JSON.parse(readFileSync(triggersPath, "utf8")).triggers).toHaveLength(0);
  });

  it("declarative triggers do NOT write to disk (live-derived from SkillStore)", async () => {
    const triggersPath = join(home, "triggers.json");
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      triggersFilePath: triggersPath,
    });
    wired.scheduler.registerTrigger({
      skillName: "declarative-one",
      source: "cron",
      name: "0 9 * * *",
      declarative: true,
    });
    // File is never written for declarative-only registrations.
    expect(existsSync(triggersPath)).toBe(false);
  });

  it("hydrates imperative triggers from disk at bootstrap with original ids", () => {
    const triggersPath = join(home, "triggers.json");
    writeFileSync(triggersPath, JSON.stringify({
      schema_version: 1,
      triggers: [
        { id: "trig-42", skill_name: "alpha", source: "cron", name: "0 9 * * *", declarative: false, registered_at: 1779000000, expires_at: null },
        { id: "trig-43", skill_name: "beta", source: "session", name: "start", declarative: false, registered_at: 1779000001, expires_at: null },
      ],
    }));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      triggersFilePath: triggersPath,
    });
    const triggers = wired.scheduler.listTriggers().filter((t) => !t.declarative);
    expect(triggers.map((t) => t.id).sort()).toEqual(["trig-42", "trig-43"]);
    expect(triggers.find((t) => t.id === "trig-42")!.skillName).toBe("alpha");
    expect(triggers.find((t) => t.id === "trig-43")!.source).toBe("session");
  });

  it("expired imperative triggers prune at boot + file rewrites without them", () => {
    const triggersPath = join(home, "triggers.json");
    const longExpired = Math.floor(Date.now() / 1000) - 10000;
    const future = Math.floor(Date.now() / 1000) + 10000;
    writeFileSync(triggersPath, JSON.stringify({
      schema_version: 1,
      triggers: [
        { id: "trig-old", skill_name: "old", source: "cron", name: "0 0 1 1 *", declarative: false, registered_at: 1779000000, expires_at: longExpired },
        { id: "trig-new", skill_name: "new", source: "cron", name: "* * * * *", declarative: false, registered_at: 1779000001, expires_at: future },
      ],
    }));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      triggersFilePath: triggersPath,
    });
    const triggers = wired.scheduler.listTriggers().filter((t) => !t.declarative);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.id).toBe("trig-new");
    // File was rewritten without the pruned row.
    const onDisk = JSON.parse(readFileSync(triggersPath, "utf8"));
    expect(onDisk.triggers).toHaveLength(1);
    expect(onDisk.triggers[0].id).toBe("trig-new");
  });

  it("restart-survival: register + reboot → trigger still listed with same id", () => {
    const triggersPath = join(home, "triggers.json");
    // First boot — register imperatively.
    const first = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      triggersFilePath: triggersPath,
    });
    const reg = first.scheduler.registerTrigger({
      skillName: "survivor",
      source: "cron",
      name: "*/5 * * * *",
      declarative: false,
    });
    const originalId = reg.id;

    // Simulate process restart by calling bootstrap a second time against
    // the same persistence file — first scheduler is GC'd.
    const second = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      triggersFilePath: triggersPath,
    });
    const reloaded = second.scheduler.listTriggers().filter((t) => !t.declarative);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]!.id).toBe(originalId);
    expect(reloaded[0]!.skillName).toBe("survivor");
    expect(reloaded[0]!.declarative).toBe(false);
  });

  it("handles missing triggers.json cleanly (no error, no file created)", () => {
    const triggersPath = join(home, "nonexistent", "triggers.json");
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      triggersFilePath: triggersPath,
    });
    expect(wired.scheduler.listTriggers()).toEqual([]);
    expect(existsSync(triggersPath)).toBe(false);
  });
});

describe("v0.2.7 Item 4 — serve / dashboard mode reporting", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v027-mode-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("runtime_capabilities reports runtimeMode=\"dashboard\" by default", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const caps = await callTool(mcpServer, "runtime_capabilities");
    expect(caps["runtimeMode"]).toBe("dashboard");
  });

  it("runtime_capabilities reports runtimeMode=\"serve\" when bootstrap mode=serve", async () => {
    const { mcpServer } = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      mode: "serve",
    });
    const caps = await callTool(mcpServer, "runtime_capabilities");
    expect(caps["runtimeMode"]).toBe("serve");
  });

  it("runtime_capabilities reports triggersFilePath when configured (null otherwise)", async () => {
    const triggersPath = join(home, "triggers.json");
    const { mcpServer: served } = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      triggersFilePath: triggersPath,
    });
    const capsServed = await callTool(served, "runtime_capabilities");
    expect(capsServed["triggersFilePath"]).toBe(triggersPath);

    const { mcpServer: unset } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const capsUnset = await callTool(unset, "runtime_capabilities");
    expect(capsUnset["triggersFilePath"]).toBeNull();
  });

  it("DashboardServer with mountSpa=false serves /rpc but 404s GET /", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces"), mode: "serve" });
    const port = 30000 + Math.floor(Math.random() * 30000);
    const server = new DashboardServer({ mcpServer, port, bindAddress: "127.0.0.1", mountSpa: false });
    await server.start();
    try {
      // GET / → 404 in serve mode.
      const indexResp = await fetch(`http://127.0.0.1:${port}/`);
      expect(indexResp.status).toBe(404);
      const body = await indexResp.text();
      expect(body).toMatch(/SPA disabled/);

      // POST /rpc → still works.
      const rpcResp = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(rpcResp.status).toBe(200);
      const rpcBody = await rpcResp.json() as { result: { tools: Array<{ name: string }> } };
      expect(rpcBody.result.tools.length).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  });

  it("DashboardServer with mountSpa=true (default) serves both / (SPA) and /rpc", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const port = 30000 + Math.floor(Math.random() * 30000);
    const server = new DashboardServer({ mcpServer, port, bindAddress: "127.0.0.1" });
    await server.start();
    try {
      const indexResp = await fetch(`http://127.0.0.1:${port}/`);
      expect(indexResp.status).toBe(200);
      // POST /rpc → works.
      const rpcResp = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(rpcResp.status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});

describe("v0.2.7 — write-through respects schema_version", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v027-schema-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("ignores triggers.json with unsupported schema_version and proceeds with empty registry", () => {
    const triggersPath = join(home, "triggers.json");
    writeFileSync(triggersPath, JSON.stringify({ schema_version: 99, triggers: [{ id: "trig-1" }] }));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      triggersFilePath: triggersPath,
    });
    expect(wired.scheduler.listTriggers()).toEqual([]);
  });

  it("ignores triggers.json with malformed JSON without crashing", () => {
    const triggersPath = join(home, "triggers.json");
    writeFileSync(triggersPath, "this is not json {{{");
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      triggersFilePath: triggersPath,
    });
    expect(wired.scheduler.listTriggers()).toEqual([]);
  });
});
