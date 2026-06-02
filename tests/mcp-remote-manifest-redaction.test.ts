import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteMcpConnector } from "../src/connectors/mcp-remote.js";

// Sub-charter 3b: manifest() must not return args verbatim. Env-block
// substitution applies at wire-time, so a configured arg like
// `Authorization: Bearer ${API_KEY}` becomes the literal token in
// `config.args` after registration. Surfacing those substituted args
// through `runtime_capabilities` (which calls connector.manifest())
// would leak credentials across the MCP wire to any consumer that asks
// for runtime capabilities.

const LSP_MOCK = String.raw`
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const headers = buf.slice(0, headerEnd).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(headers);
    if (m === null) { buf = buf.slice(headerEnd + 4); continue; }
    const len = Number(m[1]);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + len) break;
    const body = buf.slice(bodyStart, bodyStart + len).toString("utf8");
    buf = buf.slice(bodyStart + len);
    const req = JSON.parse(body);
    if (req.method === "initialize") {
      const out = JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05" } });
      process.stdout.write("Content-Length: " + Buffer.byteLength(out, "utf8") + "\r\n\r\n" + out);
    } else if (req.method === "tools/list") {
      const out = JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "ping" }] } });
      process.stdout.write("Content-Length: " + Buffer.byteLength(out, "utf8") + "\r\n\r\n" + out);
    } else if (req.method === "shutdown") {
      const out = JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null });
      process.stdout.write("Content-Length: " + Buffer.byteLength(out, "utf8") + "\r\n\r\n" + out);
      setTimeout(() => process.exit(0), 50);
    }
  }
});
`;

function writeMock(): string {
  const dir = mkdtempSync(join(tmpdir(), "redact-mock-"));
  const path = join(dir, "mock.cjs");
  writeFileSync(path, LSP_MOCK);
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

describe("RemoteMcpConnector.manifest() redaction (audit finding #3)", () => {
  it("returns args_count + args_redacted, never the raw args array", async () => {
    const mock = writeMock();
    const c = track(new RemoteMcpConnector({
      command: "node",
      args: [mock, "Authorization: Bearer sk-real-secret-token-12345", "--mode=test"],
    }));
    const manifest = await c.manifest();
    const inner = manifest.manifest as Record<string, unknown>;
    expect(inner["args_redacted"]).toBe(true);
    expect(inner["args_count"]).toBe(3);
    expect(inner["args"]).toBeUndefined();
    // Defense-in-depth: stringify the whole manifest and assert no
    // recognizable secret-shape leaks through any nested field.
    const json = JSON.stringify(manifest);
    expect(json).not.toContain("sk-real-secret");
    expect(json).not.toContain("Bearer");
  });

  it("preserves command name (not a credential surface)", async () => {
    const mock = writeMock();
    const c = track(new RemoteMcpConnector({ command: "node", args: [mock] }));
    const manifest = await c.manifest();
    expect((manifest.manifest as Record<string, unknown>)["command"]).toBe("node");
    expect((manifest.manifest as Record<string, unknown>)["kind"]).toBe("remote");
  });
});
