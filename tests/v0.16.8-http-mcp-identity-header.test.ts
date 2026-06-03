import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpMcpConnector } from "../src/connectors/http-mcp.js";

/**
 * v0.16.8 — HttpMcpConnector honesty fix per warm-agent's `1e1c9305` finding.
 *
 * v0.16.5 shipped HttpMcpConnector declaring `supports_identity_propagation: true`
 * but the impl ignored ctx entirely — only sent static `baseHeaders`. Same
 * discipline-only-contracts class as model=/|json/etc.
 *
 * v0.16.8 closes the connector-contract gap (Level 1):
 *   - `identityHeader` config field names the per-call identity header
 *   - call(ctx) reads ctx.agentId and emits the configured header per call
 *   - staticCapabilities() declares `supports_identity_propagation: false`
 *     until end-to-end propagation works (Level 2) — that needs
 *     per-identity sessions in a later ring against substrates with
 *     session-pinning behavior.
 */

interface MockHandle {
  server: Server;
  url: string;
  /** Per-request capture of headers received (only tools/call requests). */
  capturedToolCallHeaders: Array<Record<string, string | string[] | undefined>>;
  close(): Promise<void>;
}

function startMock(): Promise<MockHandle> {
  return new Promise((resolve, reject) => {
    const capturedToolCallHeaders: MockHandle["capturedToolCallHeaders"] = [];
    let sessionCounter = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => { body += c.toString(); });
      req.on("end", () => {
        let parsed: { method?: string; id?: number; params?: Record<string, unknown> } = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        if (parsed.method === "initialize") {
          sessionCounter++;
          res.setHeader("mcp-session-id", `s-${sessionCounter}`);
          res.setHeader("content-type", "text/event-stream");
          const reply = JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "id-mock", version: "1.0" } } });
          res.end(`event: message\ndata: ${reply}\n\n`);
          return;
        }
        if (parsed.method === "notifications/initialized") { res.statusCode = 202; res.end(); return; }
        if (parsed.method === "tools/call") {
          capturedToolCallHeaders.push(req.headers);
          res.setHeader("content-type", "text/event-stream");
          const reply = JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { content: [{ type: "text", text: '{"ok": true}' }] } });
          res.end(`event: message\ndata: ${reply}\n\n`);
          return;
        }
        if (parsed.method === "tools/list") {
          res.setHeader("content-type", "text/event-stream");
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { tools: [] } })}\n\n`);
          return;
        }
        res.statusCode = 400; res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}/`,
        capturedToolCallHeaders,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
    server.on("error", reject);
  });
}

describe("v0.16.8 — HttpMcpConnector identity header threading (honesty fix)", () => {
  let mock: MockHandle | undefined;
  afterEach(async () => {
    if (mock !== undefined) { await mock.close(); mock = undefined; }
  });

  it("emits configured identityHeader per call when ctx.agentId is supplied", async () => {
    mock = await startMock();
    const c = new HttpMcpConnector({ endpoint: mock.url, identityHeader: "X-Agent-Id" });
    await c.call("echo", {}, { agentId: "alice" });
    expect(mock.capturedToolCallHeaders.length).toBe(1);
    expect(mock.capturedToolCallHeaders[0]!["x-agent-id"]).toBe("alice");
  });

  it("does NOT emit identityHeader when ctx is absent (falls through to static baseHeaders)", async () => {
    mock = await startMock();
    const c = new HttpMcpConnector({ endpoint: mock.url, identityHeader: "X-Agent-Id" });
    await c.call("echo", {});
    expect(mock.capturedToolCallHeaders[0]!["x-agent-id"]).toBeUndefined();
  });

  it("does NOT emit identityHeader when identityHeader config is absent (substrate-neutral default)", async () => {
    mock = await startMock();
    // No identityHeader configured. Even with ctx.agentId, no per-call header
    // is emitted — adopter opted out by not configuring.
    const c = new HttpMcpConnector({ endpoint: mock.url });
    await c.call("echo", {}, { agentId: "alice" });
    expect(mock.capturedToolCallHeaders[0]!["x-agent-id"]).toBeUndefined();
  });

  it("identity header value updates per call (different ctx.agentId → different header)", async () => {
    mock = await startMock();
    const c = new HttpMcpConnector({ endpoint: mock.url, identityHeader: "X-Agent-Id" });
    await c.call("echo", {}, { agentId: "alice" });
    await c.call("echo", {}, { agentId: "bob" });
    expect(mock.capturedToolCallHeaders.length).toBe(2);
    expect(mock.capturedToolCallHeaders[0]!["x-agent-id"]).toBe("alice");
    expect(mock.capturedToolCallHeaders[1]!["x-agent-id"]).toBe("bob");
  });

  it("identity header coexists with static baseHeaders (both emitted)", async () => {
    mock = await startMock();
    const c = new HttpMcpConnector({
      endpoint: mock.url,
      identityHeader: "X-Agent-Id",
      headers: { "Authorization": "Bearer token123" },
    });
    await c.call("echo", {}, { agentId: "alice" });
    expect(mock.capturedToolCallHeaders[0]!["authorization"]).toBe("Bearer token123");
    expect(mock.capturedToolCallHeaders[0]!["x-agent-id"]).toBe("alice");
  });

  it("staticCapabilities declares supports_identity_propagation:false (honest until per-identity-sessions ships)", () => {
    const caps = HttpMcpConnector.staticCapabilities();
    expect(caps.features["supports_identity_propagation"]).toBe(false);
  });

  it("fromConfig accepts identityHeader when supplied", async () => {
    mock = await startMock();
    const c = HttpMcpConnector.fromConfig({ endpoint: mock.url, identityHeader: "X-Custom-Id" });
    await c.call("echo", {}, { agentId: "carol" });
    expect(mock.capturedToolCallHeaders[0]!["x-custom-id"]).toBe("carol");
  });

  it("fromConfig ignores empty-string identityHeader (substrate-neutral default behavior)", async () => {
    mock = await startMock();
    const c = HttpMcpConnector.fromConfig({ endpoint: mock.url, identityHeader: "" });
    await c.call("echo", {}, { agentId: "alice" });
    // Empty-string config treated as "not configured" — no header emitted.
    const headers = mock.capturedToolCallHeaders[0]!;
    expect(headers[""]).toBeUndefined();
    // Sanity: alice didn't end up under some other key
    const headerValues = Object.values(headers).filter((v) => typeof v === "string");
    expect(headerValues.includes("alice")).toBe(false);
  });

  it("empty ctx.agentId string is ignored (falls through to no-header path)", async () => {
    mock = await startMock();
    const c = new HttpMcpConnector({ endpoint: mock.url, identityHeader: "X-Agent-Id" });
    await c.call("echo", {}, { agentId: "" });
    expect(mock.capturedToolCallHeaders[0]!["x-agent-id"]).toBeUndefined();
  });
});
