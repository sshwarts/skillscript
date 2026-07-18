import type { TraceRecord, TraceStore } from "./trace.js";

/**
 * Health metrics aggregation per ERD §8. Computed from trace records;
 * surfaces fire rate, success rate, error category breakdown per skill,
 * and connector latency + error metrics across the deployment.
 *
 * Production deployments call `healthMetrics()` on a poll cycle (30s
 * matches the dashboard polling default); CLI surfaces it via
 * `skillfile health` (Phase 4).
 */

export interface HealthMetricsFilter {
  /** Restrict to specific skills. Empty/undefined = all. */
  skills?: string[];
  /** Restrict to specific connector instances. Empty/undefined = all. */
  connectors?: string[];
  /** Window start (ms epoch). Default: 24h ago. */
  since_ms?: number;
  /** Window end (ms epoch). Default: now. */
  until_ms?: number;
}

export interface PerSkillMetrics {
  fireCount: number;
  successCount: number;
  errorCount: number;
  /** Fires terminated by a run deadline (deadline_exceeded). Subset of the non-clean set. */
  deadlineExceededCount: number;
  /**
   * Fires that left an uncertain external effect (a mutation issued, outcome
   * unknown). The highest-severity signal — "something may have landed, reconcile
   * it" — surfaced distinctly because it isn't a plain error class.
   */
  uncertainEffectCount: number;
  /** 0-1 inclusive. Zero fires → 1 (no failures observed). */
  successRate: number;
  /** Most recent NON-CLEAN fire (errored / deadline / uncertain), ms epoch; undefined if all clean. */
  lastFailure_ms?: number;
  /** opKind → errorClass → count. */
  errorCategories: Record<string, Record<string, number>>;
}

export interface PerConnectorMetrics {
  callCount: number;
  errorCount: number;
  /** 0-1 inclusive. Zero calls → 0. */
  errorRate: number;
  latencyMs: { p50: number; p95: number; p99: number };
  /** Timestamp of the most recent successful call, undefined if none. */
  lastSuccess_ms?: number;
}

export interface HealthMetrics {
  windowStart_ms: number;
  windowEnd_ms: number;
  perSkill: Record<string, PerSkillMetrics>;
  perConnector: Record<string, PerConnectorMetrics>;
  totalFires: number;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function healthMetrics(
  traceStore: TraceStore,
  filter: HealthMetricsFilter = {},
): Promise<HealthMetrics> {
  const now = Date.now();
  const windowEnd = filter.until_ms ?? now;
  const windowStart = filter.since_ms ?? windowEnd - DEFAULT_WINDOW_MS;

  const traces: TraceRecord[] = [];
  if (filter.skills && filter.skills.length > 0) {
    for (const skill of filter.skills) {
      traces.push(...await traceStore.query({ skill_name: skill, since_ms: windowStart, until_ms: windowEnd }));
    }
  } else {
    traces.push(...await traceStore.query({ since_ms: windowStart, until_ms: windowEnd }));
  }

  const perSkill: Record<string, PerSkillMetrics> = {};
  const connectorAcc: Record<string, { latencies: number[]; errors: number; calls: number; lastSuccess?: number }> = {};
  const connectorFilter = filter.connectors !== undefined && filter.connectors.length > 0
    ? new Set(filter.connectors)
    : null;

  for (const trace of traces) {
    // Per-skill aggregation
    let skillMetrics = perSkill[trace.skill_name];
    if (skillMetrics === undefined) {
      skillMetrics = {
        fireCount: 0,
        successCount: 0,
        errorCount: 0,
        deadlineExceededCount: 0,
        uncertainEffectCount: 0,
        successRate: 1,
        errorCategories: {},
      };
      perSkill[trace.skill_name] = skillMetrics;
    }
    skillMetrics.fireCount++;
    if (trace.errors.length === 0) {
      skillMetrics.successCount++;
    } else {
      skillMetrics.errorCount++;
      for (const err of trace.errors) {
        let byOp = skillMetrics.errorCategories[err.opKind];
        if (byOp === undefined) {
          byOp = {};
          skillMetrics.errorCategories[err.opKind] = byOp;
        }
        byOp[err.class] = (byOp[err.class] ?? 0) + 1;
      }
    }
    // Deadline + uncertain-effect signals (distinct from plain error class).
    if (trace.deadline_exceeded === true) skillMetrics.deadlineExceededCount++;
    if ((trace.uncertain_effects?.length ?? 0) > 0) skillMetrics.uncertainEffectCount++;
    if (trace.errors.length > 0 || trace.deadline_exceeded === true || (trace.uncertain_effects?.length ?? 0) > 0) {
      skillMetrics.lastFailure_ms = Math.max(skillMetrics.lastFailure_ms ?? 0, trace.fired_at_ms);
    }

    // Per-connector aggregation
    for (const opRec of trace.ops) {
      if (opRec.connector === undefined) continue;
      if (connectorFilter && !connectorFilter.has(opRec.connector)) continue;
      let acc = connectorAcc[opRec.connector];
      if (acc === undefined) {
        acc = { latencies: [], errors: 0, calls: 0 };
        connectorAcc[opRec.connector] = acc;
      }
      acc.calls++;
      acc.latencies.push(opRec.duration_ms);
      if (opRec.errored) {
        acc.errors++;
      } else {
        const t = opRec.started_at_ms + opRec.duration_ms;
        if (acc.lastSuccess === undefined || t > acc.lastSuccess) acc.lastSuccess = t;
      }
    }
  }

  // Compute success rates
  for (const m of Object.values(perSkill)) {
    m.successRate = m.fireCount === 0 ? 1 : m.successCount / m.fireCount;
  }

  // Compute per-connector latency percentiles
  const perConnector: Record<string, PerConnectorMetrics> = {};
  for (const [name, acc] of Object.entries(connectorAcc)) {
    const sorted = [...acc.latencies].sort((a, b) => a - b);
    const entry: PerConnectorMetrics = {
      callCount: acc.calls,
      errorCount: acc.errors,
      errorRate: acc.calls === 0 ? 0 : acc.errors / acc.calls,
      latencyMs: {
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
      },
    };
    if (acc.lastSuccess !== undefined) entry.lastSuccess_ms = acc.lastSuccess;
    perConnector[name] = entry;
  }

  return {
    windowStart_ms: windowStart,
    windowEnd_ms: windowEnd,
    perSkill,
    perConnector,
    totalFires: traces.length,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}
