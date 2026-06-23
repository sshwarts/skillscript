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
  McpToolDescriptor,
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
  /**
   * v0.16.9 — maximum number of cached per-identity sessions. When the
   * pool reaches this size, the least-recently-used entry is evicted to
   * make room for a new identity's session. Default `undefined` =
   * unlimited (suitable for adopters with bounded identity cardinality;
   * adopters with per-end-user dispatch should configure this to prevent
   * unbounded memory growth).
   *
   * Production-hardening note: idle-timeout eviction + connection
   * healthcheck are explicit v0.17+ targets. Current impl evicts only on
   * pool-size pressure; sessions are kept alive indefinitely while the
   * pool has room.
   */
  maxPoolSize?: number;
}

interface JsonRpcReply {
  result?: { content?: Array<{ type: string; text?: string }>; tools?: Array<{ name?: string }> };
  error?: { code: number; message: string; data?: unknown };
  id?: number | string | null;
}

/**
 * v0.16.9 — per-identity session entry in the connection pool. Each
 * distinct `ctx.agentId` gets its own entry (matching identity at
 * `initialize` time, so the server's pinned-session model honors the
 * intended identity). Pool keyed by identity string; default "<default>"
 * sentinel when no identity is supplied.
 *
 * Lifted from warm-adopter's `IdentityAwareAmpConnector` reference impl;
 * generalized substrate-neutral.
 */
interface SessionEntry {
  sessionId: string | null;
  initializing: Promise<void> | null;
  // v0.23.0 — cache the full descriptor (name + description + inputSchema)
  // from `tools/list`, not just the name. Feeds connector-aware input lint
  // and selective schema discovery; the manifest derives names from it.
  cachedTools: McpToolDescriptor[] | null;
}

const DEFAULT_IDENTITY_KEY = "<default>";

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
  private readonly maxPoolSize: number | undefined;
  // v0.16.9 — per-identity session pool. Map preserves insertion order;
  // bump-on-access (delete + re-set) gives free LRU ordering when pool
  // size hits `maxPoolSize`.
  private readonly sessions: Map<string, SessionEntry> = new Map();

  constructor(config: HttpMcpConfig) {
    if (typeof config.endpoint !== "string" || config.endpoint === "") {
      throw new Error("HttpMcpConnector: `endpoint` (string, non-empty) required");
    }
    if (config.maxPoolSize !== undefined && (typeof config.maxPoolSize !== "number" || config.maxPoolSize < 1 || !Number.isInteger(config.maxPoolSize))) {
      throw new Error("HttpMcpConnector: `maxPoolSize` (if set) must be a positive integer");
    }
    this.endpoint = config.endpoint;
    this.baseHeaders = { ...(config.headers ?? {}) };
    this.identityHeader = config.identityHeader;
    this.clientName = config.clientName ?? DEFAULT_CLIENT_NAME;
    this.clientVersion = config.clientVersion ?? RUNTIME_VERSION;
    this.protocolVersion = config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.maxPoolSize = config.maxPoolSize;
  }

  static staticCapabilities(): McpConnectorCapabilities {
    return {
      connector_type: "mcp_connector",
      implementation: "HttpMcpConnector",
      contract_version: CONTRACT_VERSION,
      features: {
        // v0.16.9 — flag flips to true. Per-identity session keying lands
        // in this ring (lifted + generalized from warm-adopter's
        // IdentityAwareAmpConnector reference impl). Each distinct
        // `ctx.agentId` gets its own session, pinned to that identity at
        // server-side `initialize` time. Both Level 1 (identity reaches
        // transport) AND Level 2 (distinct ctx → distinct substrate scope)
        // achieved against session-pinning substrates including AMP.
        // Adopter gates the claim via RuntimeCapabilitiesConformance
        // probe (v0.16.9 item 3).
        supports_identity_propagation: true,
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
    // Manifest uses the default-identity session for tool introspection.
    // Per-identity tool surfaces are out of scope — substrates that vary
    // tools by identity would surface that via a different mechanism.
    let toolsAvailable: string[] | undefined;
    let fetchError: string | undefined;
    const entry = this.getOrCreateEntry(DEFAULT_IDENTITY_KEY);
    try {
      await this.ensureSession(DEFAULT_IDENTITY_KEY, entry);
      const descriptors = entry.cachedTools ?? (await this.listToolsForEntry(DEFAULT_IDENTITY_KEY, entry));
      toolsAvailable = descriptors.map((t) => t.name);
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
    // v0.16.9 — per-identity session keying. Each distinct `ctx.agentId`
    // gets its own pool entry; identity is pinned at server-side
    // `initialize` time, so the substrate's session model honors it for
    // the duration of the session. End-to-end propagation (Level 1 + 2)
    // works against session-pinning substrates.
    // Per-identity pooling activates ONLY when the adopter configured an
    // identityHeader. Without it, the connector isn't threading identity
    // to the substrate, so per-identity pool entries would be pointless
    // overhead — all calls converge to the default session.
    const identityKey = this.identityHeader !== undefined
      && typeof ctx?.agentId === "string"
      && ctx.agentId !== ""
      ? ctx.agentId
      : DEFAULT_IDENTITY_KEY;
    const entry = this.getOrCreateEntry(identityKey);
    const reply = await this.dispatchWithRetry(identityKey, entry, toolName, args);
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
   * Dispatch with bounded-at-1 retry on session-mismatch. When the
   * substrate returns HTTP >= 400 (likely session-not-found / stale),
   * evict the pool entry, re-init, and retry once. Per Perry's
   * `33fefa0f` impl-nit on retry-bounding. Persistent server errors
   * after retry surface to the caller as the second-attempt failure.
   */
  private async dispatchWithRetry(
    identityKey: string,
    entry: SessionEntry,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<JsonRpcReply | null> {
    await this.ensureSession(identityKey, entry);
    const body = {
      jsonrpc: "2.0" as const,
      id: Math.floor(Math.random() * 1e6),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    };
    try {
      return await this.post(identityKey, entry, body);
    } catch (err) {
      if (!(err instanceof StaleSessionError)) throw err;
      // Stale-session retry path. Evict entry + re-init + retry once.
      // Per warm-adopter's `33fefa0f` framing: bounded at 1 to prevent
      // infinite-loop against persistent server-side errors.
      const freshEntry = this.recreateEntry(identityKey);
      await this.ensureSession(identityKey, freshEntry);
      return this.post(identityKey, freshEntry, body);
    }
  }

  private async listToolsForEntry(identityKey: string, entry: SessionEntry): Promise<McpToolDescriptor[]> {
    const reply = (await this.post(identityKey, entry, {
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e6),
      method: "tools/list",
    })) as {
      result?: { tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }> };
    } | null;
    const tools = reply?.result?.tools;
    // v0.23.0 — retain description + inputSchema (previously discarded). The
    // inputSchema is the tool's argument contract, fed to connector-aware lint.
    const descriptors: McpToolDescriptor[] = Array.isArray(tools)
      ? tools
          .filter((t): t is { name: string; description?: string; inputSchema?: Record<string, unknown> } =>
            typeof t.name === "string" && t.name !== "")
          .map((t) => ({
            name: t.name,
            ...(typeof t.description === "string" ? { description: t.description } : {}),
            ...(t.inputSchema !== undefined && t.inputSchema !== null ? { inputSchema: t.inputSchema } : {}),
          }))
      : [];
    entry.cachedTools = descriptors;
    return descriptors;
  }

  /**
   * v0.23.0 — warmed tool descriptors for connector-aware lint + discovery.
   * Ensures the default-identity session's `tools/list` is warm (read-only
   * protocol introspection, not a tool dispatch), then returns the cached
   * descriptors. Rejects if the upstream is unreachable; the caller treats
   * that as "no schema available."
   */
  async describeTools(): Promise<McpToolDescriptor[]> {
    const entry = this.getOrCreateEntry(DEFAULT_IDENTITY_KEY);
    await this.ensureSession(DEFAULT_IDENTITY_KEY, entry);
    return entry.cachedTools ?? (await this.listToolsForEntry(DEFAULT_IDENTITY_KEY, entry));
  }

  /**
   * Pool entry get-or-create. Bumps to MRU position on access (Map insert
   * order = LRU order; delete + re-set moves to end). Evicts oldest if
   * pool would exceed `maxPoolSize`.
   *
   * Documented gap (v0.17 hardening target): no time-based eviction;
   * sessions kept alive indefinitely while pool has room. Long-running
   * adopters with high identity cardinality should configure
   * `maxPoolSize`. Substrates that silently kill idle sessions without
   * surfacing an error need adopter-side healthcheck wiring.
   */
  private getOrCreateEntry(identityKey: string): SessionEntry {
    const existing = this.sessions.get(identityKey);
    if (existing !== undefined) {
      // Bump to MRU.
      this.sessions.delete(identityKey);
      this.sessions.set(identityKey, existing);
      return existing;
    }
    // Eviction check before inserting fresh.
    if (this.maxPoolSize !== undefined && this.sessions.size >= this.maxPoolSize) {
      // Map iteration order = insertion order = LRU. Delete the first
      // (oldest) entry. Mid-dispatch eviction edge: if the evicted
      // entry is mid-flight, the dispatch's session-id mismatch on
      // next attempt triggers the retry path. Per Perry's `33fefa0f`
      // option (c) — accept the rare edge, retry handles it.
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey !== undefined) this.sessions.delete(oldestKey);
    }
    const fresh: SessionEntry = { sessionId: null, initializing: null, cachedTools: null };
    this.sessions.set(identityKey, fresh);
    return fresh;
  }

  /**
   * Evict + recreate a pool entry. Used by the stale-session retry path.
   */
  private recreateEntry(identityKey: string): SessionEntry {
    this.sessions.delete(identityKey);
    return this.getOrCreateEntry(identityKey);
  }

  private async ensureSession(identityKey: string, entry: SessionEntry): Promise<void> {
    if (entry.sessionId !== null) return;
    if (entry.initializing === null) {
      entry.initializing = (async () => {
        await this.post(identityKey, entry, {
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
          identityKey, entry,
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
      })();
    }
    await entry.initializing;
  }

  private async post(
    identityKey: string,
    entry: SessionEntry,
    body: unknown,
    isNotification = false,
  ): Promise<JsonRpcReply | null> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.baseHeaders,
    };
    // v0.16.9 — per-call identity header. When configured AND identity is
    // not the default sentinel, emit the header on every request (init +
    // notifications + tools/call). Servers that pin session-to-identity
    // at initialize time consume the header at that point; servers that
    // re-check per request consume it per request.
    if (this.identityHeader !== undefined && identityKey !== DEFAULT_IDENTITY_KEY) {
      headers[this.identityHeader] = identityKey;
    }
    if (entry.sessionId !== null) headers["mcp-session-id"] = entry.sessionId;
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid !== null) entry.sessionId = sid;
    // v0.16.9 — stale-session detection. HTTP >= 400 likely indicates
    // the server-side session is dead (session-not-found, expired, etc.).
    // Throw a typed error that `dispatchWithRetry` catches + retries
    // once with a fresh entry. Notification posts don't return a reply
    // so we treat their 4xx as terminal (server rejected the notif —
    // not retryable).
    if (res.status >= 400 && !isNotification) {
      throw new StaleSessionError(`HttpMcpConnector: ${res.status} from ${this.endpoint} (likely stale session for identity '${identityKey}')`);
    }
    if (isNotification) return null;
    const text = await res.text();
    return parseSseReply(text);
  }
}

/**
 * v0.16.9 — internal signal for the stale-session retry path. Not
 * surfaced to callers; `dispatchWithRetry` catches + handles.
 */
class StaleSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleSessionError";
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
