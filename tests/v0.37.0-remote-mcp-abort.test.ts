/**
 * 0.37.0 — RemoteMcpConnector honors the deadline/timeout AbortSignal.
 *
 * When the runtime aborts a dispatch (per-op `timeout=` or a run `# Deadline:`),
 * the connector must cancel the in-flight RPC promptly instead of leaving it
 * pending on the subprocess until `callTimeoutMs`. Spec 035c3219 (Perry's brief
 * hang) — the leg already bounds via OpTimeoutError at the runtime layer; this
 * closes the residual leak (a serial-subprocess connector could otherwise block
 * the next dispatch until the internal timeout).
 */
import { describe, it, expect } from "vitest";
import { RemoteMcpConnector } from "../src/connectors/mcp-remote.js";

// A newline-framed stdio MCP server whose `hang` tool NEVER replies.
const SERVER = `
let buf='';
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0,i); buf = buf.slice(i+1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'mini',version:'1'}}});
    else if (m.method === 'tools/list') send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'hang',inputSchema:{type:'object',properties:{}}}]}});
    else if (m.method === 'tools/call') { /* hang: never reply */ }
  }
});
function send(o){ process.stdout.write(JSON.stringify(o)+'\\n'); }
`;

describe("0.37.0 — RemoteMcpConnector honors ctx.signal (true cancel)", () => {
  it("an aborted signal rejects the in-flight call PROMPTLY, not at callTimeoutMs", async () => {
    // callTimeoutMs deliberately large so a "waited the internal timeout" bug is obvious.
    const conn = new RemoteMcpConnector({ command: process.execPath, args: ["-e", SERVER], framing: "newline", callTimeoutMs: 30_000 });
    try {
      const controller = new AbortController();
      const t0 = Date.now();
      const p = conn.call("hang", {}, { signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      await expect(p).rejects.toThrow(/abort/i);
      expect(Date.now() - t0).toBeLessThan(2000); // cut on abort (~100ms), NOT the 30s internal timeout
    } finally {
      await conn.dispose();
    }
  }, 15000);

  it("an already-aborted signal rejects immediately without dispatching", async () => {
    const conn = new RemoteMcpConnector({ command: process.execPath, args: ["-e", SERVER], framing: "newline", callTimeoutMs: 30_000 });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(conn.call("hang", {}, { signal: controller.signal })).rejects.toThrow(/abort/i);
    } finally {
      await conn.dispose();
    }
  }, 15000);
});
