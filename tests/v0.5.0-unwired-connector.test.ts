import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { lint } from "../src/lint.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.5.0 item 5 — unwired connector: hard error + tier-1 lint.
 *
 * Pre-v0.5.0 behavior: bare `$ TOOL` ops with no primary connector
 * and no embedder toolDispatch silently emitted "Would call tool X
 * (no dispatcher wired)" and bound null to the output var. That
 * masked connector misconfiguration — skills appeared to succeed
 * with no actual dispatch.
 *
 * v0.5.0 behavior:
 *   5a) Runtime throws ConnectorNotFoundError (caught by op-level
 *       `(fallback:)` if declared, otherwise surfaces).
 *   5b) Lint surfaces `unwired-primary-connector` tier-1 at compile
 *       time when the runtime registry is queryable.
 */

describe("v0.5.0 item 5a — runtime hard error on unwired", () => {
  it("bare `$ TOOL` with no primary, no toolDispatch → throws", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ some_tool arg1 -> R\n    emit(text="result=$(R)")\ndefault: run\n`;
    const home = mkdtempSync(join(tmpdir(), "v050-5a-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    // Compile path includes lint; with no registry context here it bypasses
    // the lint guard, so the runtime is the test. Use parser+execute directly.
    const compiled = await compile(src, { lint: { mcpConnectorNames: undefined } });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    // Pre-v0.5.0 this would have emitted "Would call tool ..." and result.errors === [].
    // v0.5.0: errors collected from the throw, no silent stub.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.emissions.find((e) => /Would call tool/.test(e))).toBeUndefined();
  });

  it("bare `$ TOOL` with (fallback: ...) recovers", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ some_tool arg1 -> R (fallback: "n/a")\n    emit(text="result=$(R)")\ndefault: run\n`;
    const home = mkdtempSync(join(tmpdir(), "v050-5a-fb-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const compiled = await compile(src, { lint: { mcpConnectorNames: undefined } });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["result=n/a"]);
  });
});

describe("v0.5.0 item 5b — lint: unwired-primary-connector", () => {
  it("FAIL: bare `$ TOOL` op when registry lists no primary", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ some_tool arg1 -> R\ndefault: run\n`;
    const r = await lint(src, { mcpConnectorNames: [] });
    const f = r.findings.find((x) => x.rule === "unwired-primary-connector");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.message).toMatch(/some_tool/);
  });

  it("FAIL: bare op fires even when other named connectors exist (just not 'primary')", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ some_tool arg1 -> R\ndefault: run\n`;
    const r = await lint(src, { mcpConnectorNames: ["youtrack", "slack"] });
    expect(r.findings.find((x) => x.rule === "unwired-primary-connector")).toBeDefined();
  });

  it("v0.16.0: bare op STILL fires when only 'primary' is wired (primary fallback dropped)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ some_tool arg1 -> R\ndefault: run\n`;
    const r = await lint(src, { mcpConnectorNames: ["primary", "youtrack"] });
    expect(r.findings.find((x) => x.rule === "unwired-primary-connector")).toBeDefined();
  });

  it("OK: qualified `$ named.tool` op doesn't fire (covered by unknown-connector + disallowed-tool)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ youtrack.search_issues arg1 -> R\ndefault: run\n`;
    const r = await lint(src, { mcpConnectorNames: ["youtrack"] });
    expect(r.findings.find((x) => x.rule === "unwired-primary-connector")).toBeUndefined();
  });

  it("OK: built-in `$ execute_skill` doesn't need a connector", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ execute_skill skill_name=foo -> R\ndefault: run\n`;
    const r = await lint(src, { mcpConnectorNames: [] });
    expect(r.findings.find((x) => x.rule === "unwired-primary-connector")).toBeUndefined();
  });

  it("OK: built-in `$ json_parse` doesn't need a connector", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: J="[1,2,3]"\nrun:\n    $ json_parse $(J) -> R\ndefault: run\n`;
    const r = await lint(src, { mcpConnectorNames: [] });
    expect(r.findings.find((x) => x.rule === "unwired-primary-connector")).toBeUndefined();
  });

  it("OK: silent when registry not queryable (mcpConnectorNames=undefined)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ some_tool arg1 -> R\ndefault: run\n`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "unwired-primary-connector")).toBeUndefined();
  });

  it("dedupes per (target, tool) — same op repeated only reports once", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ some_tool a -> R1\n    $ some_tool b -> R2\ndefault: run\n`;
    const r = await lint(src, { mcpConnectorNames: [] });
    const matches = r.findings.filter((x) => x.rule === "unwired-primary-connector");
    expect(matches).toHaveLength(1);
  });
});
