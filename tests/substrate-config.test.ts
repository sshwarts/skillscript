/**
 * v0.10 — tests for `connectors.json` substrate section + bootstrap dispatch.
 *
 * Coverage:
 *   - Parser handles short form ("sqlite", "filesystem", null), object form
 *     ({type, config}), and custom form ({type:"custom", module, ...})
 *   - bootstrap() reads substrate intent and builds the right instances
 *   - MCP server + dashboard wire to whichever SkillStore the substrate picks
 *   - Programmatic opts.skillStore wins over substrate config
 *   - substrate config wins over built-in default
 *   - Custom form surfaces a clear error in sync bootstrap (deferred to follow-up)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, defaultRegistry } from "../src/bootstrap.js";
import { loadConnectorsConfig } from "../src/connectors/config.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { SqliteSkillStore } from "../src/connectors/sqlite-skill-store.js";
import { ConnectorNotFoundError } from "../src/errors.js";

describe("substrate config parser", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "substrate-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("parses short-form skill_store: sqlite", () => {
    const path = join(home, "connectors.json");
    writeFileSync(path, JSON.stringify({ substrate: { skill_store: "sqlite" } }));
    const r = loadConnectorsConfig({ path });
    expect(r.errors).toEqual([]);
    expect(r.substrate?.skill_store).toEqual({ type: "sqlite" });
  });

  it("parses short-form skill_store: filesystem", () => {
    const path = join(home, "connectors.json");
    writeFileSync(path, JSON.stringify({ substrate: { skill_store: "filesystem" } }));
    const r = loadConnectorsConfig({ path });
    expect(r.errors).toEqual([]);
    expect(r.substrate?.skill_store).toEqual({ type: "filesystem" });
  });

  it("parses null as explicit no-substrate", () => {
    const path = join(home, "connectors.json");
    writeFileSync(path, JSON.stringify({ substrate: { local_model: null } }));
    const r = loadConnectorsConfig({ path });
    expect(r.errors).toEqual([]);
    expect(r.substrate?.local_model).toBeNull();
  });

  it("parses object form with config", () => {
    const path = join(home, "connectors.json");
    writeFileSync(path, JSON.stringify({
      substrate: { skill_store: { type: "sqlite", config: { dbPath: "/custom/skills.db" } } },
    }));
    const r = loadConnectorsConfig({ path });
    expect(r.errors).toEqual([]);
    expect(r.substrate?.skill_store).toEqual({
      type: "sqlite",
      config: { dbPath: "/custom/skills.db" },
    });
  });

  it("parses custom form with module path", () => {
    const path = join(home, "connectors.json");
    writeFileSync(path, JSON.stringify({
      substrate: {
        skill_store: { type: "custom", module: "./my-store.js", export: "MyStore", config: { foo: "bar" } },
      },
    }));
    const r = loadConnectorsConfig({ path });
    expect(r.errors).toEqual([]);
    expect(r.substrate?.skill_store).toMatchObject({
      type: "custom",
      module: "./my-store.js",
      export: "MyStore",
    });
  });

  it("rejects unknown type for slot", () => {
    const path = join(home, "connectors.json");
    writeFileSync(path, JSON.stringify({ substrate: { skill_store: "redis" } }));
    const r = loadConnectorsConfig({ path });
    expect(r.errors.some((e) => /unknown type 'redis'/.test(e))).toBe(true);
  });

  it("rejects unknown slot name", () => {
    const path = join(home, "connectors.json");
    writeFileSync(path, JSON.stringify({ substrate: { trace_store: "filesystem" } }));
    const r = loadConnectorsConfig({ path });
    expect(r.errors.some((e) => /unknown slot/.test(e))).toBe(true);
  });

  it("rejects short-form 'custom' (requires module)", () => {
    const path = join(home, "connectors.json");
    writeFileSync(path, JSON.stringify({ substrate: { skill_store: "custom" } }));
    const r = loadConnectorsConfig({ path });
    expect(r.errors.some((e) => /'custom' requires object form/.test(e))).toBe(true);
  });

  it("ignores _* underscore-prefixed keys (inline comments)", () => {
    const path = join(home, "connectors.json");
    writeFileSync(path, JSON.stringify({
      substrate: { _comment: "this is a comment", skill_store: "sqlite" },
    }));
    const r = loadConnectorsConfig({ path });
    expect(r.errors).toEqual([]);
    expect(r.substrate?.skill_store).toEqual({ type: "sqlite" });
  });

  it("coexists with MCP connector entries", () => {
    const path = join(home, "connectors.json");
    writeFileSync(path, JSON.stringify({
      substrate: { skill_store: "sqlite" },
      somemcp: { class: "RemoteMcpConnector", config: { command: "echo", args: [] } },
    }));
    const r = loadConnectorsConfig({ path });
    expect(r.substrate?.skill_store).toEqual({ type: "sqlite" });
    expect(r.connectors.some((c) => c.name === "somemcp")).toBe(true);
  });
});

describe("bootstrap — substrate dispatch", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "substrate-boot-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("defaults to FilesystemSkillStore when no substrate config", () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    expect(wired.skillStore).toBeInstanceOf(FilesystemSkillStore);
  });

  it("wires SqliteSkillStore when substrate.skill_store='sqlite'", () => {
    const cfg = join(home, "connectors.json");
    writeFileSync(cfg, JSON.stringify({ substrate: { skill_store: "sqlite" } }));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      connectorsConfigPath: cfg,
    });
    expect(wired.skillStore).toBeInstanceOf(SqliteSkillStore);
  });

  it("MCP server skill_list returns Sqlite-backed skills when substrate is sqlite", async () => {
    const cfg = join(home, "connectors.json");
    writeFileSync(cfg, JSON.stringify({ substrate: { skill_store: "sqlite" } }));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      connectorsConfigPath: cfg,
    });
    await wired.skillStore.store("via-sqlite",
      "# Skill: via-sqlite\n# Status: Approved\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    const resp = await wired.mcpServer.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "skill_list", arguments: {} },
    }) as { result: { content: Array<{ text: string }> } };
    const catalog = JSON.parse(resp.result.content[0]!.text);
    const allSkills = [...(catalog.receives ?? []), ...(catalog.skills ?? []), ...(catalog.headless ?? [])];
    expect(allSkills.some((s: { name: string }) => s.name === "via-sqlite")).toBe(true);
  });

  it("respects custom dbPath from substrate config", () => {
    const customDb = join(home, "custom-skills.db");
    const cfg = join(home, "connectors.json");
    writeFileSync(cfg, JSON.stringify({
      substrate: { skill_store: { type: "sqlite", config: { dbPath: customDb } } },
    }));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      connectorsConfigPath: cfg,
    });
    expect(wired.skillStore).toBeInstanceOf(SqliteSkillStore);
    // Write a skill — file should land at customDb.
    void wired.skillStore.store("a",
      "# Skill: a\n# Status: Draft\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    // Existence check via separate fs stat
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(customDb)).toBe(true);
  });

  it("programmatic opts.skillStore wins over substrate config", () => {
    const cfg = join(home, "connectors.json");
    writeFileSync(cfg, JSON.stringify({ substrate: { skill_store: "sqlite" } }));
    const explicit = new FilesystemSkillStore(join(home, "skills"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      connectorsConfigPath: cfg,
      skillStore: explicit,
    });
    expect(wired.skillStore).toBe(explicit);
  });

  it("surfaces clear error for custom form (deferred sync-bootstrap support)", () => {
    const cfg = join(home, "connectors.json");
    writeFileSync(cfg, JSON.stringify({
      substrate: {
        skill_store: { type: "custom", module: "./nonexistent.js" },
      },
    }));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      connectorsConfigPath: cfg,
    });
    // Custom form errors are in connectorConfigErrors. SkillStore falls back to default.
    expect(wired.connectorConfigErrors.some((e) => /not yet supported via connectors\.json/.test(e))).toBe(true);
    expect(wired.skillStore).toBeInstanceOf(FilesystemSkillStore);
  });

  it("substrate.data_store='sqlite' wires SqliteDataStore", () => {
    const cfg = join(home, "connectors.json");
    writeFileSync(cfg, JSON.stringify({ substrate: { data_store: "sqlite" } }));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "memories.db"),
      connectorsConfigPath: cfg,
    });
    expect(wired.registry.hasDataStore("primary")).toBe(true);
  });

  it("defaultRegistry — opts.skillStore overrides bundled default", () => {
    const custom = new SqliteSkillStore({ dbPath: ":memory:" });
    const { skillStore } = defaultRegistry({ skillsDir: join(home, "skills"), skillStore: custom });
    expect(skillStore).toBe(custom);
  });
});

describe("substrate-aware error message — Concern 1 patch (Perry's `7b107241`)", () => {
  it("$ llm against null local_model surfaces substrate.local_model remediation", () => {
    const err = new ConnectorNotFoundError("primary", "mcp_connector", "$", "R", "llm");
    expect(err.message).toMatch(/No `llm` connector wired/);
    expect(err.remediation).toMatch(/substrate\.local_model:\s*'ollama'/);
    expect(err.remediation).toMatch(/connectors\.json/);
    expect(err.remediation).toMatch(/LocalModel/);
    expect(err.remediation).toMatch(/docs\/configuration\.md/);
  });

  it("$ data_read against null data_store surfaces substrate.data_store remediation", () => {
    const err = new ConnectorNotFoundError("primary", "mcp_connector", "$", "R","data_read");
    expect(err.message).toMatch(/No `data_read` connector wired/);
    expect(err.remediation).toMatch(/substrate\.data_store:\s*'sqlite'/);
    expect(err.remediation).toMatch(/DataStore/);
  });

  it("$ data_write — same substrate-aware copy as $ data_read", () => {
    const err = new ConnectorNotFoundError("primary", "mcp_connector", "$", "R", "data_write");
    expect(err.message).toMatch(/No `data_write` connector wired/);
    expect(err.remediation).toMatch(/substrate\.data_store:\s*'sqlite'/);
  });

  it("non-bridge connector name — falls back to generic 'register via API' copy", () => {
    const err = new ConnectorNotFoundError("youtrack", "mcp_connector", "$", "R", "youtrack");
    expect(err.message).toMatch(/mcp_connector 'youtrack' not registered/);
    expect(err.remediation).toMatch(/registermcpConnector/i);
    expect(err.remediation).not.toMatch(/substrate\./);
  });

  it("qualified `$ <name>.<tool>` form — generic copy (not bare bridge)", () => {
    // Caller passes bareBridgeTool=undefined when op.mcpConnector is set
    // (i.e., explicit `$ llm.run prompt=...` rather than bare `$ llm prompt=...`).
    const err = new ConnectorNotFoundError("llm", "mcp_connector", "$", "R", undefined);
    expect(err.message).toMatch(/mcp_connector 'llm' not registered/);
    expect(err.remediation).not.toMatch(/substrate\./);
  });

  it("integration — bare $ llm against null local_model produces substrate-aware error end-to-end", async () => {
    const home = mkdtempSync(join(tmpdir(), "substrate-err-"));
    try {
      const wired = bootstrap({
        skillsDir: join(home, "skills"),
        traceDir: join(home, "traces"),
        // No local_model in substrate; no connectors.json. Bare `$ llm` should fail.
      });
      await wired.skillStore.store("llm-probe",
        "# Skill: llm-probe\n# Status: Approved\nt:\n    $ llm prompt=\"hi\" -> R\n    emit(text=\"$(R)\")\ndefault: t\n");
      const resp = await wired.mcpServer.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "execute_skill", arguments: { skill_name: "llm-probe" } },
      }) as { result: { content: Array<{ text: string }> } };
      const result = JSON.parse(resp.result.content[0]!.text);
      const errors = (result.errors as Array<{ remediation?: string }>) ?? [];
      const dispatchErr = errors.find((e) => /substrate\.local_model/.test(e.remediation ?? ""));
      expect(dispatchErr, `expected substrate-aware error; got: ${JSON.stringify(errors, null, 2)}`).toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
