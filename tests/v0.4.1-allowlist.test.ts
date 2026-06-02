import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConnectorsConfig } from "../src/connectors/config.js";
import { Registry } from "../src/connectors/registry.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";
import { lint } from "../src/lint.js";
import { execute } from "../src/runtime.js";
import { compile } from "../src/compile.js";
import { bootstrap } from "../src/bootstrap.js";

/**
 * v0.4.1 — per-connector `allowed_tools` allowlist. Item 3 in the
 * kickoff scope; spec at `8a7356dc`. Tests cover loader parsing,
 * Registry storage, `disallowed-tool` lint, runtime defense-in-depth,
 * and runtime_capabilities discovery surface.
 */

function tmpCfg(content: object): string {
  const dir = mkdtempSync(join(tmpdir(), "v041-allow-"));
  const path = join(dir, "connectors.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe("v0.4.1 — loadConnectorsConfig allowed_tools parsing", () => {
  it("allowed_tools array of strings populates ConfiguredConnector.allowedTools", () => {
    // Use a stub instance via the loader's `CallbackMcpConnector` known-class
    // path; that class doesn't have a fromConfig so it errors — but the
    // allowed_tools parsing happens BEFORE the fromConfig check fails on
    // a different path. To test the field's parsing cleanly, use the
    // RemoteMcpConnector class (which does instantiate, but we don't
    // start it — fromConfig is sync validation only).
    const cfg = tmpCfg({
      x: {
        class: "RemoteMcpConnector",
        config: { command: "node", args: ["-e", "process.exit(0)"] },
        allowed_tools: ["a", "b", "c"],
      },
    });
    const result = loadConnectorsConfig({ path: cfg });
    expect(result.errors).toEqual([]);
    expect(result.connectors[0]!.allowedTools).toEqual(["a", "b", "c"]);
  });

  it("unspecified allowed_tools → connector.allowedTools is undefined (allow-all semantics)", () => {
    const cfg = tmpCfg({
      x: {
        class: "RemoteMcpConnector",
        config: { command: "node", args: ["-e", "process.exit(0)"] },
      },
    });
    const result = loadConnectorsConfig({ path: cfg });
    expect(result.connectors[0]!.allowedTools).toBeUndefined();
  });

  it("empty array allowed_tools → connector.allowedTools is [] (allow-none)", () => {
    const cfg = tmpCfg({
      x: {
        class: "RemoteMcpConnector",
        config: { command: "node", args: ["-e", "process.exit(0)"] },
        allowed_tools: [],
      },
    });
    const result = loadConnectorsConfig({ path: cfg });
    expect(result.connectors[0]!.allowedTools).toEqual([]);
  });

  it("non-array allowed_tools → clear error", () => {
    const cfg = tmpCfg({
      x: { class: "RemoteMcpConnector", config: { command: "node", args: [] }, allowed_tools: "bogus" },
    });
    const result = loadConnectorsConfig({ path: cfg });
    expect(result.errors[0]).toMatch(/allowed_tools' must be an array of strings/);
  });

  it("array with non-string element → clear error", () => {
    const cfg = tmpCfg({
      x: { class: "RemoteMcpConnector", config: { command: "node", args: [] }, allowed_tools: ["a", 42] },
    });
    const result = loadConnectorsConfig({ path: cfg });
    expect(result.errors[0]).toMatch(/allowed_tools' must be an array of strings/);
  });
});

describe("v0.4.1 — Registry stores + exposes allowedTools", () => {
  it("registerMcpConnector with allowedTools stores them", () => {
    const reg = new Registry();
    reg.registerMcpConnector("x", new CallbackMcpConnector(async () => ({})), ["search", "get"]);
    expect(reg.getMcpConnectorAllowedTools("x")).toEqual(["search", "get"]);
    expect(reg.isToolAllowed("x", "search")).toBe(true);
    expect(reg.isToolAllowed("x", "create")).toBe(false);
  });

  it("registerMcpConnector without allowedTools → undefined (allow-all)", () => {
    const reg = new Registry();
    reg.registerMcpConnector("y", new CallbackMcpConnector(async () => ({})));
    expect(reg.getMcpConnectorAllowedTools("y")).toBeUndefined();
    expect(reg.isToolAllowed("y", "anything")).toBe(true);
  });

  it("registerMcpConnector with [] → allow-none", () => {
    const reg = new Registry();
    reg.registerMcpConnector("z", new CallbackMcpConnector(async () => ({})), []);
    expect(reg.getMcpConnectorAllowedTools("z")).toEqual([]);
    expect(reg.isToolAllowed("z", "anything")).toBe(false);
  });

  it("listMcpConnectors surfaces allowedTools", () => {
    const reg = new Registry();
    reg.registerMcpConnector("a", new CallbackMcpConnector(async () => ({})), ["t1"]);
    reg.registerMcpConnector("b", new CallbackMcpConnector(async () => ({})));
    const entries = reg.listMcpConnectors();
    const a = entries.find((e) => e.name === "a")!;
    const b = entries.find((e) => e.name === "b")!;
    expect(a.allowedTools).toEqual(["t1"]);
    expect(b.allowedTools).toBeUndefined();
  });
});

describe("v0.4.1 — disallowed-tool lint", () => {
  it("fires tier-1 on $ name.tool where tool is not in allowlist", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ youtrack.create_issue summary="bug" -> R\n    emit(text="$(R)")\ndefault: run\n`;
    const r = await lint(src, {
      mcpConnectorNames: ["youtrack"],
      mcpConnectorAllowedTools: new Map([["youtrack", ["search_issues", "get_issue"]]]),
    });
    const finding = r.findings.find((f) => f.rule === "disallowed-tool");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("error");
    expect(finding!.message).toMatch(/create_issue/);
    expect(finding!.message).toMatch(/search_issues, get_issue/);
  });

  it("does not fire when tool IS in allowlist", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ youtrack.search_issues query="for: me" -> R\n    emit(text="$(R)")\ndefault: run\n`;
    const r = await lint(src, {
      mcpConnectorNames: ["youtrack"],
      mcpConnectorAllowedTools: new Map([["youtrack", ["search_issues"]]]),
    });
    const finding = r.findings.find((f) => f.rule === "disallowed-tool");
    expect(finding).toBeUndefined();
  });

  it("does not fire when no allowlist configured (allow-all)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ youtrack.create_issue summary="bug" -> R\n    emit(text="$(R)")\ndefault: run\n`;
    const r = await lint(src, {
      mcpConnectorNames: ["youtrack"],
      // No mcpConnectorAllowedTools entry for youtrack → allow-all.
    });
    const finding = r.findings.find((f) => f.rule === "disallowed-tool");
    expect(finding).toBeUndefined();
  });

  it("empty allowlist [] → ALL tools disallowed", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ youtrack.search_issues query="x" -> R\n    emit(text="$(R)")\ndefault: run\n`;
    const r = await lint(src, {
      mcpConnectorNames: ["youtrack"],
      mcpConnectorAllowedTools: new Map([["youtrack", []]]),
    });
    const finding = r.findings.find((f) => f.rule === "disallowed-tool");
    expect(finding).toBeDefined();
    expect(finding!.message).toMatch(/Allowlist is empty/);
  });

  it("derives allowedTools from Registry when only registry is passed", async () => {
    const registry = new Registry();
    registry.registerMcpConnector("youtrack", new CallbackMcpConnector(async () => ({})), ["search_issues"]);
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ youtrack.create_issue summary="x" -> R\n    emit(text="$(R)")\ndefault: run\n`;
    const r = await lint(src, { registry });
    const finding = r.findings.find((f) => f.rule === "disallowed-tool");
    expect(finding).toBeDefined();
  });
});

describe("v0.4.1 — runtime defense-in-depth allowlist enforcement", () => {
  it("execute throws OpError when dispatching a disallowed tool", async () => {
    // Set up registry with allowlist
    const home = mkdtempSync(join(tmpdir(), "v041-rt-allow-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerMcpConnector(
      "tooler",
      new CallbackMcpConnector(async (toolName) => ({ content: { called: toolName } })),
      ["safe_tool"],
    );

    // Skill calls disallowed_tool — should fail at runtime even though
    // we bypass lint by going straight to execute.
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ tooler.disallowed_tool -> R\n    emit(text="got $(R)")\ndefault: run\n`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors.length).toBeGreaterThan(0);
    const msg = JSON.stringify(result.errors[0]);
    expect(msg).toMatch(/disallowed_tool.*not in the allowlist|allowlist.*disallowed_tool/i);
  });

  it("execute allows the tool when in allowlist", async () => {
    const home = mkdtempSync(join(tmpdir(), "v041-rt-allow-ok-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerMcpConnector(
      "tooler",
      new CallbackMcpConnector(async (toolName) => ({ called: toolName })),
      ["safe_tool"],
    );
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ tooler.safe_tool -> R\n    emit(text="got safe")\ndefault: run\n`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toContain("got safe");
  });
});

describe("v0.4.1 — runtime_capabilities surfaces allowed_tools", () => {
  it("mcpConnectors entries include allowed_tools (or null for allow-all)", async () => {
    const home = mkdtempSync(join(tmpdir(), "v041-rc-allow-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerMcpConnector("locked", new CallbackMcpConnector(async () => ({})), ["read_only"]);
    wired.registry.registerMcpConnector("open", new CallbackMcpConnector(async () => ({})));

    const resp = await wired.mcpServer.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "runtime_capabilities", arguments: { include: ["mcpConnectors"] } },
    });
    const r = resp as { result: { content: Array<{ text: string }> } };
    const data = JSON.parse(r.result.content[0]!.text) as { mcpConnectors: Array<{ name: string; allowed_tools: string[] | null }> };

    const locked = data.mcpConnectors.find((c) => c.name === "locked")!;
    const open = data.mcpConnectors.find((c) => c.name === "open")!;
    expect(locked.allowed_tools).toEqual(["read_only"]);
    expect(open.allowed_tools).toBeNull();
  });
});
