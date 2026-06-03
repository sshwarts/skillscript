import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpMcpConnector } from "../src/connectors/http-mcp.js";

/**
 * v0.16.9 item 2 — Per-identity session keying in `HttpMcpConnector`.
 *
 * Each distinct `ctx.agentId` gets its own session, pinned to that
 * identity at server-side `initialize` time. Closes the end-to-end
 * propagation (Level 2) gap that v0.16.8's per-call header couldn't
 * achieve against session-pinning substrates.
 *
 * Lifted + generalized from warm-adopter's `IdentityAwareAmpConnector`
 * reference impl per Perry's v0.16.9 charter (`f952a55b`). Validated
 * against live AMP via `299c0d20` prototype.
 */

interface MockHandle {
  server: Server;
  url: string;
  /** Per-request capture: (method, identityHeader-value, mcp-session-id). */
  capturedRequests: Array<{ method: string; identity: string | undefined; sessionId: string | undefined }>;
  close(): Promise<void>;
}

function startMock(): Promise<MockHandle> {
  return new Promise((resolve, reject) => {
    const capturedRequests: MockHandle["capturedRequests"] = [];
    // Server-side identity-pinned sessions: each session id resolves to an
    // identity captured at init time; subsequent requests under that
    // session resolve to the pinned identity (NOT the request header).
    // Models the AMP-style session-pinning substrate.
    const sessions = new Map<string, string>();  // session id → pinned identity
    let sessionCounter = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => { body += c.toString(); });
      req.on("end", () => {
        let parsed: { method?: string; id?: number } = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        const identityHeader = req.headers["x-agent-id"];
        const identity = typeof identityHeader === "string" ? identityHeader : undefined;
        const sidHeader = req.headers["mcp-session-id"];
        const sessionId = typeof sidHeader === "string" ? sidHeader : undefined;
        capturedRequests.push({ method: parsed.method ?? "<unknown>", identity, sessionId });

        if (parsed.method === "initialize") {
          sessionCounter++;
          const sid = `s-${sessionCounter}`;
          // Pin THIS session to the identity from the X-Agent-ID header at
          // init time. Models the session-pinning substrate.
          sessions.set(sid, identity ?? "<default>");
          res.setHeader("mcp-session-id", sid);
          res.setHeader("content-type", "text/event-stream");
          const reply = JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "pinned-mock", version: "1.0" } } });
          res.end(`event: message\ndata: ${reply}\n\n`);
          return;
        }
        if (parsed.method === "notifications/initialized") { res.statusCode = 202; res.end(); return; }
        // For tools/list + tools/call: resolve identity from the SESSION
        // (not from the request header — that's the session-pinning model).
        if (sessionId !== undefined && sessions.has(sessionId)) {
          const pinned = sessions.get(sessionId)!;
          res.setHeader("content-type", "text/event-stream");
          if (parsed.method === "tools/call") {
            // Reply payload reveals which identity the SESSION resolved to —
            // so the test can verify per-identity routing actually happened.
            const reply = JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: { content: [{ type: "text", text: JSON.stringify({ session_identity: pinned }) }] },
            });
            res.end(`event: message\ndata: ${reply}\n\n`);
            return;
          }
          if (parsed.method === "tools/list") {
            res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { tools: [] } })}\n\n`);
            return;
          }
        }
        // Unknown / stale session — 404 (triggers retry path).
        res.statusCode = 404;
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}/`,
        capturedRequests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
    server.on("error", reject);
  });
}

describe("v0.16.9 — HttpMcpConnector per-identity session keying", () => {
  let mock: MockHandle | undefined;
  afterEach(async () => {
    if (mock !== undefined) { await mock.close(); mock = undefined; }
  });

  it("distinct ctx.agentId → distinct sessions, each pinned to its identity", async () => {
    mock = await startMock();
    const c = new HttpMcpConnector({ endpoint: mock.url, identityHeader: "X-Agent-Id" });
    const r1 = await c.call("probe", {}, { agentId: "alice" });
    const r2 = await c.call("probe", {}, { agentId: "bob" });
    // Server's session-pinning model resolves each call to the identity
    // pinned at init time. With per-identity keying, alice + bob hit
    // distinct sessions, each pinned to their identity.
    expect(r1).toEqual({ session_identity: "alice" });
    expect(r2).toEqual({ session_identity: "bob" });
  });

  it("repeated calls under same ctx.agentId reuse the same session (pool caches by identity)", async () => {
    mock = await startMock();
    const c = new HttpMcpConnector({ endpoint: mock.url, identityHeader: "X-Agent-Id" });
    await c.call("probe", {}, { agentId: "alice" });
    await c.call("probe", {}, { agentId: "alice" });
    await c.call("probe", {}, { agentId: "alice" });
    // Should be exactly ONE initialize call (first call's handshake).
    const initCount = mock.capturedRequests.filter((r) => r.method === "initialize").length;
    expect(initCount).toBe(1);
  });

  it("no ctx (default identity) routes through the default-session pool entry", async () => {
    mock = await startMock();
    const c = new HttpMcpConnector({ endpoint: mock.url, identityHeader: "X-Agent-Id" });
    const r = await c.call("probe", {});
    expect(r).toEqual({ session_identity: "<default>" });
  });

  it("identity-header NOT configured → all calls share the default-session entry (substrate-neutral default)", async () => {
    mock = await startMock();
    // No identityHeader configured. ctx.agentId is ignored at connector
    // layer — adopter chose not to thread identity. All calls share the
    // same session.
    const c = new HttpMcpConnector({ endpoint: mock.url });
    await c.call("probe", {}, { agentId: "alice" });
    await c.call("probe", {}, { agentId: "bob" });
    const initCount = mock.capturedRequests.filter((r) => r.method === "initialize").length;
    expect(initCount).toBe(1);
  });

  it("maxPoolSize evicts LRU on overflow", async () => {
    mock = await startMock();
    const c = new HttpMcpConnector({ endpoint: mock.url, identityHeader: "X-Agent-Id", maxPoolSize: 2 });
    await c.call("probe", {}, { agentId: "alice" });
    await c.call("probe", {}, { agentId: "bob" });
    // Pool is now { alice, bob }. Adding charlie evicts alice (LRU).
    await c.call("probe", {}, { agentId: "charlie" });
    // Re-dispatch alice — pool entry is gone, fresh init triggered.
    await c.call("probe", {}, { agentId: "alice" });
    const initCount = mock.capturedRequests.filter((r) => r.method === "initialize").length;
    // Init count = 4: alice, bob, charlie, alice (re-init after eviction).
    expect(initCount).toBe(4);
  });

  it("maxPoolSize: access bumps to MRU (alice stays warm despite charlie+bob churn)", async () => {
    mock = await startMock();
    const c = new HttpMcpConnector({ endpoint: mock.url, identityHeader: "X-Agent-Id", maxPoolSize: 2 });
    await c.call("probe", {}, { agentId: "alice" });    // pool: {alice}
    await c.call("probe", {}, { agentId: "bob" });      // pool: {alice, bob}
    await c.call("probe", {}, { agentId: "alice" });    // pool: {bob, alice} (alice bumped)
    await c.call("probe", {}, { agentId: "charlie" });  // pool: {alice, charlie} (bob evicted)
    await c.call("probe", {}, { agentId: "alice" });    // alice hot — no re-init
    const initCount = mock.capturedRequests.filter((r) => r.method === "initialize").length;
    // 3 inits: alice, bob, charlie. alice's second + third call reuse.
    expect(initCount).toBe(3);
  });

  it("constructor rejects invalid maxPoolSize", () => {
    expect(() => new HttpMcpConnector({ endpoint: "http://x/", maxPoolSize: 0 })).toThrow(/positive integer/);
    expect(() => new HttpMcpConnector({ endpoint: "http://x/", maxPoolSize: -1 })).toThrow(/positive integer/);
    expect(() => new HttpMcpConnector({ endpoint: "http://x/", maxPoolSize: 1.5 })).toThrow(/positive integer/);
  });

  it("stale-session retry: server 404 triggers one bounded re-init and retry", async () => {
    // Mock that returns 404 on the FIRST tools/call (simulating stale
    // session) then succeeds on the second.
    let toolCallCount = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => { body += c.toString(); });
      req.on("end", () => {
        let parsed: { method?: string; id?: number } = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        if (parsed.method === "initialize") {
          res.setHeader("mcp-session-id", `s-${Date.now()}`);
          res.setHeader("content-type", "text/event-stream");
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: {} })}\n\n`);
          return;
        }
        if (parsed.method === "notifications/initialized") { res.statusCode = 202; res.end(); return; }
        if (parsed.method === "tools/call") {
          toolCallCount++;
          if (toolCallCount === 1) {
            // Simulate stale session — 404.
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader("content-type", "text/event-stream");
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { content: [{ type: "text", text: '{"ok":true}' }] } })}\n\n`);
          return;
        }
        res.statusCode = 400; res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const c = new HttpMcpConnector({ endpoint: url, identityHeader: "X-Agent-Id" });
      const result = await c.call("probe", {}, { agentId: "alice" });
      // After stale-session retry, the second tools/call succeeds.
      expect(result).toEqual({ ok: true });
      expect(toolCallCount).toBe(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
