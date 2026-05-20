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

export interface SkillRecord {
  name: string;
  body: string;
  status?: string;
  createdAt?: number;
  description?: string;
}

export interface SkillSummary {
  name: string;
  status?: string;
  description?: string;
}

export interface SkillStore {
  load(name: string): Promise<SkillRecord | null>;
  exists(name: string): Promise<boolean>;
  list(filter?: { status?: string }): Promise<SkillSummary[]>;
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
