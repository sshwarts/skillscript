import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { McpServer } from "../src/mcp-server.js";

/**
 * v0.16.8 — `McpServerDeps.forceAlwaysDraft` flag (Perry's `787b6b95` Option A).
 *
 * Stricter approval posture: every outside-MCP `skill_write` lands as Draft
 * regardless of body declaration. Adopters wanting "every skill needs explicit
 * human promotion" opt in via this flag at runtime startup.
 *
 * Default (false) preserves the v0.9.1 auto-stamp behavior. The in-skill
 * bridge dispatch (`SkillStoreMcpConnector`) is Draft-by-default regardless —
 * that's the separate v0.15.0 trust boundary, unaffected by this flag.
 */

const APPROVED_SKILL = `# Skill: posture-probe
# Status: Approved
t:
    emit(text="probe")
default: t
`;

describe("v0.16.8 — forceAlwaysDraft posture flag", () => {
  it("default (false) preserves auto-stamp behavior — Approved body persists as Approved", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0168-posture-default-"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });
    const resp = await wired.mcpServer.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "skill_write", arguments: { name: "default-posture", source: APPROVED_SKILL } },
    });
    const r = resp as { result: { content: Array<{ text: string }> }; error?: unknown };
    expect(r.error).toBeUndefined();
    const result = JSON.parse(r.result.content[0]!.text) as { status: string };
    expect(result.status).toBe("Approved");
  });

  it("forceAlwaysDraft: true → body says Approved but stored as Draft", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0168-posture-strict-"));
    // bootstrap doesn't wire forceAlwaysDraft directly; instantiate McpServer
    // with the flag set so the test mirrors how adopters configure it.
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });
    const strictMcp = new McpServer({
      skillStore: wired.skillStore,
      scheduler: wired.scheduler,
      traceStore: wired.traceStore,
      registry: wired.registry,
      forceAlwaysDraft: true,
    });
    const resp = await strictMcp.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "skill_write", arguments: { name: "strict-posture", source: APPROVED_SKILL } },
    });
    const r = resp as { result: { content: Array<{ text: string }> }; error?: unknown };
    expect(r.error).toBeUndefined();
    const result = JSON.parse(r.result.content[0]!.text) as { status: string };
    expect(result.status).toBe("Draft");
  });

  it("forceAlwaysDraft rewrites the body's Status header to Draft (body + persisted state agree)", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0168-posture-body-"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });
    const strictMcp = new McpServer({
      skillStore: wired.skillStore,
      scheduler: wired.scheduler,
      traceStore: wired.traceStore,
      registry: wired.registry,
      forceAlwaysDraft: true,
    });
    await strictMcp.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "skill_write", arguments: { name: "body-rewrite", source: APPROVED_SKILL } },
    });
    // Read the stored body back. Status header should be Draft, not Approved.
    const stored = await wired.skillStore.load("body-rewrite");
    expect(stored.source).toContain("# Status: Draft");
    expect(stored.source).not.toContain("# Status: Approved");
  });

  it("forceAlwaysDraft is independent of the in-skill bridge Draft-by-default (v0.15.0)", async () => {
    // Sanity check: even with forceAlwaysDraft=false (default), the bridge
    // (`SkillStoreMcpConnector`) still forces Draft on in-skill writes. This
    // test just confirms the two trust boundaries are distinct.
    const home = mkdtempSync(join(tmpdir(), "v0168-posture-bridge-"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });
    // bootstrap auto-wires SkillStoreMcpConnector as `skill_write` bridge
    // (v0.15.0). Adopter using bootstrap() gets Draft-by-default for in-skill
    // dispatch regardless of forceAlwaysDraft setting at the MCP server.
    expect(wired.registry.hasMcpConnector("skill_write")).toBe(true);
  });

  it("forceAlwaysDraft has no effect on Draft bodies (they were already Draft)", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0168-posture-draft-"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });
    const strictMcp = new McpServer({
      skillStore: wired.skillStore,
      scheduler: wired.scheduler,
      traceStore: wired.traceStore,
      registry: wired.registry,
      forceAlwaysDraft: true,
    });
    const draftSkill = APPROVED_SKILL.replace("# Status: Approved", "# Status: Draft");
    const resp = await strictMcp.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "skill_write", arguments: { name: "already-draft", source: draftSkill } },
    });
    const r = resp as { result: { content: Array<{ text: string }> } };
    const result = JSON.parse(r.result.content[0]!.text) as { status: string };
    expect(result.status).toBe("Draft");
  });
});
