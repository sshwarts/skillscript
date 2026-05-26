import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";
import { McpServer } from "../src/mcp-server.js";
import { DashboardServer } from "../src/dashboard/server.js";

/**
 * T6b dogfood pass — operator-path validation per ERD §8 + lesson
 * `a046164f`. Exercises the dashboard pipeline end-to-end:
 *   1. Real skill stored in SkillStore
 *   2. Trigger registered via MCP server (write path)
 *   3. Skill dispatched, trace recorded
 *   4. Dashboard /rpc endpoints return real data
 *   5. Status toggle via MCP write path persists + reflected in metadata
 *   6. Forced error (@ unsafe without enableUnsafeShell) surfaces with
 *      class + remediation in dashboard responses
 *   7. Trigger unregister write path persists
 *
 * Discipline streak: nine-for-nine after the CLI walkthrough catches.
 * Findings filed in dev log §12.
 */

interface Ctx {
  home: string;
  skillStore: FilesystemSkillStore;
  traceStore: FilesystemTraceStore;
  scheduler: Scheduler;
  mcpServer: McpServer;
  dashboardServer: DashboardServer;
  baseUrl: string;
}

let ctx: Ctx;

async function rpcCall<T>(baseUrl: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`${baseUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = await r.json() as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
  if (json.error !== undefined) throw new Error(json.error.message);
  return JSON.parse(json.result!.content[0]!.text) as T;
}

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "skillscript-t6b-dogfood-"));
  const skillStore = new FilesystemSkillStore(join(home, "skills"));
  const traceStore = new FilesystemTraceStore(join(home, "traces"));
  const scheduler = new Scheduler({
    registry: new Registry(),
    skillStore,
    traceStore,
    trace: { mode: "on" },
  });
  const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
  const port = 30000 + Math.floor(Math.random() * 10000);
  const dashboardServer = new DashboardServer({ mcpServer, port, bindAddress: "127.0.0.1" });
  await dashboardServer.start();
  ctx = {
    home, skillStore, traceStore, scheduler, mcpServer, dashboardServer,
    baseUrl: `http://127.0.0.1:${port}`,
  };
});

afterAll(async () => {
  if (ctx?.dashboardServer) await ctx.dashboardServer.stop();
  if (ctx?.home) rmSync(ctx.home, { recursive: true, force: true });
});

describe("T6b dogfood — dashboard end-to-end", () => {
  it("1. SPA shell loads with expected structure", async () => {
    const r = await fetch(`${ctx.baseUrl}/`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toMatch(/skillscript-runtime/);
    expect(body).toMatch(/#overview/);
    expect(body).toMatch(/#skills/);
    expect(body).toMatch(/#triggers/);
    expect(body).toMatch(/#connectors/);
  });

  it("2. MCP server reachable via /rpc with all 14 tools (v0.9.0 added set_trigger_enabled)", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const json = await r.json() as { result: { tools: Array<{ name: string }> } };
    const names = json.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "compile_skill", "execute_skill", "health_metrics", "help", "lint_skill",
      "list_triggers", "register_trigger", "runtime_capabilities", "set_trigger_enabled",
      "skill_list", "skill_metadata", "skill_status", "skill_write", "unregister_trigger",
    ]);
  });

  it("3. Author + store skill; dashboard sees it via skill_list", async () => {
    await ctx.skillStore.store("heartbeat",
      "# Skill: heartbeat\n# Status: Draft\n# Triggers: cron: */1 * * * *\n" +
      "emit:\n    ! heartbeat at $(EVENT.fired_at_unix)\ndefault: emit\n",
    );
    const skills = await rpcCall<Array<{ name: string; status: string }>>(ctx.baseUrl, "skill_list");
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("heartbeat");
    expect(skills[0]!.status).toBe("Draft");
  });

  it("4. skill_metadata returns full skill detail with version history", async () => {
    const detail = await rpcCall<{ metadata: { name: string; status: string }; versions: unknown[] }>(
      ctx.baseUrl, "skill_metadata", { name: "heartbeat" },
    );
    expect(detail.metadata.name).toBe("heartbeat");
    expect(detail.metadata.status).toBe("Draft");
    expect(detail.versions.length).toBeGreaterThanOrEqual(1);
  });

  it("5. Status toggle Draft → Approved persists (write path)", async () => {
    const result = await rpcCall<{ status: string; previous_status: string }>(
      ctx.baseUrl, "skill_status", { name: "heartbeat", new_state: "Approved" },
    );
    expect(result.status).toBe("Approved");
    expect(result.previous_status).toBe("Draft");
    // Verify via re-poll
    const skills = await rpcCall<Array<{ name: string; status: string }>>(ctx.baseUrl, "skill_list");
    expect(skills[0]!.status).toBe("Approved");
  });

  it("6. Register trigger via MCP write path → list_triggers reflects it", async () => {
    const reg = await rpcCall<{ id: string; skillName: string; source: string }>(
      ctx.baseUrl, "register_trigger",
      { skill_name: "heartbeat", source: "cron", name: "*/1 * * * *" },
    );
    expect(reg.id).toMatch(/^trig-/);
    expect(reg.skillName).toBe("heartbeat");
    const triggers = await rpcCall<Array<{ id: string; skillName: string }>>(ctx.baseUrl, "list_triggers");
    expect(triggers.length).toBe(1);
    expect(triggers[0]!.skillName).toBe("heartbeat");
  });

  it("7. Fire skill via scheduler; trace recorded; health_metrics reflects success", async () => {
    await ctx.scheduler.dispatchSkill("heartbeat", undefined, {
      source: "cron", name: "*/1 * * * *", fired_at_ms: Date.now(), trigger_id: "t-1",
    });
    const metrics = await rpcCall<{ totalFires: number; perSkill: Record<string, { fireCount: number; successCount: number }> }>(
      ctx.baseUrl, "health_metrics",
    );
    expect(metrics.totalFires).toBe(1);
    expect(metrics.perSkill["heartbeat"]!.fireCount).toBe(1);
    expect(metrics.perSkill["heartbeat"]!.successCount).toBe(1);
  });

  it("8. Forced error surfaces with class + remediation in trace", async () => {
    await ctx.skillStore.store("broken",
      "# Skill: broken\n# Status: Approved\n" +
      "fail:\n    @ unsafe echo \"requires enableUnsafeShell\"\ndefault: fail\n",
    );
    // Dispatch without enableUnsafeShell (default false) — should error.
    const result = await ctx.scheduler.dispatchSkill("broken");
    expect(result).not.toBeNull();
    expect(result!.errors.length).toBe(1);
    expect(result!.errors[0]!.class).toBe("UnsafeShellDisabledError");
    expect(result!.errors[0]!.remediation).toMatch(/enableUnsafeShell/);

    // Verify the error surfaces in health_metrics errorCategories
    const metrics = await rpcCall<{ perSkill: Record<string, { errorCategories: Record<string, Record<string, number>> }> }>(
      ctx.baseUrl, "health_metrics",
    );
    expect(metrics.perSkill["broken"]!.errorCategories["@"]!["UnsafeShellDisabledError"]).toBe(1);
  });

  it("9. Status Approved → Disabled persists; scheduler will skip future fires", async () => {
    await rpcCall(ctx.baseUrl, "skill_status", { name: "heartbeat", new_state: "Disabled" });
    const skills = await rpcCall<Array<{ name: string; status: string }>>(
      ctx.baseUrl, "skill_list", { filter: { status: "Disabled" } },
    );
    expect(skills.find((s) => s.name === "heartbeat")?.status).toBe("Disabled");

    // Verify scheduler skip-on-disabled (read from logs would be ideal; the
    // dispatchSkill return is null for non-Approved status)
    const result = await ctx.scheduler.dispatchSkill("heartbeat");
    expect(result).toBeNull();
  });

  it("10. Unregister trigger via MCP write path → list_triggers empty", async () => {
    const triggers = await rpcCall<Array<{ id: string }>>(ctx.baseUrl, "list_triggers");
    const id = triggers[0]!.id;
    const result = await rpcCall<{ removed: boolean }>(ctx.baseUrl, "unregister_trigger", { trigger_id: id });
    expect(result.removed).toBe(true);
    const remaining = await rpcCall<unknown[]>(ctx.baseUrl, "list_triggers");
    expect(remaining).toEqual([]);
  });
});
