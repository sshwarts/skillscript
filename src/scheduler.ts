import { compile } from "./compile.js";
import { execute, type ExecuteContext, type ExecuteResult } from "./runtime.js";
import type { Registry } from "./connectors/registry.js";
import type { SkillStore } from "./connectors/types.js";
import type { TriggerSource } from "./parser.js";

/**
 * Trigger scheduler — the autonomous-dispatch surface per ERD §6.
 *
 * Polls every `pollIntervalSeconds` (default 30s). On each tick, evaluates
 * registered cron triggers against the current clock; for matching triggers
 * whose skills are Approved, dispatches via runtime.execute().
 *
 * Session hooks fire on scheduler.start() (`session: start`) and on
 * scheduler.stop() / SIGTERM (`session: end`). Event/agent-event/file-watch/
 * sensor sources parse-register but never fire in v1 — dispatch attempts
 * log a debug warning + skip.
 *
 * Concurrency: each fire is an independent execute() call. No shared mutable
 * state; no serialization. Multiple skills firing the same tick run in
 * parallel. No de-dup of overlapping triggers (per Open Q #1 resolution —
 * authors dedup via skill body if needed).
 */

export type ResolvableTriggerSource = TriggerSource;

export interface TriggerRegistration {
  id: string;
  skillName: string;
  source: ResolvableTriggerSource;
  /**
   * Source-specific value: cron expression (`"0 9 * * *"`), session phase
   * (`"start"` | `"end"`), event name, file path, etc.
   */
  name: string;
  registeredAt: number;
  expiresAt?: number;
  /** True if from `# Triggers:` header at skill-write time; false if imperative. */
  declarative: boolean;
}

export interface SchedulerConfig {
  registry: Registry;
  /** Required for status-state lookup at dispatch time. */
  skillStore: SkillStore;
  /** Cron tick interval. Default 30s. */
  pollIntervalSeconds?: number;
  /** Forwarded to runtime.execute(). */
  enableUnsafeShell?: boolean;
  absoluteTimeoutMs?: number;
  /** Optional clock source for tests. Default Date.now. */
  now?: () => number;
  /** Optional debug logger. Default console.warn. */
  log?: (msg: string) => void;
}

/** Internal: snapshot of cron-fire state to dedupe within a minute. */
interface CronFireState {
  lastFiredMinuteEpoch: number;
}

export class Scheduler {
  private readonly registry: Registry;
  private readonly skillStore: SkillStore;
  private readonly pollIntervalMs: number;
  private readonly enableUnsafeShell: boolean;
  private readonly absoluteTimeoutMs: number | undefined;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly triggers = new Map<string, TriggerRegistration>();
  private readonly cronState = new Map<string, CronFireState>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sigtermHandler: (() => void) | null = null;
  private nextId = 1;

  constructor(config: SchedulerConfig) {
    this.registry = config.registry;
    this.skillStore = config.skillStore;
    this.pollIntervalMs = (config.pollIntervalSeconds ?? 30) * 1000;
    this.enableUnsafeShell = config.enableUnsafeShell ?? false;
    this.absoluteTimeoutMs = config.absoluteTimeoutMs;
    this.now = config.now ?? (() => Date.now());
    this.log = config.log ?? ((msg) => process.stderr.write(`[scheduler] ${msg}\n`));
  }

  registerTrigger(reg: Omit<TriggerRegistration, "id" | "registeredAt">): TriggerRegistration {
    const id = `trig-${this.nextId++}`;
    const full: TriggerRegistration = {
      ...reg,
      id,
      registeredAt: Math.floor(this.now() / 1000),
    };
    this.triggers.set(id, full);
    return full;
  }

  unregisterTrigger(id: string): boolean {
    this.cronState.delete(id);
    return this.triggers.delete(id);
  }

  listTriggers(filter?: { skillName?: string; source?: ResolvableTriggerSource }): TriggerRegistration[] {
    const result: TriggerRegistration[] = [];
    for (const t of this.triggers.values()) {
      if (filter?.skillName !== undefined && t.skillName !== filter.skillName) continue;
      if (filter?.source !== undefined && t.source !== filter.source) continue;
      result.push(t);
    }
    return result;
  }

  /**
   * Begin polling + fire session-start hooks. Idempotent — calling start()
   * twice has no extra effect.
   */
  start(): void {
    if (this.pollTimer !== null) return;
    this.fireSessionPhase("start").catch((err: unknown) => {
      this.log(`session:start dispatch failed: ${(err as Error).message}`);
    });
    this.pollTimer = setInterval(() => {
      this.tick().catch((err: unknown) => {
        this.log(`scheduler tick failed: ${(err as Error).message}`);
      });
    }, this.pollIntervalMs);
    // SIGTERM handler — graceful stop fires session-end. Don't install on
    // Windows or when process.on isn't available (e.g., browser-like env).
    if (typeof process !== "undefined" && typeof process.on === "function") {
      this.sigtermHandler = (): void => {
        this.stop().catch((err: unknown) => {
          this.log(`session:end dispatch failed during SIGTERM: ${(err as Error).message}`);
        });
      };
      process.on("SIGTERM", this.sigtermHandler);
    }
  }

  /**
   * Stop polling + fire session-end hooks. Returns a promise that resolves
   * when session-end fires complete.
   */
  async stop(): Promise<void> {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.sigtermHandler !== null && typeof process !== "undefined" && typeof process.off === "function") {
      process.off("SIGTERM", this.sigtermHandler);
      this.sigtermHandler = null;
    }
    await this.fireSessionPhase("end");
  }

  /**
   * Run one tick of the poll loop. Public for tests — production callers
   * use start() instead.
   */
  async tick(): Promise<void> {
    const nowMs = this.now();
    // Expiry sweep.
    const nowSec = Math.floor(nowMs / 1000);
    for (const [id, t] of this.triggers) {
      if (t.expiresAt !== undefined && t.expiresAt <= nowSec) {
        this.triggers.delete(id);
        this.cronState.delete(id);
      }
    }
    // Cron evaluation.
    const date = new Date(nowMs);
    const minuteEpoch = Math.floor(nowMs / 60_000);
    const fires: Promise<void>[] = [];
    for (const trig of this.triggers.values()) {
      if (trig.source !== "cron") continue;
      const state = this.cronState.get(trig.id) ?? { lastFiredMinuteEpoch: -1 };
      if (state.lastFiredMinuteEpoch === minuteEpoch) continue;
      if (!cronMatches(trig.name, date)) continue;
      this.cronState.set(trig.id, { lastFiredMinuteEpoch: minuteEpoch });
      fires.push(this.dispatchTrigger(trig, nowMs).then(() => undefined));
    }
    await Promise.all(fires);
  }

  /**
   * Immediate dispatch. Used by the poll loop, session-phase hooks, and
   * tests. Status-state is checked at dispatch time (not registration) per
   * spec — when a skill transitions Draft → Approved, its triggers
   * activate without re-registration.
   */
  async dispatchSkill(skillName: string, eventPayload?: Record<string, unknown>): Promise<ExecuteResult | null> {
    let meta;
    try {
      meta = await this.skillStore.metadata(skillName);
    } catch (err) {
      this.log(`dispatch '${skillName}': metadata lookup failed (${(err as Error).message}); skipping`);
      return null;
    }
    if (meta.status !== "Approved") {
      this.log(`dispatch '${skillName}': skill status is '${meta.status}' (not Approved); skipping`);
      return null;
    }
    const loaded = await this.skillStore.load(skillName);
    const compiled = await compile(loaded.source);
    const ctx: ExecuteContext = {
      registry: this.registry,
      enableUnsafeShell: this.enableUnsafeShell,
      ...(this.absoluteTimeoutMs !== undefined ? { absoluteTimeoutMs: this.absoluteTimeoutMs } : {}),
    };
    return execute(
      compiled.parsed,
      { ...compiled.resolvedVariables, ...(eventPayload ?? {}) },
      compiled.targetOrder,
      ctx,
    );
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async dispatchTrigger(trig: TriggerRegistration, firedAtMs: number): Promise<void> {
    const firedAtUnix = Math.floor(firedAtMs / 1000);
    const eventPayload: Record<string, unknown> = {
      TRIGGER_TYPE: trig.source,
      TRIGGER_PAYLOAD: trig.name,
      "EVENT.fired_at": firedAtMs,
      "EVENT.fired_at_unix": firedAtUnix,
      "EVENT.fired_at_plus_1h_unix": firedAtUnix + 3600,
      "EVENT.fired_at_plus_1d_unix": firedAtUnix + 86_400,
      "EVENT.fired_at_plus_7d_unix": firedAtUnix + 604_800,
    };
    try {
      const result = await this.dispatchSkill(trig.skillName, eventPayload);
      if (result !== null && result.errors.length > 0) {
        for (const e of result.errors) {
          this.log(`trigger ${trig.id} (${trig.source}: ${trig.name}) → ${trig.skillName} → ${e.target}/${e.opKind}: ${e.message}`);
        }
      }
    } catch (err) {
      this.log(`trigger ${trig.id} (${trig.source}: ${trig.name}) dispatch threw: ${(err as Error).message}`);
    }
  }

  private async fireSessionPhase(phase: "start" | "end"): Promise<void> {
    const matching = Array.from(this.triggers.values()).filter(
      (t) => t.source === "session" && t.name === phase,
    );
    const nowMs = this.now();
    await Promise.all(matching.map((t) => this.dispatchTrigger(t, nowMs)));
  }
}

// ─── Cron evaluator ─────────────────────────────────────────────────────────

/**
 * Match a 5-field cron expression against a Date. Supports star, integer
 * literals, ranges (a-b), step syntax with / N, and comma-separated lists
 * across MIN HOUR DOM MON DOW fields. Day-of-week uses 0=Sun convention.
 */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, dom, mon, dow] = fields;
  return (
    matchCronField(min!, date.getMinutes(), 0, 59) &&
    matchCronField(hour!, date.getHours(), 0, 23) &&
    matchCronField(dom!, date.getDate(), 1, 31) &&
    matchCronField(mon!, date.getMonth() + 1, 1, 12) &&
    matchCronField(dow!, date.getDay(), 0, 6)
  );
}

function matchCronField(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(",")) {
    if (matchCronPart(part, value, min, max)) return true;
  }
  return false;
}

function matchCronPart(part: string, value: number, min: number, max: number): boolean {
  // Step form: */N or A-B/N
  const stepIdx = part.indexOf("/");
  let base = part;
  let step = 1;
  if (stepIdx >= 0) {
    base = part.slice(0, stepIdx);
    const stepNum = parseInt(part.slice(stepIdx + 1), 10);
    if (!Number.isFinite(stepNum) || stepNum <= 0) return false;
    step = stepNum;
  }
  if (base === "*") {
    return (value - min) % step === 0;
  }
  const rangeIdx = base.indexOf("-");
  if (rangeIdx >= 0) {
    const a = parseInt(base.slice(0, rangeIdx), 10);
    const b = parseInt(base.slice(rangeIdx + 1), 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (value < a || value > b) return false;
    return (value - a) % step === 0;
  }
  const n = parseInt(base, 10);
  if (!Number.isFinite(n)) return false;
  if (value !== n) return false;
  if (n < min || n > max) return false;
  return true;
}
