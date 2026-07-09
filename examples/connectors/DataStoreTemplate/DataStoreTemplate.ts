/**
 * DataStoreTemplate — fork-me skeleton for writing your own DataStore impl.
 *
 * This is NOT a runnable connector. Every method throws a "TODO" error. The
 * purpose is to surface the DataStore contract surface in a copy-and-customize
 * shape so adopters writing AMP-, Pinecone-, Weaviate-, Qdrant-, or
 * Postgres-backed DataStores have a starting skeleton.
 *
 * Forking workflow:
 *   1. Copy this directory into your codebase (`cp -r examples/connectors/DataStoreTemplate examples/connectors/MyDataStore`)
 *   2. Rename the class — typically `<Substrate>DataStore` (e.g., `PineconeDataStore`, `AmpDataStore`)
 *   3. Implement each method against your substrate's API
 *   4. Update `staticCapabilities()` to declare what your impl actually supports
 *   5. Register from your adopter bootstrap:
 *        `registry.registerDataStore("primary", new MyDataStore({ ... }))`
 *   6. Validate via the conformance suite:
 *        `DataStoreConformance.buildTests({ build: () => new MyDataStore(...), ctor: MyDataStore })`
 *
 * See `src/connectors/data-store.ts` for the working reference implementation
 * (`SqliteDataStore` — SQLite + FTS5 backing). The full contract spec lives in
 * `src/connectors/types.ts` (`DataStore` interface + `PortableData` +
 * `QueryFilters` + `DataWrite` types).
 *
 * Runtime hosts (MCP server + web dashboard) honor whichever DataStore impl
 * you register via the registry, so once your fork passes the conformance
 * suite the entire `$ data_read` / `$ data_write` dispatch path reads + writes
 * against your substrate.
 */

import type {
  DataStore,
  QueryFilters,
  PortableData,
  DataWrite,
  DataWriteRecord,
  DataStoreCapabilities,
  ManifestInfo,
} from "skillscript-runtime/connectors";

/** Replace with your substrate's connection config (host, dbName, API key, etc.). */
export interface DataStoreTemplateConfig {
  // TODO — declare the fields your substrate needs to connect.
  // Examples:
  //   pineconeApiKey?: string;
  //   pineconeEnvironment?: string;
  //   weaviateUrl?: string;
  //   ampVault?: string;
  exampleConfigField?: string;
}

export class DataStoreTemplate implements DataStore {
  /**
   * Declare what your impl supports. The runtime + lint consult these flags
   * before exercising features. Set conservatively — overclaiming triggers
   * cryptic downstream failures; underclaiming hides usable features.
   */
  static staticCapabilities(): DataStoreCapabilities {
    return {
      connector_type: "data_store",
      implementation: "DataStoreTemplate", // ← rename to your class name
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
  constructor(_config: DataStoreTemplateConfig) {
    // TODO — establish your substrate connection. For SQL: open the database
    // + run schema migrations. For vector DB: cache the SDK client + index
    // name. For HTTP: store the base URL + auth headers.
    throw new Error("DataStoreTemplate is a fork-me skeleton; replace with your impl.");
  }

  /**
   * Capability snapshot for `runtime_capabilities` discovery. Return free-form
   * substrate-specific metadata (kind, version, supported modes, score range, etc.).
   *
   * The bundled `SqliteDataStore.manifest()` returns:
   *   { capabilities_version: "1", manifest: { kind: "sqlite-fts",
   *       supported_modes: ["fts"], score_range: "unbounded",
   *       supported_filters: ["domain_tags"], supports_write: true } }
   *
   * **v0.14.1 — `supported_filters` is load-bearing.** The DataStoreMcpConnector
   * bridge enforces this declaration: filter keys passed to `$ data_read` that
   * aren't in `supported_filters` throw `UnsupportedFilterError` at the bridge
   * BEFORE your `query()` runs. Adopters can opt out per-call with
   * `permissive_filters: true`. Declare every filter your `query()` actually
   * honors here; omissions become silent "this filter is rejected".
   */
  async manifest(): Promise<ManifestInfo<"data_store">> {
    // TODO — return a snapshot of your substrate's capabilities.
    throw new Error("TODO: manifest() — return substrate-specific capability snapshot.");
  }

  /**
   * Query memories by mode + filter. Return `PortableData[]` ordered by
   * relevance (most relevant first). Empty result is fine; never throw "not
   * found" — return [].
   *
   * `QueryFilters` shape:
   *   - `query`: string (search terms; substrate-specific interpretation)
   *   - `limit`: number (max results)
   *   - `mode`: "fts" | "semantic" | "rerank" | substrate-specific string
   *   - Plus filter fields you declared in `manifest().supported_filters`
   *     (`domain_tags`, `thread_status`, `payload_type`, `pinned`, `agent_id`,
   *     etc.). Per the curated-subset framing in `types.ts`, these top-level
   *     fields are first-class for substrates that have them.
   *
   * **v0.14.1 — what reaches `query()`.** The DataStoreMcpConnector bridge
   * pre-filters the keys against your `manifest().supported_filters`
   * declaration; unsupported keys throw `UnsupportedFilterError` upstream and
   * never reach this method. So when `query()` runs, every non-base key in
   * `filters` is one your manifest declared. Don't defensively code for
   * "filter the caller didn't declare" — that's the bridge's job.
   *
   * `PortableData` core fields:
   *   - Always: `id`, `summary`, `created_at`
   *   - Often: `detail`, `score`, `domain_tags`, `payload_type`
   *   - Per-substrate (curated): `pinned`, `confidence`, `thread_status`,
   *     `recipients`, `expires_at`, `agent_id`, `vault`
   *   - Catch-all: `metadata` object for substrate-specific extensions
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async query(_filters: QueryFilters): Promise<PortableData[]> {
    // TODO — translate `filters` to your substrate's query API.
    //   - Reject unsupported `mode` values with a clear error (don't silently
    //     fall back; cold authors will be confused)
    //   - Apply curated-subset filters (domain_tags, payload_type, etc.) where
    //     the substrate supports them
    //   - Map your substrate's result rows into `PortableData` shape
    //   - Order by relevance (most relevant first)
    //   - Honor `limit`
    throw new Error("TODO: query() — return PortableData[] ordered by relevance.");
  }

  /**
   * Persist a new data record. Return the substrate-assigned `id` +
   * `created_at` (unix seconds).
   *
   * `DataWrite` shape:
   *   - `content`: string (required; the record body)
   *   - `tags`: string[] (optional; routed to substrate's tag mechanism)
   *   - `recipients`: string[] (optional advisory — substrates with alerting
   *     machinery use this to route notifications, e.g., AMP's mailbox model)
   *   - `expires_at`: number (optional; unix seconds — substrate-side TTL)
   *   - `metadata`: Record<string, unknown> (catch-all for substrate-specific
   *     extensions like `vault`, `payload_type`, `confidence`)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async write(_entry: DataWrite): Promise<DataWriteRecord> {
    // TODO — persist the record via your substrate.
    //   - Generate or accept an id (substrate-dependent)
    //   - Persist content + tags + metadata
    //   - Apply recipients hint if your substrate has alerting
    //   - Apply expires_at if your substrate has TTL
    //   - Return { id, created_at }
    throw new Error("TODO: write() — persist record; return { id, created_at }.");
  }

  /**
   * Direct lookup by substrate-assigned id (v0.13.8 — lets `data_read`
   * inspect a record without a query roundtrip). Return `null` when the id
   * isn't found — do NOT throw; null-on-miss is the DataStore convention
   * (contrast SkillStore, which throws `SkillNotFoundError`). Substrates
   * without a native by-id lookup can implement via a filtered query, but
   * the null semantics must hold.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async get(_id: string): Promise<PortableData | null> {
    // TODO — fetch one record by id from your substrate; null when missing.
    throw new Error("TODO: get() — return the record for this id, or null.");
  }
}
