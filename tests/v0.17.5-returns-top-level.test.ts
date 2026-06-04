import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, RESERVED_ENVELOPE_FIELDS } from "../src/parser.js";
import { lint } from "../src/lint.js";
import { bootstrap } from "../src/bootstrap.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import type { JsonRpcRequest, JsonRpcResponse, McpServer } from "../src/mcp-server.js";

/**
 * v0.17.5 — Returns surface bugfix ring.
 *
 * Three coordinated fixes per Perry's `0cd2bd5a` → `101e3953` →
 * `e01f4148` exchange:
 *
 * (A) IMPL FIX: declared returns spread onto R's top level (canonical
 *     `${R.SUMMARY}` access matches spec); `R.final_vars` kept as
 *     iteration-view of the same filtered map.
 * (B) RESERVED-NAME GUARD: parser rejects `# Returns:` names that
 *     collide with envelope fields (outputs, transcript, errors,
 *     target_order, fallbacks, agent_delivery_receipts, skill_name,
 *     final_vars). Per Perry's non-optional condition: "treat the
 *     guard as part of the fix, not a follow-up."
 * (C) LINT REGEX EXTENDED: `unexported-final-var-access` now catches
 *     `${R.X}` top-level pattern (the canonical access path Perry's
 *     repro tested) alongside the existing `${R.final_vars.X}` path.
 *     Skips envelope-field sibling access.
 */

const PARENT_HEAD = `# Skill: parent\n# Status: Approved\n# Returns: R\n`;

async function callTool(mcpServer: McpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const resp: JsonRpcResponse = await mcpServer.handle(req);
  if ("error" in resp) throw new Error(`MCP error: ${JSON.stringify(resp.error)}`);
  const content = resp.result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

describe("v0.17.5 — (B) reserved-name guard in parser", () => {
  for (const reserved of ["outputs", "transcript", "errors", "target_order", "fallbacks", "agent_delivery_receipts", "skill_name", "final_vars"]) {
    it(`rejects \`# Returns: ${reserved}\` — collision with envelope field`, () => {
      const source = `# Skill: bad
# Status: Draft
# Returns: ${reserved}

t:
    $set ${reserved} = "shadow attempt"
default: t
`;
      const parsed = parse(source);
      const collisionError = parsed.parseErrors.find((e) => e.includes(`'${reserved}' collides with a reserved result-envelope field`));
      expect(collisionError).toBeDefined();
      expect(parsed.returns).not.toContain(reserved);
    });
  }

  it("allows non-reserved names alongside the rejected ones in a mixed declaration", () => {
    const source = `# Skill: mixed
# Status: Draft
# Returns: SUMMARY, outputs, TEMP

t:
    $set SUMMARY = "ok"
    $set TEMP = "42"
default: t
`;
    const parsed = parse(source);
    expect(parsed.returns).toEqual(["SUMMARY", "TEMP"]);
    expect(parsed.parseErrors.some((e) => e.includes("outputs"))).toBe(true);
  });

  it("RESERVED_ENVELOPE_FIELDS is exported + matches the canonical set", () => {
    expect(RESERVED_ENVELOPE_FIELDS.has("outputs")).toBe(true);
    expect(RESERVED_ENVELOPE_FIELDS.has("transcript")).toBe(true);
    expect(RESERVED_ENVELOPE_FIELDS.has("final_vars")).toBe(true);
    expect(RESERVED_ENVELOPE_FIELDS.has("SUMMARY")).toBe(false);
  });
});

describe("v0.17.5 — (A) declared returns at top level of R", () => {
  let home: string;
  let mcpServer: McpServer;
  let skillStore: FilesystemSkillStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0175-toplevel-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    mcpServer = wired.mcpServer;
    skillStore = wired.skillStore as FilesystemSkillStore;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("caller accessing `${R.<DECLARED>}` at top level resolves correctly", async () => {
    await skillStore.store("ret-callee",
      "# Skill: ret-callee\n# Status: Approved\n# Returns: ALPHA, BETA\n\nrun:\n    $set ALPHA = \"alpha-value\"\n    $set BETA = \"beta-value\"\n    $set INTERNAL = \"scratch — not exported\"\n    emit(text=\"emit content\")\ndefault: run\n");
    await skillStore.store("caller",
      "# Skill: caller\n# Status: Approved\n# Returns: R\n\ncompose:\n    $ execute_skill skill_name=\"ret-callee\" -> R\n    emit(text=\"top-level: \${R.ALPHA} and \${R.BETA}\")\ndefault: compose\n");

    const result = await callTool(mcpServer, "execute_skill", { name: "caller" });
    expect(result["errors"]).toEqual([]);
    expect((result["transcript"] as string[]).join("\n")).toMatch(/top-level: alpha-value and beta-value/);
  });

  it("`${R.final_vars.<DECLARED>}` (iteration-view path) still resolves — both paths work", async () => {
    await skillStore.store("ret-callee",
      "# Skill: ret-callee\n# Status: Approved\n# Returns: ALPHA\n\nrun:\n    $set ALPHA = \"alpha-value\"\ndefault: run\n");
    await skillStore.store("caller",
      "# Skill: caller\n# Status: Approved\n# Returns: R\n\ncompose:\n    $ execute_skill skill_name=\"ret-callee\" -> R\n    emit(text=\"compat-view: \${R.final_vars.ALPHA}\")\ndefault: compose\n");

    const result = await callTool(mcpServer, "execute_skill", { name: "caller" });
    expect(result["errors"]).toEqual([]);
    expect((result["transcript"] as string[]).join("\n")).toMatch(/compat-view: alpha-value/);
  });

  it("R top-level surface includes declared returns + envelope fields", async () => {
    await skillStore.store("ret-callee",
      "# Skill: ret-callee\n# Status: Approved\n# Returns: ALPHA\n\nrun:\n    $set ALPHA = \"alpha-value\"\n    emit(text=\"hi\")\ndefault: run\n");
    await skillStore.store("caller",
      "# Skill: caller\n# Status: Approved\n# Returns: R\n\ncompose:\n    $ execute_skill skill_name=\"ret-callee\" -> R\n    emit(text=\"done\")\ndefault: compose\n");

    const result = await callTool(mcpServer, "execute_skill", { name: "caller" });
    const finalVars = result["final_vars"] as Record<string, unknown>;
    const R = finalVars["R"] as Record<string, unknown>;
    // Declared returns at top level.
    expect(R["ALPHA"]).toBe("alpha-value");
    // Envelope fields at top level.
    expect(R["outputs"]).toBeDefined();
    expect(R["transcript"]).toBeDefined();
    expect(R["errors"]).toBeDefined();
    // Iteration view also has ALPHA.
    expect((R["final_vars"] as Record<string, unknown>)["ALPHA"]).toBe("alpha-value");
  });

  it("undeclared internal scratch does NOT appear at top level (filter holds)", async () => {
    await skillStore.store("ret-callee",
      "# Skill: ret-callee\n# Status: Approved\n# Returns: ALPHA\n\nrun:\n    $set ALPHA = \"declared\"\n    $set SCRATCH = \"internal — should NOT leak\"\ndefault: run\n");
    await skillStore.store("caller",
      "# Skill: caller\n# Status: Approved\n# Returns: R\n\ncompose:\n    $ execute_skill skill_name=\"ret-callee\" -> R\n    emit(text=\"done\")\ndefault: compose\n");

    const result = await callTool(mcpServer, "execute_skill", { name: "caller" });
    const finalVars = result["final_vars"] as Record<string, unknown>;
    const R = finalVars["R"] as Record<string, unknown>;
    expect(R["ALPHA"]).toBe("declared");
    expect(R["SCRATCH"]).toBeUndefined();
    expect((R["final_vars"] as Record<string, unknown>)["SCRATCH"]).toBeUndefined();
  });
});

describe("v0.17.5 — (C) lint catches top-level `${R.X}` undeclared pattern", () => {
  let home: string;
  let skillStore: FilesystemSkillStore;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "v0175-lint-"));
    skillStore = new FilesystemSkillStore(home);
    await skillStore.store("ret-callee",
      "# Skill: ret-callee\n# Status: Approved\n# Returns: ALPHA\n\nrun:\n    $set ALPHA = \"alpha\"\ndefault: run\n");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("fires tier-2 on top-level `${R.BOGUS}` — Perry's repro shape", async () => {
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="ret-callee" -> R
    emit(text="\${R.BOGUS}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hit = findings.find((f) => f.rule === "unexported-final-var-access");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("warning");
    expect(hit?.message).toMatch(/BOGUS/);
    expect(hit?.extras?.["access_path"]).toBe("top-level");
  });

  it("does NOT fire on top-level `${R.ALPHA}` — ALPHA is declared", async () => {
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="ret-callee" -> R
    emit(text="\${R.ALPHA}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hits = findings.filter((f) => f.rule === "unexported-final-var-access");
    expect(hits).toEqual([]);
  });

  it("does NOT fire on always-exported envelope-field access (`outputs`, `transcript`, etc.)", async () => {
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="ret-callee" -> R
    emit(text="\${R.outputs} \${R.transcript} \${R.errors} \${R.target_order} \${R.fallbacks} \${R.agent_delivery_receipts}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hits = findings.filter((f) => f.rule === "unexported-final-var-access");
    expect(hits).toEqual([]);
  });

  it("does NOT fire on `${R.final_vars}` bare iteration-view access", async () => {
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="ret-callee" -> R
    foreach KEY in \${R.final_vars}:
        emit(text="\${KEY}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hits = findings.filter((f) => f.rule === "unexported-final-var-access");
    expect(hits).toEqual([]);
  });

  it("fires on `${R.final_vars.BOGUS}` (explicit-path form) — existing v0.17.4 behavior preserved", async () => {
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="ret-callee" -> R
    emit(text="\${R.final_vars.BOGUS}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hit = findings.find((f) => f.rule === "unexported-final-var-access");
    expect(hit).toBeDefined();
    expect(hit?.extras?.["access_path"]).toBe("final_vars");
  });

  it("fires on both top-level AND explicit paths when both used in same skill", async () => {
    const source = `# Skill: caller
# Status: Draft

compose:
    $ execute_skill skill_name="ret-callee" -> R
    emit(text="top: \${R.BOGUS1}")
    emit(text="explicit: \${R.final_vars.BOGUS2}")
default: compose
`;
    const { findings } = await lint(source, { skillStore });
    const hits = findings.filter((f) => f.rule === "unexported-final-var-access");
    expect(hits).toHaveLength(2);
    const messages = hits.map((h) => h.message).join("\n");
    expect(messages).toMatch(/BOGUS1/);
    expect(messages).toMatch(/BOGUS2/);
  });
});
