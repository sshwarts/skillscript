import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/parser.js";
import { lint } from "../src/lint.js";
import { bootstrap } from "../src/bootstrap.js";
import type { JsonRpcRequest, JsonRpcResponse, McpServer } from "../src/mcp-server.js";

/**
 * v0.17.3 — `# Returns:` frontmatter declares the export surface for
 * `execute_skill` composition.
 *
 * Closes Perry's `1ea3d625` Finding 2 (execute_skill leaks full child
 * final_vars into parent — 252KB MCP-response blowup on a 2-line emit).
 * Substrate-author's `6fb6ac1c` empirical pre-flight (0/16 skills reach
 * `${R.final_vars.X}`) confirmed the migration-free cut: default
 * exports outputs + transcript + metadata only; declared returns opt
 * in to additional final_vars surface.
 *
 * Three-test discipline per `feedback_three_test_discipline_per_dispatch_shape`:
 *  - Parser: # Returns: header parses; rejects defaults; reserved-name checks
 *  - Runtime: filterFinalVarsByReturns at composition boundary
 *  - Lint: unknown-returns-ref tier-1
 *  - E2E: declared Returns flow through MCP wire; undeclared scratch filtered
 */

const HEAD = `# Skill: probe\n# Status: Draft\n`;
const BODY = `\nt:\n    emit(text="probe")\ndefault: t\n`;

function parseReturnsLine(returnsLine: string): { returns: string[]; parseErrors: string[] } {
  const source = `${HEAD}# Returns: ${returnsLine}${BODY}`;
  const parsed = parse(source);
  return { returns: parsed.returns, parseErrors: parsed.parseErrors };
}

describe("v0.17.3 — `# Returns:` parser", () => {
  it("parses a single-name returns declaration", () => {
    expect(parseReturnsLine("RESULT").returns).toEqual(["RESULT"]);
  });

  it("parses comma-separated names", () => {
    expect(parseReturnsLine("SUMMARY, TEMP_F, CONDITIONS").returns).toEqual(["SUMMARY", "TEMP_F", "CONDITIONS"]);
  });

  it("treats `(none)` as empty (explicit no-exports declaration)", () => {
    expect(parseReturnsLine("(none)").returns).toEqual([]);
  });

  it("missing header defaults to empty returns (default-export-outputs-only)", () => {
    const source = `${HEAD}${BODY}`;
    const parsed = parse(source);
    expect(parsed.returns).toEqual([]);
  });

  it("rejects defaults in returns declarations (use # Vars: for input defaults)", () => {
    const { returns, parseErrors } = parseReturnsLine("X=foo");
    expect(returns).toEqual([]);
    expect(parseErrors.join("\n")).toMatch(/declares export names only.*no defaults/);
  });

  it("handles empty entries silently (e.g. trailing comma)", () => {
    expect(parseReturnsLine("A, B, ").returns).toEqual(["A", "B"]);
  });
});

describe("v0.17.3 — `unknown-returns-ref` lint", () => {
  it("fires tier-1 when a returns name has no binding source", async () => {
    const source = `# Skill: bad
# Status: Draft
# Returns: NEVER_BOUND

t:
    emit(text="probe")
default: t
`;
    const { findings } = await lint(source, {});
    const hit = findings.find((f) => f.rule === "unknown-returns-ref");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toMatch(/NEVER_BOUND/);
  });

  it("does NOT fire when the returns name is bound via $set", async () => {
    const source = `# Skill: ok-set
# Status: Draft
# Returns: BOUND_VAR

t:
    $set BOUND_VAR = "hi"
default: t
`;
    const { findings } = await lint(source, {});
    const hits = findings.filter((f) => f.rule === "unknown-returns-ref");
    expect(hits).toEqual([]);
  });

  it("does NOT fire when the returns name is bound via op output (-> VAR)", async () => {
    const source = `# Skill: ok-output
# Status: Draft
# Returns: PARSED

t:
    $set RAW = "{\\"k\\":1}"
    $ json_parse \${RAW} -> PARSED
default: t
`;
    const { findings } = await lint(source, {});
    const hits = findings.filter((f) => f.rule === "unknown-returns-ref");
    expect(hits).toEqual([]);
  });

  it("does NOT fire when the returns name is a # Vars: declaration", async () => {
    const source = `# Skill: ok-vars
# Status: Draft
# Vars: WHO=world
# Returns: WHO

t:
    emit(text="Hello, \${WHO}!")
default: t
`;
    const { findings } = await lint(source, {});
    const hits = findings.filter((f) => f.rule === "unknown-returns-ref");
    expect(hits).toEqual([]);
  });

  it("does NOT fire when no # Returns: header is present (default behavior)", async () => {
    const source = `# Skill: no-returns
# Status: Draft

t:
    emit(text="probe")
default: t
`;
    const { findings } = await lint(source, {});
    const hits = findings.filter((f) => f.rule === "unknown-returns-ref");
    expect(hits).toEqual([]);
  });
});

async function callTool(mcpServer: McpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const resp = await mcpServer.handle(req);
  return parseToolResult(resp);
}

function parseToolResult(resp: JsonRpcResponse): Record<string, unknown> {
  if ("error" in resp) throw new Error(`MCP error: ${JSON.stringify(resp.error)}`);
  const content = resp.result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

describe("v0.17.3 — runtime final_vars filter via composition", () => {
  let home: string;
  let mcpServer: McpServer;
  let skillStore: ReturnType<typeof bootstrap>["skillStore"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0173-runtime-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    mcpServer = wired.mcpServer;
    skillStore = wired.skillStore;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("child without # Returns: → caller's R.final_vars is empty (no scratch leaks)", async () => {
    // Child has internal scratch (LARGE_RAW, PARSED) but no `# Returns:` header.
    // Pre-v0.17.3: parent's R.final_vars would contain LARGE_RAW.
    // Post-v0.17.3: filter strips everything; R.final_vars is empty.
    await skillStore.store("scratch-skill",
      "# Skill: scratch-skill\n# Status: Approved\n\nwork:\n    $set LARGE_RAW = \"this is internal scratch that should not leak\"\n    $set PARSED = \"more scratch\"\n    emit(text=\"emit content\")\ndefault: work\n");
    // Parent declares `# Returns: R` to expose the composed child result to
    // the MCP caller. Per v0.17.3 — parent's own final_vars also filters to
    // declared returns; without this header the MCP caller would see empty
    // final_vars (which would be hiding the child filter we're testing).
    await skillStore.store("parent",
      "# Skill: parent\n# Status: Approved\n# Returns: R\n\ncompose:\n    $ execute_skill skill_name=\"scratch-skill\" -> R\n    emit(text=\"caller transcript ok\")\ndefault: compose\n");

    const result = await callTool(mcpServer, "execute_skill", { name: "parent" });
    expect(result["errors"]).toEqual([]);
    const finalVars = result["final_vars"] as Record<string, unknown>;
    const R = finalVars["R"] as Record<string, unknown>;
    expect(R).toBeDefined();
    // R.final_vars should be empty — no Returns declared, nothing exported.
    expect(R["final_vars"]).toEqual({});
    // But R.outputs and R.transcript flow (implicit-export).
    expect(R["transcript"]).toBeDefined();
    expect((R["transcript"] as string[]).join("\n")).toMatch(/emit content/);
  });

  it("child with # Returns: SUMMARY → caller sees SUMMARY but NOT scratch vars", async () => {
    await skillStore.store("declared-skill",
      "# Skill: declared-skill\n# Status: Approved\n# Returns: SUMMARY\n\nwork:\n    $set RAW = \"39KB-worth-of-stuff\"\n    $set PARSED = \"intermediate value\"\n    $set SUMMARY = \"the actual export\"\n    emit(text=\"\${SUMMARY}\")\ndefault: work\n");
    await skillStore.store("parent",
      "# Skill: parent\n# Status: Approved\n# Returns: R\n\ncompose:\n    $ execute_skill skill_name=\"declared-skill\" -> R\n    emit(text=\"summary=\${R.final_vars.SUMMARY}\")\ndefault: compose\n");

    const result = await callTool(mcpServer, "execute_skill", { name: "parent" });
    expect(result["errors"]).toEqual([]);
    const finalVars = result["final_vars"] as Record<string, unknown>;
    const R = finalVars["R"] as Record<string, unknown>;
    const childFinalVars = R["final_vars"] as Record<string, unknown>;
    expect(childFinalVars["SUMMARY"]).toBe("the actual export");
    expect(childFinalVars["RAW"]).toBeUndefined();
    expect(childFinalVars["PARSED"]).toBeUndefined();
    expect((result["transcript"] as string[]).join("\n")).toMatch(/summary=the actual export/);
  });

  it("declared returns that aren't actually bound at runtime are silently absent (lint catches this at author time)", async () => {
    // Skill declares # Returns: X but $set never runs for X (conditional).
    // Lint tier-1 would have caught no-binding-at-all; this test confirms
    // runtime tolerates "declared but conditionally unbound" — the filter
    // doesn't crash, it just omits the key.
    await skillStore.store("conditional-skill",
      "# Skill: conditional-skill\n# Status: Approved\n# Vars: TRIGGER=false\n# Returns: MAYBE\n\nwork:\n    if \${TRIGGER} == \"true\":\n        $set MAYBE = \"set\"\n    emit(text=\"ran\")\ndefault: work\n");
    await skillStore.store("parent",
      "# Skill: parent\n# Status: Approved\n# Returns: R\n\ncompose:\n    $ execute_skill skill_name=\"conditional-skill\" -> R\n    emit(text=\"ran\")\ndefault: compose\n");

    const result = await callTool(mcpServer, "execute_skill", { name: "parent" });
    expect(result["errors"]).toEqual([]);
    const finalVars = result["final_vars"] as Record<string, unknown>;
    const R = finalVars["R"] as Record<string, unknown>;
    expect(R["final_vars"]).toEqual({});
  });

  it("multiple returns export the full declared surface", async () => {
    await skillStore.store("multi-returns",
      "# Skill: multi-returns\n# Status: Approved\n# Returns: A, B, C\n\nwork:\n    $set A = \"alpha\"\n    $set B = \"beta\"\n    $set C = \"gamma\"\n    $set D = \"delta-internal\"\n    emit(text=\"ran\")\ndefault: work\n");
    await skillStore.store("parent",
      "# Skill: parent\n# Status: Approved\n# Returns: R\n\ncompose:\n    $ execute_skill skill_name=\"multi-returns\" -> R\n    emit(text=\"done\")\ndefault: compose\n");

    const result = await callTool(mcpServer, "execute_skill", { name: "parent" });
    expect(result["errors"]).toEqual([]);
    const finalVars = result["final_vars"] as Record<string, unknown>;
    const R = finalVars["R"] as Record<string, unknown>;
    const childFinalVars = R["final_vars"] as Record<string, unknown>;
    expect(childFinalVars).toEqual({ A: "alpha", B: "beta", C: "gamma" });
    expect(childFinalVars["D"]).toBeUndefined();
  });

  it("MCP execute_skill top-level response also reflects the filter (closes 252KB-blowup root cause)", async () => {
    // The MCP-level execute_skill response IS the composition result, so
    // the filter at composition.ts naturally trims the top-level response
    // too. This test confirms the no-leak property end-to-end.
    await skillStore.store("noisy-skill",
      "# Skill: noisy-skill\n# Status: Approved\n# Returns: ONLY_THIS\n\nwork:\n    $set BIG_SCRATCH = \"would-be-leaked-bytes\"\n    $set ONLY_THIS = \"clean export\"\n    emit(text=\"\${ONLY_THIS}\")\ndefault: work\n");

    const result = await callTool(mcpServer, "execute_skill", { name: "noisy-skill" });
    expect(result["errors"]).toEqual([]);
    const finalVars = result["final_vars"] as Record<string, unknown>;
    expect(finalVars).toEqual({ ONLY_THIS: "clean export" });
    expect(finalVars["BIG_SCRATCH"]).toBeUndefined();
  });
});
