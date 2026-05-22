import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, defaultRegistry, wireDeclarativeTriggers } from "../src/bootstrap.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { Scheduler } from "../src/scheduler.js";
import { Registry } from "../src/connectors/registry.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";

/**
 * v0.2.1 — patch validating the three load-bearing changes from Perry's
 * imperative-trigger-fire bug (thread `52f3d3d9`):
 *
 *   1. `bootstrap()` + `defaultRegistry()` extract the shared host wiring
 *      so cmdDashboard and (v0.3) cmdServe share a single instantiation
 *      path.
 *   2. `wireDeclarativeTriggers()` registers `# Triggers:` headers from
 *      Approved skills at boot. Achieves declarative-trigger parity with
 *      imperative MCP registration.
 *   3. `runtime_capabilities` MCP tool surfaces wired connectors + shell-
 *      execution mode for cold-agent discoverability.
 *
 * The scheduler.start() wire-up itself is integration-tested through
 * dogfood-t6b's tick-fire path (separate suite).
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

describe("v0.2.1 — bootstrap()", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v021-boot-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns scheduler + mcpServer + registry + stores", () => {
    const result = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    expect(result.registry).toBeInstanceOf(Registry);
    expect(result.scheduler).toBeInstanceOf(Scheduler);
    expect(result.mcpServer).toBeInstanceOf(McpServer);
    expect(result.skillStore).toBeInstanceOf(FilesystemSkillStore);
    expect(result.traceStore).toBeInstanceOf(FilesystemTraceStore);
    expect(result.enableUnsafeShell).toBe(false);
  });

  it("registers primary SkillStore + three LocalModels in the registry", () => {
    const { registry } = defaultRegistry({ skillsDir: join(home, "skills") });
    expect(registry.hasSkillStore("primary")).toBe(true);
    expect(registry.hasLocalModel("default")).toBe(true);
    expect(registry.hasLocalModel("gemma2")).toBe(true);
    expect(registry.hasLocalModel("qwen")).toBe(true);
  });

  it("propagates enableUnsafeShell into result + McpServer", async () => {
    const result = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces"), enableUnsafeShell: true });
    expect(result.enableUnsafeShell).toBe(true);
    const caps = await callTool(result.mcpServer, "runtime_capabilities", { include: ["shellExecution"] });
    const shell = caps["shellExecution"] as { unsafe_enabled: boolean };
    expect(shell.unsafe_enabled).toBe(true);
  });

  it("skipping memoryDbPath leaves MemoryStore unregistered", () => {
    const { registry } = defaultRegistry({ skillsDir: join(home, "skills") });
    expect(registry.hasMemoryStore("primary")).toBe(false);
  });
});

describe("v0.2.1 — wireDeclarativeTriggers()", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v021-trig-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("registers # Triggers: headers from Approved skills only", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.skillStore.store("approved-one",
      "# Skill: approved-one\n# Status: Approved\n# Triggers: cron: */5 * * * *\nt:\n    ! hi\ndefault: t\n");
    await wired.skillStore.store("draft-one",
      "# Skill: draft-one\n# Status: Draft\n# Triggers: cron: */1 * * * *\nt:\n    ! hi\ndefault: t\n");
    const { registered, skipped } = await wireDeclarativeTriggers(wired, () => {});
    expect(registered).toBe(1);
    expect(skipped).toBe(0);
    const triggers = wired.scheduler.listTriggers();
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.skillName).toBe("approved-one");
    expect(triggers[0]!.declarative).toBe(true);
  });

  it("registers every # Triggers: entry when a skill declares multiple", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.skillStore.store("multi",
      "# Skill: multi\n# Status: Approved\n# Triggers: cron: 0 9 * * *, session: start\nt:\n    ! hi\ndefault: t\n");
    const { registered } = await wireDeclarativeTriggers(wired, () => {});
    expect(registered).toBe(2);
    const sources = wired.scheduler.listTriggers().map((t) => t.source).sort();
    expect(sources).toEqual(["cron", "session"]);
  });

  it("returns { registered: 0 } on empty SkillStore without crashing", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await wireDeclarativeTriggers(wired, () => {});
    expect(result.registered).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

describe("v0.2.1 — runtime_capabilities MCP tool", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v021-caps-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("appears in tools/list (v0.2.3 ships 11 tools total; runtime_capabilities is among them)", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const resp = await mcpServer.handle(rpc("tools/list"));
    const r = (resp as { result: { tools: Array<{ name: string }> } }).result;
    expect(r.tools.map((t) => t.name)).toContain("runtime_capabilities");
    expect(r.tools).toHaveLength(11);
  });

  it("returns all categories when called without filter", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const caps = await callTool(mcpServer, "runtime_capabilities");
    expect(Array.isArray(caps["skillStores"])).toBe(true);
    expect(Array.isArray(caps["localModels"])).toBe(true);
    expect(Array.isArray(caps["memoryStores"])).toBe(true);
    expect(Array.isArray(caps["mcpConnectors"])).toBe(true);
    expect(Array.isArray(caps["agentConnectors"])).toBe(true);
    expect(typeof caps["shellExecution"]).toBe("object");
    expect(caps["runtimeVersion"]).toBe("0.2.3");
  });

  it("honors include filter — returns only requested categories", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const caps = await callTool(mcpServer, "runtime_capabilities", { include: ["skillStores", "shellExecution"] });
    expect(Array.isArray(caps["skillStores"])).toBe(true);
    expect(typeof caps["shellExecution"]).toBe("object");
    expect(caps["localModels"]).toBeUndefined();
    expect(caps["runtimeVersion"]).toBeUndefined();
  });

  it("surfaces FilesystemSkillStore + Ollama models per default wiring", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const caps = await callTool(mcpServer, "runtime_capabilities");
    const stores = caps["skillStores"] as Array<{ name: string; implementation: string }>;
    expect(stores).toEqual([
      expect.objectContaining({ name: "primary", implementation: "FilesystemSkillStore" }),
    ]);
    const models = (caps["localModels"] as Array<{ name: string }>).map((m) => m.name).sort();
    expect(models).toEqual(["default", "gemma2", "qwen"]);
  });

  it("shellExecution reports structural-spawn + unsafe_enabled flag", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const caps = await callTool(mcpServer, "runtime_capabilities", { include: ["shellExecution"] });
    const shell = caps["shellExecution"] as { mode: string; unsafe_enabled: boolean };
    expect(shell.mode).toBe("structural-spawn");
    expect(shell.unsafe_enabled).toBe(false);
  });

  it("is read-only — calls do not mutate state", async () => {
    const { mcpServer, registry } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const before = registry.listSkillStores().length;
    await callTool(mcpServer, "runtime_capabilities");
    await callTool(mcpServer, "runtime_capabilities");
    expect(registry.listSkillStores().length).toBe(before);
  });

  it("falls back to empty arrays when McpServer is constructed without a registry", async () => {
    const skillStore = new FilesystemSkillStore(join(home, "skills"));
    const traceStore = new FilesystemTraceStore(join(home, "traces"));
    const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
    const server = new McpServer({ skillStore, scheduler, traceStore });
    const caps = await callTool(server, "runtime_capabilities");
    expect(caps["skillStores"]).toEqual([]);
    expect(caps["localModels"]).toEqual([]);
  });
});

describe("v0.2.1 — scheduler.start() in dashboard host", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v021-tick-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("fires a registered cron trigger when the tick loop is armed", async () => {
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      pollIntervalSeconds: 0.05,
      trace: { mode: "on" },
    });
    await wired.skillStore.store("ticky",
      "# Skill: ticky\n# Status: Approved\nt:\n    ! pong\ndefault: t\n");
    wired.scheduler.registerTrigger({
      skillName: "ticky",
      source: "cron",
      name: "* * * * *",
      declarative: false,
    });
    wired.scheduler.start();
    // First tick of a "* * * * *" cron will match the current minute and
    // dispatch synchronously inside the tick promise. Give the timer ~150ms
    // (pollIntervalSeconds 0.05 × 3) to fire.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await wired.scheduler.stop();
    const fires = await wired.traceStore.query({ skill_name: "ticky", limit: 10 });
    expect(fires.length).toBeGreaterThan(0);
  });
});
