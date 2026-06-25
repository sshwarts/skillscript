/**
 * v0.23.x — SkillStore.version() change-token + skill_list ETag (#1b).
 *
 * A cheap store-wide change-token (no body loads) lets skill_list short-circuit
 * the N+1 catalog rebuild on an unchanged poll — the win for remote stores.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { SqliteSkillStore } from "../src/connectors/sqlite-skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";
import { Scheduler } from "../src/scheduler.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";

const SKILL = (n: string) => `# Skill: ${n}\n# Status: Approved\n\nrun:\n    emit(text="hi")\ndefault: run\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("v0.23.x — SqliteSkillStore.version() (exact, no body load)", () => {
  let store: SqliteSkillStore;
  beforeEach(() => { store = new SqliteSkillStore({ dbPath: ":memory:" }); });
  afterEach(() => store.close());

  it("is stable without changes and moves on add / edit / status / delete", async () => {
    const v0 = await store.version();
    await store.store("a", SKILL("a"), { status: "Approved" });
    const v1 = await store.version();
    expect(v1).not.toBe(v0);
    expect(await store.version()).toBe(v1); // stable across repeat calls, no change

    await store.store("a", `# Skill: a\n# Status: Approved\n\nrun:\n    emit(text="changed")\ndefault: run\n`, { status: "Approved" });
    const v2 = await store.version();
    expect(v2).not.toBe(v1); // body edit moves the content hash

    await store.update_status("a", "Disabled");
    const v3 = await store.version();
    expect(v3).not.toBe(v2); // status change moves it

    await store.delete("a");
    expect(await store.version()).not.toBe(v3); // delete moves it
  });
});

describe("v0.23.x — FilesystemSkillStore.version() (cheap mtimes, no body load)", () => {
  let dir: string;
  let store: FilesystemSkillStore;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "v23-fsver-")); store = new FilesystemSkillStore(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is stable without changes and moves on add / delete", async () => {
    const v0 = await store.version(); // existing-but-empty dir → stable token
    await store.store("a", SKILL("a"), { status: "Approved" });
    const v1 = await store.version();
    expect(v1).not.toBe(v0);
    expect(await store.version()).toBe(v1); // stable, no change
    await sleep(5); // ensure a distinct mtime
    await store.store("b", SKILL("b"), { status: "Approved" });
    expect(await store.version()).not.toBe(v1); // new file moves the token
    await store.delete("a");
    expect(await store.version()).not.toBe(v1);
  });
});

function rpc(method: string, params: unknown): JsonRpcRequest { return { jsonrpc: "2.0", id: 1, method, params } as JsonRpcRequest; }
async function call(srv: McpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await srv.handle(rpc("tools/call", { name, arguments: args }));
  const r = resp as { result: { content: Array<{ text: string }> } };
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

describe("v0.23.x — skill_list ETag short-circuit", () => {
  let dir: string;
  let store: SqliteSkillStore;
  let srv: McpServer;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v23-etag-"));
    store = new SqliteSkillStore({ dbPath: join(dir, "skills.db") });
    const traceStore = new FilesystemTraceStore(join(dir, "traces"));
    const registry = new Registry();
    registry.registerSkillStore("primary", store);
    const scheduler = new Scheduler({ registry, skillStore: store, traceStore });
    srv = new McpServer({ skillStore: store, scheduler, traceStore, registry });
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it("returns catalog_version; matching if_none_match → not_modified; a change re-rebuilds", async () => {
    await store.store("a", SKILL("a"), { status: "Approved" });
    const first = await call(srv, "skill_list", { filter: { audience: "all", status: "Approved" } });
    const token = first["catalog_version"] as string;
    expect(typeof token).toBe("string");
    expect(first["not_modified"]).toBeUndefined();

    // Same token → short-circuit, no rebuild.
    const cached = await call(srv, "skill_list", { filter: { audience: "all", status: "Approved" }, if_none_match: token });
    expect(cached["not_modified"]).toBe(true);
    expect(cached["catalog_version"]).toBe(token);
    expect(cached["skills"]).toBeUndefined(); // catalog not built

    // A change moves the token → the old if_none_match no longer matches → full rebuild.
    await store.store("b", SKILL("b"), { status: "Approved" });
    const after = await call(srv, "skill_list", { filter: { audience: "all", status: "Approved" }, if_none_match: token });
    expect(after["not_modified"]).toBeUndefined();
    expect(after["catalog_version"]).not.toBe(token);
  });
});
