import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { LocalModelMcpConnector } from "../src/connectors/local-model-mcp.js";
import { DataStoreMcpConnector } from "../src/connectors/data-store-mcp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalModel, DataStore, PortableData } from "../src/connectors/types.js";

// v0.7.2 push-blocker fix (per Perry f46d3c49): bare-form `$ data_read ...` and
// `$ llm ...` must dispatch through the auto-wired bridges, not fail with
// ConnectorNotFoundError trying to look up "primary". These tests exercise
// the bare-form path end-to-end — the coverage gap that let the bug slip
// past Perry's signoff.

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

describe("v0.7.2 — bare-form bridge dispatch (push-blocker fix)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "v072-bare-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("`$ llm prompt=\"...\" -> R` dispatches through bridge (NOT ConnectorNotFoundError)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    // Swap the auto-wired llm bridge to use a fake LocalModel so the test
    // doesn't depend on a running Ollama. Re-register the `llm` connector.
    const fakeLm = new FakeLocalModel();
    wired.registry.registerMcpConnector("llm", new LocalModelMcpConnector(fakeLm));

    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ llm prompt="hello world" -> R\n    emit(text="\${R}")\ndefault: run\n`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(fakeLm.lastPrompt).toBe("hello world");
    expect(result.emissions[0]).toBe("LM:hello world");
  });

  it("`$ data_read mode=\"fts\" query=\"...\" limit=N -> R` dispatches through bridge", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const fakeMs = new FakeDataStore();
    wired.registry.registerMcpConnector("data_read", new DataStoreMcpConnector(fakeMs));

    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ data_read mode="fts" query="incidents" limit=5 -> R\n    emit(text="got \${R.items|length} items")\ndefault: run\n`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(fakeMs.lastQuery).toMatchObject({ query: "incidents", limit: 5, mode: "fts" });
    expect(result.emissions[0]).toBe("got 1 items");
  });

  it("dotted form `$ data_read.query mode=... ...` still works (no regression)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const fakeMs = new FakeDataStore();
    wired.registry.registerMcpConnector("data_read", new DataStoreMcpConnector(fakeMs));

    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ data_read.query mode="fts" query="x" limit=10 -> R\n    emit(text="\${R.items|length}")\ndefault: run\n`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe("1");
  });

  it("bare-form $ <unknown-name> still falls back to primary lookup (backward compat)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    // No bridge re-registration; no `unknown_tool` connector; no `primary`.
    // The unknown tool name doesn't match any registered connector, so it
    // falls back to primary lookup, which fails cleanly.
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ unknown_tool foo=bar -> R\ndefault: run\n`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    // ConnectorNotFoundError fires — the bare-form `unknown_tool` doesn't
    // name-match any registered connector, so it tries primary, which
    // isn't wired in this test setup.
    expect(result.errors.length).toBeGreaterThan(0);
    expect((result.errors[0] as { class?: string }).class).toBe("ConnectorNotFoundError");
  });

  it("v0.16.0: named-form `$ primary.prompt` works against a wired primary", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerMcpConnector("primary", new LocalModelMcpConnector(new FakeLocalModel()));

    // Named form against `primary` connector + `prompt` tool (declared on
    // LocalModelMcpConnector.staticTools).
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ primary.prompt prompt="hi" -> R\n    emit(text="\${R}")\ndefault: run\n`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe("LM:hi");
  });

  it("foreach over `${R.items}` from bare-form memory works end-to-end", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const fakeMs = new FakeDataStore();
    wired.registry.registerMcpConnector("data_read", new DataStoreMcpConnector(fakeMs));

    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ data_read mode="fts" query="x" limit=10 -> R\n    foreach M in \${R.items}:\n        emit(text="\${M.summary}")\ndefault: run\n`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe("first item");
  });
});
