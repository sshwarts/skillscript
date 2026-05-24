import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteMcpConnector, RemoteMcpDispatchError } from "../src/connectors/mcp-remote.js";
import { KNOWN_CONNECTOR_CLASSES, listKnownConnectorClasses, loadConnectorsConfig } from "../src/connectors/config.js";

/**
 * v0.4.1 — RemoteMcpConnector tests. Use a small Node mock-server
 * script that speaks the JSON-RPC stdio protocol so the tests exercise
 * the full spawn + framing + handshake + dispatch path without needing
 * any external MCP installed.
 *
 * The mock-server scripts are emitted to a temp dir per test, then
 * referenced as the `command: "node", args: [mockPath]` shape in the
 * connector config.
 */

/**
 * Mock-server script source — speaks LSP-framed JSON-RPC. Handles:
 *   - `initialize` → returns canned protocolVersion + serverInfo
 *   - `tools/list` → returns 2 fake tools
 *   - `tools/call` for `echo` → returns the args as content
 *   - `tools/call` for `fail` → returns `isError: true`
 *   - `tools/call` for `slow` → never responds (tests timeout path)
 *   - `shutdown` → exits cleanly
 *   - unknown method → returns JSON-RPC error -32601
 */
const LSP_MOCK = String.raw`
const readline = require("node:readline");
const chunks = [];
let buf = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const headers = buf.slice(0, headerEnd).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(headers);
    if (m === null) {
      buf = buf.slice(headerEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + len) break;
    const body = buf.slice(bodyStart, bodyStart + len).toString("utf8");
    buf = buf.slice(bodyStart + len);
    handleMessage(body);
  }
});

function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\r\n\r\n" + body);
}

function handleMessage(raw) {
  let req;
  try { req = JSON.parse(raw); } catch { return; }
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "lsp-mock", version: "1.0" } } });
    return;
  }
  if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "echo" }, { name: "fail" }, { name: "slow" }] } });
    return;
  }
  if (req.method === "tools/call") {
    const name = req.params && req.params.name;
    const args = (req.params && req.params.arguments) || {};
    if (name === "echo") {
      send({ jsonrpc: "2.0", id: req.id, result: { content: args, isError: false } });
      return;
    }
    if (name === "fail") {
      send({ jsonrpc: "2.0", id: req.id, result: { content: "intentional failure", isError: true } });
      return;
    }
    if (name === "slow") {
      return; // intentionally no response
    }
    send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "unknown tool: " + name } });
    return;
  }
  if (req.method === "shutdown") {
    send({ jsonrpc: "2.0", id: req.id, result: null });
    setTimeout(() => process.exit(0), 50);
    return;
  }
  send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "unknown method: " + req.method } });
}
`;

const NEWLINE_MOCK = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05" } }) + "\n");
    return;
  }
  if (req.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "ping" }] } }) + "\n");
    return;
  }
  if (req.method === "tools/call" && req.params && req.params.name === "ping") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { content: "pong" } }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "unknown" } }) + "\n");
});
`;

function writeMock(source: string, name = "mock.cjs"): string {
  const dir = mkdtempSync(join(tmpdir(), "v041-mock-"));
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

const connectorsToDispose: RemoteMcpConnector[] = [];

afterEach(async () => {
  for (const c of connectorsToDispose.splice(0)) {
    try { await c.dispose(); } catch { /* ignore */ }
  }
});

function track(c: RemoteMcpConnector): RemoteMcpConnector {
  connectorsToDispose.push(c);
  return c;
}

describe("v0.4.1 — RemoteMcpConnector closed-set registration", () => {
  it("KNOWN_CONNECTOR_CLASSES includes RemoteMcpConnector with fromConfig", () => {
    const entry = KNOWN_CONNECTOR_CLASSES.get("RemoteMcpConnector");
    expect(entry).toBeDefined();
    expect(entry!.fromConfig).toBeDefined();
  });

  it("listKnownConnectorClasses returns both v0.4.0 + v0.4.1 classes", () => {
    const list = listKnownConnectorClasses();
    expect(list).toContain("CallbackMcpConnector");
    expect(list).toContain("RemoteMcpConnector");
  });
});

describe("v0.4.1 — RemoteMcpConnector.fromConfig validation", () => {
  it("requires command (non-empty string)", () => {
    expect(() => RemoteMcpConnector.fromConfig({ command: "", args: [] })).toThrow(/`command` must be a non-empty string/);
    expect(() => RemoteMcpConnector.fromConfig({ args: [] })).toThrow(/`command` must be a non-empty string/);
  });

  it("requires args (array of strings)", () => {
    expect(() => RemoteMcpConnector.fromConfig({ command: "node", args: "not array" })).toThrow(/`args` must be an array of strings/);
    expect(() => RemoteMcpConnector.fromConfig({ command: "node", args: [1, 2] })).toThrow(/`args` must be an array of strings/);
  });

  it("rejects framing values other than 'lsp' or 'newline'", () => {
    expect(() => RemoteMcpConnector.fromConfig({ command: "node", args: [], framing: "bogus" })).toThrow(/`framing` must be "lsp" or "newline"/);
  });

  it("accepts valid lsp framing", () => {
    expect(() => RemoteMcpConnector.fromConfig({ command: "node", args: [], framing: "lsp" })).not.toThrow();
  });

  it("accepts valid newline framing", () => {
    expect(() => RemoteMcpConnector.fromConfig({ command: "node", args: [], framing: "newline" })).not.toThrow();
  });

  it("default framing is lsp when unspecified", () => {
    const c = RemoteMcpConnector.fromConfig({ command: "node", args: [] });
    expect(c).toBeDefined();
    // Internal default verified via staticCapabilities + behavior; here we just accept defined.
  });

  it("env values must be strings", () => {
    expect(() => RemoteMcpConnector.fromConfig({ command: "node", args: [], env: { X: 123 } })).toThrow(/env\['X'\] must be a string/);
  });
});

describe("v0.4.1 — RemoteMcpConnector dispatch (LSP framing)", () => {
  it("initialize handshake + tools/list + tools/call echo round-trip", async () => {
    const mock = writeMock(LSP_MOCK);
    const c = track(new RemoteMcpConnector({ command: "node", args: [mock] }));
    // RemoteMcpConnector.call returns the raw JSON-RPC result (wrapped
    // in MCP's {content, isError} envelope). Runtime's unwrapToolResult
    // does the convention-aware unwrap; library-level `.call()` callers
    // see the wire shape.
    const result = await c.call("echo", { x: 42, y: "hi" });
    expect(result).toEqual({ content: { x: 42, y: "hi" }, isError: false });
  });

  it("manifest surfaces tools_available after handshake", async () => {
    const mock = writeMock(LSP_MOCK);
    const c = track(new RemoteMcpConnector({ command: "node", args: [mock] }));
    await c.call("echo", { ping: true });
    const m = await c.manifest();
    expect(m.manifest.tools_available).toEqual(["echo", "fail", "slow"]);
  });

  it("isError: true from inner tool surfaces as DispatchError", async () => {
    const mock = writeMock(LSP_MOCK);
    const c = track(new RemoteMcpConnector({ command: "node", args: [mock] }));
    await expect(c.call("fail", {})).rejects.toThrow(RemoteMcpDispatchError);
    await expect(c.call("fail", {})).rejects.toThrow(/intentional failure/);
  });

  it("JSON-RPC error response (unknown tool) surfaces as DispatchError", async () => {
    const mock = writeMock(LSP_MOCK);
    const c = track(new RemoteMcpConnector({ command: "node", args: [mock] }));
    await expect(c.call("nope", {})).rejects.toThrow(/unknown tool: nope/);
  });

  it("call timeout fires when child never responds", async () => {
    const mock = writeMock(LSP_MOCK);
    const c = track(new RemoteMcpConnector({ command: "node", args: [mock], callTimeoutMs: 150 }));
    await expect(c.call("slow", {})).rejects.toThrow(/timed out after 150ms/);
  });
});

describe("v0.4.1 — RemoteMcpConnector dispatch (newline framing)", () => {
  it("round-trip works with newline-delimited framing", async () => {
    const mock = writeMock(NEWLINE_MOCK);
    const c = track(new RemoteMcpConnector({ command: "node", args: [mock], framing: "newline" }));
    const result = await c.call("ping", {});
    expect(result).toEqual({ content: "pong" });
  });
});

describe("v0.4.1 — RemoteMcpConnector lifecycle", () => {
  it("dispose terminates the child gracefully", async () => {
    const mock = writeMock(LSP_MOCK);
    const c = new RemoteMcpConnector({ command: "node", args: [mock] });
    await c.call("echo", { hi: 1 });
    await c.dispose();
    // Second dispose should be a no-op.
    await c.dispose();
  });

  it("dispatch after dispose throws", async () => {
    const mock = writeMock(LSP_MOCK);
    const c = new RemoteMcpConnector({ command: "node", args: [mock] });
    await c.call("echo", { hi: 1 });
    await c.dispose();
    await expect(c.call("echo", {})).rejects.toThrow();
  });

  it("spawn failure (nonexistent binary) → DispatchError on first call", async () => {
    const c = track(new RemoteMcpConnector({ command: "/tmp/definitely-nonexistent-binary-v041", args: [] }));
    await expect(c.call("any", {})).rejects.toThrow();
  });
});

describe("v0.4.1 — connectors.json with RemoteMcpConnector", () => {
  it("loadConnectorsConfig instantiates RemoteMcpConnector via fromConfig", async () => {
    const mock = writeMock(LSP_MOCK);
    const cfgDir = mkdtempSync(join(tmpdir(), "v041-cfg-"));
    const cfgPath = join(cfgDir, "connectors.json");
    writeFileSync(cfgPath, JSON.stringify({
      mock_remote: {
        class: "RemoteMcpConnector",
        config: { command: "node", args: [mock] },
      },
    }));
    const result = loadConnectorsConfig({ path: cfgPath });
    expect(result.errors).toEqual([]);
    expect(result.connectors.length).toBe(1);
    expect(result.connectors[0]!.instance).toBeDefined();
    // Dispatch end-to-end through the loaded instance.
    const inst = result.connectors[0]!.instance as RemoteMcpConnector;
    track(inst);
    const echoed = await inst.call("echo", { hello: "world" });
    expect(echoed).toEqual({ content: { hello: "world" }, isError: false });
  });

  it("connectors.json + ${ENV} substitution in RemoteMcpConnector config", () => {
    const mock = writeMock(LSP_MOCK);
    const cfgDir = mkdtempSync(join(tmpdir(), "v041-cfg-env-"));
    const cfgPath = join(cfgDir, "connectors.json");
    writeFileSync(cfgPath, JSON.stringify({
      mock_remote: {
        class: "RemoteMcpConnector",
        config: { command: "node", args: [mock], env: { TEST_AUTH: "Bearer ${TEST_V041_TOKEN}" } },
      },
    }));
    const result = loadConnectorsConfig({ path: cfgPath, env: { TEST_V041_TOKEN: "tok-xyz" } });
    expect(result.errors).toEqual([]);
    expect(result.connectors[0]!.config["env"]).toEqual({ TEST_AUTH: "Bearer tok-xyz" });
  });

  it("rejects unknown framing in connectors.json", () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "v041-cfg-bad-"));
    const cfgPath = join(cfgDir, "connectors.json");
    writeFileSync(cfgPath, JSON.stringify({
      bad: { class: "RemoteMcpConnector", config: { command: "node", args: [], framing: "weird" } },
    }));
    const result = loadConnectorsConfig({ path: cfgPath });
    expect(result.errors[0]).toMatch(/`framing` must be "lsp" or "newline"/);
  });
});
