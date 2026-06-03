import { compile } from "./compile.js";
import { execute, type ExecuteContext, type ExecuteResult } from "./runtime.js";
import type { Registry } from "./connectors/registry.js";
import type { SkillStore } from "./connectors/types.js";
import type { TriggerSource } from "./parser.js";
import type { TraceConfig, TraceStore } from "./trace.js";
import { evaluateApprovalGate } from "./approval.js";

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
  /**
   * v0.9.0 — per-trigger enable/disable for vacation / maintenance windows.
   * Disabled triggers remain registered (scheduler.listTriggers shows them)
   * but the poll loop skips firing. State persists via the onTriggersChanged
   * hook to triggers.json so a restart preserves the disabled state.
   * Default `true` on registration.
   */
  enabled: boolean;
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
  /** Dispatch trace recording config. Forwarded to execute() ctx. */
  trace?: TraceConfig;
  /** Trace store backend. Forwarded to execute() ctx. */
  traceStore?: TraceStore;
  /** Optional clock source for tests. Default Date.now. */
  now?: () => number;
  /** Optional debug logger. Default console.warn. */
  log?: (msg: string) => void;
  /**
   * Optional write-through hook. Fires on register/unregister of an
   * imperative (non-declarative) trigger so a persistent registry can
   * mirror the in-memory state to disk. v0.2.7 addition — used by the
   * `bootstrap()` helper to wire `$SKILLSCRIPT_HOME/triggers.json`.
   * Declarative triggers (parsed from `# Triggers:` headers) are NOT
   * forwarded to this hook — those re-derive from the SkillStore at
   * every boot and don't belong in the persistent registry.
   */
  onTriggersChanged?: (snapshot: ReadonlyArray<TriggerRegistration>) => void;
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
  private readonly trace: TraceConfig | undefined;
  private readonly traceStore: TraceStore | undefined;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly onTriggersChanged: ((snapshot: ReadonlyArray<TriggerRegistration>) => void) | undefined;
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
    this.trace = config.trace;
    this.traceStore = config.traceStore;
    this.now = config.now ?? (() => Date.now());
    this.log = config.log ?? ((msg) => process.stderr.write(`[scheduler] ${msg}\n`));
    this.onTriggersChanged = config.onTriggersChanged;
  }

  /**
   * Register a new trigger. v0.2.7: imperative registrations fire the
   * `onTriggersChanged` hook so the persistent registry can write
   * through to disk. Declarative registrations skip the hook — those
   * re-derive from the SkillStore at boot, not from the persistent file.
   *
   * `seedFromPersistence`: when true, suppresses the hook AND assigns the
   * stored id verbatim so the trigger comes back from disk with the same
   * id the MCP client originally received. Used by `bootstrap()` during
   * boot-time hydration.
   */
  registerTrigger(
    reg: Omit<TriggerRegistration, "id" | "registeredAt" | "enabled"> & { id?: string; registeredAt?: number; enabled?: boolean },
    opts?: { seedFromPersistence?: boolean },
  ): TriggerRegistration {
    const id = reg.id ?? `trig-${this.nextId++}`;
    // Keep nextId monotonic across hydrated ids so future imperative
    // registrations don't collide with seeded ones.
    const idNum = /^trig-(\d+)$/.exec(id);
    if (idNum && Number(idNum[1]) >= this.nextId) {
      this.nextId = Number(idNum[1]) + 1;
    }
    const full: TriggerRegistration = {
      skillName: reg.skillName,
      source: reg.source,
      name: reg.name,
      registeredAt: reg.registeredAt ?? Math.floor(this.now() / 1000),
      declarative: reg.declarative,
      enabled: reg.enabled ?? true,
      ...(reg.expiresAt !== undefined ? { expiresAt: reg.expiresAt } : {}),
      id,
    };
    this.triggers.set(id, full);
    if (opts?.seedFromPersistence !== true && !full.declarative) {
      this.fireOnTriggersChanged();
    }
    return full;
  }

  unregisterTrigger(id: string): boolean {
    this.cronState.delete(id);
    const existed = this.triggers.get(id);
    const removed = this.triggers.delete(id);
    if (removed && existed !== undefined && !existed.declarative) {
      this.fireOnTriggersChanged();
    }
    return removed;
  }

  /**
   * v0.9.0 — toggle a trigger's enabled state. Disabled triggers remain
   * registered but the poll loop skips firing them. Persists via
   * onTriggersChanged for imperative triggers; declarative triggers don't
   * round-trip to triggers.json (they're rederived from skill bodies at
   * bootstrap), so toggling those only persists until the next reboot.
   *
   * Returns the updated registration, or `null` if no trigger has that id.
   */
  setTriggerEnabled(id: string, enabled: boolean): TriggerRegistration | null {
    const existing = this.triggers.get(id);
    if (existing === undefined) return null;
    if (existing.enabled === enabled) return existing;
    const updated: TriggerRegistration = { ...existing, enabled };
    this.triggers.set(id, updated);
    if (!existing.declarative) this.fireOnTriggersChanged();
    return updated;
  }

  private fireOnTriggersChanged(): void {
    if (this.onTriggersChanged === undefined) return;
    try {
      this.onTriggersChanged(Array.from(this.triggers.values()));
    } catch (err) {
      this.log(`onTriggersChanged hook threw: ${(err as Error).message}`);
    }
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
    // Expiry sweep. Imperative triggers that expire need to fire the
    // onTriggersChanged hook so the persistent registry drops them on disk.
    const nowSec = Math.floor(nowMs / 1000);
    let imperativeExpired = false;
    for (const [id, t] of this.triggers) {
      if (t.expiresAt !== undefined && t.expiresAt <= nowSec) {
        if (!t.declarative) imperativeExpired = true;
        this.triggers.delete(id);
        this.cronState.delete(id);
      }
    }
    if (imperativeExpired) this.fireOnTriggersChanged();
    // Cron evaluation.
    const date = new Date(nowMs);
    const minuteEpoch = Math.floor(nowMs / 60_000);
    const fires: Promise<void>[] = [];
    for (const trig of this.triggers.values()) {
      if (trig.source !== "cron") continue;
      if (trig.enabled === false) continue; // v0.9.0 — disabled-trigger skip
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
   *
   * Auto-populates `$(EVENT.fired_at_*_unix)` and `$(TRIGGER_TYPE)` from
   * the current clock unless the caller's eventPayload overrides them.
   * Callers invoking dispatchSkill directly (without going through a
   * registered trigger) still get clock-time ambient refs out of the box.
   */
  async dispatchSkill(
    skillName: string,
    eventPayload?: Record<string, unknown>,
    triggerCtx?: { source: string; name: string; fired_at_ms: number; trigger_id?: string },
  ): Promise<ExecuteResult | null> {
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
    // v0.9.0 — universal execution gate. SkillStore metadata says Approved,
    // but we must re-verify the hash token: body edits since approval
    // (e.g. agent-modifies-then-fires-trigger) invalidate the prior stamp.
    const gate = evaluateApprovalGate(loaded.source);
    if (!gate.ok) {
      this.log(`dispatch '${skillName}': approval gate refused (${gate.reason}); skipping`);
      return null;
    }
    const compiled = await compile(loaded.source);
    const nowMs = this.now();
    const ctx: ExecuteContext = {
      registry: this.registry,
      enableUnsafeShell: this.enableUnsafeShell,
      ...(this.absoluteTimeoutMs !== undefined ? { absoluteTimeoutMs: this.absoluteTimeoutMs } : {}),
      ...(this.trace !== undefined ? { trace: this.trace } : {}),
      ...(this.traceStore !== undefined ? { traceStore: this.traceStore } : {}),
      // v0.9.6 — "manual" enum value dropped per audit Q12. Default fallback
      // is "inline" — "programmatic call without explicit trigger context"
      // per Perry's mapping. Specific callers (CLI, dashboard, agent-driven)
      // pass their own triggerCtx with the right source value.
      triggerCtx: triggerCtx ?? { source: "inline", name: "", fired_at_ms: nowMs },
      skillVersion: loaded.metadata.version,
      // v0.16.9 — identity follows the skill. Trigger-fired dispatch
      // (cron, scheduled, event-source) carries the skill's author as
      // ctx.agentId. Closes the `olsen-nightly` cron case from Scott's
      // original framing: a skill that writes to its author's mailbox
      // now dispatches under the author's identity even when fired by
      // the scheduler under a different process identity.
      ...(loaded.metadata.author !== undefined ? { agentId: loaded.metadata.author } : {}),
    };
    const defaults = this.buildEventDefaults();
    return execute(
      compiled.parsed,
      { ...compiled.resolvedVariables, ...defaults, ...(eventPayload ?? {}) },
      compiled.targetOrder,
      ctx,
    );
  }

  /** Default EVENT.* ambient refs at the current clock; caller may override. */
  private buildEventDefaults(): Record<string, unknown> {
    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    return {
      TRIGGER_TYPE: "inline",
      "EVENT.fired_at": nowMs,
      "EVENT.fired_at_unix": nowSec,
      "EVENT.fired_at_plus_1h_unix": nowSec + 3600,
      "EVENT.fired_at_plus_1d_unix": nowSec + 86_400,
      "EVENT.fired_at_plus_7d_unix": nowSec + 604_800,
    };
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
      const result = await this.dispatchSkill(trig.skillName, eventPayload, {
        source: trig.source,
        name: trig.name,
        fired_at_ms: firedAtMs,
        trigger_id: trig.id,
      });
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
      (t) => t.source === "session" && t.name === phase && t.enabled !== false,
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
