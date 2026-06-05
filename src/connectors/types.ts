// Connector contracts — the integration boundary between the runtime and
// external state. Five kinds: SkillStore (where skills live), DataStore
// (queryable knowledge), LocalModel (local LLM inference), McpConnector
// (MCP tool dispatch), AgentConnector (deliver to / wake a frontier agent;
// T7.1).
//
// Capabilities are split into two surfaces:
//
//   - `staticCapabilities()` — class-level static method. Pure, synchronous,
//     no instance, no network. The linter calls this offline to validate
//     `# Requires:` clauses against the configured connector set without
//     needing the substrate to be reachable.
//
//   - `manifest()` — instance method. Returns substrate-specific dynamic
//     state (which models a specific Ollama instance serves, which tools
//     a specific MCP server exposes). Runtime caches the result per
//     `(connector_instance, capabilities_version)`; connectors bump the
//     version when manifest *content* changes (new tool wired, new model
//     loaded), NOT on every dispatch.

/** The five connector kinds. */
export type ConnectorType = "skill_store" | "data_store" | "local_model" | "mcp_connector" | "agent_connector";

// ─── Per-contract feature-flag namespaces ─────────────────────────────────
//
// Closed-set unions per connector kind. `# Requires:` lint clauses match
// against `<connector_type>.<flag>`; the union enforces typo-safety at
// authoring time on the connector side AND at lint time when validating
// the closed set.

export type SkillStoreFeature =
  | "supports_writes"
  | "supports_versioning"
  | "supports_tag_filter"
  | "supports_audit_trail"
  | "supports_atomic_status_transitions";

export type DataStoreFeature =
  | "supports_writes"
  | "supports_tag_filter"
  | "supports_semantic"
  | "supports_rerank"
  | "supports_thread_status_filter"
  | "supports_pinning"
  | "supports_decay_model";

export type LocalModelFeature =
  | "supports_max_tokens"
  | "supports_timeout"
  | "supports_streaming"
  | "supports_embedding";

export type McpConnectorFeature =
  | "supports_identity_propagation"
  | "supports_streaming_responses"
  | "supports_batch";

/** AgentConnector flags are method-presence shape (one per contract method). */
export type AgentConnectorFeature =
  | "deliver"
  | "wake"
  | "list_agents"
  | "agent_status"
  | "health_check"
  | "request_response";

/**
 * Static capabilities — declared by the connector class, consumed by the
 * linter offline. Discriminated union per `connector_type`; per-kind
 * feature unions enforce closed-set flag names at compile time. `# Requires:`
 * lint clauses match against `<connector_type>.<flag>`.
 */
interface BaseStaticCapabilities {
  /** Implementation class name; appears in conformance test output + dashboard. */
  implementation: string;
  /** Contract version this implementation targets (e.g. "1.0.0"). Lets the runtime refuse incompatible impls. */
  contract_version: string;
}

export interface SkillStoreCapabilities extends BaseStaticCapabilities {
  connector_type: "skill_store";
  features: Partial<Record<SkillStoreFeature, boolean>>;
}

export interface DataStoreCapabilities extends BaseStaticCapabilities {
  connector_type: "data_store";
  features: Partial<Record<DataStoreFeature, boolean>>;
}

export interface LocalModelCapabilities extends BaseStaticCapabilities {
  connector_type: "local_model";
  features: Partial<Record<LocalModelFeature, boolean>>;
}

export interface McpConnectorCapabilities extends BaseStaticCapabilities {
  connector_type: "mcp_connector";
  features: Partial<Record<McpConnectorFeature, boolean>>;
}

export interface AgentConnectorCapabilities extends BaseStaticCapabilities {
  connector_type: "agent_connector";
  features: Partial<Record<AgentConnectorFeature, boolean>>;
}

export type StaticCapabilities =
  | SkillStoreCapabilities
  | DataStoreCapabilities
  | LocalModelCapabilities
  | McpConnectorCapabilities
  | AgentConnectorCapabilities;

// ─── Per-contract manifest shapes ─────────────────────────────────────────
//
// Each contract's `manifest()` returns substrate metadata for its kind.
// Known fields are typed; the `[key: string]: unknown` catch-all lets
// adopter impls add substrate-specific extensions without losing type
// safety on the known fields. AgentConnector has no manifest() (per v0.9.6
// audit), so no AgentConnectorManifest.
//
// **Convention**: `kind` is a string tag for the implementation flavor
// ("filesystem", "sqlite", "ollama", "remote-mcp", ...). Not locked to a
// union — adopter forks pick their own ("amp", "postgres", etc.).
// **Capability flags** live in `StaticCapabilities.features`, NOT in
// manifest. Don't duplicate.

export interface SkillStoreManifest {
  kind: string;
  /** Filesystem-backed impls — root directory for `.skill.md` files. */
  root_dir?: string;
  /** SQLite-backed impls — db file path. */
  db_path?: string;
  /** Adopter-extension catch-all. */
  [key: string]: unknown;
}

export interface DataStoreManifest {
  kind: string;
  /** Query modes the substrate supports — e.g., ["fts"], ["semantic", "rerank"]. */
  supported_modes?: string[];
  /** Filter fields the substrate honors in `query()`. */
  supported_filters?: string[];
  /** Score range hint — e.g., "unbounded", "0..1". */
  score_range?: string;
  [key: string]: unknown;
}

export interface LocalModelManifest {
  kind: string;
  /** Default model tag (e.g., "gemma2:9b"). */
  default_model?: string;
  /** Endpoint URL the impl connects to. */
  endpoint?: string;
  /** Available model list. Populated when the impl can introspect the substrate (e.g., `/api/tags` for Ollama). Absent on impls that don't enumerate. */
  models_available?: string[];
  /**
   * Set when the substrate query that would populate `models_available`
   * failed (network error, auth failure, parse error, etc.). Cold authors
   * + adopters see this and know why the model list is empty, rather than
   * silently getting `models_available: []` and assuming no models are
   * installed. v0.13.0.
   */
  fetch_error?: string;
  [key: string]: unknown;
}

export interface McpConnectorManifest {
  kind: string;
  /** Spawned command for child-process bridges. */
  command?: string;
  /** Stdio framing convention for child-process bridges. */
  framing?: string;
  /** Tools available — populated for bridges that introspect upstream MCPs at startup. */
  tools_available?: string[];
  /** For bridge connectors that wrap an underlying contract — the inner manifest. */
  wraps?: Record<string, unknown>;
  [key: string]: unknown;
}

type ManifestPayload<K extends ConnectorType> =
  K extends "skill_store" ? SkillStoreManifest
  : K extends "data_store" ? DataStoreManifest
  : K extends "local_model" ? LocalModelManifest
  : K extends "mcp_connector" ? McpConnectorManifest
  : never;

/**
 * Dynamic manifest — instance state. Runtime caches per `capabilities_version`;
 * connectors bump version on schema/structural changes only. Parameterized
 * by connector kind; default is the open union for code that doesn't care.
 */
export interface ManifestInfo<K extends Exclude<ConnectorType, "agent_connector"> = Exclude<ConnectorType, "agent_connector">> {
  capabilities_version: string;
  manifest: ManifestPayload<K>;
}

// ─── SkillStore ───────────────────────────────────────────────────────────

export type SkillStatus = "Draft" | "Approved" | "Disabled";

/**
 * Closed enumeration of valid `SkillStatus` values. Use with `isSkillStatus`
 * to guard at MCP-handler / store-layer entry points so undefined/typo'd
 * statuses never reach `rewriteStatusHeader` (which would silently write
 * literal `# Status: undefined` into the skill body — v0.13.7 fix).
 */
export const VALID_SKILL_STATUSES: readonly SkillStatus[] = ["Draft", "Approved", "Disabled"] as const;

/** Runtime type guard for `SkillStatus`. Returns false for undefined, null, wrong type, or unknown strings. */
export function isSkillStatus(value: unknown): value is SkillStatus {
  return typeof value === "string" && (VALID_SKILL_STATUSES as readonly string[]).includes(value);
}

/**
 * The source bytes of a skill plus its identity metadata. Returned by
 * `SkillStore.load()`. `version` is opaque-substrate-declared (equality
 * comparison only); `content_hash` is substrate-independent SHA-256 of
 * canonicalized source. Use `content_hash` for staleness / dependency
 * walking; use `version` for display + substrate-specific pinning.
 */
export interface SkillSource {
  name: string;
  version: string;
  content_hash: string;
  source: string;
  metadata: SkillMeta;
}

/**
 * Skill metadata — everything you can know about a skill without loading
 * its body. Returned by `query()` / `metadata()`. `created_at` /
 * `updated_at` / `status_changed_at` are Unix seconds.
 */
export interface SkillMeta {
  name: string;
  version: string;
  content_hash: string;
  status: SkillStatus;
  description?: string;
  vars?: string[];
  /**
   * v0.18.0 — declared export surface from `# Returns: X, Y, Z` header.
   * The output-side mirror of `vars` (input surface). Empty array when
   * the skill has no `# Returns:` header declared (default — caller
   * sees only `outputs`/`transcript`/execution metadata, no exports
   * from `final_vars`). Surfaces through `skill_metadata` MCP for
   * dashboard contract display + adopter introspection.
   */
  returns?: string[];
  requires?: string[];
  triggers?: Array<{ source: string; name: string; agent_id?: string }>;
  outputs?: string[];
  type?: "procedural" | "data";
  created_at: number;
  updated_at: number;
  status_changed_at?: number;
  /**
   * Authenticated writer captured at first-store. The SkillStore IS the
   * trust boundary — whoever's authenticated to write IS the owner. Locked
   * at first-write: subsequent `store()` calls with `overwrite=true`
   * preserve the original author silently (or throw if an explicit
   * `metadata.author` disagrees). Transfer of ownership is a substrate-
   * specific privileged operation, not a side-effect of an authoring
   * rewrite.
   *
   * For bundled `FilesystemSkillStore`: defaults to `os.userInfo().username`
   * — trust-boundaried by FS perms, FS user IS the identity. Adopter
   * stores capture from their auth header / session via the
   * `metadata.author` argument on `store()`.
   *
   * Runtime threads this into `McpDispatchCtx.agentId` at dispatch time so
   * substrate-side identity-scoped reads/writes resolve under the owner.
   * Connectors that advertise `supports_identity_propagation` honor it;
   * substrates without per-identity sessions need that capability shipped
   * before end-to-end propagation works.
   */
  author?: string;
  metadata_bag?: Record<string, unknown>;
}

/**
 * Records a write or status transition. `previous_status` is populated
 * on every `update_status()` call so audit traces can reconstruct the
 * lifecycle without reading the full version list. `changed_at` is
 * Unix seconds.
 */
export interface VersionInfo {
  name: string;
  version: string;
  content_hash: string;
  status: SkillStatus;
  previous_status?: SkillStatus;
  changed_at: number;
  changed_by?: string;
}

/**
 * Filter shape for `SkillStore.query()`. Extensible — substrates honor what
 * they support and ignore the rest. `name_pattern` is a substrate-specific
 * glob/regex string; substrates declare support via the
 * `supports_tag_filter` / `supports_versioning` feature flags.
 */
export interface SkillFilter {
  status?: SkillStatus | SkillStatus[];
  type?: "procedural" | "data";
  tag?: string | string[];
  author?: string;
  since?: number;
  name_pattern?: string;
  limit?: number;
  offset?: number;
  [key: string]: unknown;
}

/**
 * v0.9.8 — agent-facing discovery shape for `skill_list` MCP tool.
 * Pre-grouped by audience-derived category so a cold agent reading the
 * response at session start can immediately see "what pushes to me"
 * (`receives`) vs "what I can invoke" (`skills`). Per Perry's audit
 * thread `f0b8b832`; locked shape in `011feaf0`.
 *
 * Category derivation rule (multi-output safe):
 *   ANY output[i].kind === "agent"    → "augmenting" (surfaces in `receives`)
 *   else ANY output[i].kind === "template" → "template" (surfaces in `skills`)
 *   else                              → "headless"   (surfaces only when audience filter allows)
 *
 * **Footnote**: invocation is independent of discovery grouping.
 * `execute_skill(skill_name="X")` works regardless of whether X surfaced
 * in `receives` or `skills`. Discovery grouping is signal, not gating.
 */
export interface SkillCatalog {
  receives?: SkillEntry[];   // present when audience includes augmenting
  skills?: SkillEntry[];     // present when audience includes template
  headless?: SkillEntry[];   // present when audience filter allows
}

export interface SkillEntry {
  name: string;
  category: "augmenting" | "template" | "headless";
  description: string;
  status: SkillStatus;
  /**
   * v0.18.6 — optional connector-provided authorship attribution.
   * `null` when the substrate doesn't track or expose author per skill.
   * Bundled stores populate from `SkillMeta.author` (captured at first
   * write per the v0.16.x identity ring). Adopter substrates can map
   * onto their own ownership concept (e.g., AMP's `author:<id>` tag).
   *
   * Per Perry's spec (thread `1f278e5e`): generic, connector-implemented,
   * graceful-degrading. Substrate-neutral.
   */
  author?: string | null;
  /**
   * Vars derived from `# Vars:` frontmatter per the `73c79a28` addendum:
   *   `NAME` (bare)         → { required: true,  default: null }
   *   `NAME=`               → { required: false, default: "" }
   *   `NAME=value`          → { required: false, default: "value" }
   * Order preserved as declared in frontmatter (left-to-right).
   */
  vars: Array<{ name: string; required: boolean; default: string | null }>;
  /**
   * Array of all `# Output:` declarations. Multi-output skills preserve
   * the full picture; category derivation uses the first agent/template
   * kind found.
   */
  output: Array<{ kind: "agent" | "template" | "text" | "file" | "none"; target?: string }>;
  /**
   * Discriminated union of triggers. v1.0-locked enum: cron / session /
   * webhook / event. Phase-2 trigger kinds (`agent-event`, `file-watch`,
   * `sensor`) added additively when those firing paths land — non-breaking
   * via TS discriminated union semantics.
   */
  triggers: Array<
    | { kind: "cron"; expression: string }
    | { kind: "session"; phase: "start" | "end" }
    | { kind: "webhook"; path?: string }
    | { kind: "event"; event_type: string }
  >;
}

export interface SkillListFilter {
  /** Default "agent" — receives + skills. "all" adds headless. "headless" only. */
  audience?: "agent" | "all" | "headless";
  /** Default "Approved" — cold authors don't see Drafts unless asked. */
  status?: SkillStatus;
  /** Narrow to skills with at least one trigger of this kind. Absent = any. */
  trigger_kind?: "cron" | "session" | "webhook" | "event";
  /** AND-match — skill must have all listed tags in its metadata. */
  domain_tags?: string[];
  /** Adopter-side scoping (e.g., per-project filtering by name convention). */
  name_prefix?: string;
  /**
   * v0.18.6 — narrow to skills authored by a specific identity. AND-composes
   * with other filters. Threaded through to `SkillStore.query({author: ...})`
   * for substrates that honor it natively; bundled stores also filter
   * in-memory against `SkillMeta.author` so adopters get a working filter
   * without substrate-side work. Per Perry's spec (thread `1f278e5e`):
   * graceful degradation — substrates that don't track authorship return
   * all rows and the catalog layer filters in-memory.
   */
  author?: string;
}

export interface SkillStore {
  /** Throws `SkillNotFoundError` if `name` (+ optional `version`) is missing. */
  load(name: string, version?: string): Promise<SkillSource>;
  /** Returns empty array on no matches; never throws for "not found". */
  query(filter?: SkillFilter): Promise<SkillMeta[]>;
  /** Throws `SkillNotFoundError` if missing. */
  metadata(name: string): Promise<SkillMeta>;
  /** Throws `SkillNotFoundError` if missing. Empty array is valid for new skills. */
  versions(name: string): Promise<VersionInfo[]>;
  /**
   * Creates or updates. Throws `LintFailureError` if tier-1 lint rejects.
   * `metadata.author` is captured at first-write and locked: subsequent
   * `store()` calls preserve the original author. Throws `StorageConflictError`
   * if an explicit `metadata.author` disagrees with the existing first-write
   * author. SkillStore implementations supply a substrate-appropriate default
   * when `metadata.author` is omitted (e.g., `os.userInfo().username` for
   * filesystem; session identity for MCP-exposed stores).
   */
  store(name: string, source: string, metadata?: Partial<SkillMeta>): Promise<VersionInfo>;
  /** Substrate-only delete. Referential integrity is the runtime's concern (T2 Phase 2.1). */
  delete(name: string): Promise<void>;
  /** Returns a `VersionInfo` with `previous_status` populated. */
  update_status(name: string, status: SkillStatus): Promise<VersionInfo>;
  manifest(): Promise<ManifestInfo>;
}

export interface SkillStoreClass {
  new (...args: never[]): SkillStore;
  staticCapabilities(): StaticCapabilities;
}

// ─── DataStore ──────────────────────────────────────────────────────────

/**
 * Portable memory shape. Field-access semantics (4-tier resolution):
 *   1. Core fields — id, summary, detail, score
 *   2. Curated substrate subset — top-level fields whose concept is portable
 *   3. Substrate-specific — accessed via metadata.X
 *   4. Ambient passthrough — literal $(MEMORY.field) for unknowns
 *
 * Connector duplication discipline: a curated-subset field must be at
 * top-level only, never also in metadata. Silent divergence otherwise.
 */
export interface PortableData {
  id: string;
  summary: string;
  detail?: string;
  score?: number;

  // Curated substrate subset.
  thread_status?: string;
  pinned?: boolean;
  confidence?: number;
  domain_tags?: string[];
  payload_type?: string;
  knowledge_type?: string;
  recipients?: string[];
  expires_at?: number;
  created_at?: number;
  agent_id?: string;
  vault?: string;

  metadata?: Record<string, unknown>;
}

export interface QueryFilters {
  query: string;
  limit: number;
  mode: "fts" | "semantic" | "rerank" | string;
  /**
   * v0.14.1 — per-call opt-out from strict filter-key enforcement. Default
   * is strict: filter keys outside the substrate's declared
   * `supported_filters` manifest throw `UnsupportedFilterError` at the
   * `DataStoreMcpConnector.dispatchQuery` boundary. Set to `true` to
   * acknowledge that unknown filter keys are advisory and the substrate
   * may silently ignore them. Closes the silent-scope-leak class where
   * pre-v0.14.1 substrates dropped unsupported filters and the caller
   * assumed filtering happened. Sibling default to the mutation-gate
   * runtime enforcement: defaults-over-knobs for security-relevant
   * surfaces.
   */
  permissive_filters?: boolean;
  [key: string]: unknown;
}

/**
 * Shape of a `DataStore.write()` input. `content` is required; other
 * fields are optional hints to the substrate. `recipients` lets the
 * memory system route alerts if it has alerting machinery (e.g., AMP's
 * mailbox model) — purely advisory at the language layer. `metadata`
 * carries substrate-specific extensions (e.g., AMP's `vault`,
 * `confidence`, `payload_type` fields) without bloating the typed
 * contract. v0.8.0.
 */
export interface DataWrite {
  content: string;
  tags?: string[];
  recipients?: string[];
  /**
   * Unix seconds for a finite expiry, or `null` to opt into "durable forever"
   * explicitly. Omit (or set `undefined`) to defer to the substrate's
   * default lifecycle policy (which may be durable, may have decay/TTL —
   * substrate-specific). Substrates with default TTL semantics (AMP memory
   * vaults, Redis with default expiry, hosted memory APIs) should treat
   * `null` as the portable verb for "exempt this write from substrate-level
   * sweep" — e.g., map to the substrate's pin / no-decay flag. Substrates
   * that are durable by default (SqliteDataStore) can treat `null` as a
   * no-op since the same outcome already holds.
   */
  expires_at?: number | null;
  metadata?: Record<string, unknown>;
}

/**
 * Return shape from `DataStore.write()`. `id` is the substrate-assigned
 * identifier; `created_at` is unix seconds. v0.8.0.
 */
export interface DataWriteRecord {
  id: string;
  created_at: number;
}

export interface DataStore {
  query(filters: QueryFilters): Promise<PortableData[]>;
  /**
   * Persist a new memory entry. v0.8.0 — bundled with the passthrough
   * auth model (substrate enforces credentials threaded through MCP
   * dispatch context). Returns the substrate-assigned id + timestamp.
   */
  write(entry: DataWrite): Promise<DataWriteRecord>;
  /**
   * Direct lookup by substrate-assigned id. v0.13.8 — added so the
   * `data_read` MCP tool can inspect a memory without going through
   * a query roundtrip. Returns `null` (not throws) when the id isn't
   * found, matching DataStore's existing empty-set convention (vs.
   * SkillStore which throws `SkillNotFoundError`). Substrates that
   * don't have a queryable-by-id concept can implement via
   * `query({id})` extension + filter, but `null` semantics must hold.
   */
  get(id: string): Promise<PortableData | null>;
  manifest(): Promise<ManifestInfo>;
}

export interface DataStoreClass {
  new (...args: never[]): DataStore;
  staticCapabilities(): StaticCapabilities;
}

// ─── LocalModel ───────────────────────────────────────────────────────────

export interface LocalModel {
  run(prompt: string, opts: { maxTokens?: number; model?: string }): Promise<string>;
  manifest(): Promise<ManifestInfo>;
}

export interface LocalModelClass {
  new (...args: never[]): LocalModel;
  staticCapabilities(): StaticCapabilities;
}

// ─── McpConnector ─────────────────────────────────────────────────────────

/** Identity overrides threaded through `$` op dispatch. Per-call > registry > intrinsic. */
export interface McpDispatchCtx {
  agentId?: string;
  isAdmin?: boolean;
}

export interface McpConnector {
  call(
    toolName: string,
    args: Record<string, unknown>,
    ctxOverrides?: McpDispatchCtx,
  ): Promise<unknown>;
  manifest(): Promise<ManifestInfo>;
}

export interface McpConnectorClass {
  new (...args: never[]): McpConnector;
  staticCapabilities(): StaticCapabilities;
  /**
   * v0.9.1 — closed-set tool surface for static dispatch validation.
   * Returns the canonical tool names the connector class supports when the
   * surface is known at compile time. Returns `null` when the surface
   * varies at runtime (e.g., RemoteMcpConnector wrapping an arbitrary
   * upstream MCP server). Used by `validateDispatch` to catch
   * `$ ref.unknown_tool` at lint time. When `null`, lint emits a tier-3
   * advisory rather than green-lighting.
   *
   * Optional — connectors without this method behave as `null`.
   */
  staticTools?(): string[] | null;
}

// ─── Curated memory fields ────────────────────────────────────────────────

/** Eleven curated substrate fields. Connectors route equivalents here at top level; everything else flows into metadata. */
export const CURATED_DATA_FIELDS = [
  "thread_status",
  "pinned",
  "confidence",
  "domain_tags",
  "payload_type",
  "knowledge_type",
  "recipients",
  "expires_at",
  "created_at",
  "agent_id",
  "vault",
] as const;

export type CuratedDataField = (typeof CURATED_DATA_FIELDS)[number];
