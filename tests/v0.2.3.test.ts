import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { Scheduler } from "../src/scheduler.js";
import { Registry } from "../src/connectors/registry.js";

/**
 * v0.2.3 — three new MCP authoring-lifecycle tools per Perry's thread
 * `f48b8ef3`. Closes the over-the-wire authoring gap that the cold-client
 * MCP probe surfaced — foreign clients can now lint → compile → write →
 * status → register_trigger → observe end-to-end without filesystem access
 * to the SkillStore root.
 *
 *   lint_skill({source?|name})         → diagnostics across tiers 1/2/3
 *   compile_skill({source?|name, inputs?}) → rendered artifact + errors
 *   skill_write({name, source, overwrite?})→ commit to SkillStore (Draft)
 *
 * The integration suite at the bottom exercises the lifecycle end-to-end
 * against a real bootstrap-wired McpServer + FilesystemSkillStore.
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

const GOOD_SKILL = [
  "# Skill: hello-world",
  "# Description: Emit a greeting",
  "# Status: Draft",
  "greet:",
  "    emit(text=\"hello\")",
  "default: greet",
  "",
].join("\n");

const TIER_1_FAILING_SKILL = [
  "# Skill: bad",
  "# Status: Draft",
  "# This skill has no targets and no default — tier-1 lint will fire.",
  "",
].join("\n");

describe("v0.2.3 — lint_skill MCP tool", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v023-lint-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("appears in tools/list (v0.13.8 ships 16 tools total; lint_skill is among them)", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const resp = await mcpServer.handle(rpc("tools/list"));
    const r = (resp as { result: { tools: Array<{ name: string }> } }).result;
    const names = r.tools.map((t) => t.name).sort();
    expect(names).toContain("lint_skill");
    expect(r.tools).toHaveLength(16);
  });

  it("lints a literal source body and returns passes_tier_1: true for a clean skill", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "lint_skill", { source: GOOD_SKILL });
    expect(result["passes_tier_1"]).toBe(true);
    expect(result["error_count"]).toBe(0);
    expect(Array.isArray(result["diagnostics"])).toBe(true);
  });

  it("surfaces tier-1 errors with severity + tier on a malformed skill", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "lint_skill", { source: TIER_1_FAILING_SKILL });
    expect(result["passes_tier_1"]).toBe(false);
    expect(result["error_count"]).toBeGreaterThan(0);
    const diagnostics = result["diagnostics"] as Array<{ tier: number; severity: string }>;
    expect(diagnostics.some((d) => d.tier === 1 && d.severity === "error")).toBe(true);
  });

  it("lints by stored skill name", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.skillStore.store("stored-hello", GOOD_SKILL);
    const result = await callTool(wired.mcpServer, "lint_skill", { name: "stored-hello" });
    expect(result["passes_tier_1"]).toBe(true);
  });

  it("throws when neither source nor name provided", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await expect(callTool(mcpServer, "lint_skill", {})).rejects.toThrow(/source.*name.*required/i);
  });
});

describe("v0.2.3 — compile_skill MCP tool", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v023-compile-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns rendered artifact + target_order + resolved_variables for a clean skill", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "compile_skill", { source: GOOD_SKILL });
    expect(result["skill_name"]).toBe("hello-world");
    expect(typeof result["rendered"]).toBe("string");
    expect((result["rendered"] as string).length).toBeGreaterThan(0);
    expect(result["target_order"]).toEqual(["greet"]);
    expect(result["errors"]).toEqual([]);
  });

  it("surfaces parse/compile errors in the `errors` array (no throw) so cold authors can iterate", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "compile_skill", { source: TIER_1_FAILING_SKILL });
    expect(result["rendered"]).toBeNull();
    expect(Array.isArray(result["errors"])).toBe(true);
    expect((result["errors"] as string[]).length).toBeGreaterThan(0);
  });

  it("honors `inputs` overrides for declared `# Vars:`", async () => {
    const src = [
      "# Skill: greet",
      "# Vars: WHO=world",
      "# Status: Draft",
      "g:",
      "    emit(text=\"Hello $(WHO)\")",
      "default: g",
      "",
    ].join("\n");
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "compile_skill", { source: src, inputs: { WHO: "Perry" } });
    expect(result["errors"]).toEqual([]);
    const vars = result["resolved_variables"] as Record<string, string>;
    expect(vars["WHO"]).toBe("Perry");
    expect(result["rendered"]).toMatch(/Perry/);
  });

  it("compiles by stored skill name", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.skillStore.store("by-name", GOOD_SKILL);
    const result = await callTool(wired.mcpServer, "compile_skill", { name: "by-name" });
    expect(result["skill_name"]).toBe("hello-world");
    expect(result["errors"]).toEqual([]);
  });
});

describe("v0.2.3 — skill_write MCP tool", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v023-write-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes a clean skill and returns version + content_hash + Draft status", async () => {
    const { mcpServer, skillStore } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callTool(mcpServer, "skill_write", { name: "hello-world", source: GOOD_SKILL });
    expect(result["name"]).toBe("hello-world");
    expect(typeof result["version"]).toBe("string");
    expect(typeof result["content_hash"]).toBe("string");
    expect(result["status"]).toBe("Draft");
    // Confirm the skill landed in the store.
    const stored = await skillStore.metadata("hello-world");
    expect(stored.name).toBe("hello-world");
    expect(stored.status).toBe("Draft");
  });

  it("rejects overwrite of existing skill without overwrite=true", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.skillStore.store("existing", GOOD_SKILL);
    await expect(callTool(wired.mcpServer, "skill_write", { name: "existing", source: GOOD_SKILL }))
      .rejects.toThrow(/already exists.*overwrite/);
  });

  it("accepts overwrite=true to replace an existing skill", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.skillStore.store("existing", GOOD_SKILL);
    const result = await callTool(wired.mcpServer, "skill_write", { name: "existing", source: GOOD_SKILL, overwrite: true });
    expect(result["status"]).toBe("Draft");
  });

  it("rejects empty name or source", async () => {
    const { mcpServer } = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await expect(callTool(mcpServer, "skill_write", { name: "", source: GOOD_SKILL })).rejects.toThrow(/name.*required/i);
    await expect(callTool(mcpServer, "skill_write", { name: "x", source: "" })).rejects.toThrow(/source.*required/i);
  });
});

describe("v0.2.3 — cold-author lifecycle end-to-end", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skillscript-v023-lifecycle-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("lint → compile → write → status(Approved) → register_trigger flow succeeds for a clean skill", async () => {
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      trace: { mode: "on" },
    });

    // 1. Lint the draft body — cold author validates before commit.
    const lintResult = await callTool(wired.mcpServer, "lint_skill", { source: GOOD_SKILL });
    expect(lintResult["passes_tier_1"]).toBe(true);

    // 2. Compile to confirm the artifact looks right.
    const compileResult = await callTool(wired.mcpServer, "compile_skill", { source: GOOD_SKILL });
    expect(compileResult["errors"]).toEqual([]);
    expect(compileResult["skill_name"]).toBe("hello-world");

    // 3. Write to SkillStore (lands as Draft).
    const writeResult = await callTool(wired.mcpServer, "skill_write", { name: "hello-world", source: GOOD_SKILL });
    expect(writeResult["status"]).toBe("Draft");

    // 4. Transition to Approved via existing skill_status.
    const statusResult = await callTool(wired.mcpServer, "skill_status", { name: "hello-world", new_state: "Approved" });
    expect(statusResult["status"]).toBe("Approved");

    // 5. Register a trigger via existing register_trigger.
    const trigResult = await callTool(wired.mcpServer, "register_trigger", {
      skill_name: "hello-world",
      source: "cron",
      name: "* * * * *",
    });
    expect(trigResult["skillName"]).toBe("hello-world");
    expect(trigResult["source"]).toBe("cron");
  });
});
