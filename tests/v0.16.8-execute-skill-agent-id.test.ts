import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";

/**
 * v0.16.8 — `execute_skill` MCP entry threads `meta.author` into
 * `ExecuteContext.agentId`, which runtime threads to `McpDispatchCtx`
 * at connector dispatch time.
 *
 * Class-sibling to v0.15.4 `enableUnsafeShell-in-ctx` (Perry's
 * `adf47c0b`) and the v0.16 series discipline-only-contracts closures:
 * a feature surface that was wired at the contract layer (`ctx.agentId`
 * field has existed on ExecuteContext) but never populated at the entry
 * point, so dispatch silently fell through to runtime identity.
 *
 * v0.16.8 ships the population. End-to-end propagation through a substrate
 * with per-pinned sessions still needs v0.16.9's per-identity-sessions
 * work (per warm-agent's `1e1c9305` session-pinning finding).
 */

const SAMPLE_SKILL = (name: string, author?: string): string => {
  const lines = [
    `# Skill: ${name}`,
    "# Status: Approved",
    "run:",
    `    $ probe ping=1`,
    "default: run",
  ];
  if (author !== undefined) {
    // Not in body — author lands via SkillStore metadata. Body unchanged.
  }
  return lines.join("\n") + "\n";
};

describe("v0.16.8 — execute_skill MCP entry populates ctx.agentId from SkillMeta.author", () => {
  it("named-skill dispatch carries skill author through to connector ctx", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0168-agentid-named-"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });
    // Capture the dispatch ctx the probe connector receives.
    let receivedCtx: { agentId?: string; isAdmin?: boolean } | undefined;
    wired.registry.registerMcpConnector("probe", new CallbackMcpConnector(async (_tool, _args, ctx) => {
      receivedCtx = ctx;
      return { ok: true };
    }));

    // Store the skill with author=alice via the SkillStore directly.
    await wired.skillStore.store("agent-id-probe", SAMPLE_SKILL("agent-id-probe"), { author: "alice" });

    // Invoke execute_skill via the MCP tool surface (the path that builds
    // ExecuteContext at line ~599 of mcp-server.ts).
    const resp = await wired.mcpServer.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "execute_skill", arguments: { skill_name: "agent-id-probe" } },
    });
    const r = resp as { result: { content: Array<{ text: string }> }; error?: unknown };
    expect(r.error).toBeUndefined();
    expect(receivedCtx?.agentId).toBe("alice");
  });

  it("source-form execute_skill (no SkillStore lookup possible) → ctx.agentId stays undefined", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0168-agentid-source-"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });
    let receivedCtx: { agentId?: string; isAdmin?: boolean } | undefined;
    wired.registry.registerMcpConnector("probe", new CallbackMcpConnector(async (_tool, _args, ctx) => {
      receivedCtx = ctx;
      return { ok: true };
    }));

    // No store() — execute via source. SkillStore can't be consulted; agentId
    // stays undefined. The caller is responsible for supplying it via other
    // ExecuteContext paths if needed (v0.16.9+ work).
    const sourceBody = SAMPLE_SKILL("inline-probe");
    const resp = await wired.mcpServer.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "execute_skill", arguments: { source: sourceBody } },
    });
    const r = resp as { result: { content: Array<{ text: string }> }; error?: unknown };
    expect(r.error).toBeUndefined();
    expect(receivedCtx?.agentId).toBeUndefined();
  });

  it("skill with no author metadata (legacy/pre-v0.16.8 storage) → ctx.agentId stays undefined", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0168-agentid-legacy-"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });
    let receivedCtx: { agentId?: string; isAdmin?: boolean } | undefined;
    wired.registry.registerMcpConnector("probe", new CallbackMcpConnector(async (_tool, _args, ctx) => {
      receivedCtx = ctx;
      return { ok: true };
    }));

    // Simulate legacy storage: write the skill file directly without going
    // through store() — no versions log, so meta.author resolves to undefined.
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "skills"), { recursive: true });
    await writeFile(join(home, "skills", "legacy-skill.skill.md"), SAMPLE_SKILL("legacy-skill"), "utf8");

    const resp = await wired.mcpServer.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "execute_skill", arguments: { skill_name: "legacy-skill" } },
    });
    const r = resp as { result: { content: Array<{ text: string }> }; error?: unknown };
    expect(r.error).toBeUndefined();
    expect(receivedCtx?.agentId).toBeUndefined();
  });
});
