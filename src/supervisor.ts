// Autonomous-fire failure supervision (Perry spec 967ed739, Phase 1).
//
// A cron/event fire is fire-and-forget: no caller reads its result, so a failed
// 3am fire (or one cut mid-effect leaving a mutation "outcome uncertain") is
// invisible unless someone goes and queries the trace. This adds PUSH.
//
// Core principle: don't trust a failed fire to report its own failure (the same
// logic as the uncatchable deadline — a skill can't emit-to-supervisor on a
// deadline trip; the abort blows past it). So the notifier is an INDEPENDENT
// process reading the durable trace, not the skill self-reporting. That process
// is the SCHEDULER TICK (already the trusted headless-at-boot spine that holds
// the trace store) — not a new daemon, which dissolves the "who watches the
// watcher" regress: if the scheduler is alive to fire crons, it's alive to sweep.
//
// The sweeper only DETECTS (reliably) and ROUTES; the notification POLICY +
// delivery live in a governed, approvable handler SKILL ("mechanism is a
// script"). Per-fire dedup keeps it dumb + reliable; digest/severity/open-
// resolved intelligence is the handler's concern.

import type { TraceRecord } from "./trace.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A fire is "non-clean" (worth alerting on) if it errored, was deadline-cut, or
 * left an uncertain external effect. This is the applicability filter — the
 * sweeper routes exactly these to the handler skill.
 */
export function isNonCleanFire(rec: TraceRecord): boolean {
  return (
    rec.errors.length > 0 ||
    rec.deadline_exceeded === true ||
    (rec.uncertain_effects?.length ?? 0) > 0
  );
}

/** A short human class for the failure, passed to the handler as ${OUTCOME}. */
export function classifyOutcome(rec: TraceRecord): string {
  if ((rec.uncertain_effects?.length ?? 0) > 0) return "uncertain-effects";
  if (rec.deadline_exceeded === true) return "deadline-exceeded";
  return "errored";
}

/**
 * Small margin the sweep subtracts from its completion-time cursor when
 * re-querying — it covers only the write/read skew at the sweep boundary (a
 * record completing right as the last sweep read the store), NOT run duration.
 * The cursor keys on COMPLETION time (see SweeperState), so run length is
 * irrelevant to correctness — a run of any length is caught when it completes
 * (Perry finding #1). The notified-set dedups the small overlap.
 */
export const SWEEP_MARGIN_MS = 5 * 60 * 1000;

interface SweeperStateData {
  /** High-water COMPLETION time swept (ms). The sweep re-queries completed_since (cursor − margin). */
  cursor_ms: number;
  /** traceId → completedAtMs, so we can prune ids that fall below the margin floor. */
  notified: Record<string, number>;
}

/**
 * The sweeper's dedup memory: a high-water cursor + the set of already-notified
 * trace ids. Persisted to a JSON sidecar (atomic temp+rename, serialized writes
 * — the observed-shape sidecar pattern) so a restart doesn't re-alert every
 * recent failure. In-memory only when no path is given.
 */
export class SweeperState {
  private cursorMs = 0;
  private notified = new Map<string, number>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string | undefined) {}

  async load(): Promise<void> {
    if (this.path === undefined) return;
    try {
      const raw = await readFile(this.path, "utf8");
      const data = JSON.parse(raw) as SweeperStateData;
      if (typeof data.cursor_ms === "number") this.cursorMs = data.cursor_ms;
      if (data.notified !== null && typeof data.notified === "object") {
        for (const [id, ms] of Object.entries(data.notified)) {
          if (typeof ms === "number") this.notified.set(id, ms);
        }
      }
    } catch {
      /* missing/corrupt sidecar → start fresh; the notified-set self-heals within one lookback window */
    }
  }

  get cursor(): number {
    return this.cursorMs;
  }

  isNotified(traceId: string): boolean {
    return this.notified.has(traceId);
  }

  markNotified(traceId: string, firedAtMs: number): void {
    this.notified.set(traceId, firedAtMs);
  }

  advanceCursor(ms: number): void {
    if (ms > this.cursorMs) this.cursorMs = ms;
  }

  /** Drop notified ids older than the lookback floor — they can't be re-queried. */
  prune(floorMs: number): void {
    for (const [id, ms] of this.notified) {
      if (ms < floorMs) this.notified.delete(id);
    }
  }

  /** Best-effort persist (atomic temp+rename, serialized). No-op without a path. */
  async persist(): Promise<void> {
    if (this.path === undefined) return;
    const path = this.path;
    const snapshot: SweeperStateData = {
      cursor_ms: this.cursorMs,
      notified: Object.fromEntries(this.notified),
    };
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        await writeFile(tmp, JSON.stringify(snapshot), "utf8");
        await rename(tmp, path);
      } catch {
        /* best-effort — a persistence failure must never break the tick */
      }
    });
    return this.writeChain;
  }
}
