// Connector contracts — the integration boundary between the runtime and
// external state. Four kinds: SkillStore (where skills live), MemoryStore
// (queryable knowledge), LocalModel (local LLM inference), McpConnector
// (MCP tool dispatch).
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

/** The four connector kinds. */
export type ConnectorType = "skill_store" | "memory_store" | "local_model" | "mcp_connector";

/**
 * Static capabilities — declared by the connector class, consumed by the
 * linter offline. `features` is a string→boolean map of feature flags;
 * skill `# Requires:` clauses match against the names. See per-contract
 * feature-flag namespaces below.
 */
export interface StaticCapabilities {
  connector_type: ConnectorType;
  /** Implementation class name; appears in conformance test output + dashboard. */
  implementation: string;
  /** Contract version this implementation targets (e.g. "1.0.0"). Lets the runtime refuse incompatible impls. */
  contract_version: string;
  features: Record<string, boolean>;
}

/**
 * Dynamic manifest — instance state. Runtime caches per `capabilities_version`;
 * connectors bump version on schema/structural changes only.
 */
export interface ManifestInfo {
  capabilities_version: string;
  manifest: Record<string, unknown>;
}

// ─── SkillStore ───────────────────────────────────────────────────────────

export type SkillStatus = "draft" | "approved" | "disabled";

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
  requires?: string[];
  triggers?: Array<{ source: string; name: string; agent_id?: string }>;
  outputs?: string[];
  type?: "procedural" | "data";
  created_at: number;
  updated_at: number;
  status_changed_at?: number;
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

export interface SkillStore {
  /** Throws `SkillNotFoundError` if `name` (+ optional `version`) is missing. */
  load(name: string, version?: string): Promise<SkillSource>;
  /** Returns empty array on no matches; never throws for "not found". */
  query(filter?: SkillFilter): Promise<SkillMeta[]>;
  /** Throws `SkillNotFoundError` if missing. */
  metadata(name: string): Promise<SkillMeta>;
  /** Throws `SkillNotFoundError` if missing. Empty array is valid for new skills. */
  versions(name: string): Promise<VersionInfo[]>;
  /** Creates or updates. Throws `LintFailureError` if tier-1 lint rejects. */
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

// ─── MemoryStore ──────────────────────────────────────────────────────────

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
export interface PortableMemory {
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
  [key: string]: unknown;
}

export interface MemoryStore {
  query(filters: QueryFilters): Promise<PortableMemory[]>;
  manifest(): Promise<ManifestInfo>;
}

export interface MemoryStoreClass {
  new (...args: never[]): MemoryStore;
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
}

// ─── Curated memory fields ────────────────────────────────────────────────

/** Eleven curated substrate fields. Connectors route equivalents here at top level; everything else flows into metadata. */
export const CURATED_MEMORY_FIELDS = [
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

export type CuratedMemoryField = (typeof CURATED_MEMORY_FIELDS)[number];
