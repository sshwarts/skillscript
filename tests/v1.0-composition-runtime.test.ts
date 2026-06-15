/**
 * v1.0 runtime-semantics test battery — Lane (d): composition runtime.
 *
 * Pins the `$ execute_skill` composition primitive's runtime semantics for
 * the v1.0 freeze: end-to-end dispatch, `# Returns:` filter behavior at the
 * parent/child boundary, `${R.final_vars.X}` reach for declared exports,
 * recursion-depth guard, and forward-reference resolution.
 *
 * Most behaviors are already exercised in v0.17.3 / v0.17.4 / v0.17.5 /
 * v0.15.2 — this file isolates one representative execution test per
 * behavior so `pnpm vitest run tests/v1.0-*` surfaces composition-runtime
 * regressions as freeze breakage, not as scattered failures in version-
 * tagged files.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import type { JsonRpcRequest, JsonRpcResponse, McpServer } from "../src/mcp-server.js";

let home: string;
let mcpServer: McpServer;
let skillStore: ReturnType<typeof bootstrap>["skillStore"];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "v1-comp-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  mcpServer = wired.mcpServer;
  skillStore = wired.skillStore;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const resp = (await mcpServer.handle(req)) as JsonRpcResponse;
  if ("error" in resp) throw new Error(`MCP error: ${JSON.stringify(resp.error)}`);
  const content = (resp.result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("v1.0 runtime — composition end-to-end", () => {
  it("`$ execute_skill name=X inputs={...} -> R` binds child result into parent", async () => {
    await skillStore.store("greet",
      "# Skill: greet\n# Status: Approved\n# Vars: WHO=world\n# Returns: G\n\nrun:\n    $set G = \"hello, ${WHO}\"\n    emit(text=\"${G}\")\ndefault: run\n");
    await skillStore.store("parent",
      "# Skill: parent\n# Status: Approved\n# Returns: R\n\nrun:\n    $ execute_skill name=\"greet\" inputs={\"WHO\":\"perry\"} -> R\n    emit(text=\"got=${R.final_vars.G}\")\ndefault: run\n");

    const result = await callTool("execute_skill", { name: "parent" });
    expect(result["errors"]).toEqual([]);
    const transcript = (result["transcript"] as string[]).join("\n");
    expect(transcript).toMatch(/got=hello, perry/);
  });

  it("declared `# Returns:` exports propagate; undeclared scratch stays local", async () => {
    await skillStore.store("filtered",
      "# Skill: filtered\n# Status: Approved\n# Returns: KEEP\n\nrun:\n    $set KEEP = \"exported\"\n    $set INTERNAL = \"should-not-reach-parent\"\n    emit(text=\"ran\")\ndefault: run\n");
    await skillStore.store("parent",
      "# Skill: parent\n# Status: Approved\n# Returns: R\n\nrun:\n    $ execute_skill name=\"filtered\" -> R\n    emit(text=\"done\")\ndefault: run\n");

    const result = await callTool("execute_skill", { name: "parent" });
    const finalVars = result["final_vars"] as Record<string, unknown>;
    const R = finalVars["R"] as Record<string, unknown>;
    const childFinalVars = R["final_vars"] as Record<string, unknown>;
    expect(childFinalVars["KEEP"]).toBe("exported");
    expect(childFinalVars["INTERNAL"]).toBeUndefined();
  });

  it("`${R.final_vars.X}` accesses declared export at template-substitution time", async () => {
    await skillStore.store("count",
      "# Skill: count\n# Status: Approved\n# Returns: N\n\nrun:\n    $set N = \"42\"\n    emit(text=\"counted\")\ndefault: run\n");
    await skillStore.store("parent",
      "# Skill: parent\n# Status: Approved\n\nrun:\n    $ execute_skill name=\"count\" -> R\n    emit(text=\"answer=${R.final_vars.N}\")\ndefault: run\n");

    const result = await callTool("execute_skill", { name: "parent" });
    expect(result["errors"]).toEqual([]);
    expect((result["transcript"] as string[]).join("\n")).toMatch(/answer=42/);
  });

  it("recursion-depth guard fires (default limit = 10)", async () => {
    // Self-referential skill with no termination — the guard catches it
    // at depth 10. The runtime wraps the deepest child's error into the
    // R binding (parent's `$ execute_skill -> R` catches it) and that R
    // nests at each level on the way up. So the depth-exceeded error
    // lives BURIED in R.R.R...errors, not at the top-level result.errors.
    // This is the documented behavior; we assert by searching the JSON
    // for the canonical guard message rather than walking the nested R
    // chain (which is fragile to runtime-shape changes).
    // `# Returns: R` preserves R in the parent's filtered final_vars so
    // the buried recursion-depth error reaches the MCP-wire serialization.
    // Without it, R (and the depth-exceeded message inside it) would be
    // filtered out by the parent's # Returns: cascade.
    await skillStore.store("loop",
      "# Skill: loop\n# Status: Approved\n# Returns: R\n\nrun:\n    $ execute_skill name=\"loop\" -> R\n    emit(text=\"never-here\")\ndefault: run\n");

    const result = await callTool("execute_skill", { name: "loop" });
    const json = JSON.stringify(result);
    expect(json).toMatch(/recursion depth exceeded.*limit 10/i);
  });

  it("forward-reference resolution — child stored before parent executes", async () => {
    // Register parent BEFORE child. Forward-reference path resolves at
    // execute time (parent's `$ execute_skill` reaches into SkillStore
    // when the op fires, not at parent's compile time). `# Returns: R`
    // exposes the child result through the parent's filtered final_vars.
    await skillStore.store("parent",
      "# Skill: parent\n# Status: Approved\n# Returns: R\n\nrun:\n    $ execute_skill name=\"future-child\" -> R\n    emit(text=\"after-child\")\ndefault: run\n");
    await skillStore.store("future-child",
      "# Skill: future-child\n# Status: Approved\n\nrun:\n    emit(text=\"deferred resolution worked\")\ndefault: run\n");

    const result = await callTool("execute_skill", { name: "parent" });
    expect(result["errors"]).toEqual([]);
    const finalVars = result["final_vars"] as Record<string, unknown>;
    const R = finalVars["R"] as Record<string, unknown>;
    expect(R).toBeDefined();
    const childTranscript = (R["transcript"] as string[]).join("\n");
    expect(childTranscript).toMatch(/deferred resolution worked/);
  });
});
