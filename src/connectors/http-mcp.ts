// v0.16.5 — Bundled generic HTTP MCP connector. Speaks Streamable HTTP MCP
// transport (JSON-RPC over HTTP + Server-Sent Events) for any compliant MCP
// server. Substrate-neutral by design: AMP, Anthropic-hosted MCP, GitHub MCP,
// Linear MCP, and any other MCP server speaking the spec all work via the
// same connector class with different `endpoint` + `headers` config.
//
// Compare to `RemoteMcpConnector` (mcp-remote.ts): that one spawns a child
// process to bridge stdio MCPs to this runtime. `HttpMcpConnector` cuts out
// the subprocess and speaks HTTP/SSE directly — lower latency, no node
// child process per connector, direct control over connection lifecycle.
//
// **Transport details** (learned the hard way per warm-adopter memory
// `41fedec6`, which documents the lift checklist these six items came from):
//
//   1. `initialize` returns an `mcp-session-id` RESPONSE header. The client
//      MUST capture it and echo on every subsequent request.
//   2. `notifications/initialized` MUST be sent after `initialize` and
//      before any `tools/call`. Protocol-mandatory step.
//   3. Responses arrive as `text/event-stream` (`event: message\n
//      data: <json>` frames). Take the terminal JSON-RPC frame —
//      multi-frame responses where a trailing notification masquerades as
//      the reply are the easy-to-miss edge case.
//   4. Static auth/identity headers are passed through verbatim. Adopters
//      configure these per-server (e.g. `Authorization: Bearer ...`,
//      `X-Agent-ID: ...`).
//   5. Result unwrap: when the tool reply carries `content[0].text` shaped
//      as a JSON string, parse it and return the parsed object. Falls
//      back to raw text or the full `result` block when not text-shaped.
//      Generic to MCP — not substrate-specific.
//   6. `staticTools()` returns `null` (runtime-discovered); `manifest()`
//      populates `tools_available` via a `tools/list` call.
//
// Adopter-side tool-name normalization (e.g., `service.tool_name` →
// `service_tool_name`) is deliberately NOT here — it's a naming
// convenience belonging at the adopter layer, not transport. Adopters
// wanting it wrap this connector or compose it with their own layer.
//
// Source: lifted from warm-adopter's `amp-mcp-client.ts` (commit 844a19e
// in the adopter's tree) per Perry's v0.16.4 sign-off in `934fc9d8`.
// Generalized substrate-specifics out at the lift boundary.

import { RUNTIME_VERSION } from "../version.js";
import type {
  McpConnector,
  McpDispatchCtx,
  McpConnectorCapabilities,
  ManifestInfo,
} from "./types.js";

const CONTRACT_VERSION = "1.0.0";
const DEFAULT_CLIENT_NAME = "skillscript-runtime-http-mcp";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export interface HttpMcpConfig {
  /** Streamable HTTP MCP endpoint URL. */
  endpoint: string;
  /**
   * Static request headers. Auth tokens (`Authorization: Bearer ...`),
   * identity (`X-Agent-ID: ...`), etc. Passed verbatim on every request.
   */
  headers?: Record<string, string>;
  /**
   * v0.16.8 — adopter-configurable per-call identity header name. When
   * set, `call(toolName, args, ctx)` reads `ctx.agentId` and emits this
   * header per call (e.g., `identityHeader: "X-Agent-ID"` → requests
   * carry `X-Agent-ID: <ctx.agentId>` when ctx is supplied). When the
   * header value would be empty (no ctx, no agentId), the header is
   * omitted — falls through to `headers` static defaults.
   *
   * Default `undefined` — no per-call identity threading. Adopters
   * configure per their substrate's auth convention; no substrate-
   * specific defaults are bundled (substrate-neutrality).
   *
   * **Critical caveat — substrate behavior gates effectiveness:**
   *
   * Per-call identity headers achieve end-to-end propagation ONLY
   * against substrates that DON'T pin sessions per-identity. Substrates
   * with session pinning (current default for many MCP servers including
   * Streamable HTTP servers that establish identity at session-init)
   * look at the session's identity, not the per-call header. Within a
   * pinned session, swapping the header per call is a no-op against
   * such substrates.
   *
   * Real end-to-end propagation against session-pinning substrates
   * needs **per-identity session keying** — a connection pool where
   * each distinct `ctx.agentId` gets its own session. That's target
   * for a later ring; warm-adopter's prototype demonstrates the shape
   * (~40 LOC over the existing client) and validates it against live
   * AMP.
   *
   * Today's `supports_identity_propagation: false` declaration in
   * `staticCapabilities()` reflects this honestly: the connector reads
   * ctx and emits the header (Level 1 contract), but end-to-end
   * propagation (Level 2) isn't guaranteed against session-pinning
   * substrates. The flag flips true when per-identity session keying
   * lands.
   */
  identityHeader?: string;
  /**
   * Client-identity strings echoed in the `initialize` handshake. The
   * server may surface these in audit logs. Defaults to
   * `"skillscript-runtime-http-mcp"` / runtime version.
   */
  clientName?: string;
  clientVersion?: string;
  /**
   * MCP protocol version sent in the `initialize` handshake. Default
   * matches the version warm-adopter validated against
   * (`"2025-06-18"`); override only when targeting a server that
   * requires a different protocol version.
   */
  protocolVersion?: string;
}

interface JsonRpcReply {
  result?: { content?: Array<{ type: string; text?: string }>; tools?: Array<{ name?: string }> };
  error?: { code: number; message: string; data?: unknown };
  id?: number | string | null;
}

/**
 * Streamable HTTP MCP connector. Implements McpConnector against any
 * MCP server speaking the spec over HTTP. See module docstring.
 */
export class HttpMcpConnector implements McpConnector {
  private readonly endpoint: string;
  private readonly baseHeaders: Record<string, string>;
  private readonly identityHeader: string | undefined;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly protocolVersion: string;
  private sessionId: string | null = null;
  private initializing: Promise<void> | null = null;
  private cachedTools: string[] | null = null;

  constructor(config: HttpMcpConfig) {
    if (typeof config.endpoint !== "string" || config.endpoint === "") {
      throw new Error("HttpMcpConnector: `endpoint` (string, non-empty) required");
    }
    this.endpoint = config.endpoint;
    this.baseHeaders = { ...(config.headers ?? {}) };
    this.identityHeader = config.identityHeader;
    this.clientName = config.clientName ?? DEFAULT_CLIENT_NAME;
    this.clientVersion = config.clientVersion ?? RUNTIME_VERSION;
    this.protocolVersion = config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  }

  static staticCapabilities(): McpConnectorCapabilities {
    return {
      connector_type: "mcp_connector",
      implementation: "HttpMcpConnector",
      contract_version: CONTRACT_VERSION,
      features: {
        // v0.16.8 — flag intentionally `false`. Single-value contract means
        // end-to-end propagation (Level 2 in the consolidated charter): the
        // connector reads `ctx.agentId` and emits the configured identity
        // header per-call (Level 1, contract-honesty), BUT substrates that
        // pin sessions per-identity (current default for many MCP servers)
        // don't honor the per-call header within a pinned session. Real
        // end-to-end propagation needs per-identity sessions, target: later
        // ring. Until then this flag stays false; per-call header emission
        // is internal-only behavior gated by `identityHeader` config.
        supports_identity_propagation: false,
        supports_streaming_responses: false,
        supports_batch: false,
      },
    };
  }

  /**
   * v0.9.1 — runtime-discovered tool surface (no compile-time set). Tools
   * are introspected via `tools/list` at first dispatch. Adopters who want
   * compile-time validation use `allowed_tools` in connectors.json.
   */
  static staticTools(): string[] | null {
    return null;
  }

  /**
   * Factory used by the `connectors.json` loader. Validates the config
   * shape and constructs an instance. `${ENV}` substitution happens at
   * loader time, so values arrive resolved.
   */
  static fromConfig(config: Record<string, unknown>): HttpMcpConnector {
    const endpoint = config["endpoint"];
    if (typeof endpoint !== "string" || endpoint === "") {
      throw new Error("HttpMcpConnector.fromConfig: `endpoint` (string, non-empty) required");
    }
    const headers = config["headers"];
    if (headers !== undefined && (typeof headers !== "object" || headers === null || Array.isArray(headers))) {
      throw new Error("HttpMcpConnector.fromConfig: `headers` must be an object (string→string) when supplied");
    }
    const clientName = config["clientName"];
    const clientVersion = config["clientVersion"];
    const protocolVersion = config["protocolVersion"];
    const identityHeader = config["identityHeader"];
    return new HttpMcpConnector({
      endpoint,
      ...(headers !== undefined ? { headers: headers as Record<string, string> } : {}),
      ...(typeof clientName === "string" ? { clientName } : {}),
      ...(typeof clientVersion === "string" ? { clientVersion } : {}),
      ...(typeof protocolVersion === "string" ? { protocolVersion } : {}),
      ...(typeof identityHeader === "string" && identityHeader !== "" ? { identityHeader } : {}),
    });
  }

  async manifest(): Promise<ManifestInfo<"mcp_connector">> {
    let toolsAvailable: string[] | undefined;
    let fetchError: string | undefined;
    try {
      await this.ensureSession();
      toolsAvailable = this.cachedTools ?? (await this.listTools());
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }
    return {
      capabilities_version: "1",
      manifest: {
        kind: "http-mcp",
        endpoint: this.endpoint,
        framing: "json-rpc+sse",
        ...(toolsAvailable !== undefined ? { tools_available: toolsAvailable } : {}),
        ...(fetchError !== undefined ? { fetch_error: fetchError } : {}),
      },
    };
  }

  async call(toolName: string, args: Record<string, unknown>, ctx?: McpDispatchCtx): Promise<unknown> {
    await this.ensureSession();
    // v0.16.8 — per-call identity header. When the adopter configured an
    // `identityHeader` AND the runtime passed a `ctx.agentId`, emit the
    // header on this call. Falls through to `baseHeaders` static defaults
    // otherwise. Note: this closes the connector-contract gap (Level 1 of
    // the propagation work) but doesn't achieve end-to-end propagation
    // against substrates that pin sessions per-identity — per-identity
    // session work is a later ring. The
    // `supports_identity_propagation: false` declaration in
    // staticCapabilities() reflects this honesty.
    const extraHeaders: Record<string, string> = {};
    if (this.identityHeader !== undefined && typeof ctx?.agentId === "string" && ctx.agentId !== "") {
      extraHeaders[this.identityHeader] = ctx.agentId;
    }
    const reply = await this.post({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e6),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }, false, extraHeaders);
    if (reply === null) throw new Error(`HttpMcpConnector: empty reply from ${toolName} at ${this.endpoint}`);
    if (reply.error !== undefined) {
      throw new Error(`HttpMcpConnector ${toolName} error ${reply.error.code}: ${reply.error.message}`);
    }
    const content = reply.result?.content?.[0];
    if (content?.type === "text" && typeof content.text === "string") {
      try {
        return JSON.parse(content.text) as unknown;
      } catch {
        return content.text;
      }
    }
    return reply.result;
  }

  /**
   * Discover the server's tool surface via `tools/list`. Result is cached
   * for subsequent `manifest()` calls; first dispatch may pay the
   * round-trip cost.
   */
  private async listTools(): Promise<string[]> {
    const reply = (await this.post({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e6),
      method: "tools/list",
    })) as { result?: { tools?: Array<{ name?: string }> } } | null;
    const tools = reply?.result?.tools;
    const names = Array.isArray(tools)
      ? tools.map((t) => t.name ?? "").filter((n) => n !== "")
      : [];
    this.cachedTools = names;
    return names;
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId !== null) return;
    if (this.initializing === null) {
      this.initializing = (async () => {
        await this.post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: this.protocolVersion,
            capabilities: {},
            clientInfo: { name: this.clientName, version: this.clientVersion },
          },
        });
        // Protocol-mandatory: notifications/initialized after initialize,
        // before any tools/call. Per warm-adopter checklist `41fedec6`
        // item #2.
        await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
      })();
    }
    await this.initializing;
  }

  private async post(body: unknown, isNotification = false, extraHeaders?: Record<string, string>): Promise<JsonRpcReply | null> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.baseHeaders,
      ...(extraHeaders ?? {}),
    };
    if (this.sessionId !== null) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid !== null) this.sessionId = sid;
    if (isNotification) return null;
    const text = await res.text();
    return parseSseReply(text);
  }
}

/**
 * Extract the terminal JSON-RPC object from an SSE response body.
 * MCP servers MAY send multiple `event: message\n data: <json>` frames
 * (e.g., a trailing notification frame after the reply); the contract is
 * that the LAST data frame is the response. Per `41fedec6` item #3.
 */
function parseSseReply(text: string): JsonRpcReply | null {
  const datas = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  let last: JsonRpcReply | null = null;
  for (const d of datas) {
    try {
      last = JSON.parse(d) as JsonRpcReply;
    } catch {
      // Ignore non-JSON frames (e.g., heartbeat comments).
    }
  }
  return last;
}
