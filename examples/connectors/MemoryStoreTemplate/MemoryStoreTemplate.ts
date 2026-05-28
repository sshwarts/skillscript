/**
 * MemoryStoreTemplate — fork-me skeleton for writing your own MemoryStore impl.
 *
 * This is NOT a runnable connector. Every method throws a "TODO" error. The
 * purpose is to surface the MemoryStore contract surface in a copy-and-customize
 * shape so adopters writing AMP-, Pinecone-, Weaviate-, Qdrant-, or
 * Postgres-backed MemoryStores have a starting skeleton.
 *
 * Forking workflow:
 *   1. Copy this directory into your codebase (`cp -r examples/connectors/MemoryStoreTemplate examples/connectors/MyMemoryStore`)
 *   2. Rename the class — typically `<Substrate>MemoryStore` (e.g., `PineconeMemoryStore`, `AmpMemoryStore`)
 *   3. Implement each method against your substrate's API
 *   4. Update `staticCapabilities()` to declare what your impl actually supports
 *   5. Register from your adopter bootstrap:
 *        `registry.registerMemoryStore("primary", new MyMemoryStore({ ... }))`
 *   6. Validate via the conformance suite:
 *        `MemoryStoreConformance.buildTests({ build: () => new MyMemoryStore(...), ctor: MyMemoryStore })`
 *
 * See `src/connectors/memory-store.ts` for the working reference implementation
 * (`SqliteMemoryStore` — SQLite + FTS5 backing). The full contract spec lives in
 * `src/connectors/types.ts` (`MemoryStore` interface + `PortableMemory` +
 * `QueryFilters` + `MemoryWrite` types).
 *
 * Runtime hosts (MCP server + web dashboard) honor whichever MemoryStore impl
 * you register via the registry, so once your fork passes the conformance
 * suite the entire `$ memory` / `$ memory_write` dispatch path reads + writes
 * against your substrate.
 */

import type {
  MemoryStore,
  QueryFilters,
  PortableMemory,
  MemoryWrite,
  MemoryWriteRecord,
  StaticCapabilities,
  ManifestInfo,
} from "../../../src/connectors/types.js";

/** Replace with your substrate's connection config (host, dbName, API key, etc.). */
export interface MemoryStoreTemplateConfig {
  // TODO — declare the fields your substrate needs to connect.
  // Examples:
  //   pineconeApiKey?: string;
  //   pineconeEnvironment?: string;
  //   weaviateUrl?: string;
  //   ampVault?: string;
  exampleConfigField?: string;
}

export class MemoryStoreTemplate implements MemoryStore {
  /**
   * Declare what your impl supports. The runtime + lint consult these flags
   * before exercising features. Set conservatively — overclaiming triggers
   * cryptic downstream failures; underclaiming hides usable features.
   */
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "memory_store",
      implementation: "MemoryStoreTemplate", // ← rename to your class name
      contract_version: "1.0.0",
      features: {
        // TODO — set each flag based on what your substrate can actually do.
        supports_writes: false,                  // can write() persist new memories?
        supports_tag_filter: false,              // can query() filter by domain_tags?
        supports_semantic: false,                // mode="semantic" supported?
        supports_rerank: false,                  // mode="rerank" supported?
        supports_thread_status_filter: false,    // can query() filter by thread_status?
        supports_pinning: false,                 // does the substrate track pinned: true?
        supports_decay_model: false,             // does the substrate honor decay_model?
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: MemoryStoreTemplateConfig) {
    // TODO — establish your substrate connection. For SQL: open the database
    // + run schema migrations. For vector DB: cache the SDK client + index
    // name. For HTTP: store the base URL + auth headers.
    throw new Error("MemoryStoreTemplate is a fork-me skeleton; replace with your impl.");
  }

  /**
   * Capability snapshot for `runtime_capabilities` discovery. Return free-form
   * substrate-specific metadata (kind, version, supported modes, score range, etc.).
   *
   * The bundled `SqliteMemoryStore.manifest()` returns:
   *   { capabilities_version: "1", manifest: { kind: "sqlite-fts",
   *       supported_modes: ["fts"], score_range: "unbounded",
   *       supported_filters: ["domain_tags"], supports_write: true } }
   */
  async manifest(): Promise<ManifestInfo> {
    // TODO — return a snapshot of your substrate's capabilities.
    throw new Error("TODO: manifest() — return substrate-specific capability snapshot.");
  }

  /**
   * Query memories by mode + filter. Return `PortableMemory[]` ordered by
   * relevance (most relevant first). Empty result is fine; never throw "not
   * found" — return [].
   *
   * `QueryFilters` shape:
   *   - `query`: string (search terms; substrate-specific interpretation)
   *   - `limit`: number (max results)
   *   - `mode`: "fts" | "semantic" | "rerank" | substrate-specific string
   *   - Plus arbitrary additional filter fields (`domain_tags`, `thread_status`,
   *     `payload_type`, `pinned`, `agent_id`, etc.) — substrate honors what
   *     it supports, ignores the rest. Per the curated-subset framing in
   *     `types.ts`, these top-level fields are first-class for substrates
   *     that have them.
   *
   * `PortableMemory` core fields:
   *   - Always: `id`, `summary`, `created_at`
   *   - Often: `detail`, `score`, `domain_tags`, `payload_type`
   *   - Per-substrate (curated): `pinned`, `confidence`, `thread_status`,
   *     `recipients`, `expires_at`, `agent_id`, `vault`
   *   - Catch-all: `metadata` object for substrate-specific extensions
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async query(_filters: QueryFilters): Promise<PortableMemory[]> {
    // TODO — translate `filters` to your substrate's query API.
    //   - Reject unsupported `mode` values with a clear error (don't silently
    //     fall back; cold authors will be confused)
    //   - Apply curated-subset filters (domain_tags, payload_type, etc.) where
    //     the substrate supports them
    //   - Map your substrate's result rows into `PortableMemory` shape
    //   - Order by relevance (most relevant first)
    //   - Honor `limit`
    throw new Error("TODO: query() — return PortableMemory[] ordered by relevance.");
  }

  /**
   * Persist a new memory entry. Return the substrate-assigned `id` +
   * `created_at` (unix seconds).
   *
   * `MemoryWrite` shape:
   *   - `content`: string (required; the memory body)
   *   - `tags`: string[] (optional; routed to substrate's tag mechanism)
   *   - `recipients`: string[] (optional advisory — substrates with alerting
   *     machinery use this to route notifications, e.g., AMP's mailbox model)
   *   - `expires_at`: number (optional; unix seconds — substrate-side TTL)
   *   - `metadata`: Record<string, unknown> (catch-all for substrate-specific
   *     extensions like `vault`, `payload_type`, `confidence`)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async write(_entry: MemoryWrite): Promise<MemoryWriteRecord> {
    // TODO — persist the memory via your substrate.
    //   - Generate or accept an id (substrate-dependent)
    //   - Persist content + tags + metadata
    //   - Apply recipients hint if your substrate has alerting
    //   - Apply expires_at if your substrate has TTL
    //   - Return { id, created_at }
    throw new Error("TODO: write() — persist memory; return { id, created_at }.");
  }
}
