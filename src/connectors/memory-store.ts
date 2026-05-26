import { createRequire } from "node:module";
import { dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  MemoryStore,
  MemoryWrite,
  MemoryWriteRecord,
  PortableMemory,
  QueryFilters,
  StaticCapabilities,
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
  return (requireNode("node:sqlite") as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync;
}

/**
 * SQLite-backed MemoryStore. Schema:
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
export interface SqliteMemoryStoreConfig {
  dbPath: string;
}

export class SqliteMemoryStore implements MemoryStore {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "memory_store",
      implementation: "SqliteMemoryStore",
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

  constructor(config: SqliteMemoryStoreConfig) {
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
    `);
  }

  async query(filters: QueryFilters): Promise<PortableMemory[]> {
    const { query, limit, mode } = filters;
    if (mode !== "fts") {
      throw new Error(
        `SqliteMemoryStore: mode '${mode}' not supported in T1 baseline. Use 'fts'. ` +
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
    const rows = this.db.prepare(
      `SELECT m.id, m.summary, m.detail, m.tags, m.created_at, m.metadata, bm25(memories_fts) AS score
         FROM memories_fts
         JOIN memories m ON memories_fts.rowid = m.rowid
        WHERE memories_fts MATCH $q
        ORDER BY score
        LIMIT $limit`,
    ).all({ $q: sanitized, $limit: limit }) as Array<Record<string, unknown>>;
    const results = rows.map((r) => this.rowToMemory(r, r["score"] as number | undefined));

    // Optional substring filter on domain_tags. Stored as a JSON-stringified array.
    if (typeof filters["domain_tags"] === "string" && filters["domain_tags"] !== "") {
      const needle = filters["domain_tags"] as string;
      return results.filter((m) =>
        Array.isArray(m.domain_tags) && m.domain_tags.some((t) => t.includes(needle)),
      );
    }
    return results;
  }

  async manifest(): Promise<ManifestInfo> {
    return {
      capabilities_version: "1",
      manifest: {
        kind: "sqlite-fts",
        supported_modes: ["fts"],
        score_range: "unbounded",
        supported_filters: ["domain_tags"],
        supports_write: true,
      },
    };
  }

  /**
   * v0.8.0 — `MemoryStore.write()` impl. Generates a substrate id; persists
   * via the existing `upsert()` schema with tags + metadata. The `summary`
   * field defaults to the first line of content (per the v0.7.x convention
   * — adopters who want richer summaries pre-compose and pass via metadata).
   * Recipients hint is stored in metadata for substrates that key alerts off it.
   */
  async write(entry: MemoryWrite): Promise<MemoryWriteRecord> {
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
    const tags = memory.domain_tags ? JSON.stringify(memory.domain_tags) : null;
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
      $tags: tags,
      $createdAt: createdAt,
      $metadata: metadata,
    });
  }

  close(): void {
    this.db.close();
  }

  private rowToMemory(row: Record<string, unknown>, score: number | undefined): PortableMemory {
    const tags = typeof row["tags"] === "string" ? safeParseJson(row["tags"]) : null;
    const metadata = typeof row["metadata"] === "string" ? safeParseJson(row["metadata"]) : null;
    const memory: PortableMemory = {
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
   * Strip FTS5 special syntax to safe phrase form. FTS5 errors on bare
   * punctuation; quote each whitespace-separated token to make a phrase
   * search. Authors who want raw FTS5 syntax can pass it pre-quoted.
   */
  private sanitizeFtsQuery(q: string): string {
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
