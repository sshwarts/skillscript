import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { DashboardServer } from "../src/dashboard/server.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";
import { resolveRuntimeConfigFromEnv } from "../src/runtime-env-resolver.js";

/**
 * v0.19.1 — three convergent fixes:
 *
 *   (A) Shared resolveRuntimeConfigFromEnv() — adopter CR f2549ddf +
 *       follow-up aeccddac. Programmatic bootstrap() / DashboardServer
 *       inherit env support for ALL SKILLSCRIPT_* knobs. Perry's
 *       explicit-wins guard generalized across every field.
 *
 *   (B) Dynamic declarative-trigger registration on skill_write +
 *       skill_status. Perry F1 (memory f68eb84d) + adopter Finding 2
 *       (memory d538f7df). Mid-session writes are live immediately;
 *       no restart required.
 *
 *   (C) Imperative register_trigger auto-derives params from the
 *       named skill's # Vars: declaration. Perry F2 (memory f68eb84d).
 *       Closes the asymmetry where declarative wiring derived params
 *       but the imperative MCP path didn't.
 */

const APPROVED = "# Status: Approved";

let savedEnv: Record<string, string | undefined> = {};

function captureEnv(): void {
  const keys = [
    "SKILLSCRIPT_PORT", "SKILLSCRIPT_HOST", "SKILLSCRIPT_MCP_CALLER_IDENTITY_HEADER",
    "SKILLSCRIPT_ENABLE_UNSAFE_SHELL", "SKILLSCRIPT_FORCE_ALWAYS_DRAFT",
    "SKILLSCRIPT_POLL_INTERVAL_SECONDS", "SKILLSCRIPT_ABSOLUTE_TIMEOUT_MS",
    "SKILLSCRIPT_MAX_RECURSION_DEPTH", "SKILLSCRIPT_SHELL_ALLOWLIST",
    "SKILLSCRIPT_EVENT_INGRESS_ENABLED", "SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN",
  ];
  for (const k of keys) savedEnv[k] = process.env[k];
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ────────────────────────────────────────────────────────────────────────
// (A) resolveRuntimeConfigFromEnv — shared resolver
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.1 — resolveRuntimeConfigFromEnv parses all SKILLSCRIPT_* knobs", () => {
  it("empty env → empty config", () => {
    const result = resolveRuntimeConfigFromEnv({});
    expect(result).toEqual({});
  });

  it("parses every SKILLSCRIPT_* knob from supplied env", () => {
    const env = {
      SKILLSCRIPT_PORT: "8080",
      SKILLSCRIPT_HOST: "0.0.0.0",
      SKILLSCRIPT_MCP_CALLER_IDENTITY_HEADER: "X-Agent-Id",
      SKILLSCRIPT_ENABLE_UNSAFE_SHELL: "true",
      SKILLSCRIPT_FORCE_ALWAYS_DRAFT: "true",
      SKILLSCRIPT_POLL_INTERVAL_SECONDS: "15",
      SKILLSCRIPT_ABSOLUTE_TIMEOUT_MS: "60000",
      SKILLSCRIPT_MAX_RECURSION_DEPTH: "25",
      SKILLSCRIPT_SHELL_ALLOWLIST: "curl,git,jq",
      SKILLSCRIPT_EVENT_INGRESS_ENABLED: "true",
      SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN: "secret",
    };
    const result = resolveRuntimeConfigFromEnv(env);
    expect(result).toEqual({
      port: 8080,
      host: "0.0.0.0",
      mcpCallerIdentityHeader: "X-Agent-Id",
      enableUnsafeShell: true,
      forceAlwaysDraft: true,
      pollIntervalSeconds: 15,
      absoluteTimeoutMs: 60000,
      maxRecursionDepth: 25,
      shellAllowlist: ["curl", "git", "jq"],
      eventIngressEnabled: true,
      eventIngressAuthToken: "secret",
    });
  });

  it("invalid numeric values silently fall through (consistent with CLI cascade)", () => {
    const env = {
      SKILLSCRIPT_PORT: "not-a-number",
      SKILLSCRIPT_POLL_INTERVAL_SECONDS: "-1",
      SKILLSCRIPT_ABSOLUTE_TIMEOUT_MS: "0",
      SKILLSCRIPT_MAX_RECURSION_DEPTH: "0",
    };
    const result = resolveRuntimeConfigFromEnv(env);
    expect(result.port).toBeUndefined();
    expect(result.pollIntervalSeconds).toBeUndefined();
    expect(result.absoluteTimeoutMs).toBeUndefined();
    expect(result.maxRecursionDepth).toBeUndefined();
  });

  it("boolean knobs accept 'true'/'false' literally; other values undefined", () => {
    const result = resolveRuntimeConfigFromEnv({
      SKILLSCRIPT_ENABLE_UNSAFE_SHELL: "yes",
      SKILLSCRIPT_FORCE_ALWAYS_DRAFT: "1",
    });
    expect(result.enableUnsafeShell).toBeUndefined();
    expect(result.forceAlwaysDraft).toBeUndefined();
  });

  it("explicit 'false' literal sets the field to false (NOT undefined)", () => {
    const result = resolveRuntimeConfigFromEnv({
      SKILLSCRIPT_ENABLE_UNSAFE_SHELL: "false",
      SKILLSCRIPT_FORCE_ALWAYS_DRAFT: "false",
      SKILLSCRIPT_EVENT_INGRESS_ENABLED: "false",
    });
    expect(result.enableUnsafeShell).toBe(false);
    expect(result.forceAlwaysDraft).toBe(false);
    expect(result.eventIngressEnabled).toBe(false);
  });

  it("SKILLSCRIPT_SHELL_ALLOWLIST empty string → explicit empty list", () => {
    const result = resolveRuntimeConfigFromEnv({ SKILLSCRIPT_SHELL_ALLOWLIST: "" });
    expect(result.shellAllowlist).toEqual([]);
  });

  it("SKILLSCRIPT_SHELL_ALLOWLIST with whitespace → trimmed + empties dropped", () => {
    const result = resolveRuntimeConfigFromEnv({ SKILLSCRIPT_SHELL_ALLOWLIST: " curl , , jq " });
    expect(result.shellAllowlist).toEqual(["curl", "jq"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// (A.cont) bootstrap() + DashboardServer env-fallback
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.1 — bootstrap() reads env for every SKILLSCRIPT_* knob", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0191-bootstrap-"));
    captureEnv();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    restoreEnv();
  });

  it("env set + opts undefined → env values populate Scheduler config", () => {
    process.env["SKILLSCRIPT_POLL_INTERVAL_SECONDS"] = "5";
    process.env["SKILLSCRIPT_ABSOLUTE_TIMEOUT_MS"] = "120000";
    process.env["SKILLSCRIPT_MAX_RECURSION_DEPTH"] = "20";
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const sched = wired.scheduler as unknown as {
      pollIntervalMs: number;
      absoluteTimeoutMs: number | undefined;
      maxRecursionDepth: number | undefined;
    };
    expect(sched.pollIntervalMs).toBe(5000);
    expect(sched.absoluteTimeoutMs).toBe(120000);
    expect(sched.maxRecursionDepth).toBe(20);
  });

  it("explicit opts win over env (Perry's explicit-wins guard) — pollIntervalSeconds", () => {
    process.env["SKILLSCRIPT_POLL_INTERVAL_SECONDS"] = "99";
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      pollIntervalSeconds: 7,
    });
    const sched = wired.scheduler as unknown as { pollIntervalMs: number };
    expect(sched.pollIntervalMs).toBe(7000);
  });

  it("explicit shellAllowlist: [] resists env override (the v0.18.9 security guard generalized)", () => {
    process.env["SKILLSCRIPT_SHELL_ALLOWLIST"] = "curl,git,jq";
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      shellAllowlist: [],
    });
    const sched = wired.scheduler as unknown as { shellAllowlist: string[] | undefined };
    expect(sched.shellAllowlist).toEqual([]);
  });

  it("explicit enableUnsafeShell: false resists env override (true)", () => {
    process.env["SKILLSCRIPT_ENABLE_UNSAFE_SHELL"] = "true";
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      enableUnsafeShell: false,
    });
    const sched = wired.scheduler as unknown as { enableUnsafeShell: boolean };
    expect(sched.enableUnsafeShell).toBe(false);
  });
});

describe("v0.19.1 — DashboardServer reads env for event ingress + server-level knobs", () => {
  let home: string;
  let scheduler: Scheduler;
  let skillStore: FilesystemSkillStore;
  let traceStore: FilesystemTraceStore;
  let mcpServer: McpServer;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0191-srv-"));
    skillStore = new FilesystemSkillStore(join(home, "skills"));
    traceStore = new FilesystemTraceStore(join(home, "traces"));
    const registry = new Registry();
    registry.registerSkillStore("primary", skillStore);
    scheduler = new Scheduler({ registry, skillStore, traceStore });
    mcpServer = new McpServer({ skillStore, scheduler, traceStore, registry });
    captureEnv();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    restoreEnv();
  });

  it("env-set SKILLSCRIPT_EVENT_INGRESS_ENABLED + no config field → reads env", () => {
    process.env["SKILLSCRIPT_EVENT_INGRESS_ENABLED"] = "true";
    const server = new DashboardServer({ mcpServer, scheduler });
    const s = server as unknown as { eventIngressEnabled: boolean };
    expect(s.eventIngressEnabled).toBe(true);
  });

  it("explicit eventIngressEnabled: false resists env override (true)", () => {
    process.env["SKILLSCRIPT_EVENT_INGRESS_ENABLED"] = "true";
    const server = new DashboardServer({ mcpServer, eventIngressEnabled: false });
    const s = server as unknown as { eventIngressEnabled: boolean };
    expect(s.eventIngressEnabled).toBe(false);
  });

  it("env-set port + host populate when config omits", () => {
    process.env["SKILLSCRIPT_PORT"] = "9000";
    process.env["SKILLSCRIPT_HOST"] = "0.0.0.0";
    const server = new DashboardServer({ mcpServer });
    const s = server as unknown as { port: number; bindAddress: string };
    expect(s.port).toBe(9000);
    expect(s.bindAddress).toBe("0.0.0.0");
  });

  it("env-set auth token populates when config omits", () => {
    process.env["SKILLSCRIPT_EVENT_INGRESS_ENABLED"] = "true";
    process.env["SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN"] = "from-env";
    const server = new DashboardServer({ mcpServer, scheduler });
    const s = server as unknown as { eventIngressAuthToken: string | undefined };
    expect(s.eventIngressAuthToken).toBe("from-env");
  });
});

// ────────────────────────────────────────────────────────────────────────
// (B) Dynamic declarative-trigger registration on skill_write/skill_status
// ────────────────────────────────────────────────────────────────────────

async function buildMcpEnv(): Promise<{
  server: McpServer;
  scheduler: Scheduler;
  skillStore: FilesystemSkillStore;
  cleanup: () => void;
}> {
  const home = mkdtempSync(join(tmpdir(), "v0191-mcp-"));
  const skillStore = new FilesystemSkillStore(join(home, "skills"));
  const traceStore = new FilesystemTraceStore(join(home, "traces"));
  const registry = new Registry();
  registry.registerSkillStore("primary", skillStore);
  const scheduler = new Scheduler({ registry, skillStore, traceStore });
  const server = new McpServer({ skillStore, scheduler, traceStore, registry });
  return { server, scheduler, skillStore, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

async function callTool<T>(server: McpServer, name: string, args: Record<string, unknown>): Promise<T> {
  const req: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
  const resp = await server.handle(req);
  const wrapped = (resp.result as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(wrapped) as T;
}

describe("v0.19.1 — skill_write registers declarative triggers immediately (Perry F1 + adopter Finding 2)", () => {
  it("Approved skill with # Triggers: event: X → /event accepts immediately (no restart)", async () => {
    const { server, scheduler, cleanup } = await buildMcpEnv();
    try {
      await callTool(server, "skill_write", {
        name: "live-event",
        source: `# Skill: live-event\n${APPROVED}\n# Description: dynamic-trigger probe\n# Triggers: event: probe-now\nm:\n    emit(text="ok")\ndefault: m\n`,
      });
      // No restart, no wireDeclarativeTriggers call — should be live now.
      expect(() => scheduler.fireEvent("probe-now", {})).not.toThrow();
      const triggers = scheduler.listTriggers({ skillName: "live-event" });
      expect(triggers.length).toBe(1);
      expect(triggers[0]!.source).toBe("event");
      expect(triggers[0]!.declarative).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("Draft skill with # Triggers: → triggers NOT registered (only Approved fires)", async () => {
    const { server, scheduler, cleanup } = await buildMcpEnv();
    try {
      await callTool(server, "skill_write", {
        name: "draft-event",
        source: `# Skill: draft-event\n# Status: Draft\n# Description: probe\n# Triggers: event: draft-probe\nm:\n    emit(text="ok")\ndefault: m\n`,
      });
      const triggers = scheduler.listTriggers({ skillName: "draft-event" });
      expect(triggers.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("skill_status Approved → Disabled drops declarative triggers", async () => {
    const { server, scheduler, cleanup } = await buildMcpEnv();
    try {
      await callTool(server, "skill_write", {
        name: "toggle-event",
        source: `# Skill: toggle-event\n${APPROVED}\n# Description: x\n# Triggers: event: toggle-probe\nm:\n    emit(text="ok")\ndefault: m\n`,
      });
      expect(scheduler.listTriggers({ skillName: "toggle-event" }).length).toBe(1);
      await callTool(server, "skill_status", { name: "toggle-event", new_state: "Disabled" });
      expect(scheduler.listTriggers({ skillName: "toggle-event" }).length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("skill_status Disabled → Approved restores declarative triggers", async () => {
    const { server, scheduler, cleanup } = await buildMcpEnv();
    try {
      await callTool(server, "skill_write", {
        name: "restore-event",
        source: `# Skill: restore-event\n# Status: Disabled\n# Description: x\n# Triggers: event: restore-probe\nm:\n    emit(text="ok")\ndefault: m\n`,
      });
      expect(scheduler.listTriggers({ skillName: "restore-event" }).length).toBe(0);
      await callTool(server, "skill_status", { name: "restore-event", new_state: "Approved" });
      expect(scheduler.listTriggers({ skillName: "restore-event" }).length).toBe(1);
    } finally {
      cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// (C) Imperative register_trigger derives params from # Vars: (Perry F2)
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.1 — imperative register_trigger derives params from # Vars: (Perry F2)", () => {
  it("imperative event register inherits the named skill's # Vars: as params", async () => {
    const { server, cleanup } = await buildMcpEnv();
    try {
      await callTool(server, "skill_write", {
        name: "imperative-with-vars",
        source: `# Skill: imperative-with-vars\n# Status: Draft\n# Description: x\n# Vars: NAME, REGION\nm:\n    emit(text="ok")\ndefault: m\n`,
      });
      // Imperatively register an event trigger (no triggers in the body)
      const reg = await callTool<{ params?: string[] }>(server, "register_trigger", {
        skill_name: "imperative-with-vars",
        source: "event",
        name: "imperative-event",
      });
      expect(reg.params).toEqual(["NAME", "REGION"]);
    } finally {
      cleanup();
    }
  });

  it("imperative register for cron source does NOT derive params (cron has no params)", async () => {
    const { server, cleanup } = await buildMcpEnv();
    try {
      await callTool(server, "skill_write", {
        name: "imperative-cron",
        source: `# Skill: imperative-cron\n# Status: Draft\n# Description: x\n# Vars: SHOULD_BE_IGNORED\nm:\n    emit(text="ok")\ndefault: m\n`,
      });
      const reg = await callTool<{ params?: string[] }>(server, "register_trigger", {
        skill_name: "imperative-cron",
        source: "cron",
        name: "0 9 * * *",
      });
      expect(reg.params).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// (D) Perry F3 — schema enum trim regression guard
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.1 — MCP register_trigger / list_triggers source enum is the v0.19.0 trim (regression guard)", () => {
  it("register_trigger schema accepts only cron + event", async () => {
    const { server, cleanup } = await buildMcpEnv();
    try {
      const resp = await server.handle({
        jsonrpc: "2.0", id: 1, method: "tools/list",
      } as JsonRpcRequest);
      const tools = (resp.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }> }).tools;
      const registerTrigger = tools.find((t) => t.name === "register_trigger");
      expect(registerTrigger).toBeDefined();
      const sourceEnum = registerTrigger!.inputSchema.properties["source"]?.enum;
      expect(sourceEnum).toEqual(["cron", "event"]);
    } finally {
      cleanup();
    }
  });

  it("list_triggers schema accepts only cron + event for source filter", async () => {
    const { server, cleanup } = await buildMcpEnv();
    try {
      const resp = await server.handle({
        jsonrpc: "2.0", id: 1, method: "tools/list",
      } as JsonRpcRequest);
      const tools = (resp.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }> }).tools;
      const listTriggers = tools.find((t) => t.name === "list_triggers");
      expect(listTriggers).toBeDefined();
      const sourceEnum = listTriggers!.inputSchema.properties["source"]?.enum;
      expect(sourceEnum).toEqual(["cron", "event"]);
    } finally {
      cleanup();
    }
  });
});
