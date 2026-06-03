import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpMcpConnector } from "../src/connectors/http-mcp.js";
import {
  KNOWN_CONNECTOR_CLASSES,
  listKnownConnectorClasses,
  loadConnectorsConfig,
} from "../src/connectors/config.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.16.5 — HttpMcpConnector tests. Spins up a real local HTTP server
 * per test that speaks the Streamable HTTP MCP protocol so the connector
 * exercises the full session-handshake + SSE-parsing + tool-dispatch path
 * end-to-end against actual sockets — no mocks of fetch or HTTP semantics.
 *
 * The mock server's behavior matches the lift-checklist from warm-adopter
 * memory `41fedec6`:
 *   - `initialize` returns an `mcp-session-id` response header
 *   - `notifications/initialized` is accepted before `tools/call` works
 *   - responses are `text/event-stream` (`event: message\ndata: <json>`)
 *   - multi-frame responses use the terminal frame as the reply
 *   - identity headers (X-* / Authorization) are echoed back for inspection
 */

interface MockServerOpts {
  /** Tool surface to advertise via tools/list. */
  tools?: Array<{ name: string }>;
  /** Per-tool response payload. `content[0]` shape. */
  toolResponses?: Record<string, { type: string; text?: string } | { type: string; data: unknown }>;
  /** Per-tool, return an error result instead of a normal one. */
  toolErrors?: Record<string, { code: number; message: string }>;
  /** When set, prepend a notification frame before the reply frame in the SSE response. */
  prependNotificationFrame?: boolean;
  /** Required header values — if request missing them, server responds with 401. */
  requireHeaders?: Record<string, string>;
  /** When true, server refuses tools/call requests that arrive without an `mcp-session-id` header. */
  enforceSessionId?: boolean;
}

interface MockServerHandle {
  server: Server;
  url: string;
  /** Capture of all requests received (method, headers, body). */
  capturedRequests: Array<{ method: string; headers: Record<string, string | string[] | undefined>; body: unknown }>;
  close(): Promise<void>;
}

function startMockServer(opts: MockServerOpts = {}): Promise<MockServerHandle> {
  return new Promise((resolve, reject) => {
    const tools = opts.tools ?? [{ name: "echo" }];
    const toolResponses = opts.toolResponses ?? { echo: { type: "text", text: JSON.stringify({ ok: true }) } };
    const toolErrors = opts.toolErrors ?? {};
    const capturedRequests: MockServerHandle["capturedRequests"] = [];
    let sessionCounter = 0;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => {
        let parsed: { jsonrpc?: string; method?: string; id?: number | string; params?: Record<string, unknown> } = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        capturedRequests.push({ method: parsed.method ?? "<unparseable>", headers: req.headers, body: parsed });

        // Required-header gating (auth scenarios).
        if (opts.requireHeaders !== undefined) {
          for (const [k, v] of Object.entries(opts.requireHeaders)) {
            if (req.headers[k.toLowerCase()] !== v) {
              res.statusCode = 401;
              res.end();
              return;
            }
          }
        }

        if (parsed.method === "initialize") {
          sessionCounter++;
          const sessionId = `test-session-${sessionCounter}`;
          res.setHeader("mcp-session-id", sessionId);
          res.setHeader("content-type", "text/event-stream");
          const reply = JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: { protocolVersion: "2025-06-18", serverInfo: { name: "http-mock", version: "1.0" } },
          });
          res.end(`event: message\ndata: ${reply}\n\n`);
          return;
        }

        if (parsed.method === "notifications/initialized") {
          res.statusCode = 202;
          res.end();
          return;
        }

        // From here on, all real RPC requests should carry an mcp-session-id
        // when enforceSessionId is set.
        if (opts.enforceSessionId === true && req.headers["mcp-session-id"] === undefined) {
          res.statusCode = 400;
          res.end();
          return;
        }

        if (parsed.method === "tools/list") {
          res.setHeader("content-type", "text/event-stream");
          const reply = JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { tools } });
          res.end(`event: message\ndata: ${reply}\n\n`);
          return;
        }

        if (parsed.method === "tools/call") {
          const name = (parsed.params?.["name"] ?? "") as string;
          res.setHeader("content-type", "text/event-stream");
          let mainReply: string;
          if (toolErrors[name] !== undefined) {
            const err = toolErrors[name]!;
            mainReply = JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: err });
          } else {
            const content = toolResponses[name];
            if (content === undefined) {
              mainReply = JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32601, message: `unknown tool: ${name}` } });
            } else {
              mainReply = JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { content: [content] } });
            }
          }

          if (opts.prependNotificationFrame === true) {
            const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { value: 0.5 } });
            res.end(`event: message\ndata: ${notif}\n\nevent: message\ndata: ${mainReply}\n\n`);
          } else {
            res.end(`event: message\ndata: ${mainReply}\n\n`);
          }
          return;
        }

        res.statusCode = 400;
        res.end();
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}/`;
      resolve({
        server,
        url,
        capturedRequests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
    server.on("error", reject);
  });
}

describe("v0.16.5 — HttpMcpConnector", () => {
  let mock: MockServerHandle | undefined;
  afterEach(async () => {
    if (mock !== undefined) {
      await mock.close();
      mock = undefined;
    }
  });

  it("performs the initialize handshake and captures mcp-session-id on first dispatch", async () => {
    mock = await startMockServer({ enforceSessionId: true });
    const connector = new HttpMcpConnector({ endpoint: mock.url });

    const result = await connector.call("echo", { x: 1 });
    expect(result).toEqual({ ok: true });

    // Verify the handshake sequence:
    // 1. initialize  → server sets mcp-session-id
    // 2. notifications/initialized  → protocol-mandatory
    // 3. tools/call  → carries the captured session id
    const methods = mock.capturedRequests.map((r) => r.method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);

    const toolCallReq = mock.capturedRequests[2]!;
    expect(toolCallReq.headers["mcp-session-id"]).toBe("test-session-1");
  });

  it("sends notifications/initialized BEFORE any tools/call (protocol-mandatory per 41fedec6 item #2)", async () => {
    mock = await startMockServer();
    const connector = new HttpMcpConnector({ endpoint: mock.url });
    await connector.call("echo", {});

    const initIdx = mock.capturedRequests.findIndex((r) => r.method === "initialize");
    const notifIdx = mock.capturedRequests.findIndex((r) => r.method === "notifications/initialized");
    const callIdx = mock.capturedRequests.findIndex((r) => r.method === "tools/call");
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(notifIdx).toBeGreaterThan(initIdx);
    expect(callIdx).toBeGreaterThan(notifIdx);
  });

  it("dedupes concurrent first-call dispatches into a single handshake", async () => {
    mock = await startMockServer();
    const connector = new HttpMcpConnector({ endpoint: mock.url });

    // Fire 3 concurrent calls before the handshake has completed.
    const [r1, r2, r3] = await Promise.all([
      connector.call("echo", { i: 1 }),
      connector.call("echo", { i: 2 }),
      connector.call("echo", { i: 3 }),
    ]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    expect(r3).toEqual({ ok: true });

    const inits = mock.capturedRequests.filter((r) => r.method === "initialize");
    expect(inits.length).toBe(1);
  });

  it("parses the terminal JSON-RPC frame when the SSE response is multi-frame (per 41fedec6 item #3)", async () => {
    mock = await startMockServer({
      prependNotificationFrame: true,
      toolResponses: { echo: { type: "text", text: JSON.stringify({ value: 42 }) } },
    });
    const connector = new HttpMcpConnector({ endpoint: mock.url });
    const result = await connector.call("echo", {});
    // The result must come from the terminal frame (the reply), NOT the
    // prepended notification frame.
    expect(result).toEqual({ value: 42 });
  });

  it("JSON-parses text-shaped tool replies (content[0].text)", async () => {
    mock = await startMockServer({
      toolResponses: { echo: { type: "text", text: JSON.stringify({ pi: 3.14, nested: { a: 1 } }) } },
    });
    const connector = new HttpMcpConnector({ endpoint: mock.url });
    const result = await connector.call("echo", {}) as { pi: number; nested: { a: number } };
    expect(result.pi).toBe(3.14);
    expect(result.nested.a).toBe(1);
  });

  it("falls back to raw text when content[0].text is not JSON-parseable", async () => {
    mock = await startMockServer({
      toolResponses: { echo: { type: "text", text: "plain string response" } },
    });
    const connector = new HttpMcpConnector({ endpoint: mock.url });
    const result = await connector.call("echo", {});
    expect(result).toBe("plain string response");
  });

  it("returns the full result block when content is not text-shaped", async () => {
    mock = await startMockServer({
      toolResponses: { echo: { type: "image", data: { mime: "image/png", b64: "ABC" } } as never },
    });
    const connector = new HttpMcpConnector({ endpoint: mock.url });
    const result = await connector.call("echo", {}) as { content: unknown[] };
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content[0] as { type: string }).type).toBe("image");
  });

  it("throws on JSON-RPC error replies with code + message", async () => {
    mock = await startMockServer({
      toolErrors: { fail: { code: -32000, message: "server-side rejection" } },
      tools: [{ name: "fail" }],
    });
    const connector = new HttpMcpConnector({ endpoint: mock.url });
    await expect(connector.call("fail", {})).rejects.toThrow(/error -32000.*server-side rejection/);
  });

  it("passes configured static headers (auth, identity) on every request", async () => {
    mock = await startMockServer({
      requireHeaders: { "x-agent-id": "agent-42", "authorization": "Bearer secret-token" },
    });
    const connector = new HttpMcpConnector({
      endpoint: mock.url,
      headers: { "X-Agent-ID": "agent-42", "Authorization": "Bearer secret-token" },
    });
    const result = await connector.call("echo", {});
    expect(result).toEqual({ ok: true });
    // Verify every captured request carried the headers (not just the first).
    for (const r of mock.capturedRequests) {
      expect(r.headers["x-agent-id"]).toBe("agent-42");
      expect(r.headers["authorization"]).toBe("Bearer secret-token");
    }
  });

  it("manifest() exposes endpoint + framing + tools_available via tools/list introspection", async () => {
    mock = await startMockServer({
      tools: [{ name: "tool_a" }, { name: "tool_b" }, { name: "tool_c" }],
    });
    const connector = new HttpMcpConnector({ endpoint: mock.url });
    const m = await connector.manifest();
    expect(m.manifest["kind"]).toBe("http-mcp");
    expect(m.manifest["endpoint"]).toBe(mock.url);
    expect(m.manifest["framing"]).toBe("json-rpc+sse");
    expect(m.manifest["tools_available"]).toEqual(["tool_a", "tool_b", "tool_c"]);
    expect(m.manifest["fetch_error"]).toBeUndefined();
  });

  it("manifest() reports fetch_error when server is unreachable (graceful degradation)", async () => {
    // Bind a server then immediately close it to get an unreachable URL.
    const tmp = await startMockServer();
    const url = tmp.url;
    await tmp.close();

    const connector = new HttpMcpConnector({ endpoint: url });
    const m = await connector.manifest();
    expect(m.manifest["kind"]).toBe("http-mcp");
    expect(m.manifest["endpoint"]).toBe(url);
    expect(m.manifest["tools_available"]).toBeUndefined();
    expect(typeof m.manifest["fetch_error"]).toBe("string");
  });

  it("staticTools() returns null — tool surface is runtime-discovered", () => {
    expect(HttpMcpConnector.staticTools()).toBeNull();
  });

  it("staticCapabilities() declares the McpConnector contract surface", () => {
    const caps = HttpMcpConnector.staticCapabilities();
    expect(caps.connector_type).toBe("mcp_connector");
    expect(caps.implementation).toBe("HttpMcpConnector");
    expect(caps.contract_version).toBe("1.0.0");
    // v0.16.8 — honest declaration. Single-value contract means end-to-end
    // propagation; per-pinned-session substrates need per-identity-sessions
    // (later ring) for actual propagation. False until that lands.
    expect(caps.features["supports_identity_propagation"]).toBe(false);
  });

  it("fromConfig validates `endpoint` is a non-empty string", () => {
    expect(() => HttpMcpConnector.fromConfig({})).toThrow(/endpoint/);
    expect(() => HttpMcpConnector.fromConfig({ endpoint: "" })).toThrow(/endpoint/);
    expect(() => HttpMcpConnector.fromConfig({ endpoint: 42 as never })).toThrow(/endpoint/);
  });

  it("fromConfig validates `headers` shape when provided", () => {
    expect(() => HttpMcpConnector.fromConfig({ endpoint: "http://x", headers: "not-an-object" as never })).toThrow(/headers/);
    expect(() => HttpMcpConnector.fromConfig({ endpoint: "http://x", headers: ["array", "not", "object"] as never })).toThrow(/headers/);
  });

  it("constructor validates endpoint", () => {
    expect(() => new HttpMcpConnector({ endpoint: "" })).toThrow(/endpoint/);
  });
});

describe("v0.16.5 — HttpMcpConnector class registration + connectors.json wiring", () => {
  it("HttpMcpConnector is in the bundled KNOWN_CONNECTOR_CLASSES set", () => {
    expect(KNOWN_CONNECTOR_CLASSES.has("HttpMcpConnector")).toBe(true);
  });

  it("HttpMcpConnector surfaces via listKnownConnectorClasses() for discovery + lint", () => {
    expect(listKnownConnectorClasses()).toContain("HttpMcpConnector");
  });

  it("declarative wiring from connectors.json constructs an instance via fromConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "v0165-http-mcp-"));
    const cfgPath = join(dir, "connectors.json");
    writeFileSync(cfgPath, JSON.stringify({
      my_remote: {
        class: "HttpMcpConnector",
        config: { endpoint: "https://example.invalid/mcp", headers: { "Authorization": "Bearer xyz" } },
      },
    }, null, 2));
    const result = loadConnectorsConfig({ path: cfgPath });
    expect(result.errors).toEqual([]);
    const entry = result.connectors.find((c) => c.name === "my_remote");
    expect(entry).toBeDefined();
    expect(entry!.className).toBe("HttpMcpConnector");
    expect(entry!.instance).toBeInstanceOf(HttpMcpConnector);
  });
});
