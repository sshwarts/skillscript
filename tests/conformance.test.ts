import { describe, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SkillStoreConformance,
  MemoryStoreConformance,
  LocalModelConformance,
  McpConnectorConformance,
} from "../src/testing/index.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { SqliteMemoryStore } from "../src/connectors/memory-store.js";
import { OllamaLocalModel } from "../src/connectors/local-model.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";

/**
 * Every bundled-default connector must pass its ContractConformance suite.
 * Failures here mean a contract regression that downstream impl authors
 * would also hit. CI gates on this.
 */

describe("FilesystemSkillStore conformance", () => {
  let dirs: string[] = [];
  beforeEach(() => { dirs = []; });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const tests = SkillStoreConformance.buildTests({
    build: () => {
      const d = mkdtempSync(join(tmpdir(), "skillscript-conf-"));
      dirs.push(d);
      return new FilesystemSkillStore(d);
    },
    ctor: FilesystemSkillStore,
  });

  for (const t of tests) {
    it(`[${t.category}] ${t.name}`, t.run);
  }
});

describe("SqliteMemoryStore conformance", () => {
  let dirs: string[] = [];
  beforeEach(() => { dirs = []; });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const tests = MemoryStoreConformance.buildTests({
    build: () => {
      const d = mkdtempSync(join(tmpdir(), "skillscript-mem-"));
      dirs.push(d);
      return new SqliteMemoryStore({ dbPath: join(d, "test.db") });
    },
    ctor: SqliteMemoryStore,
    // Close the SQLite handle so Windows can unlink the file in afterEach.
    // Linux/macOS don't care (open files can be unlinked), but Windows
    // locks held files.
    teardown: async (instance) => { (instance as { close?(): void }).close?.(); },
  });

  for (const t of tests) {
    it(`[${t.category}] ${t.name}`, t.run);
  }
});

describe("OllamaLocalModel conformance (liveDispatch=false)", () => {
  const tests = LocalModelConformance.buildTests({
    build: () => new OllamaLocalModel({ defaultModelTag: "gemma2:9b", timeoutMs: 2_000 }),
    ctor: OllamaLocalModel,
    // No Ollama running in test env; feature-behavior tests for run() skip.
    liveDispatch: false,
  });

  for (const t of tests) {
    it(`[${t.category}] ${t.name}`, t.run);
  }
});

describe("CallbackMcpConnector conformance", () => {
  const tests = McpConnectorConformance.buildTests({
    build: () => new CallbackMcpConnector(async () => ({ content: [{ type: "text", text: "ok" }] })),
    ctor: CallbackMcpConnector,
  });

  for (const t of tests) {
    it(`[${t.category}] ${t.name}`, t.run);
  }
});
