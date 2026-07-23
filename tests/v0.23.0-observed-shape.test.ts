/**
 * v0.23.0 — observed output-shape capture (connector-discovery ring, phase 1).
 *
 * A `$ conn.tool` dispatch records the UNWRAPPED bound value's shape (keys/types,
 * not values) into the trace store's sidecar cache; skill_preflight surfaces the
 * last-observed shape for the skill's tools. Capture rides the real run path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";
import { Scheduler } from "../src/scheduler.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { describeValueShape, isShapeWorthRecording } from "../src/observed-shape.js";
import type { McpConnector, McpToolDescriptor, ManifestInfo } from "../src/connectors/types.js";

describe("v0.23.0 — describeValueShape", () => {
  it("describes an object as keys → type names (no values)", () => {
    const s = describeValueShape({ results: ["a"], query: "x", count: 2, ok: true, extra: null });
    expect(s).toEqual({ kind: "object", keys: { results: "array", query: "string", count: "number", ok: "boolean", extra: "null" } });
  });
  it("describes an array by its first element's shape", () => {
    const s = describeValueShape([{ title: "a", score: 1 }]);
    expect(s).toEqual({ kind: "array", element: { kind: "object", keys: { title: "string", score: "number" } } });
  });
  it("describes a scalar by kind", () => {
    expect(describeValueShape("hi")).toEqual({ kind: "string" });
  });
  it("isShapeWorthRecording keeps structured + non-empty text, skips shapeless", () => {
    expect(isShapeWorthRecording({ a: 1 })).toBe(true);
    expect(isShapeWorthRecording([1])).toBe(true);
    // Text returns ARE worth recording — ddg.search etc. return a formatted
    // string, and "it's text, not an object" is the answer an author needs.
    expect(isShapeWorthRecording("Found 2 results: ...")).toBe(true);
    expect(isShapeWorthRecording([])).toBe(false);
    expect(isShapeWorthRecording("")).toBe(false);
    expect(isShapeWorthRecording(null)).toBe(false);
    expect(isShapeWorthRecording(undefined)).toBe(false);
  });
});

describe("v0.23.0 — FilesystemTraceStore observed-shape cache", () => {
  let dir: string;
  let store: FilesystemTraceStore;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "v0.23.0-shape-")); store = new FilesystemTraceStore(join(dir, "traces")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records + reads back a shape; last-write-wins", async () => {
    await store.recordObservedShape!({ connector: "ddg", tool: "search", shape: { kind: "object", keys: { a: "string" } }, observed_at_ms: 1 });
    await store.recordObservedShape!({ connector: "ddg", tool: "search", shape: { kind: "object", keys: { a: "string", b: "number" } }, observed_at_ms: 2 });
    const got = await store.getObservedShapes!([{ connector: "ddg", tool: "search" }]);
    expect(got.get("ddg.search")!.shape).toEqual({ kind: "object", keys: { a: "string", b: "number" } });
    expect(got.get("ddg.search")!.observed_at_ms).toBe(2);
  });

  it("a sidecar at the trace root does not break query/get/prune", async () => {
    await store.recordObservedShape!({ connector: "x", tool: "y", shape: { kind: "object", keys: {} }, observed_at_ms: 1 });
    // These walk the trace root; the observed-shapes.json sidecar must be skipped, not throw.
    await expect(store.query({})).resolves.toEqual([]);
    await expect(store.get("nope")).resolves.toBeNull();
    await expect(store.prune(0)).resolves.toBe(0);
  });
});

// Fake connector: call() returns a structured object; describeTools() advertises search.
const SEARCH: McpToolDescriptor = {
  name: "search",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
class FakeMcpConnector implements McpConnector {
  // `returns` mirrors how real MCP tools behave: ddg.search returns a TEXT blob
  // (string), others return structured objects. The probe caught that a fake
  // returning only an object missed the text-capture path entirely.
  constructor(private readonly returns: unknown = { results: ["a", "b"], query: "x", count: 2 }) {}
  static staticCapabilities() {
    return { connector_type: "mcp_connector" as const, implementation: "FakeMcpConnector", contract_version: "1.0.0", features: {} };
  }
  async call(): Promise<unknown> { return this.returns; }
  async manifest(): Promise<ManifestInfo> { return { capabilities_version: "1", manifest: { kind: "fake" } } as ManifestInfo; }
  async describeTools(): Promise<McpToolDescriptor[]> { return [SEARCH]; }
}

function rpc(method: string, params: unknown): JsonRpcRequest { return { jsonrpc: "2.0", id: 1, method, params } as JsonRpcRequest; }
async function callTool(srv: McpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await srv.handle(rpc("tools/call", { name, arguments: args }));
  if ("error" in resp) throw new Error((resp as { error: { message: string } }).error.message);
  const r = resp as { result: { content: Array<{ text: string }> } };
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

describe("v0.23.0 — observed-shape end-to-end (run → preflight)", () => {
  let dir: string;
  let srv: McpServer;
  let skillStore: FilesystemSkillStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v0.23.0-e2e-"));
    skillStore = new FilesystemSkillStore(join(dir, "skills"));
    const traceStore = new FilesystemTraceStore(join(dir, "traces"));
    const registry = new Registry();
    registry.registerSkillStore("primary", skillStore);
    registry.registerMcpConnector("ddg", new FakeMcpConnector());
    const scheduler = new Scheduler({ registry, skillStore, traceStore });
    srv = new McpServer({ skillStore, scheduler, traceStore, registry });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("captures the tool's output shape on execute_skill, surfaces it in skill_preflight", async () => {
    await skillStore.store(
      "searcher",
      `# Skill: searcher\n# Status: Approved\n# Vars: TOPIC\n\nrun:\n    $ ddg.search query="\${TOPIC}" -> R\n    emit(text="done")\ndefault: run\n`,
      { status: "Approved" },
    );
    // Before any run: no observed shape yet.
    const before = await callTool(srv, "skill_preflight", { name: "searcher" });
    const ctBefore = before["connector_tools"] as Array<Record<string, unknown>>;
    expect(ctBefore[0]!["observed_output_shape"]).toBeUndefined();

    // Run it — the $ ddg.search dispatch records the shape.
    await callTool(srv, "execute_skill", { name: "searcher", inputs: { TOPIC: "skillscript" } });

    // Now preflight surfaces the last-observed output shape for ddg.search.
    const after = await callTool(srv, "skill_preflight", { name: "searcher" });
    const ct = after["connector_tools"] as Array<Record<string, unknown>>;
    expect(ct[0]!["connector"]).toBe("ddg");
    expect(ct[0]!["observed_output_shape"]).toEqual({
      kind: "object",
      keys: { results: "array", query: "string", count: "number" },
    });
    expect(typeof ct[0]!["observed_at_ms"]).toBe("number");
  });

  // Perry (pdf-extract): authors reach for runtime_capabilities({tool}) to answer
  // "what does this return?" — it must carry the observed shape too, not only
  // skill_preflight (which requires already having a skill that references it).
  it("surfaces observed_output_shape via runtime_capabilities({tool}), not just skill_preflight", async () => {
    await skillStore.store(
      "searcher",
      `# Skill: searcher\n# Status: Approved\n# Vars: TOPIC\n\nrun:\n    $ ddg.search query="\${TOPIC}" -> R\n    emit(text="done")\ndefault: run\n`,
      { status: "Approved" },
    );
    // Before any run: the tool fetch has the input schema but no observed shape.
    const before = await callTool(srv, "runtime_capabilities", { tool: "ddg.search" });
    expect((before["toolSchema"] as Record<string, unknown>)["observed_output_shape"]).toBeUndefined();

    await callTool(srv, "execute_skill", { name: "searcher", inputs: { TOPIC: "skillscript" } });

    const after = await callTool(srv, "runtime_capabilities", { tool: "ddg.search" });
    const ts = after["toolSchema"] as Record<string, unknown>;
    expect(ts["observed_output_shape"]).toEqual({
      kind: "object",
      keys: { results: "array", query: "string", count: "number" },
    });
    expect(typeof ts["observed_at_ms"]).toBe("number");
  });

  it("captures a TEXT-returning tool's shape as {kind: string} (the ddg.search reality the probe found)", async () => {
    // Rebuild the server with a connector that returns a formatted text blob.
    const d2 = mkdtempSync(join(tmpdir(), "v0.23.0-txt-"));
    try {
      const ss = new FilesystemSkillStore(join(d2, "skills"));
      const ts = new FilesystemTraceStore(join(d2, "traces"));
      const reg = new Registry();
      reg.registerSkillStore("primary", ss);
      reg.registerMcpConnector("ddg", new FakeMcpConnector("Found 2 search results:\n\n1. ...\n2. ..."));
      const sched = new Scheduler({ registry: reg, skillStore: ss, traceStore: ts });
      const server = new McpServer({ skillStore: ss, scheduler: sched, traceStore: ts, registry: reg });
      await ss.store(
        "txtsearch",
        `# Skill: txtsearch\n# Status: Approved\n# Vars: TOPIC\n\nrun:\n    $ ddg.search query="\${TOPIC}" -> R\n    emit(text="ok")\ndefault: run\n`,
        { status: "Approved" },
      );
      await callTool(server, "execute_skill", { name: "txtsearch", inputs: { TOPIC: "x" } });
      const pf = await callTool(server, "skill_preflight", { name: "txtsearch" });
      const ct = pf["connector_tools"] as Array<Record<string, unknown>>;
      expect(ct[0]!["observed_output_shape"]).toEqual({ kind: "string" });
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });
});
