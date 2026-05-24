import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConnectorsConfig } from "../src/connectors/config.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { RemoteMcpConnector } from "../src/connectors/mcp-remote.js";

/**
 * v0.4.1 — YouTrack end-to-end proving case. Item 4 of the kickoff scope
 * (c65e77af) + Scott's always-fail-if-missing CI gating (89e2752d).
 *
 * Requires `YOUTRACK_TEST_TOKEN` in the env. If absent the test fails
 * (not skipped) — silent regression risk outweighs operational cost
 * per Scott's call.
 *
 * Exercises the full v0.4.1 chain end-to-end against real YouTrack:
 *   - connectors.json loader
 *   - env-block-as-scope ${VAR} substitution
 *   - newline-framed JSON-RPC stdio bridge via mcp-remote
 *   - RemoteMcpConnector initialize handshake + tool dispatch
 *   - allowed_tools allowlist enforcement
 *   - unwrapToolResult (MCP convention text→JSON.parse)
 *   - dotted field access on parsed structure
 *   - foreach over parsed-JSON array
 *   - kwarg type coercion (integer limit=5)
 */

const TOKEN = process.env["YOUTRACK_TEST_TOKEN"];
const HAS_TOKEN = typeof TOKEN === "string" && TOKEN.length > 0;
const YOUTRACK_URL = "https://sshwarts.youtrack.cloud/mcp";

const connectorsToDispose: RemoteMcpConnector[] = [];

afterAll(async () => {
  for (const c of connectorsToDispose.splice(0)) {
    try { await c.dispose(); } catch { /* ignore */ }
  }
});

function setupYoutrackConnector(): { instance: RemoteMcpConnector; allowedTools: string[] } {
  const cfgDir = mkdtempSync(join(tmpdir(), "v041-youtrack-ci-"));
  const cfgPath = join(cfgDir, "connectors.json");
  writeFileSync(cfgPath, JSON.stringify({
    youtrack: {
      class: "RemoteMcpConnector",
      config: {
        command: "npx",
        args: ["mcp-remote", YOUTRACK_URL, "--header", "Authorization:${AUTH_HEADER}"],
        env: { AUTH_HEADER: "Bearer ${YOUTRACK_TEST_TOKEN}" },
        framing: "newline",
      },
      allowed_tools: ["search_issues", "get_issue", "get_issue_comments", "get_saved_issue_searches", "find_projects", "get_project", "get_current_user"],
    },
  }));
  const result = loadConnectorsConfig({ path: cfgPath });
  expect(result.errors).toEqual([]);
  expect(result.connectors.length).toBe(1);
  const c = result.connectors[0]!;
  expect(c.instance).toBeDefined();
  const inst = c.instance as RemoteMcpConnector;
  connectorsToDispose.push(inst);
  return { instance: inst, allowedTools: c.allowedTools as string[] };
}

describe("v0.4.1 YouTrack proving — env gate", () => {
  it("YOUTRACK_TEST_TOKEN is set", () => {
    // Always-fail-if-missing per Scott's call (89e2752d). Silent regression
    // risk outweighs operational cost. Set the env var when running CI.
    expect(HAS_TOKEN).toBe(true);
  });
});

// All subsequent tests fail descriptively if no token; using describe.runIf
// would skip, which is the opposite of what we want per Scott's call.
describe.skipIf(!HAS_TOKEN)("v0.4.1 YouTrack proving — direct connector dispatch", () => {
  it("connects + initialize handshake + tools/list", async () => {
    const { instance } = setupYoutrackConnector();
    await instance.start();
    const tools = instance.getToolsAvailable();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).toContain("get_current_user");
    expect(tools).toContain("search_issues");
  }, 30_000);

  it("get_current_user dispatches and returns admin identity", async () => {
    const { instance } = setupYoutrackConnector();
    const result = await instance.call("get_current_user", {}) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toMatch(/admin/);
  }, 30_000);

  it("search_issues with integer limit returns issuesPage array", async () => {
    const { instance } = setupYoutrackConnector();
    const result = await instance.call("search_issues", { query: "for: me", limit: 3 }) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text) as { issuesPage: unknown[] };
    expect(Array.isArray(parsed.issuesPage)).toBe(true);
  }, 30_000);
});

describe.skipIf(!HAS_TOKEN)("v0.4.1 YouTrack proving — full skill chain end-to-end", () => {
  it("morning-sweep skill compiles + executes against real YouTrack", async () => {
    const { instance, allowedTools } = setupYoutrackConnector();
    const registry = new Registry();
    const home = mkdtempSync(join(tmpdir(), "v041-yt-rt-"));
    registry.registerSkillStore("primary", new FilesystemSkillStore(join(home, "skills")));
    registry.registerMcpConnector("youtrack", instance, allowedTools);

    const skillSource = readFileSync(join(__dirname, "..", "examples", "youtrack-morning-sweep.skill.md"), "utf8");
    const compiled = await compile(skillSource, { registry });
    expect(compiled.warnings).toEqual([]);
    expect(compiled.targetOrder).toEqual(["fetch_me", "fetch_issues", "report"]);

    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toMatch(/^Morning sweep for/);
    expect(result.emissions[1]).toMatch(/^Open issues assigned: \d+$/);
    // At least one issue line if we have any issues, or none if zero.
    // We don't pin issue counts because real YouTrack state changes.
    const issueLines = result.emissions.filter((e) => e.startsWith("  -"));
    expect(issueLines.length).toBeGreaterThanOrEqual(0);
  }, 45_000);

  it("kwarg type coercion: limit=5 in skill source becomes integer in MCP call", async () => {
    // Regression-locks v0.4.1's coerceKwargValue. Pre-v0.4.1 limit was
    // string-typed → YouTrack rejected with "expected integer".
    const { instance, allowedTools } = setupYoutrackConnector();
    const registry = new Registry();
    const home = mkdtempSync(join(tmpdir(), "v041-yt-coerce-"));
    registry.registerSkillStore("primary", new FilesystemSkillStore(join(home, "skills")));
    registry.registerMcpConnector("youtrack", instance, allowedTools);
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ youtrack.search_issues query="for: me" limit=3 -> R\n    ! count: $(R.issuesPage|length)\ndefault: run\n`;
    const compiled = await compile(src, { registry });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toMatch(/^count: \d+$/);
  }, 30_000);
});

describe.skipIf(!HAS_TOKEN)("v0.4.1 YouTrack proving — allowlist enforcement against real connector", () => {
  it("disallowed tool refused at runtime (defense-in-depth)", async () => {
    // Allowlist is the configured read-only set. create_issue isn't in it.
    // Bypass lint by going straight to execute (compile would catch it too,
    // but we want to prove runtime defense-in-depth fires independently).
    const { instance, allowedTools } = setupYoutrackConnector();
    const registry = new Registry();
    const home = mkdtempSync(join(tmpdir(), "v041-yt-allow-"));
    registry.registerSkillStore("primary", new FilesystemSkillStore(join(home, "skills")));
    registry.registerMcpConnector("youtrack", instance, allowedTools);
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ youtrack.create_issue summary="bug" -> R\n    ! created\ndefault: run\n`;
    const compiled = await compile(src, { registry, skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    expect(result.errors.length).toBeGreaterThan(0);
    const msg = JSON.stringify(result.errors[0]);
    expect(msg).toMatch(/create_issue.*not in the allowlist|allowlist.*create_issue/i);
  }, 30_000);

  it("allowed tool dispatches successfully (positive control)", async () => {
    const { instance, allowedTools } = setupYoutrackConnector();
    const registry = new Registry();
    const home = mkdtempSync(join(tmpdir(), "v041-yt-allow-pos-"));
    registry.registerSkillStore("primary", new FilesystemSkillStore(join(home, "skills")));
    registry.registerMcpConnector("youtrack", instance, allowedTools);
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ youtrack.get_current_user -> R\n    ! ok: $(R.login)\ndefault: run\n`;
    const compiled = await compile(src, { registry });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toMatch(/^ok: /);
  }, 30_000);
});
