import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { safePathJoin, validatePathComponent } from "./safe-path.js";
import { InvalidPathError } from "./errors.js";
import type { ExecutionError, UncertainEffect } from "./runtime.js";
import type { ObservedShapeRecord } from "./observed-shape.js";
import { shapeKey } from "./observed-shape.js";

/**
 * Per-fire dispatch trace recording. Lets operators query "what did this
 * skill do at 09:05?" + "which fires failed?" + replay traces against
 * current connectors for "does this still work?" debugging.
 *
 * Three trace modes per-deployment + per-fire (per Open Q #6 disposition):
 *   - off    — no per-fire record. Error-only trace records still written
 *              (NFR-11 floor: failures always visible).
 *   - on     — every op + every output recorded.
 *   - sample — N% of fires recorded; sampling is deterministic via SHA-256
 *              of (trigger_id + skill_name).
 *
 * Trace store contract: pluggable backend. v1 ships `FilesystemTraceStore`
 * (file-backed default, zero external dependency). `DataStoreTraceStore`
 * (substrate-backed via the configured DataStore connector) becomes
 * possible when DataStore contract grows a write surface — currently
 * read-only per §3.
 */

export type TraceMode = "off" | "on" | "sample";

export interface TraceConfig {
  mode: TraceMode;
  /** Used when mode === "sample"; integer 0-100. Default 10. */
  samplePct?: number;
  /** Retention in ms before prune archives the record. Default 30d. */
  retentionMs?: number;
}

const DEFAULT_SAMPLE_PCT = 10;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Versioned trace record. Bumping `version` is a breaking change for
 * trace store consumers; T6 ships at version 1.
 */
export interface TraceRecord {
  version: 1;
  trace_id: string;
  skill_name: string;
  skill_version: string;
  trigger: { source: string; name: string; fired_at_ms: number };
  identity: { agent_id?: string };
  ops: TraceOpRecord[];
  emissions: string[];
  outputs: Record<string, unknown>;
  errors: ExecutionError[];
  /**
   * True when the run's `# Deadline:` (or operator ceiling) was exceeded and the
   * run was terminated early — the same flag as `ExecuteResult.deadlineExceeded`,
   * made durable. Recoverable from `errors` (`class: "RunDeadlineExceeded"`) too,
   * but carried explicitly so a trace reader needn't string-match. Absent on a
   * normal completion. Phase 1 of the deadlines feature (Perry spec de11dcc5).
   */
  deadline_exceeded?: boolean;
  /**
   * Mutations that were IN FLIGHT when the deadline cut them — "issued, outcome
   * uncertain, never auto-retried." This is the ONLY place the uncertain-effect
   * log survives for an AUTONOMOUS (cron/event) fire: there's no live caller to
   * read `ExecuteResult.uncertainEffects`, so without this the "the robot may
   * still be moving" signal would be lost from the durable record. Absent when
   * nothing was cut mid-mutation. Phase 1 (Perry spec de11dcc5, Part 4 floor).
   */
  uncertain_effects?: UncertainEffect[];
  fired_at_ms: number;
  completed_at_ms: number;
  duration_ms: number;
}

export interface TraceOpRecord {
  op_kind: string;
  target: string;
  body: string;
  started_at_ms: number;
  duration_ms: number;
  /** True when the op produced an error (captured in TraceRecord.errors). */
  errored: boolean;
  /**
   * Connector instance this op dispatched through. Present for `$`/`~`/`>`
   * ops; absent for `@`/`!`/`??`/`$set`/`foreach`/`if` (no connector
   * involvement). Used by `healthMetrics()` for per-connector aggregation.
   */
  connector?: string;
  /**
   * v0.18.8 — structured reason when the runtime refused the op without
   * dispatching. Today's enum:
   *   - "binary-not-allowed" — shell op binary not in operator allowlist
   * Dashboards filter `/fires` by this field for the operator's
   * observe→promote loop ("which off-list binaries did skills try to
   * invoke; do I want to add any to the allowlist?").
   */
  blocked_reason?: "binary-not-allowed";
}

export interface TraceQueryFilter {
  skill_name?: string;
  since_ms?: number;
  until_ms?: number;
  limit?: number;
}

export interface TraceStore {
  write(record: TraceRecord): Promise<void>;
  query(filter: TraceQueryFilter): Promise<TraceRecord[]>;
  get(traceId: string): Promise<TraceRecord | null>;
  /**
   * Prune records older than now-retentionMs. Non-destructive by default:
   * v1 hard-deletes (audit trail simplification); v1.x can add an archive
   * path. Returns the count of records pruned.
   */
  prune(retentionMs: number): Promise<number>;
  /**
   * v0.23.0 — record a `$ connector.tool` op's last-observed return shape
   * (keys/types, not values). Optional: a store without it simply contributes
   * no observed shapes and skill_preflight degrades (no shape surfaced). Internal
   * runtime cache, last-write-wins.
   */
  recordObservedShape?(record: ObservedShapeRecord): Promise<void>;
  /** v0.23.0 — read the last-observed shapes for a set of (connector, tool) refs. */
  getObservedShapes?(refs: Array<{ connector: string; tool: string }>): Promise<Map<string, ObservedShapeRecord>>;
  /**
   * v0.23.0 — await any in-flight observed-shape writes. Called at run
   * completion so fire-and-forget captures are durable before execute()
   * returns (CLI-exit-safe; an immediately-following read sees them).
   */
  flushObservedShapes?(): Promise<void>;
}

// ─── FilesystemTraceStore (bundled default) ─────────────────────────────────

/**
 * Writes JSON records under `<rootDir>/<skill_name>/<trace_id>.json`.
 * Zero external dependency; suitable for the standalone runtime out of
 * the box. Operators with a substrate wired can swap for a
 * substrate-backed store via config.
 */
export class FilesystemTraceStore implements TraceStore {
  constructor(private readonly rootDir: string) {}

  // v0.23.0 — observed output-shape cache. A single sidecar map under the
  // trace root, last-write-wins. Writes are serialized in-process via this
  // promise chain so concurrent records don't tear the file (atomic temp +
  // rename on each flush). Cross-process races degrade to last-write-wins,
  // which is fine for a hint cache.
  private observedShapeWrite: Promise<void> = Promise.resolve();
  private observedShapesPath(): string {
    return join(this.rootDir, "observed-shapes.json");
  }
  private async readObservedShapes(): Promise<Record<string, ObservedShapeRecord>> {
    try {
      const text = await readFile(this.observedShapesPath(), "utf8");
      const parsed = JSON.parse(text) as Record<string, ObservedShapeRecord>;
      return parsed !== null && typeof parsed === "object" ? parsed : {};
    } catch {
      return {}; // missing / unparseable → empty
    }
  }

  async recordObservedShape(record: ObservedShapeRecord): Promise<void> {
    // Serialize read-modify-write on the in-process chain.
    this.observedShapeWrite = this.observedShapeWrite.then(async () => {
      const all = await this.readObservedShapes();
      all[shapeKey(record.connector, record.tool)] = record;
      await mkdir(this.rootDir, { recursive: true });
      const path = this.observedShapesPath();
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
      await rename(tmp, path);
    }).catch(() => { /* best-effort cache; never surface a write failure */ });
    return this.observedShapeWrite;
  }

  async flushObservedShapes(): Promise<void> {
    await this.observedShapeWrite;
  }

  async getObservedShapes(
    refs: Array<{ connector: string; tool: string }>,
  ): Promise<Map<string, ObservedShapeRecord>> {
    const all = await this.readObservedShapes();
    const out = new Map<string, ObservedShapeRecord>();
    for (const r of refs) {
      const k = shapeKey(r.connector, r.tool);
      const rec = all[k];
      if (rec !== undefined) out.set(k, rec);
    }
    return out;
  }

  async write(record: TraceRecord): Promise<void> {
    // safePathJoin throws InvalidPathError on `..`, `.`, separators, null bytes.
    // Record came from a parser that accepted `# Skill: ..` (the parser checks
    // reserved keywords only); the path-traversal boundary is enforced here.
    const dir = safePathJoin(this.rootDir, record.skill_name);
    await mkdir(dir, { recursive: true });
    const path = safePathJoin(dir, `${record.trace_id}.json`);
    await writeFile(path, JSON.stringify(record, null, 2), "utf8");
  }

  async query(filter: TraceQueryFilter): Promise<TraceRecord[]> {
    const results: TraceRecord[] = [];
    let skillDirs: string[];
    if (filter.skill_name !== undefined) {
      try {
        validatePathComponent(filter.skill_name);
      } catch (err) {
        if (err instanceof InvalidPathError) return [];
        throw err;
      }
      skillDirs = [filter.skill_name];
    } else {
      try {
        skillDirs = await readdir(this.rootDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    }
    for (const skillDir of skillDirs) {
      const full = join(this.rootDir, skillDir);
      let entries: string[];
      try {
        entries = await readdir(full);
      } catch (err) {
        // ENOENT (race) or ENOTDIR (a sidecar file at the root, e.g.
        // observed-shapes.json) — skip; only skill subdirs hold trace records.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw err;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const text = await readFile(join(full, entry), "utf8");
          const rec = JSON.parse(text) as TraceRecord;
          if (filter.since_ms !== undefined && rec.fired_at_ms < filter.since_ms) continue;
          if (filter.until_ms !== undefined && rec.fired_at_ms > filter.until_ms) continue;
          results.push(rec);
        } catch {
          /* unreadable / unparseable — skip */
        }
      }
    }
    results.sort((a, b) => b.fired_at_ms - a.fired_at_ms);
    if (filter.limit !== undefined) return results.slice(0, filter.limit);
    return results;
  }

  async get(traceId: string): Promise<TraceRecord | null> {
    // traceId is caller-supplied (CLI arg or MCP arg) — validate before file ops.
    try {
      validatePathComponent(traceId);
    } catch (err) {
      if (err instanceof InvalidPathError) return null;
      throw err;
    }
    let skillDirs: string[];
    try {
      skillDirs = await readdir(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    for (const skillDir of skillDirs) {
      const path = join(this.rootDir, skillDir, `${traceId}.json`);
      try {
        const text = await readFile(path, "utf8");
        return JSON.parse(text) as TraceRecord;
      } catch (err) {
        // ENOENT (no such trace under this skill) or ENOTDIR (skillDir is a
        // sidecar file like observed-shapes.json, not a directory) — skip.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw err;
      }
    }
    return null;
  }

  async prune(retentionMs: number): Promise<number> {
    const cutoff = Date.now() - retentionMs;
    let count = 0;
    let skillDirs: string[];
    try {
      skillDirs = await readdir(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
    for (const skillDir of skillDirs) {
      const full = join(this.rootDir, skillDir);
      let entries: string[];
      try {
        entries = await readdir(full);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const path = join(full, entry);
        try {
          const text = await readFile(path, "utf8");
          const rec = JSON.parse(text) as TraceRecord;
          if (rec.fired_at_ms < cutoff) {
            await unlink(path);
            count++;
          }
        } catch {
          /* skip unreadable */
        }
      }
    }
    return count;
  }
}

// ─── Sampling decision ─────────────────────────────────────────────────────

/**
 * Deterministic sample decision per Open Q #2: SHA-256 of `trigger_id +
 * ":" + skill_name`, take the first byte mod 100, fire trace if under
 * `pct`. Same inputs always produce the same sampling decision — useful
 * for reproducible testing + dashboard drill-down.
 */
export function shouldSample(triggerId: string, skillName: string, pct: number): boolean {
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  const hash = createHash("sha256").update(`${triggerId}:${skillName}`).digest();
  return hash[0]! % 100 < pct;
}

// ─── TraceBuilder (mutable, used during execution) ──────────────────────────

/**
 * Accumulator used by the runtime during a single fire. Records per-op
 * timing + body; finalize() builds the immutable TraceRecord.
 */
export class TraceBuilder {
  private readonly ops: TraceOpRecord[] = [];
  private readonly firedAtMs: number;
  readonly trace_id: string;

  constructor(
    private readonly skill_name: string,
    private readonly skill_version: string,
    private readonly trigger: { source: string; name: string; fired_at_ms: number },
    private readonly identity: { agent_id?: string },
    /**
     * v0.19.0 — optional pre-minted trace_id. Used by the `/event` HTTP
     * ingress so the synchronous 200-response `run_id` matches the
     * trace_id the runtime will later write — adopters paste `run_id`
     * into the dashboard / `fires` query and find the trace cleanly.
     * When omitted, mints a fresh UUID (existing v1 behavior).
     */
    preMintedTraceId?: string,
  ) {
    this.firedAtMs = trigger.fired_at_ms;
    this.trace_id = preMintedTraceId ?? randomUUID();
  }

  recordOp(record: TraceOpRecord): void {
    this.ops.push(record);
  }

  finalize(
    emissions: string[],
    outputs: Record<string, unknown>,
    errors: ExecutionError[],
    deadline?: { deadlineExceeded: boolean; uncertainEffects: UncertainEffect[] },
  ): TraceRecord {
    const completedAtMs = Date.now();
    return {
      version: 1,
      trace_id: this.trace_id,
      skill_name: this.skill_name,
      skill_version: this.skill_version,
      trigger: this.trigger,
      identity: this.identity,
      ops: this.ops,
      emissions: [...emissions],
      outputs: { ...outputs },
      errors: [...errors],
      // Deadline outcome — durable so an autonomous fire's uncertain-effect log
      // isn't lost (no live caller reads ExecuteResult for cron/event fires).
      ...(deadline?.deadlineExceeded ? { deadline_exceeded: true } : {}),
      ...(deadline !== undefined && deadline.uncertainEffects.length > 0
        ? { uncertain_effects: [...deadline.uncertainEffects] }
        : {}),
      fired_at_ms: this.firedAtMs,
      completed_at_ms: completedAtMs,
      duration_ms: completedAtMs - this.firedAtMs,
    };
  }
}

/**
 * Decide whether a fire should be traced given config + trigger context.
 * Used by the runtime / scheduler at fire start. `mode === "off"` always
 * returns false (errors are still surfaced via `result.errors[]` — the
 * NFR-11 floor); the trace store is bypassed entirely.
 */
export function shouldTraceFire(
  config: TraceConfig | undefined,
  triggerId: string,
  skillName: string,
): boolean {
  if (config === undefined || config.mode === "off") return false;
  if (config.mode === "on") return true;
  const pct = config.samplePct ?? DEFAULT_SAMPLE_PCT;
  return shouldSample(triggerId, skillName, pct);
}

export const TRACE_DEFAULTS = {
  SAMPLE_PCT: DEFAULT_SAMPLE_PCT,
  RETENTION_MS: DEFAULT_RETENTION_MS,
} as const;

// ─── Internals ──────────────────────────────────────────────────────────────

/** Convenience for tests: derive the on-disk path FilesystemTraceStore writes to. */
export function _traceFilePathFor(rootDir: string, record: TraceRecord): string {
  void basename;
  void dirname;
  return safePathJoin(rootDir, record.skill_name, `${record.trace_id}.json`);
}
