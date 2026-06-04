import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { loadSkillscriptConfig } from "../src/runtime-config.js";
import type { JsonRpcRequest } from "../src/mcp-server.js";

/**
 * v0.17.4 — `forceAlwaysDraft` wiring through `BootstrapOpts` +
 * `SkillscriptConfig`.
 *
 * The policy itself (rewriting body to Draft before persist) shipped
 * in v0.16.8 inside McpServer. This ring wires the adopter surfaces:
 * - `bootstrap({ forceAlwaysDraft: true })` — programmatic
 * - `{ "forceAlwaysDraft": true }` in `skillscript.config.json`
 * - `SKILLSCRIPT_FORCE_ALWAYS_DRAFT=true` env var (CLI-level cascade)
 *
 * This test file validates the bootstrap surface + SkillscriptConfig
 * parse. The env-var cascade lives in CLI; tested separately when
 * the CLI surface accumulates env-cascade test coverage.
 */

const APPROVED_SKILL = `# Skill: probe
# Status: Approved

t:
    emit(text="hi")
default: t
`;

async function callSkillWrite(mcpServer: import("../src/mcp-server.js").McpServer, name: string, source: string): Promise<Record<string, unknown>> {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "skill_write", arguments: { name, source } },
  };
  const resp = await mcpServer.handle(req);
  if ("error" in resp) throw new Error(`MCP error: ${JSON.stringify(resp.error)}`);
  const content = resp.result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

describe("v0.17.4 — forceAlwaysDraft wiring through BootstrapOpts", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0174-fad-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("default (flag unset) — Approved body lands Approved (v0.9.1 self-approval preserved)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const result = await callSkillWrite(wired.mcpServer, "probe", APPROVED_SKILL);
    expect(result["status"]).toBe("Approved");
  });

  it("forceAlwaysDraft: true — Approved body forced to Draft (human-promotion posture)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces"), forceAlwaysDraft: true });
    const result = await callSkillWrite(wired.mcpServer, "probe", APPROVED_SKILL);
    expect(result["status"]).toBe("Draft");
  });

  it("forceAlwaysDraft: false — explicit-false equivalent to unset (default behavior)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces"), forceAlwaysDraft: false });
    const result = await callSkillWrite(wired.mcpServer, "probe", APPROVED_SKILL);
    expect(result["status"]).toBe("Approved");
  });
});

describe("v0.17.4 — forceAlwaysDraft via skillscript.config.json", () => {
  let home: string;
  let configPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0174-fad-cfg-"));
    configPath = join(home, "skillscript.config.json");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("parses { forceAlwaysDraft: true } from skillscript.config.json", () => {
    writeFileSync(configPath, JSON.stringify({ forceAlwaysDraft: true }));
    const { config, errors } = loadSkillscriptConfig({ path: configPath });
    expect(errors).toEqual([]);
    expect(config.forceAlwaysDraft).toBe(true);
  });

  it("parses { forceAlwaysDraft: false } correctly (explicit-false honored)", () => {
    writeFileSync(configPath, JSON.stringify({ forceAlwaysDraft: false }));
    const { config, errors } = loadSkillscriptConfig({ path: configPath });
    expect(errors).toEqual([]);
    expect(config.forceAlwaysDraft).toBe(false);
  });

  it("absent field — config.forceAlwaysDraft is undefined (no default applied at parse layer)", () => {
    writeFileSync(configPath, JSON.stringify({}));
    const { config, errors } = loadSkillscriptConfig({ path: configPath });
    expect(errors).toEqual([]);
    expect(config.forceAlwaysDraft).toBeUndefined();
  });

  it("non-boolean value rejected at parse time", () => {
    writeFileSync(configPath, JSON.stringify({ forceAlwaysDraft: "true" }));
    const { errors } = loadSkillscriptConfig({ path: configPath });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/forceAlwaysDraft.*must be a boolean/);
  });

  it("loaded config piped into bootstrap activates the rewrite", async () => {
    writeFileSync(configPath, JSON.stringify({ forceAlwaysDraft: true }));
    const { config } = loadSkillscriptConfig({ path: configPath });
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      ...(config.forceAlwaysDraft !== undefined ? { forceAlwaysDraft: config.forceAlwaysDraft } : {}),
    });
    const result = await callSkillWrite(wired.mcpServer, "probe", APPROVED_SKILL);
    expect(result["status"]).toBe("Draft");
  });
});
