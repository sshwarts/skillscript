import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { lint } from "../src/lint.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { LocalModelMcpConnector } from "../src/connectors/local-model-mcp.js";
import { DataStoreMcpConnector } from "../src/connectors/data-store-mcp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalModel, DataStore, PortableData } from "../src/connectors/types.js";

// v0.7.3 push-blocker fix (per Perry 75b964ed). The v0.7.2 bare-form
// dispatch fix landed at the runtime resolver but the `unwired-primary-
// connector` lint rule still used the pre-v0.7.2 model: bare `$ <name>`
// was treated as a tool name needing `primary.<name>` lookup, ignoring
// name-match against wired connectors. Cold-author skills with bare-form
// `$ llm` / `$ data_read` failed at lint before ever reaching the runtime
// resolver — making the v0.7.2 "bare-form just works" promise broken at
// the user-facing layer.
//
// **The protocol lesson** (recurring from v0.7.2): when a release fixes
// a multi-layer promise (lint + compile + runtime), every layer the user
// path traverses needs the fix. The v0.7.2 bridge-bare-dispatch tests
// asserted runtime dispatch but bypassed the lint gate; cold authors hit
// the gate first. This test file closes that gap by traversing the FULL
// user path: lint → compile → execute end-to-end.

class FakeLocalModel implements LocalModel {
  public lastPrompt = "";
  async run(prompt: string, _opts: { maxTokens?: number; model?: string }): Promise<string> {
    this.lastPrompt = prompt;
    return `LM:${prompt}`;
  }
  async manifest(): Promise<{ capabilities_version: string; manifest: Record<string, unknown> }> {
    return { capabilities_version: "1", manifest: { kind: "fake-local-model" } };
  }
}

class FakeDataStore implements DataStore {
  public lastQuery: Record<string, unknown> | null = null;
  async query(filters: Record<string, unknown> & { query: string; limit: number; mode: string }): Promise<PortableData[]> {
    this.lastQuery = filters;
    return [
      { id: "m1", summary: "first item", confidence: 0.9, agentId: "test", vault: "private" } as unknown as PortableData,
    ];
  }
  async manifest(): Promise<{ capabilities_version: string; manifest: Record<string, unknown> }> {
    return { capabilities_version: "1", manifest: { kind: "fake-data-store" } };
  }
}

describe("v0.7.3 — bare-form bridge dispatch lint (full user path: lint → compile → execute)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "v073-bare-lint-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("LINT — bare `$ data_read` passes when `memory` connector is wired (was push-blocker pre-v0.7.3)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerMcpConnector("data_read", new DataStoreMcpConnector(new FakeDataStore()));

    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ data_read mode="fts" query="incidents" limit=5 -> R\n    emit(text="\${R.items|length}")\ndefault: run\n`;
    const result = await lint(src, { registry: wired.registry });
    // The exact assertion: no `unwired-primary-connector` errors against `$ data_read`.
    const unwiredErrors = result.findings.filter((f) => f.rule === "unwired-primary-connector");
    expect(unwiredErrors).toEqual([]);
    expect(result.errorCount).toBe(0);
  });

  it("LINT — bare `$ llm` passes when `llm` connector is wired (was push-blocker pre-v0.7.3)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerMcpConnector("llm", new LocalModelMcpConnector(new FakeLocalModel()));

    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ llm prompt="hello" -> R\n    emit(text="\${R}")\ndefault: run\n`;
    const result = await lint(src, { registry: wired.registry });
    const unwiredErrors = result.findings.filter((f) => f.rule === "unwired-primary-connector");
    expect(unwiredErrors).toEqual([]);
    expect(result.errorCount).toBe(0);
  });

  it("LINT — bare `$ unknown_tool` STILL errors when no matching connector + no primary (regression guard)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerMcpConnector("data_read", new DataStoreMcpConnector(new FakeDataStore()));
    // `unknown_tool` has no matching connector and no primary → lint should error.
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ unknown_tool foo="bar" -> R\ndefault: run\n`;
    const result = await lint(src, { registry: wired.registry });
    const unwiredErrors = result.findings.filter((f) => f.rule === "unwired-primary-connector");
    expect(unwiredErrors.length).toBeGreaterThan(0);
    expect(unwiredErrors[0]!.message).toContain("unknown_tool");
  });

  it("v0.16.0 — bare `$ <name>` with `primary` wired now FIRES (primary fallback dropped)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerMcpConnector("primary", new LocalModelMcpConnector(new FakeLocalModel()));
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ some_tool prompt="hi" -> R\n    emit(text="\${R}")\ndefault: run\n`;
    const result = await lint(src, { registry: wired.registry });
    const unwiredErrors = result.findings.filter((f) => f.rule === "unwired-primary-connector");
    expect(unwiredErrors.length).toBeGreaterThan(0);
  });

  it("FULL USER PATH — bare `$ data_read` + `$ llm` skill runs lint → compile → execute end-to-end", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const fakeLm = new FakeLocalModel();
    const fakeMs = new FakeDataStore();
    wired.registry.registerMcpConnector("llm", new LocalModelMcpConnector(fakeLm));
    wired.registry.registerMcpConnector("data_read", new DataStoreMcpConnector(fakeMs));

    const src = `# Skill: bare-bridge-canonical\n# Status: Approved\n# Vars: QUERY=incidents\nrun:\n    $ data_read mode="fts" query="\${QUERY}" limit=3 -> MEMS\n    $ llm prompt="One-line summary of: \${MEMS.items|length} hits" -> SUMMARY\n    emit(text="\${SUMMARY}")\ndefault: run\n`;

    // Step 1: lint must accept the bare-form (this was the push-blocker).
    const lintResult = await lint(src, { registry: wired.registry });
    expect(lintResult.errorCount).toBe(0);
    expect(lintResult.findings.filter((f) => f.rule === "unwired-primary-connector")).toEqual([]);

    // Step 2: compile must succeed with the same registry context (registry
    // threads through to compile's lint preflight — if lint would still
    // reject, compile would throw).
    const compiled = await compile(src, { registry: wired.registry });

    // Step 3: execute must dispatch through the bridges.
    const executed = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(executed.errors).toEqual([]);
    expect(fakeMs.lastQuery).toMatchObject({ query: "incidents", limit: 3, mode: "fts" });
    expect(fakeLm.lastPrompt).toBe("One-line summary of: 1 hits");
    expect(executed.emissions[0]).toBe("LM:One-line summary of: 1 hits");
  });
});
