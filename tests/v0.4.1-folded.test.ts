import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGitignoreRisk, loadConnectorsConfig } from "../src/connectors/config.js";
import { bootstrap } from "../src/bootstrap.js";
import { evalCondition } from "../src/runtime.js";
import { execute } from "../src/runtime.js";
import { compile } from "../src/compile.js";
import { Registry } from "../src/connectors/registry.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";

/**
 * v0.4.1 — folded items (Scott's `89e2752d` answers):
 *   - Item 6: loader-time gitignore-detection warning
 *   - Item 7: unknown-connector lint auto-wiring from runtime registry
 *   - Item 8: foreach over parsed-JSON arrays
 */

describe("v0.4.1 item 8 — foreach over parsed-JSON arrays", () => {
  it("foreach over a $ json_parse-bound array iterates the parsed array", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: RAW=[10,20,30]\nrun:\n    $ json_parse $(RAW) -> P\n    foreach I in $(P):\n        ! item: $(I)\ndefault: run\n`;
    const home = mkdtempSync(join(tmpdir(), "v041-fe-jp-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["item: 10", "item: 20", "item: 30"]);
  });

  it("foreach over a string-typed Var that's JSON-string of an array iterates correctly (v0.2.5 in-RHS tolerance mirror)", async () => {
    // Pre-v0.4.1: RAW resolves to the JSON string "[1,2,3]" — foreach
    // wraps as [val] (single-element array of the string).
    // Post-v0.4.1: foreach tries JSON.parse on string-typed values and
    // uses the parsed array if successful.
    const src = `# Skill: t\n# Status: Approved\n# Vars: RAW=[1,2,3]\nrun:\n    foreach I in $(RAW):\n        ! item: $(I)\ndefault: run\n`;
    const home = mkdtempSync(join(tmpdir(), "v041-fe-str-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["item: 1", "item: 2", "item: 3"]);
  });

  it("regression: foreach over a literal list expression still works", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    foreach I in [a, b, c]:\n        ! got $(I)\ndefault: run\n`;
    const home = mkdtempSync(join(tmpdir(), "v041-fe-lit-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["got a", "got b", "got c"]);
  });

  it("regression: foreach over non-JSON-parseable string still wraps as [val]", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: X=hello\nrun:\n    foreach I in $(X):\n        ! got $(I)\ndefault: run\n`;
    const home = mkdtempSync(join(tmpdir(), "v041-fe-bare-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["got hello"]);
  });
});

describe("v0.4.1 item 7 — unknown-connector lint auto-wires from runtime registry", () => {
  it("MCP lint_skill picks up registry-wired connectors by default", async () => {
    const home = mkdtempSync(join(tmpdir(), "v041-lint-aw-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerMcpConnector("known", new CallbackMcpConnector(async () => ({})));

    // Skill references an UNKNOWN connector — runtime knows about "known"
    // but not "unknown_conn"; lint_skill should now fire unknown-connector
    // automatically (pre-v0.4.1 was silent because mcpConnectorNames wasn't auto-derived).
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ unknown_conn.do_thing -> R\n    ! $(R)\ndefault: run\n`;
    const resp = await wired.mcpServer.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "lint_skill", arguments: { source: src } },
    });
    const r = resp as { result: { content: Array<{ text: string }> } };
    const data = JSON.parse(r.result.content[0]!.text) as {
      diagnostics: Array<{ rule: string; message: string }>;
    };
    const finding = data.diagnostics.find((d) => d.rule === "unknown-connector");
    expect(finding).toBeDefined();
    expect(finding!.message).toMatch(/unknown connector 'unknown_conn'/);
    expect(finding!.message).toMatch(/Wired connectors: known/);
  });

  it("compile_skill preflight uses registry for disallowed-tool detection", async () => {
    const home = mkdtempSync(join(tmpdir(), "v041-cmp-aw-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerMcpConnector(
      "tooler",
      new CallbackMcpConnector(async () => ({})),
      ["safe_tool"],
    );

    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ tooler.disallowed_one -> R\n    ! $(R)\ndefault: run\n`;
    const resp = await wired.mcpServer.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "compile_skill", arguments: { source: src } },
    });
    const r = resp as { result: { content: Array<{ text: string }> } };
    const data = JSON.parse(r.result.content[0]!.text) as {
      errors: string[];
      lint_findings?: Array<{ rule: string }>;
    };
    // Compile fails tier-1 because disallowed-tool fired.
    expect(data.errors.length).toBeGreaterThan(0);
    const lintFinding = data.lint_findings?.find((d) => d.rule === "disallowed-tool");
    expect(lintFinding).toBeDefined();
  });
});

describe("v0.4.1 item 6 — gitignore-detection warning", () => {
  it("detectGitignoreRisk returns null when configPath is not in a git repo", () => {
    // tmpdir locations are typically not in a git repo
    const dir = mkdtempSync(join(tmpdir(), "v041-gi-nogit-"));
    const cfg = join(dir, "connectors.json");
    writeFileSync(cfg, "{}");
    expect(detectGitignoreRisk(cfg)).toBeNull();
  });

  it("detectGitignoreRisk returns warning when in git repo without .gitignore entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "v041-gi-warn-"));
    // Simulate a git repo by creating an empty .git directory
    mkdirSync(join(dir, ".git"));
    const cfg = join(dir, "connectors.json");
    writeFileSync(cfg, "{}");
    const warning = detectGitignoreRisk(cfg);
    expect(warning).not.toBeNull();
    expect(warning).toMatch(/git-tracked directory/);
  });

  it("detectGitignoreRisk returns null when .gitignore has explicit /connectors.json entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "v041-gi-ok-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "/connectors.json\n");
    const cfg = join(dir, "connectors.json");
    writeFileSync(cfg, "{}");
    expect(detectGitignoreRisk(cfg)).toBeNull();
  });

  it("detectGitignoreRisk returns null when .gitignore has bare connectors.json entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "v041-gi-bare-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\nconnectors.json\n*.log\n");
    const cfg = join(dir, "connectors.json");
    writeFileSync(cfg, "{}");
    expect(detectGitignoreRisk(cfg)).toBeNull();
  });

  it("detectGitignoreRisk handles wildcard *.json gracefully (treats as covered)", () => {
    const dir = mkdtempSync(join(tmpdir(), "v041-gi-star-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "*.json\n");
    const cfg = join(dir, "connectors.json");
    writeFileSync(cfg, "{}");
    expect(detectGitignoreRisk(cfg)).toBeNull();
  });

  it("bootstrap emits gitignore warning to stderr when risk detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "v041-gi-boot-"));
    mkdirSync(join(dir, ".git"));
    const cfg = join(dir, "connectors.json");
    writeFileSync(cfg, "{}");

    // Capture stderr writes
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (chunk: string) => boolean) = (chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    };
    try {
      bootstrap({
        skillsDir: join(dir, "skills"),
        traceDir: join(dir, "traces"),
        connectorsConfigPath: cfg,
      });
    } finally {
      process.stderr.write = origWrite;
    }
    const combined = stderrChunks.join("");
    expect(combined).toMatch(/git-tracked directory/);
  });
});
