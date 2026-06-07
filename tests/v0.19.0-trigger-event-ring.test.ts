import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";
import { DashboardServer } from "../src/dashboard/server.js";
import { EventNotFoundError, EventParamMismatchError } from "../src/errors.js";

/**
 * v0.19.0 — Simplified trigger model + event HTTP ingress (memory `ceaf4579`).
 *
 * Tests cover:
 *   1. Scheduler.fireEvent — happy path, 404 unknown, 400 missing, 400 extra
 *   2. Event registration upsert + cross-skill rebind audit log
 *   3. DashboardServer POST /event — full HTTP shape with auth
 *   4. run_id = trace_id (preMintedTraceId plumbed end-to-end)
 *   5. Async dispatch (200 returns BEFORE skill completion)
 */

const APPROVED = "# Status: Approved";

async function buildScheduler(): Promise<{
  scheduler: Scheduler;
  skillStore: FilesystemSkillStore;
  home: string;
  cleanup: () => void;
}> {
  const home = mkdtempSync(join(tmpdir(), "v0190-"));
  const skillStore = new FilesystemSkillStore(join(home, "skills"));
  const traceStore = new FilesystemTraceStore(join(home, "traces"));
  const registry = new Registry();
  registry.registerSkillStore("primary", skillStore);
  const scheduler = new Scheduler({
    registry,
    skillStore,
    traceStore,
    trace: { mode: "on" },
  });
  return { scheduler, skillStore, home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// ────────────────────────────────────────────────────────────────────────
// 1. Scheduler.fireEvent
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.0 — Scheduler.fireEvent", () => {
  it("fires registered event_name, returns run_id (UUID)", async () => {
    const { scheduler, skillStore, cleanup } = await buildScheduler();
    try {
      await skillStore.store("echo-skill",
        `# Skill: echo-skill\n${APPROVED}\n# Description: echo\nm:\n    emit(text="\${MESSAGE}")\ndefault: m\n`,
      );
      scheduler.registerTrigger({
        skillName: "echo-skill",
        source: "event",
        name: "echo",
        params: ["MESSAGE"],
        declarative: false,
      });
      const { run_id } = scheduler.fireEvent("echo", { MESSAGE: "hello" });
      expect(run_id).toMatch(/^[0-9a-f-]{36}$/); // UUID v4 shape
    } finally {
      cleanup();
    }
  });

  it("throws EventNotFoundError on unregistered event_name", async () => {
    const { scheduler, cleanup } = await buildScheduler();
    try {
      expect(() => scheduler.fireEvent("nope", {})).toThrow(EventNotFoundError);
    } finally {
      cleanup();
    }
  });

  it("case-insensitive event_name lookup (normalized at register + fire)", async () => {
    const { scheduler, skillStore, cleanup } = await buildScheduler();
    try {
      await skillStore.store("s", `# Skill: s\n${APPROVED}\n# Description: s\nm:\n    emit(text="hi")\ndefault: m\n`);
      scheduler.registerTrigger({
        skillName: "s",
        source: "event",
        name: "HeartBeat",  // mixed case at register
        declarative: false,
      });
      // Lookup with different case still hits
      expect(() => scheduler.fireEvent("heartbeat", {})).not.toThrow();
      expect(() => scheduler.fireEvent("HEARTBEAT", {})).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it("strict params: throws EventParamMismatchError on missing required", async () => {
    const { scheduler, skillStore, cleanup } = await buildScheduler();
    try {
      await skillStore.store("s", `# Skill: s\n${APPROVED}\n# Description: s\nm:\n    emit(text="hi")\ndefault: m\n`);
      scheduler.registerTrigger({
        skillName: "s",
        source: "event",
        name: "needs-two",
        params: ["A", "B"],
        declarative: false,
      });
      let err: Error | null = null;
      try {
        scheduler.fireEvent("needs-two", { A: "x" });
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeInstanceOf(EventParamMismatchError);
      expect((err as EventParamMismatchError).missing).toEqual(["B"]);
      expect((err as EventParamMismatchError).extra).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("strict params: throws EventParamMismatchError on extra/unknown param", async () => {
    const { scheduler, skillStore, cleanup } = await buildScheduler();
    try {
      await skillStore.store("s", `# Skill: s\n${APPROVED}\n# Description: s\nm:\n    emit(text="hi")\ndefault: m\n`);
      scheduler.registerTrigger({
        skillName: "s",
        source: "event",
        name: "one-param",
        params: ["A"],
        declarative: false,
      });
      let err: Error | null = null;
      try {
        scheduler.fireEvent("one-param", { A: "x", UNKNOWN: "y" });
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeInstanceOf(EventParamMismatchError);
      expect((err as EventParamMismatchError).extra).toEqual(["UNKNOWN"]);
    } finally {
      cleanup();
    }
  });

  it("no params declared + empty body → fires cleanly", async () => {
    const { scheduler, skillStore, cleanup } = await buildScheduler();
    try {
      await skillStore.store("s", `# Skill: s\n${APPROVED}\n# Description: s\nm:\n    emit(text="hi")\ndefault: m\n`);
      scheduler.registerTrigger({
        skillName: "s",
        source: "event",
        name: "noargs",
        declarative: false,
      });
      const { run_id } = scheduler.fireEvent("noargs", {});
      expect(run_id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2. Registration upsert + cross-skill rebind audit log
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.0 — event_name registration: upsert + cross-skill rebind audit", () => {
  it("same skill re-registering same event_name → silent upsert (no log)", async () => {
    const { skillStore, cleanup, home } = await buildScheduler();
    try {
      const logs: string[] = [];
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      const registry = new Registry();
      registry.registerSkillStore("primary", skillStore);
      const scheduler = new Scheduler({
        registry,
        skillStore,
        traceStore,
        log: (m) => logs.push(m),
      });
      await skillStore.store("s", `# Skill: s\n${APPROVED}\n# Description: s\nm:\n    emit(text="hi")\ndefault: m\n`);
      scheduler.registerTrigger({
        skillName: "s",
        source: "event",
        name: "thing",
        declarative: false,
      });
      scheduler.registerTrigger({
        skillName: "s",
        source: "event",
        name: "thing",  // re-register, same skill → silent upsert
        declarative: false,
      });
      expect(logs.filter((m) => m.includes("rebound"))).toEqual([]);
      // Only one trigger should be live (upsert replaced)
      const triggers = scheduler.listTriggers().filter((t) => t.source === "event" && t.name === "thing");
      expect(triggers.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("cross-skill rebind → allowed, audit log fires", async () => {
    const { skillStore, cleanup, home } = await buildScheduler();
    try {
      const logs: string[] = [];
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      const registry = new Registry();
      registry.registerSkillStore("primary", skillStore);
      const scheduler = new Scheduler({
        registry,
        skillStore,
        traceStore,
        log: (m) => logs.push(m),
      });
      await skillStore.store("a", `# Skill: a\n${APPROVED}\n# Description: a\nm:\n    emit(text="A")\ndefault: m\n`);
      await skillStore.store("b", `# Skill: b\n${APPROVED}\n# Description: b\nm:\n    emit(text="B")\ndefault: m\n`);
      scheduler.registerTrigger({ skillName: "a", source: "event", name: "shared", declarative: false });
      scheduler.registerTrigger({ skillName: "b", source: "event", name: "shared", declarative: false });

      // Audit log fires for the cross-skill rebind
      const reboundLines = logs.filter((m) => m.includes("rebound"));
      expect(reboundLines.length).toBe(1);
      expect(reboundLines[0]).toMatch(/event_name 'shared' rebound: skill 'a' → skill 'b'/);

      // Last-write-wins: only b's binding remains
      const triggers = scheduler.listTriggers().filter((t) => t.source === "event" && t.name === "shared");
      expect(triggers.length).toBe(1);
      expect(triggers[0]!.skillName).toBe("b");
    } finally {
      cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// 3. DashboardServer POST /event
// ────────────────────────────────────────────────────────────────────────

async function buildDashboardServer(opts: {
  eventIngressEnabled: boolean;
  eventIngressAuthToken?: string;
}): Promise<{
  server: DashboardServer;
  scheduler: Scheduler;
  skillStore: FilesystemSkillStore;
  cleanup: () => void;
}> {
  const { scheduler, skillStore, home, cleanup } = await buildScheduler();
  const traceStore = new FilesystemTraceStore(join(home, "traces"));
  const registry = new Registry();
  registry.registerSkillStore("primary", skillStore);
  const mcpServer = new McpServer({ skillStore, scheduler, traceStore, registry });
  const server = new DashboardServer({
    mcpServer,
    port: 0,
    eventIngressEnabled: opts.eventIngressEnabled,
    ...(opts.eventIngressAuthToken !== undefined ? { eventIngressAuthToken: opts.eventIngressAuthToken } : {}),
    ...(opts.eventIngressEnabled ? { scheduler } : {}),
    mountSpa: false,
  });
  return { server, scheduler, skillStore, cleanup };
}

// Minimal req/res shims for direct handler testing (no network bind)
function mockReqRes(method: string, url: string, body: string, headers: Record<string, string> = {}): {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  getStatus: () => number;
  getBody: () => string;
} {
  const chunks = [Buffer.from(body)];
  let chunkIdx = 0;
  // Stream-like IncomingMessage with method + url + headers + async iter
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      while (chunkIdx < chunks.length) {
        yield chunks[chunkIdx++]!;
      }
    },
  } as unknown as import("node:http").IncomingMessage;
  let statusCode = 200;
  let responseBody = "";
  const res = {
    set statusCode(v: number) { statusCode = v; },
    get statusCode() { return statusCode; },
    setHeader: () => {},
    end: (data: string | Buffer) => { responseBody = typeof data === "string" ? data : data.toString("utf8"); },
  } as unknown as import("node:http").ServerResponse;
  return { req, res, getStatus: () => statusCode, getBody: () => responseBody };
}

describe("v0.19.0 — DashboardServer POST /event", () => {
  it("returns 404 when event ingress is disabled (default)", async () => {
    const { server, cleanup } = await buildDashboardServer({ eventIngressEnabled: false });
    try {
      const { req, res, getStatus, getBody } = mockReqRes("POST", "/event", "{}");
      await server.handle(req, res);
      expect(getStatus()).toBe(404);
      expect(getBody()).toMatch(/event ingress disabled/);
    } finally {
      cleanup();
    }
  });

  it("returns 405 on GET (when enabled, POST-only)", async () => {
    const { server, cleanup } = await buildDashboardServer({ eventIngressEnabled: true });
    try {
      const { req, res, getStatus } = mockReqRes("GET", "/event", "");
      await server.handle(req, res);
      expect(getStatus()).toBe(405);
    } finally {
      cleanup();
    }
  });

  it("200 + run_id + durability self-describing on accept", async () => {
    const { server, scheduler, skillStore, cleanup } = await buildDashboardServer({ eventIngressEnabled: true });
    try {
      await skillStore.store("s", `# Skill: s\n${APPROVED}\n# Description: s\nm:\n    emit(text="hi")\ndefault: m\n`);
      scheduler.registerTrigger({ skillName: "s", source: "event", name: "go", declarative: false });
      const { req, res, getStatus, getBody } = mockReqRes(
        "POST", "/event",
        JSON.stringify({ event_name: "go", params: {} }),
        { "content-type": "application/json" },
      );
      await server.handle(req, res);
      expect(getStatus()).toBe(200);
      const body = JSON.parse(getBody()) as { run_id: string; durability: string };
      expect(body.run_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.durability).toBe("in-process");
    } finally {
      cleanup();
    }
  });

  it("404 on unknown event_name", async () => {
    const { server, cleanup } = await buildDashboardServer({ eventIngressEnabled: true });
    try {
      const { req, res, getStatus, getBody } = mockReqRes(
        "POST", "/event",
        JSON.stringify({ event_name: "nope", params: {} }),
      );
      await server.handle(req, res);
      expect(getStatus()).toBe(404);
      const body = JSON.parse(getBody()) as { reason: string };
      expect(body.reason).toMatch(/'nope'/);
    } finally {
      cleanup();
    }
  });

  it("400 on missing param + names missing in response", async () => {
    const { server, scheduler, skillStore, cleanup } = await buildDashboardServer({ eventIngressEnabled: true });
    try {
      await skillStore.store("s", `# Skill: s\n${APPROVED}\n# Description: s\nm:\n    emit(text="hi")\ndefault: m\n`);
      scheduler.registerTrigger({ skillName: "s", source: "event", name: "p", params: ["X"], declarative: false });
      const { req, res, getStatus, getBody } = mockReqRes(
        "POST", "/event",
        JSON.stringify({ event_name: "p", params: {} }),
      );
      await server.handle(req, res);
      expect(getStatus()).toBe(400);
      const body = JSON.parse(getBody()) as { missing: string[]; extra: string[] };
      expect(body.missing).toEqual(["X"]);
    } finally {
      cleanup();
    }
  });

  it("400 on extra param + names extra in response", async () => {
    const { server, scheduler, skillStore, cleanup } = await buildDashboardServer({ eventIngressEnabled: true });
    try {
      await skillStore.store("s", `# Skill: s\n${APPROVED}\n# Description: s\nm:\n    emit(text="hi")\ndefault: m\n`);
      scheduler.registerTrigger({ skillName: "s", source: "event", name: "p", params: ["X"], declarative: false });
      const { req, res, getStatus, getBody } = mockReqRes(
        "POST", "/event",
        JSON.stringify({ event_name: "p", params: { X: 1, BADKEY: 2 } }),
      );
      await server.handle(req, res);
      expect(getStatus()).toBe(400);
      const body = JSON.parse(getBody()) as { extra: string[] };
      expect(body.extra).toEqual(["BADKEY"]);
    } finally {
      cleanup();
    }
  });

  it("400 on malformed JSON body", async () => {
    const { server, cleanup } = await buildDashboardServer({ eventIngressEnabled: true });
    try {
      const { req, res, getStatus } = mockReqRes("POST", "/event", "not json");
      await server.handle(req, res);
      expect(getStatus()).toBe(400);
    } finally {
      cleanup();
    }
  });

  it("400 when event_name missing or empty", async () => {
    const { server, cleanup } = await buildDashboardServer({ eventIngressEnabled: true });
    try {
      const { req, res, getStatus } = mockReqRes("POST", "/event", JSON.stringify({ params: {} }));
      await server.handle(req, res);
      expect(getStatus()).toBe(400);
    } finally {
      cleanup();
    }
  });

  it("401 when auth token configured + missing Authorization header", async () => {
    const { server, cleanup } = await buildDashboardServer({
      eventIngressEnabled: true,
      eventIngressAuthToken: "secret",
    });
    try {
      const { req, res, getStatus } = mockReqRes(
        "POST", "/event",
        JSON.stringify({ event_name: "x", params: {} }),
        // no Authorization header
      );
      await server.handle(req, res);
      expect(getStatus()).toBe(401);
    } finally {
      cleanup();
    }
  });

  it("401 when auth token configured + wrong token", async () => {
    const { server, cleanup } = await buildDashboardServer({
      eventIngressEnabled: true,
      eventIngressAuthToken: "secret",
    });
    try {
      const { req, res, getStatus } = mockReqRes(
        "POST", "/event",
        JSON.stringify({ event_name: "x", params: {} }),
        { authorization: "Bearer wrong" },
      );
      await server.handle(req, res);
      expect(getStatus()).toBe(401);
    } finally {
      cleanup();
    }
  });

  it("200 when auth token configured + correct token", async () => {
    const { server, scheduler, skillStore, cleanup } = await buildDashboardServer({
      eventIngressEnabled: true,
      eventIngressAuthToken: "secret",
    });
    try {
      await skillStore.store("s", `# Skill: s\n${APPROVED}\n# Description: s\nm:\n    emit(text="hi")\ndefault: m\n`);
      scheduler.registerTrigger({ skillName: "s", source: "event", name: "g", declarative: false });
      const { req, res, getStatus } = mockReqRes(
        "POST", "/event",
        JSON.stringify({ event_name: "g", params: {} }),
        { authorization: "Bearer secret" },
      );
      await server.handle(req, res);
      expect(getStatus()).toBe(200);
    } finally {
      cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// 4. DashboardServer config validation
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.0 — DashboardServer config requires scheduler when event ingress enabled", () => {
  it("throws when eventIngressEnabled=true but scheduler omitted", () => {
    const { home, cleanup } = (() => {
      const home = mkdtempSync(join(tmpdir(), "v0190-cfg-"));
      return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
    })();
    try {
      const skillStore = new FilesystemSkillStore(join(home, "skills"));
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      const registry = new Registry();
      const scheduler = new Scheduler({ registry, skillStore, traceStore });
      const mcpServer = new McpServer({ skillStore, scheduler, traceStore, registry });
      expect(() => new DashboardServer({
        mcpServer,
        eventIngressEnabled: true,
        // scheduler deliberately omitted
      })).toThrow(/eventIngressEnabled requires a scheduler/);
    } finally {
      cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// 5. MCP register_trigger accepts only cron + event sources (v0.19.0 trim)
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.0 — MCP register_trigger source enum restricted to cron + event", () => {
  it("registers cron + event sources via MCP register_trigger", async () => {
    const { scheduler, skillStore, cleanup, home } = await buildScheduler();
    try {
      await skillStore.store("s", `# Skill: s\n${APPROVED}\n# Description: s\nm:\n    emit(text="hi")\ndefault: m\n`);
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      const registry = new Registry();
      registry.registerSkillStore("primary", skillStore);
      const mcpServer = new McpServer({ skillStore, scheduler, traceStore, registry });

      const req1: JsonRpcRequest = {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "register_trigger", arguments: { skill_name: "s", source: "cron", name: "0 9 * * *" } },
      };
      const r1 = await mcpServer.handle(req1);
      expect((r1.result as { content: Array<{ text: string }> }).content[0]!.text).toMatch(/"source":"cron"/);

      const req2: JsonRpcRequest = {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "register_trigger", arguments: { skill_name: "s", source: "event", name: "go" } },
      };
      const r2 = await mcpServer.handle(req2);
      expect((r2.result as { content: Array<{ text: string }> }).content[0]!.text).toMatch(/"source":"event"/);
    } finally {
      cleanup();
    }
  });
});
