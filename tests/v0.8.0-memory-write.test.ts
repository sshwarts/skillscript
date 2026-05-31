import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { SqliteDataStore } from "../src/connectors/data-store.js";
import { DataStoreMcpConnector } from "../src/connectors/data-store-mcp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// v0.8.0 — `$ data_write content=... [recipients=...] [tags=...]
// [expires_at=N] [metadata={...}] -> R` MCP dispatch routes through the
// DataStoreMcpConnector bridge's dispatchWrite path. End-to-end:
// parser → lint (name-match v0.7.3) → runtime dispatch → bridge → DataStore.write()
// → returns {id, created_at} envelope.

describe("v0.8.0 — $ data_write op (end-to-end through bridge)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "v080-memwrite-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("bare-form `$ data_write content='...' -> R` writes via the bridge", async () => {
    const dbPath = join(home, "data.db");
    const store = new SqliteDataStore({ dbPath });
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerDataStore("primary", store);
    wired.registry.registerMcpConnector("data_write", new DataStoreMcpConnector(store));

    const src = `# Skill: t\n# Status: Approved\n# Autonomous: true\nrun:\n    $ data_write content="durable handoff" -> R\n    emit(text="wrote id=\${R.id}")\ndefault: run\n`;
    const compiled = await compile(src, { registry: wired.registry });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toMatch(/^wrote id=[0-9a-f-]+$/);

    // Verify the row landed in the store via query.
    const rows = await store.query({ query: "durable handoff", limit: 5, mode: "fts" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.summary).toBe("durable handoff");
    expect(rows[0]!.detail).toBe("durable handoff");

    store.close();
  });

  it("passes recipients + tags + metadata through the bridge", async () => {
    const dbPath = join(home, "data.db");
    const store = new SqliteDataStore({ dbPath });
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerDataStore("primary", store);
    wired.registry.registerMcpConnector("data_write", new DataStoreMcpConnector(store));

    const src = `# Skill: t\n# Status: Approved\n# Autonomous: true\nrun:\n    $ data_write content="urgent alert" recipients=["oncall","backup"] tags=["incident","sev-1"] -> R\ndefault: run\n`;
    const compiled = await compile(src, { registry: wired.registry });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(result.errors).toEqual([]);

    const rows = await store.query({ query: "urgent alert", limit: 5, mode: "fts" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.domain_tags).toEqual(["incident", "sev-1"]);
    expect(rows[0]!.metadata?.["recipients"]).toEqual(["oncall", "backup"]);

    store.close();
  });

  it("requires content kwarg — empty string throws DispatchError", async () => {
    const dbPath = join(home, "data.db");
    const store = new SqliteDataStore({ dbPath });
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerDataStore("primary", store);
    wired.registry.registerMcpConnector("data_write", new DataStoreMcpConnector(store));

    const src = `# Skill: t\n# Status: Approved\n# Autonomous: true\nrun:\n    $ data_write content="" -> R\ndefault: run\n`;
    const compiled = await compile(src, { registry: wired.registry });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.errors)).toMatch(/content.*required/);

    store.close();
  });

  it("bootstrap auto-wires `data_write` connector alongside `memory`", () => {
    const dbPath = join(home, "data.db");
    const store = new SqliteDataStore({ dbPath });
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: dbPath,
    });
    // Both connector names should be wired by bootstrap.
    const mcps = wired.registry.listMcpConnectors().map((e) => e.name);
    expect(mcps).toContain("data_read");
    expect(mcps).toContain("data_write");
    store.close();
  });
});
