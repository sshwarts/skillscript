import { createRequire } from "node:module";
import { dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { suppressSqliteExperimentalWarning } from "../sqlite-warning-suppress.js";
import type {
  DataStore,
  DataWrite,
  DataWriteRecord,
  PortableData,
  QueryFilters,
  DataStoreCapabilities,
  ManifestInfo,
} from "./types.js";

function generateMemoryId(): string {
  return randomUUID();
}

const CONTRACT_VERSION = "1.0.0";

/**
 * Lazy-load `node:sqlite` at instance construction time, not at module
 * load time. Two reasons:
 *   1. The Vite transformer (used by vitest dev pipeline) strips the
 *      `node:` prefix and fails to resolve plain `sqlite`. Lazy-loading
 *      via createRequire bypasses Vite entirely.
 *   2. CLI invocations that never touch SQLite (running a no-LocalModel
 *      skill, listing skills, etc.) don't pay the ExperimentalWarning
 *      cost on every command.
 *
 * Type guarded as `unknown` since we can't import the type without paying
 * the load cost.
 */
const requireNode = createRequire(import.meta.url);
type DatabaseSyncCtor = new (path: string) => DatabaseSync;
interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): { get(params?: object): unknown; all(params?: object): unknown[]; run(params?: object): unknown };
  close(): void;
}
function loadDatabaseSync(): DatabaseSyncCtor {
  // v0.15.4 — suppress the node:sqlite ExperimentalWarning at the actual
  // load site (covers programmatic adopters running their own bootstrap;
  // v0.15.1's CLI-only filter missed that path). Idempotent — only the
  // first call installs the filter.
  suppressSqliteExperimentalWarning();
  return (requireNode("node:sqlite") as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync;
}

/**
 * SQLite-backed DataStore. Schema:
 *
 *   memories(
 *     id TEXT PRIMARY KEY,
 *     summary TEXT NOT NULL,
 *     detail TEXT,
 *     tags TEXT,                -- JSON array
 *     created_at INTEGER NOT NULL,
 *     metadata TEXT             -- JSON object, substrate-specific fields
 *   )
 *
 *   memories_fts — FTS5 virtual table over summary + detail
 *
 * v1 modes: `fts` (FTS5 keyword), `semantic` and `rerank` reserved (require
 * embedding pipeline, deferred to a follow-up). Filters: domain_tags (substring
 * match), payload_type (top-level metadata field), and arbitrary metadata.*
 * keys.
 *
 * Identity / vault semantics intentionally absent here. Backends that need
 * agent/vault scoping wrap the contract in a separate adapter; the
 * filesystem-default store has no agents and open visibility.
 */
export interface SqliteDataStoreConfig {
  dbPath: string;
}

export class SqliteDataStore implements DataStore {
  static staticCapabilities(): DataStoreCapabilities {
    return {
      connector_type: "data_store",
      implementation: "SqliteDataStore",
      contract_version: CONTRACT_VERSION,
      features: {
        supports_writes: true,
        supports_tag_filter: true,
        supports_semantic: false,
        supports_rerank: false,
        supports_thread_status_filter: false,
        supports_pinning: false,
        supports_decay_model: false,
      },
    };
  }

  private readonly db: DatabaseSync;

  constructor(config: SqliteDataStoreConfig) {
    const dir = dirname(config.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    this.db = new DatabaseSync(config.dbPath);
    this.bootstrap();
  }

  private bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        detail TEXT,
        tags TEXT,
        created_at INTEGER NOT NULL,
        metadata TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        summary, detail, content='memories', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, summary, detail) VALUES (new.rowid, new.summary, new.detail);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, detail) VALUES('delete', old.rowid, old.summary, old.detail);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, detail) VALUES('delete', old.rowid, old.summary, old.detail);
        INSERT INTO memories_fts(rowid, summary, detail) VALUES (new.rowid, new.summary, new.detail);
      END;
      -- v0.13.0 — normalized tag relation. Pre-v0.13 tag filter was a JS-side
      -- substring scan over the JSON tags column (linear, wrong-ranked).
      -- Relation lets SQL push tag predicates into indexed lookups + EXISTS
      -- semantics. FK + ON DELETE CASCADE keeps the relation in sync when
      -- memories rows are removed (FTS triggers stay separate).
      CREATE TABLE IF NOT EXISTS memory_tags (
        memory_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (memory_id, tag),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS memory_tags_tag_idx ON memory_tags(tag);
      PRAGMA foreign_keys = ON;
    `);
    this.backfillMemoryTags();
  }

  /**
   * v0.13.0 — one-time backfill on bootstrap. If memory_tags is empty AND
   * memories has tags-bearing rows (pre-v0.13 data), populate from the JSON
   * column. Idempotent: subsequent bootstraps find memory_tags non-empty and
   * skip. Adopters migrating from earlier versions get indexed tag filters
   * without an explicit migration step.
   */
  private backfillMemoryTags(): void {
    const have = (this.db.prepare("SELECT COUNT(*) AS c FROM memory_tags").get() as { c: number }).c;
    if (have > 0) return;
    const hasJson = (this.db.prepare("SELECT COUNT(*) AS c FROM memories WHERE tags IS NOT NULL").get() as { c: number }).c;
    if (hasJson === 0) return;
    this.db.exec(`
      INSERT OR IGNORE INTO memory_tags (memory_id, tag)
      SELECT m.id, je.value
      FROM memories m, json_each(m.tags) je
      WHERE m.tags IS NOT NULL;
    `);
  }

  // v0.13.8 — direct lookup by id. Mirrors `SqliteSkillStore.skillRow` shape
  // but returns `null` on miss instead of throwing (per DataStore's empty-set
  // convention, distinct from SkillStore's throw-on-miss).
  async get(id: string): Promise<PortableData | null> {
    const row = this.db.prepare(
      "SELECT id, summary, detail, tags, created_at, metadata FROM memories WHERE id = $id",
    ).get({ $id: id }) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return this.rowToMemory(row, undefined);
  }

  async query(filters: QueryFilters): Promise<PortableData[]> {
    const { query, limit, mode } = filters;
    if (mode !== "fts") {
      throw new Error(
        `SqliteDataStore: mode '${mode}' not supported in T1 baseline. Use 'fts'. ` +
        `Semantic / rerank land alongside the embedding pipeline in a follow-up thread.`,
      );
    }
    if (!query || query.trim() === "") {
      const rows = this.db.prepare(
        "SELECT id, summary, detail, tags, created_at, metadata FROM memories ORDER BY created_at DESC LIMIT $limit",
      ).all({ $limit: limit }) as Array<Record<string, unknown>>;
      return rows.map((r) => this.rowToMemory(r, undefined));
    }
    const sanitized = this.sanitizeFtsQuery(query);
    // v0.13.0 — push tag filter into SQL via EXISTS join on memory_tags
    // relation. Exact match (was JS substring scan; semantic change). Reduces
    // a linear-time JS filter to an indexed lookup; ranking still by FTS
    // score (tags don't influence relevance, just inclusion).
    const tagFilter = filters["domain_tags"];
    const params: Record<string, unknown> = { $q: sanitized, $limit: limit };
    let tagJoin = "";
    if (typeof tagFilter === "string" && tagFilter !== "") {
      tagJoin = "AND EXISTS (SELECT 1 FROM memory_tags mt WHERE mt.memory_id = m.id AND mt.tag = $tag)";
      params["$tag"] = tagFilter;
    }
    const rows = this.db.prepare(
      `SELECT m.id, m.summary, m.detail, m.tags, m.created_at, m.metadata, bm25(memories_fts) AS score
         FROM memories_fts
         JOIN memories m ON memories_fts.rowid = m.rowid
        WHERE memories_fts MATCH $q ${tagJoin}
        ORDER BY score
        LIMIT $limit`,
    ).all(params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToMemory(r, r["score"] as number | undefined));
  }

  async manifest(): Promise<ManifestInfo<"data_store">> {
    return {
      capabilities_version: "1",
      manifest: {
        kind: "sqlite-fts",
        supported_modes: ["fts"],
        score_range: "unbounded",
        supported_filters: ["domain_tags"],
        // v0.13.0 — `domain_tags` filter pushed into SQL via memory_tags
        // relation; exact match semantic (was substring scan pre-v0.13).
        tag_filter_semantic: "exact match via indexed memory_tags relation",
        // v0.13.0 — `query` field is phrase-tokens by default; prefix with
        // `raw:` for adopter-explicit FTS5 syntax.
        fts_query_semantic: "phrase-tokens (boolean ops disabled); use `raw:` prefix for FTS5 syntax",
      },
    };
  }

  /**
   * v0.8.0 — `DataStore.write()` impl. Generates a substrate id; persists
   * via the existing `upsert()` schema with tags + metadata. The `summary`
   * field defaults to the first line of content (per the v0.7.x convention
   * — adopters who want richer summaries pre-compose and pass via metadata).
   * Recipients hint is stored in metadata for substrates that key alerts off it.
   */
  async write(entry: DataWrite): Promise<DataWriteRecord> {
    const id = generateMemoryId();
    const createdAt = Math.floor(Date.now() / 1000);
    const firstLine = entry.content.split("\n")[0] ?? entry.content;
    const summary = firstLine.length > 200 ? firstLine.slice(0, 197) + "..." : firstLine;
    // Detail = full content. Summary = preview. Consistent with v0.7.x query() shape.
    const metadata: Record<string, unknown> = { ...(entry.metadata ?? {}) };
    if (entry.recipients !== undefined) metadata["recipients"] = entry.recipients;
    if (entry.expires_at !== undefined) metadata["expires_at"] = entry.expires_at;
    this.upsert({
      id,
      summary,
      detail: entry.content,
      ...(entry.tags !== undefined ? { domain_tags: entry.tags } : {}),
      created_at: createdAt,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
    return { id, created_at: createdAt };
  }

  /** Helper for tests/seeding — insert a memory. */
  upsert(memory: {
    id: string;
    summary: string;
    detail?: string;
    domain_tags?: string[];
    created_at?: number;
    metadata?: Record<string, unknown>;
  }): void {
    const tagList = memory.domain_tags ?? [];
    const tagsJson = tagList.length > 0 ? JSON.stringify(tagList) : null;
    const metadata = memory.metadata ? JSON.stringify(memory.metadata) : null;
    const createdAt = memory.created_at ?? Math.floor(Date.now() / 1000);
    this.db.prepare(
      `INSERT INTO memories (id, summary, detail, tags, created_at, metadata)
         VALUES ($id, $summary, $detail, $tags, $createdAt, $metadata)
         ON CONFLICT(id) DO UPDATE SET
           summary = $summary, detail = $detail, tags = $tags, metadata = $metadata`,
    ).run({
      $id: memory.id,
      $summary: memory.summary,
      $detail: memory.detail ?? null,
      $tags: tagsJson,
      $createdAt: createdAt,
      $metadata: metadata,
    });
    // v0.13.0 — maintain the memory_tags relation. Clear + reinsert keeps
    // upsert semantics clean (tag list is canonical per call).
    this.db.prepare("DELETE FROM memory_tags WHERE memory_id = $id").run({ $id: memory.id });
    if (tagList.length > 0) {
      const ins = this.db.prepare(
        "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES ($id, $tag)",
      );
      for (const tag of tagList) ins.run({ $id: memory.id, $tag: tag });
    }
  }

  close(): void {
    this.db.close();
  }

  private rowToMemory(row: Record<string, unknown>, score: number | undefined): PortableData {
    const tags = typeof row["tags"] === "string" ? safeParseJson(row["tags"]) : null;
    const metadata = typeof row["metadata"] === "string" ? safeParseJson(row["metadata"]) : null;
    const memory: PortableData = {
      id: row["id"] as string,
      summary: row["summary"] as string,
      created_at: row["created_at"] as number,
    };
    if (typeof row["detail"] === "string") memory.detail = row["detail"];
    if (Array.isArray(tags)) memory.domain_tags = tags as string[];
    if (metadata !== null && typeof metadata === "object") {
      memory.metadata = metadata as Record<string, unknown>;
    }
    if (score !== undefined) memory.score = score;
    return memory;
  }

  /**
   * v0.13.0 — sanitize a query string for FTS5 MATCH.
   *
   * Default behavior: split on whitespace, quote each token. FTS5 sees N
   * literal phrase tokens AND'd together. **Boolean operators like `OR` /
   * `NOT` / `NEAR` are NOT supported** — they're quoted as literal phrase
   * tokens and become a search for those words. This is a deliberate
   * safety stance over arbitrary user input.
   *
   * Escape hatch: prefix the query with `raw:` and the rest passes through
   * verbatim. Caller takes responsibility for FTS5 syntax + injection
   * safety. Example: `raw:foo OR bar`.
   *
   * Pre-v0.13 docstring claimed "pre-quoted" passed through; that wasn't
   * accurate (the tokenizer re-quoted). The `raw:` prefix is the actual
   * escape hatch.
   */
  private sanitizeFtsQuery(q: string): string {
    if (q.startsWith("raw:")) {
      return q.slice(4).trim();
    }
    return q
      .split(/\s+/)
      .filter((s) => s.length > 0)
      .map((tok) => `"${tok.replace(/"/g, '""')}"`)
      .join(" ");
  }
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
