// v0.7.2 — `MemoryStoreMcpConnector`. Bridge class that exposes a registered
// `MemoryStore` instance as an `McpConnector`, so the canonical
// `$ memory mode=... query=... limit=N` MCP-dispatch path works in default
// deployments without adopter wiring.
//
// Per Perry's v0.7.2 kickoff (d284763f) + Scott's substrate-portability
// architectural decision (831c2661 thread) + Perry's bundled-memory-call
// scope-lock (5f471b0a).
//
// **Bundled surface is ONE canonical call.** Read-only FTS-flavored query:
//
//   $ <connector_name> mode="fts|semantic|rerank" query="..." limit=N [...extras] -> R
//
// where R is `{items: PortableMemory[]}` envelope (consistent with the
// object-iteration-advisory hint pattern: cold authors write
// `foreach M in ${R.items}`).
//
// Explicitly NOT in this bridge: `memory_write`, by-id lookup, thread
// operations, introspection / traversal / promote / reinforce. Those
// are substrate-specific and adopter-wired via the dotted form
// (e.g., `$ amp.amp_write_memory ...`).
//
// Substrate-portability: skills written against this bridge's shape
// work across any `MemoryStore` interface impl. The bundled
// `SqliteMemoryStore` is the reference impl; adopters with FTS-style
// substrates implement `MemoryStore` and the bridge transparently
// wraps. Fundamentally-different substrates (vector DBs, embedding-
// based stores) wire under different connector names with their own
// surface — this bridge stays canonical FTS-flavored.
//
// Wiring: auto-registered at bootstrap as connector instance "memory"
// pointing at the "default" MemoryStore registration. Adopters override
// by re-registering "memory" with their own bridge instance OR a
// different MCP connector entirely.

import type {
  McpConnector,
  McpDispatchCtx,
  StaticCapabilities,
  ManifestInfo,
  MemoryStore,
  MemoryWrite,
  QueryFilters,
} from "./types.js";

const CONTRACT_VERSION = "1.0.0";

export class MemoryStoreMcpConnector implements McpConnector {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "mcp_connector",
      implementation: "MemoryStoreMcpConnector",
      contract_version: CONTRACT_VERSION,
      features: {
        supports_identity_propagation: false,
        supports_streaming_responses: false,
        supports_batch: false,
        supports_write: true,
      },
    };
  }

  constructor(private readonly memoryStore: MemoryStore) {}

  async call(
    toolName: string,
    args: Record<string, unknown>,
    _ctxOverrides?: McpDispatchCtx,
  ): Promise<unknown> {
    // v0.8.0 — toolName discrimination. The same bridge instance can be
    // registered under multiple connector names (e.g., "memory" + "memory_write")
    // so bare-form dispatch via name-match routes both to this impl. The
    // toolName tells us which substrate method to invoke.
    if (toolName === "memory_write") {
      return this.dispatchWrite(args);
    }
    return this.dispatchQuery(args);
  }

  private async dispatchQuery(args: Record<string, unknown>): Promise<unknown> {
    const query = typeof args["query"] === "string" ? args["query"] : "";
    if (query === "") {
      throw new Error("MemoryStoreMcpConnector: `query` kwarg is required and must be a non-empty string.");
    }
    const mode = typeof args["mode"] === "string" && args["mode"] !== "" ? args["mode"] : "fts";
    let limit = 10;
    const rawLimit = args["limit"];
    if (typeof rawLimit === "number" && rawLimit > 0) {
      limit = rawLimit;
    } else if (typeof rawLimit === "string") {
      const n = parseInt(rawLimit, 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
    // Pass extras (anything beyond mode/query/limit) verbatim — substrate
    // impls may consume domain_tags, vault, payload_type, etc.
    const filters: QueryFilters = { query, limit, mode };
    for (const [k, v] of Object.entries(args)) {
      if (k === "query" || k === "limit" || k === "mode") continue;
      filters[k] = v;
    }
    const items = await this.memoryStore.query(filters);
    // Envelope-wrap per the canonical contract. Cold-author iteration
    // pattern: `foreach M in ${R.items}` (consistent with the v0.7.2
    // object-iteration-advisory's hint).
    return { items };
  }

  private async dispatchWrite(args: Record<string, unknown>): Promise<unknown> {
    // v0.8.0 — canonical `$ memory_write content=... [recipients=...] [tags=...]
    // [expires_at=N] [metadata={...}] -> R` shape. Returns the substrate-
    // assigned `{id, created_at}`.
    const content = typeof args["content"] === "string" ? args["content"] : "";
    if (content === "") {
      throw new Error("MemoryStoreMcpConnector: `content` kwarg is required for memory_write and must be a non-empty string.");
    }
    const entry: MemoryWrite = { content };
    if (Array.isArray(args["tags"]) && args["tags"].every((t) => typeof t === "string")) {
      entry.tags = args["tags"] as string[];
    }
    if (Array.isArray(args["recipients"]) && args["recipients"].every((r) => typeof r === "string")) {
      entry.recipients = args["recipients"] as string[];
    }
    if (typeof args["expires_at"] === "number") {
      entry.expires_at = args["expires_at"];
    }
    if (args["metadata"] !== undefined && args["metadata"] !== null && typeof args["metadata"] === "object" && !Array.isArray(args["metadata"])) {
      entry.metadata = args["metadata"] as Record<string, unknown>;
    }
    return this.memoryStore.write(entry);
  }

  async manifest(): Promise<ManifestInfo> {
    const msManifest = await this.memoryStore.manifest();
    return {
      capabilities_version: "1",
      manifest: {
        kind: "memory-store-bridge",
        wraps: msManifest.manifest ?? {},
      },
    };
  }
}
