/**
 * v0.23.1 — RemoteMcpConnector respawn-on-child-death (adopter finding 15463781).
 *
 * The connector latched a PERMANENT error when its stdio child exited and never
 * respawned — a single child death (e.g. an external SIGTERM, code=143) was a
 * total connector outage until full process restart. start() now self-heals:
 * a dead prior session is discarded and the next dispatch relaunches it.
 */
import { describe, it, expect } from "vitest";
import { RemoteMcpConnector } from "../src/connectors/mcp-remote.js";
import { Registry } from "../src/connectors/registry.js";

// A minimal newline-framed stdio MCP server. `echo` returns its args; `die`
// exits the process with code 143 (the SIGTERM exit the adopter saw).
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
    else if (m.method === 'tools/list') send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo',inputSchema:{type:'object',properties:{msg:{type:'string'}}}},{name:'die',inputSchema:{type:'object',properties:{}}}]}});
    else if (m.method === 'tools/call') {
      if (m.params.name === 'die') process.exit(143);
      send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify(m.params.arguments)}]}});
    }
  }
});
function send(o){ process.stdout.write(JSON.stringify(o)+'\\n'); }
`;

function mk(): RemoteMcpConnector {
  return new RemoteMcpConnector({ command: process.execPath, args: ["-e", SERVER], framing: "newline" });
}
function textOf(result: unknown): unknown {
  const c = (result as { content?: Array<{ text?: string }> }).content;
  return JSON.parse(c![0]!.text!);
}

describe("v0.23.1 — RemoteMcpConnector respawn-on-child-death", () => {
  it("respawns after the child exits, instead of latching a permanent error", async () => {
    const conn = mk();
    try {
      // 1. First dispatch spawns the child + works.
      expect(textOf(await conn.call("echo", { msg: "hi" }))).toEqual({ msg: "hi" });

      // 2. `die` kills the child mid-request — that dispatch rejects.
      await expect(conn.call("die", {})).rejects.toBeTruthy();

      // 3. The NEXT dispatch must self-heal (respawn), not throw a terminal
      //    "in error state" — this is the regression the fix closes.
      expect(textOf(await conn.call("echo", { msg: "again" }))).toEqual({ msg: "again" });
    } finally {
      await conn.dispose();
    }
  });

  it("describeTools() also self-heals after a child death", async () => {
    const conn = mk();
    try {
      expect((await conn.describeTools()).map((t) => t.name)).toContain("echo");
      await expect(conn.call("die", {})).rejects.toBeTruthy();
      // describeTools goes through start() too — should respawn + return the surface.
      expect((await conn.describeTools()).map((t) => t.name)).toContain("echo");
    } finally {
      await conn.dispose();
    }
  });

  // #3b — registry.disposeAll() reaps connector children on shutdown.
  it("Registry.disposeAll() disposes a wired RemoteMcpConnector (reaps the child)", async () => {
    const registry = new Registry();
    const conn = mk();
    registry.registerMcpConnector("mini", conn);
    expect(textOf(await conn.call("echo", { msg: "x" }))).toEqual({ msg: "x" }); // spawns the child
    await registry.disposeAll();
    // Post-dispose dispatch must throw — proves dispose() ran (child killed + disposed flag set).
    await expect(conn.call("echo", { msg: "y" })).rejects.toThrow(/disposed/);
  });
});
