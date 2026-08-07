import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpMcpConnector } from "../src/connectors/http-mcp.js";

/**
 * v0.39.1 — HttpMcpConnector transport-failure latch fix.
 *
 * Bug (reproduced, not inferred — thread 75d0fe6c): `ensureSession` memoized
 * the handshake promise in `entry.initializing` and never cleared it on
 * rejection. A transport-level `fetch()` throw during the handshake — e.g. the
 * MCP server restarting mid-`initialize` — left `initializing` a permanently
 * rejected promise. Every later call saw it non-null, skipped re-initializing,
 * and re-awaited the same rejection: the pool entry was WEDGED until the runtime
 * process restarted, even after the server came back healthy. `dispatchWithRetry`
 * calls `ensureSession` OUTSIDE its `StaleSessionError` catch, so the existing
 * recovery path could never fire for this failure shape.
 *
 * Ruled fix (Perry, ae25c0a3): clear `entry.initializing` on rejection — nothing
 * else. NO tool-call retry on a transport throw (a throw is silence about whether
 * a mutating effect landed; retrying could double-apply it), NO idempotency flag.
 * The latch-clear converts a permanent wedge into a transient failure the next
 * call recovers from — which alone fully resolves the reported incident.
 *
 * Acceptance criterion is two-phase and behavioral, not implementation-shaped:
 * endpoint down during handshake → call fails; endpoint back up → the NEXT call
 * on the SAME connector instance succeeds, with no restart. Only phase 2
 * distinguishes a fixed connector from a wedged one.
 */

// A mock Streamable-HTTP MCP server whose `initialize` handling can be toggled
// to destroy the socket (producing a real transport-level fetch throw) rather
// than return an HTTP status (which would be the already-handled 4xx path).
function startToggleServer(): Promise<{ server: Server; url: string; setFailHandshake: (v: boolean) => void }> {
  let failHandshake = false;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c.toString(); });
      req.on("end", () => {
        let parsed: { method?: string; id?: number | string } = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }

        if (parsed.method === "initialize") {
          if (failHandshake) {
            // Transport failure: tear down the connection with no response, so
            // the client's `fetch()` throws (socket hang up) — the exact shape
            // that latched the entry pre-fix.
            req.socket.destroy();
            return;
          }
          res.setHeader("mcp-session-id", "sess-1");
          res.setHeader("content-type", "text/event-stream");
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2025-06-18" } })}\n\n`);
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.statusCode = 202;
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          res.setHeader("content-type", "text/event-stream");
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] } })}\n\n`);
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, setFailHandshake: (v) => { failHandshake = v; } });
    });
  });
}

describe("v0.39.1 — HttpMcpConnector recovers from a transport failure during handshake", () => {
  let handle: Awaited<ReturnType<typeof startToggleServer>> | undefined;
  afterEach(async () => {
    if (handle) await new Promise<void>((r) => handle!.server.close(() => r()));
    handle = undefined;
  });

  it("endpoint down mid-handshake → call fails; endpoint back up → next call on the SAME connector succeeds (no restart)", async () => {
    handle = await startToggleServer();
    const conn = new HttpMcpConnector({ endpoint: handle.url });

    // Phase 1 — handshake transport-throws. The call fails (correctly — we don't
    // retry a transport throw), but it must NOT latch the pool entry.
    handle.setFailHandshake(true);
    await expect(conn.call("echo", {})).rejects.toThrow();

    // Phase 2 — server healthy again. The SAME connector instance must recover
    // on the next call. Pre-fix this awaited the latched rejected promise and
    // threw; post-fix the cleared latch lets it re-handshake and succeed.
    handle.setFailHandshake(false);
    const result = await conn.call("echo", {});
    expect(result).toEqual({ ok: true });
  });

  it("the latch never sticks — a fresh handshake failure on a second identity is also recoverable", async () => {
    handle = await startToggleServer();
    // identityHeader makes each distinct agentId its own pool entry, so each
    // requires its own handshake — lets us re-exercise the failure path cleanly.
    const conn = new HttpMcpConnector({ endpoint: handle.url, identityHeader: "X-Agent-ID" });

    // Identity "a": fail then recover.
    handle.setFailHandshake(true);
    await expect(conn.call("echo", {}, { agentId: "a" })).rejects.toThrow();
    handle.setFailHandshake(false);
    expect(await conn.call("echo", {}, { agentId: "a" })).toEqual({ ok: true });

    // Identity "b": a fresh entry, so a fresh handshake — same fail-then-recover.
    handle.setFailHandshake(true);
    await expect(conn.call("echo", {}, { agentId: "b" })).rejects.toThrow();
    handle.setFailHandshake(false);
    expect(await conn.call("echo", {}, { agentId: "b" })).toEqual({ ok: true });
  });
});
