import { createRequire } from "node:module";
import { dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { suppressSqliteExperimentalWarning } from "../sqlite-warning-suppress.js";
import type {
  SkillStore,
  SkillSource,
  SkillMeta,
  SkillStatus,
  SkillFilter,
  VersionInfo,
  SkillStoreCapabilities,
  ManifestInfo,
} from "./types.js";
import { VALID_SKILL_STATUSES, isSkillStatus } from "./types.js";
import {
  SkillNotFoundError,
  VersionNotFoundError,
  StorageConflictError,
} from "../errors.js";
import { extractStatusFromBody, stampApprovalToken } from "../approval.js";

const CONTRACT_VERSION = "1.0.0";

// v0.13.6 — Module-level flag so the REGEXP-fallback warning prints at most
// once per process, regardless of how many SqliteSkillStore instances get
// constructed against how many dbPaths. The warning describes a property of
// the loaded `node:sqlite` binary (build-time absence of REGEXP), not of any
// particular database file.
let regexpWarningPrinted = false;

// Lazy-load `node:sqlite` at instance construction time, not module load.
// Vite (vitest dev pipeline) strips the `node:` prefix and fails to resolve
// plain `sqlite`; createRequire bypasses Vite entirely. Matches the pattern
// in src/connectors/data-store.ts.
const requireNode = createRequire(import.meta.url);
type DatabaseSyncCtor = new (path: string) => DatabaseSync;
interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): {
    get(params?: object): unknown;
    all(params?: object): unknown[];
    run(params?: object): { changes: number; lastInsertRowid: number };
  };
  close(): void;
}
function loadDatabaseSync(): DatabaseSyncCtor {
  // v0.15.4 — see src/sqlite-warning-suppress.ts header. Same idempotent
  // filter used by SqliteDataStore.
  suppressSqliteExperimentalWarning();
  return (requireNode("node:sqlite") as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync;
}

export interface SqliteSkillStoreConfig {
  /** Path to the SQLite database file. Use `:memory:` for an ephemeral store. */
  dbPath: string;
}

/**
 * SQLite-backed SkillStore. Two-table schema:
 *
 *   skills(name PRIMARY KEY, current_version, content_hash, status, source,
 *          description, metadata_json, created_at, updated_at,
 *          status_changed_at)
 *   skill_versions(name, version, content_hash, source, status,
 *                  previous_status, changed_at, PRIMARY KEY (name, version))
 *
 * `skills` is the fast-path read for `load()` / `metadata()` / `query()`.
 * `skill_versions` is the append-only history for `versions()`.
 *
 * `update_status()` wraps the UPDATE + INSERT in a transaction so the audit
 * trail never logs a transition that didn't take effect. `delete()` hard-
 * cascades — both tables purged. If you need recovery, back up adopter-side
 * BEFORE calling delete (skill names can be reused after delete; no orphan
 * history left behind).
 *
 * WAL is enabled at bootstrap so concurrent readers don't block a writer.
 * Tag filtering uses `json_extract(metadata_json, '$.tags')` — O(n) table
 * scan documented in `manifest()` features.
 *
 * `version` string format: first 12 chars of `content_hash`. Consumers MUST
 * treat `version` as opaque (equality only) — same convention as
 * FilesystemSkillStore.
 *
 * **Bundled default — one of three legs of the SkillStore connector model.**
 * Adopters wire which leg via `connectors.json` substrate config:
 *   - `"filesystem"` (default) — uses FilesystemSkillStore
 *   - `"sqlite"` — uses this class
 *   - `{ type: "custom", module, export, config }` — adopter's own impl
 *
 * Runtime hosts (MCP server, web dashboard) honor the configured leg
 * automatically. The bundled CLI authoring commands (`skillfile compile`,
 * `skillfile lint`, `skillfile audit`, `skillfile list`) stay
 * filesystem-pinned — they're the FS-authoring loop regardless of substrate
 * config. Sqlite-backed skills are authored via the dashboard or the
 * `skill_write` MCP tool.
 *
 * See `docs/sqlite-skill-store.md` for the forking checklist (writing your
 * own adopter SkillStore impl).
 */
export class SqliteSkillStore implements SkillStore {
  static staticCapabilities(): SkillStoreCapabilities {
    return {
      connector_type: "skill_store",
      implementation: "SqliteSkillStore",
      contract_version: CONTRACT_VERSION,
      features: {
        supports_writes: true,
        supports_versioning: true,
        supports_tag_filter: true,
        supports_audit_trail: true,
        supports_atomic_status_transitions: true,
      },
    };
  }

  private readonly db: DatabaseSync;
  /**
   * v0.13.0 — REGEXP support probed once at construction. `node:sqlite`
   * doesn't include REGEXP by default. When unsupported, `query()` with
   * `name_pattern` falls back to a JS-side filter over a full-table scan
   * (no index help). Surfaced in `manifest()` so adopters notice the
   * degradation; was a silent fallback before.
   */
  private readonly regexpSupported: boolean;

  constructor(config: SqliteSkillStoreConfig) {
    if (config.dbPath !== ":memory:") {
      const dir = dirname(config.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    const DatabaseSync = loadDatabaseSync();
    this.db = new DatabaseSync(config.dbPath);
    this.bootstrap();
    this.regexpSupported = this.probeRegexpSupport();
    // v0.13.6 — REGEXP support is a property of the loaded node:sqlite
    // binary, not the dbPath. Multiple instances would otherwise repeat
    // the same warning. Module-level flag suppresses repeat prints; the
    // manifest still exposes `regexp_fallback_active` per-instance.
    if (!this.regexpSupported && !regexpWarningPrinted) {
      regexpWarningPrinted = true;
      process.stderr.write(
        `[SqliteSkillStore] REGEXP not supported by node:sqlite build; ` +
        `\`query({name_pattern: ...})\` will fall back to a JS-side filter over a full-table scan ` +
        `(no index help). Use \`status\` / \`tag\` / \`since\` filters instead where possible. ` +
        `(One-time warning per process; manifest.regexp_fallback_active exposes per-instance state.)\n`,
      );
    }
  }

  private probeRegexpSupport(): boolean {
    try {
      this.db.prepare(`SELECT 1 WHERE 'a' REGEXP 'a'`).get();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * v0.13.0 — transaction helper. Wraps a synchronous block in
   * BEGIN/COMMIT/ROLLBACK with the "ROLLBACK after COMMIT may itself fail"
   * edge case absorbed once. Three callers (`store()`, `delete()`,
   * `update_status()`) consolidate here.
   */
  private withTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      // ROLLBACK after a successful COMMIT throws ("cannot rollback - no
      // transaction is active") — that's a no-op for our purposes. Swallow
      // the ROLLBACK error; always re-raise the original.
      try { this.db.exec("ROLLBACK"); } catch { /* no-op */ }
      throw err;
    }
  }

  private bootstrap(): void {
    this.db.exec(`PRAGMA journal_mode = WAL;`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY,
        current_version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        description TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status_changed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS skill_versions (
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        previous_status TEXT,
        changed_at INTEGER NOT NULL,
        changed_by TEXT,
        PRIMARY KEY (name, version)
      );
      CREATE INDEX IF NOT EXISTS skills_status_idx ON skills(status);
      CREATE INDEX IF NOT EXISTS skills_updated_at_idx ON skills(updated_at);
      CREATE INDEX IF NOT EXISTS skill_versions_name_idx ON skill_versions(name);
    `);
  }

  async manifest(): Promise<ManifestInfo<"skill_store">> {
    return {
      capabilities_version: "1",
      manifest: {
        kind: "sqlite",
        // v0.13.0 — capability flags moved to StaticCapabilities.features only.
        // Manifest is substrate metadata (kind, paths, runtime context),
        // NOT a duplicate capability surface.
        tag_filter_note: "json_extract on metadata.tags; O(n) table scan",
        // v0.13.0 — surfaces when REGEXP isn't compiled into node:sqlite
        // so adopters can see the index-bypass at runtime_capabilities.
        regexp_fallback_active: !this.regexpSupported,
      },
    };
  }

  async load(name: string, version?: string): Promise<SkillSource> {
    if (version !== undefined) {
      const row = this.db.prepare(
        `SELECT name, version, content_hash, source, status FROM skill_versions
          WHERE name = $name AND version = $version`,
      ).get({ $name: name, $version: version }) as Record<string, unknown> | undefined;
      if (row === undefined) {
        // Check if the skill exists at all to disambiguate the error.
        const exists = this.db.prepare(
          `SELECT 1 FROM skills WHERE name = $name`,
        ).get({ $name: name });
        if (exists === undefined) throw new SkillNotFoundError(name, "SqliteSkillStore");
        throw new VersionNotFoundError(name, version, "SqliteSkillStore");
      }
      const meta = this.metadataRowToMeta(name, this.skillRow(name));
      return {
        name,
        version: row["version"] as string,
        content_hash: row["content_hash"] as string,
        source: row["source"] as string,
        metadata: meta,
      };
    }
    const row = this.skillRow(name);
    return {
      name,
      version: row["current_version"] as string,
      content_hash: row["content_hash"] as string,
      source: row["source"] as string,
      metadata: this.metadataRowToMeta(name, row),
    };
  }

  async query(filter?: SkillFilter): Promise<SkillMeta[]> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter?.status !== undefined) {
      const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
      const placeholders = wanted.map((_, i) => `$status${i}`).join(",");
      where.push(`status IN (${placeholders})`);
      wanted.forEach((s, i) => { params[`$status${i}`] = s; });
    }
    if (filter?.name_pattern !== undefined && this.regexpSupported) {
      where.push(`name REGEXP $name_pattern`);
      params["$name_pattern"] = filter.name_pattern;
    }
    // v0.13.0 — JS-side `name_pattern` filter applied post-query when
    // REGEXP is unsupported. Proactive instead of catch-and-retry.
    if (filter?.since !== undefined) {
      where.push(`updated_at >= $since`);
      params["$since"] = filter.since;
    }
    if (filter?.tag !== undefined) {
      const tags = Array.isArray(filter.tag) ? filter.tag : [filter.tag];
      tags.forEach((t, i) => {
        // AND semantics: skill must contain every requested tag.
        where.push(`EXISTS (SELECT 1 FROM json_each(json_extract(metadata_json, '$.tags')) WHERE value = $tag${i})`);
        params[`$tag${i}`] = t;
      });
    }
    if (filter?.author !== undefined) {
      where.push(`json_extract(metadata_json, '$.author') = $author`);
      params["$author"] = filter.author;
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    let sql = `SELECT name, current_version, content_hash, status, source, description,
                      metadata_json, created_at, updated_at, status_changed_at
                 FROM skills ${whereSql}
                 ORDER BY name`;
    if (filter?.limit !== undefined) sql += ` LIMIT $limit`;
    if (filter?.offset !== undefined) sql += ` OFFSET $offset`;
    if (filter?.limit !== undefined) params["$limit"] = filter.limit;
    if (filter?.offset !== undefined) params["$offset"] = filter.offset;
    let rows = this.db.prepare(sql).all(params) as Array<Record<string, unknown>>;
    // v0.13.0 — apply JS-side `name_pattern` filter when REGEXP unsupported.
    // Operator was warned at construction; manifest.regexp_fallback_active
    // reflects this at runtime_capabilities.
    if (filter?.name_pattern !== undefined && !this.regexpSupported) {
      const pat = new RegExp(filter.name_pattern);
      rows = rows.filter((r) => pat.test(r["name"] as string));
      if (filter?.offset !== undefined) rows = rows.slice(filter.offset);
      if (filter?.limit !== undefined) rows = rows.slice(0, filter.limit);
    }
    return rows.map((r) => this.metadataRowToMeta(r["name"] as string, r));
  }

  async metadata(name: string): Promise<SkillMeta> {
    const row = this.skillRow(name);
    return this.metadataRowToMeta(name, row);
  }

  async versions(name: string): Promise<VersionInfo[]> {
    // Verify the skill exists at all so we throw rather than return [].
    this.skillRow(name);
    const rows = this.db.prepare(
      `SELECT name, version, content_hash, status, previous_status, changed_at, changed_by
         FROM skill_versions WHERE name = $name ORDER BY changed_at`,
    ).all({ $name: name }) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const info: VersionInfo = {
        name: r["name"] as string,
        version: r["version"] as string,
        content_hash: r["content_hash"] as string,
        status: r["status"] as SkillStatus,
        changed_at: r["changed_at"] as number,
      };
      if (typeof r["previous_status"] === "string") info.previous_status = r["previous_status"] as SkillStatus;
      if (typeof r["changed_by"] === "string") info.changed_by = r["changed_by"] as string;
      return info;
    });
  }

  async store(name: string, source: string, metadata?: Partial<SkillMeta>): Promise<VersionInfo> {
    if (name.length === 0) {
      throw new StorageConflictError(name, "name must not be empty", "SqliteSkillStore");
    }
    // Auto-stamp approval token if body declares Approved without a valid
    // token. Matches FilesystemSkillStore behavior so headless adopters get
    // a runnable Approved state without a dashboard round-trip.
    let bodyToWrite = source;
    const extracted = extractStatusFromBody(source);
    if (extracted !== null && extracted.status === "Approved") {
      bodyToWrite = stampApprovalToken(source);
    }
    const content_hash = hashSource(bodyToWrite);
    const version = shortHash(content_hash);
    const status = metadata?.status ?? extracted?.status ?? "Draft";
    const description = metadata?.description ?? extractHeader(bodyToWrite, "Description");
    const nowSec = Math.floor(Date.now() / 1000);
    const metaJson = serializeMetadata(metadata);

    this.db.exec("BEGIN");
    try {
      const existing = this.db.prepare(
        `SELECT created_at FROM skills WHERE name = $name`,
      ).get({ $name: name }) as { created_at: number } | undefined;
      const createdAt = existing?.created_at ?? nowSec;
      this.db.prepare(
        `INSERT INTO skills (name, current_version, content_hash, status, source, description,
                             metadata_json, created_at, updated_at, status_changed_at)
              VALUES ($name, $version, $hash, $status, $source, $description,
                      $meta, $createdAt, $updatedAt, $statusChangedAt)
          ON CONFLICT(name) DO UPDATE SET
            current_version = $version,
            content_hash = $hash,
            status = $status,
            source = $source,
            description = $description,
            metadata_json = $meta,
            updated_at = $updatedAt,
            status_changed_at = $statusChangedAt`,
      ).run({
        $name: name,
        $version: version,
        $hash: content_hash,
        $status: status,
        $source: bodyToWrite,
        $description: description ?? null,
        $meta: metaJson,
        $createdAt: createdAt,
        $updatedAt: nowSec,
        $statusChangedAt: nowSec,
      });
      this.db.prepare(
        `INSERT INTO skill_versions (name, version, content_hash, source, status, changed_at, changed_by)
              VALUES ($name, $version, $hash, $source, $status, $changedAt, $changedBy)
          ON CONFLICT(name, version) DO UPDATE SET
            source = $source, status = $status, changed_at = $changedAt, changed_by = $changedBy`,
      ).run({
        $name: name,
        $version: version,
        $hash: content_hash,
        $source: bodyToWrite,
        $status: status,
        $changedAt: nowSec,
        $changedBy: metadata?.author ?? null,
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    const info: VersionInfo = {
      name,
      version,
      content_hash,
      status,
      changed_at: nowSec,
    };
    if (metadata?.author !== undefined) info.changed_by = metadata.author;
    return info;
  }

  async delete(name: string): Promise<void> {
    const result = this.withTransaction(() => {
      const r = this.db.prepare(
        `DELETE FROM skills WHERE name = $name`,
      ).run({ $name: name });
      this.db.prepare(
        `DELETE FROM skill_versions WHERE name = $name`,
      ).run({ $name: name });
      return r;
    });
    // Post-commit no-rows check — the transaction completed cleanly, but
    // there was nothing to delete. Same shape as the other "not found" misses.
    if (result.changes === 0) throw new SkillNotFoundError(name, "SqliteSkillStore");
  }

  async update_status(name: string, status: SkillStatus): Promise<VersionInfo> {
    // v0.13.7 — defense in depth. The MCP handler already validates, but
    // direct API callers can bypass that layer. Guard at store entry so
    // `rewriteStatusHeader` never sees undefined/invalid status (which would
    // silently corrupt the skill body with `# Status: undefined`).
    if (!isSkillStatus(status)) {
      throw new Error(
        `SqliteSkillStore.update_status(${JSON.stringify(name)}, ...): status must be one of ${VALID_SKILL_STATUSES.map((s) => `"${s}"`).join(", ")}; got ${JSON.stringify(status)}.`,
      );
    }
    const row = this.skillRow(name);
    const previous_status = row["status"] as SkillStatus;
    const source = row["source"] as string;
    // Transitions to Approved stamp the token; transitions away strip it.
    const updated = status === "Approved"
      ? stampApprovalToken(rewriteStatusHeader(source, "Approved"))
      : rewriteStatusHeader(source, status);
    const content_hash = hashSource(updated);
    const version = shortHash(content_hash);
    const nowSec = Math.floor(Date.now() / 1000);

    this.withTransaction(() => {
      this.db.prepare(
        `UPDATE skills SET
            current_version = $version,
            content_hash = $hash,
            status = $status,
            source = $source,
            updated_at = $updatedAt,
            status_changed_at = $statusChangedAt
          WHERE name = $name`,
      ).run({
        $name: name,
        $version: version,
        $hash: content_hash,
        $status: status,
        $source: updated,
        $updatedAt: nowSec,
        $statusChangedAt: nowSec,
      });
      this.db.prepare(
        `INSERT INTO skill_versions (name, version, content_hash, source, status, previous_status, changed_at)
              VALUES ($name, $version, $hash, $source, $status, $previous, $changedAt)
          ON CONFLICT(name, version) DO UPDATE SET
            status = $status, previous_status = $previous, changed_at = $changedAt`,
      ).run({
        $name: name,
        $version: version,
        $hash: content_hash,
        $source: updated,
        $status: status,
        $previous: previous_status,
        $changedAt: nowSec,
      });
    });

    return {
      name,
      version,
      content_hash,
      status,
      previous_status,
      changed_at: nowSec,
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * v0.13.0 — Throws `SkillNotFoundError` on miss. Cannot distinguish
   * "never existed" from "deleted between calls" — hard-cascade `delete()`
   * removes the skill row + all skill_versions, so the substrate has no
   * evidence either way. Callers needing that distinction must track
   * delete events themselves (e.g., watch their own `delete()` calls) or
   * switch to soft-delete (tombstone via `update_status("Disabled")`).
   */
  private skillRow(name: string): Record<string, unknown> {
    const row = this.db.prepare(
      `SELECT name, current_version, content_hash, status, source, description,
              metadata_json, created_at, updated_at, status_changed_at
         FROM skills WHERE name = $name`,
    ).get({ $name: name }) as Record<string, unknown> | undefined;
    if (row === undefined) throw new SkillNotFoundError(name, "SqliteSkillStore");
    return row;
  }

  private metadataRowToMeta(name: string, row: Record<string, unknown>): SkillMeta {
    const meta: SkillMeta = {
      name,
      version: row["current_version"] as string,
      content_hash: row["content_hash"] as string,
      status: row["status"] as SkillStatus,
      created_at: row["created_at"] as number,
      updated_at: row["updated_at"] as number,
    };
    if (typeof row["description"] === "string") meta.description = row["description"];
    if (typeof row["status_changed_at"] === "number") meta.status_changed_at = row["status_changed_at"];
    if (typeof row["metadata_json"] === "string") {
      const parsed = safeParseJson(row["metadata_json"]);
      if (parsed !== null && typeof parsed === "object") {
        const bag = parsed as Record<string, unknown>;
        if (typeof bag["author"] === "string") meta.author = bag["author"];
        if (Object.keys(bag).length > 0) meta.metadata_bag = bag;
      }
    }
    return meta;
  }
}

function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function shortHash(content_hash: string): string {
  return content_hash.slice(0, 12);
}

function extractHeader(body: string, key: string): string | null {
  const re = new RegExp(`^#\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m");
  const m = re.exec(body);
  return m ? m[1]! : null;
}

function rewriteStatusHeader(source: string, status: SkillStatus): string {
  const line = `# Status: ${status}`;
  const re = /^#\s*Status\s*:\s*.+?\s*$/m;
  if (re.test(source)) return source.replace(re, line);
  const skillLineRe = /^(#\s*Skill\s*:\s*.+?)\s*$/m;
  if (skillLineRe.test(source)) return source.replace(skillLineRe, `$1\n${line}`);
  return `${line}\n${source}`;
}

function serializeMetadata(metadata?: Partial<SkillMeta>): string | null {
  if (metadata === undefined) return null;
  const bag: Record<string, unknown> = { ...(metadata.metadata_bag ?? {}) };
  if (metadata.author !== undefined) bag["author"] = metadata.author;
  return Object.keys(bag).length > 0 ? JSON.stringify(bag) : null;
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
