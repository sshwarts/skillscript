import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import type { JsonRpcRequest, JsonRpcResponse, McpServer } from "../src/mcp-server.js";

/**
 * v0.27.0 — `(fallback:)` now contains a RAISED THROW from the two intercept
 * ops (`execute_skill`, `$ json_parse`), not just a MISSING VALUE. This retires
 * the "(fallback:) catches empty but not throws" split so the trailer's mental
 * model is uniform across every fallible op: a failing op with `(fallback:)`
 * degrades to the fallback and continues, whatever the failure shape.
 *
 * Two invariants the fix must preserve (Perry `c052581b` decision B):
 *   - The throw MESSAGE is kept in `fallbacks[].reason` — degrade-loud, still
 *     diagnosable (not silently erased from the result).
 *   - A child's own OP-level failure (incl. a policy/security refusal) is
 *     captured in the child's `result.errors[]` and never reaches the parent's
 *     execute_skill `catch`, so `(fallback:)` CANNOT swallow it.
 */

let home: string;
let mcpServer: McpServer;
let skillStore: ReturnType<typeof bootstrap>["skillStore"];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "v0270-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  mcpServer = wired.mcpServer;
  skillStore = wired.skillStore;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function run(name: string): Promise<Record<string, unknown>> {
  const req: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_skill", arguments: { name } } };
  const resp = (await mcpServer.handle(req)) as JsonRpcResponse;
  if ("error" in resp) throw new Error(`MCP error: ${JSON.stringify(resp.error)}`);
  const content = (resp.result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}
const transcript = (r: Record<string, unknown>) => (r["transcript"] as string[]) ?? [];
const errors = (r: Record<string, unknown>) => (r["errors"] as Array<{ message: string }>) ?? [];
const fallbacks = (r: Record<string, unknown>) => (r["fallbacks"] as Array<{ reason?: string }>) ?? [];

// A child that throws by escaping its output-template render (Perry's AREA
// case): with FLAG=no, AREA is never bound and `Weather: ${AREA}` hard-fails.
const CHILD_THROWS = '# Skill: wthrow\n# Status: Approved\n# Vars: FLAG=no\nWeather: ${AREA}\nrun:\n    if ${FLAG} == "yes":\n        $set AREA = "here"\ndefault: run\n';

describe("v0.27.0 — (fallback:) contains a raised throw", () => {
  it("execute_skill child-throw WITH (fallback:) → contained, degraded value bound, reason kept", async () => {
    await skillStore.store("wthrow", CHILD_THROWS);
    await skillStore.store("p",
      '# Skill: p\n# Status: Approved\nrun:\n    execute_skill(skill_name="wthrow") -> WX (fallback: "DEGRADED")\n    emit(text="after: ${WX}")\ndefault: run\n');
    const r = await run("p");
    expect(transcript(r)).toContain("after: DEGRADED");        // the op AFTER the throwing one ran
    expect(errors(r)).toEqual([]);                              // parent did not abort
    expect(fallbacks(r).some((f) => /execute_skill failed/.test(f.reason ?? ""))).toBe(true); // reason preserved
  });

  it("multi-leg gather: one throwing leg with (fallback:) no longer sinks the siblings", async () => {
    await skillStore.store("wthrow", CHILD_THROWS);
    await skillStore.store("good", '# Skill: good\n# Status: Approved\nOK-LEG\nrun:\n    $set _ = "noop"\ndefault: run\n');
    await skillStore.store("gather",
      '# Skill: gather\n# Status: Approved\nrun:\n    execute_skill(skill_name="wthrow") -> WX (fallback: "DEGRADED")\n    execute_skill(skill_name="good") -> OK\n    emit(text="done wx=${WX}")\ndefault: run\n');
    const r = await run("gather");
    expect(transcript(r).some((t) => t.startsWith("done wx=DEGRADED"))).toBe(true); // reached the final emit → leg2 ran
    expect(errors(r)).toEqual([]);
  });

  it("json_parse off-shape WITH (fallback:) → contained, reason kept", async () => {
    await skillStore.store("p",
      '# Skill: p\n# Status: Approved\nrun:\n    $ json_parse \'not json{\' -> P (fallback: "{}")\n    emit(text="parsed: ${P}")\ndefault: run\n');
    const r = await run("p");
    expect(transcript(r)).toContain("parsed: {}");
    expect(fallbacks(r).some((f) => /json_parse failed/.test(f.reason ?? ""))).toBe(true);
  });

  it("REGRESSION: execute_skill child-throw with NO (fallback:) still aborts", async () => {
    await skillStore.store("wthrow", CHILD_THROWS);
    await skillStore.store("p",
      '# Skill: p\n# Status: Approved\nrun:\n    execute_skill(skill_name="wthrow") -> WX\n    emit(text="after: ${WX}")\ndefault: run\n');
    const r = await run("p");
    expect(errors(r).length).toBeGreaterThan(0);   // the throw still surfaces
    expect(transcript(r)).not.toContain("after: ");
  });

  it("REGRESSION: json_parse off-shape with NO (fallback:) still throws", async () => {
    await skillStore.store("p",
      '# Skill: p\n# Status: Approved\nrun:\n    $ json_parse \'not json{\' -> P\n    emit(text="parsed: ${P}")\ndefault: run\n');
    const r = await run("p");
    expect(errors(r).length).toBeGreaterThan(0);
  });

  it("SECURITY: a child's policy refusal is NOT swallowed by the parent's (fallback:)", async () => {
    // The child hits the shell allowlist (default-deny). That is an OP-level
    // failure INSIDE the child — captured in the child's result.errors[], it
    // never escapes as a parent throw, so the parent (fallback:) does not fire
    // and the refusal stays visible in the bound child result.
    await skillStore.store("child_policy",
      '# Skill: child_policy\n# Status: Approved\nrun:\n    shell(command="rmdangerous /") -> X\n    emit(text="ran: ${X}")\ndefault: run\n');
    await skillStore.store("p",
      '# Skill: p\n# Status: Approved\nrun:\n    execute_skill(skill_name="child_policy") -> R (fallback: "SWALLOWED")\n    emit(text="child_errors: ${R.errors}")\ndefault: run\n');
    const r = await run("p");
    // Parent did not degrade to the fallback — no execute_skill fallback fired.
    expect(fallbacks(r).some((f) => /execute_skill/.test(f.reason ?? ""))).toBe(false);
    // The child's security refusal surfaced through the bound result.
    const joined = transcript(r).join(" ");
    expect(joined).toMatch(/ShellBinaryNotAllowedError|not in the operator's shell allowlist/);
    expect(joined).not.toContain("SWALLOWED");
  });
});
