import { compile } from "./compile.js";
import { execute, type ExecuteContext, type ExecuteResult } from "./runtime.js";
import type { Registry } from "./connectors/registry.js";
import type { SkillStore } from "./connectors/types.js";
import type { TriggerSource } from "./parser.js";
import type { TraceConfig, TraceStore } from "./trace.js";
import { evaluateApprovalGate } from "./approval.js";
import { EventNotFoundError, EventParamMismatchError } from "./errors.js";
import { randomUUID } from "node:crypto";

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
   * Source-specific value:
   *   - `cron`: cron expression (`"0 9 * * *"`)
   *   - `event` (v0.19.0): the `event_name` — the PUBLIC contract addressed
   *     by HTTP POSTers. Case-insensitive (normalized to lowercase at
   *     register + lookup); unique per deployment (1:1 mapping to one
   *     skill). Cross-skill rebind is allowed but logged. Posters address
   *     `event_name`, never `skill_name` directly — lets the skill behind
   *     an event swap without breaking callers, and avoids POST-to-arbitrary-
   *     skill exposure.
   */
  name: string;
  /**
   * v0.19.0 — declared parameter name list for `event` triggers. POST body
   * params must match this set exactly (all required present, no unknowns).
   * Empty / undefined on cron triggers. Per Perry's spec: strict v1
   * validation, no defaults, type validation deferred to v2.
   */
  params?: string[];
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
  /**
   * v0.18.8 — operator allowlist of permitted shell binaries. Threaded
   * into per-dispatch ctx; runtime refuses off-list binaries on both
   * the safe + unsafe paths. Default-deny when unset (BREAKING).
   */
  shellAllowlist?: string[];
  /** v1.0 Gate #7 — filesystem path allowlist for file_read/file_write. */
  fsAllowlist?: string[];
  absoluteTimeoutMs?: number;
  /**
   * v0.18.7 — composition recursion-depth ceiling (default 10). Threaded
   * into the per-dispatch ctx so trigger-fired skills inherit it.
   */
  maxRecursionDepth?: number;
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
  private readonly shellAllowlist: string[] | undefined;
  private readonly fsAllowlist: string[] | undefined;
  private readonly absoluteTimeoutMs: number | undefined;
  private readonly maxRecursionDepth: number | undefined;
  private readonly trace: TraceConfig | undefined;
  private readonly traceStore: TraceStore | undefined;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly onTriggersChanged: ((snapshot: ReadonlyArray<TriggerRegistration>) => void) | undefined;
  private readonly triggers = new Map<string, TriggerRegistration>();
  private readonly cronState = new Map<string, CronFireState>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;

  constructor(config: SchedulerConfig) {
    this.registry = config.registry;
    this.skillStore = config.skillStore;
    this.pollIntervalMs = (config.pollIntervalSeconds ?? 30) * 1000;
    this.enableUnsafeShell = config.enableUnsafeShell ?? false;
    this.shellAllowlist = config.shellAllowlist;
    this.fsAllowlist = config.fsAllowlist;
    this.absoluteTimeoutMs = config.absoluteTimeoutMs;
    this.maxRecursionDepth = config.maxRecursionDepth;
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
    // v0.19.0 — event_name is the public contract (1:1 → exactly one skill,
    // case-insensitive). Normalize to lowercase for register+lookup
    // uniformity. Cross-skill rebind allowed (last-write-wins) but logged
    // for visibility per Perry+Scott (memory `f4249796`). Same-skill
    // re-register (declarative re-save path) is silent upsert.
    const normalizedName = reg.source === "event" ? reg.name.toLowerCase() : reg.name;
    if (reg.source === "event") {
      // Find any existing registration for this event_name (case-insensitive)
      const existing = [...this.triggers.values()].find(
        (t) => t.source === "event" && t.name.toLowerCase() === normalizedName,
      );
      if (existing !== undefined && existing.skillName !== reg.skillName) {
        // Cross-skill rebind: allowed, but visible — prevents silent hijack.
        this.log(`event_name '${normalizedName}' rebound: skill '${existing.skillName}' → skill '${reg.skillName}'`);
        // Drop the old binding; new registration takes ownership below.
        this.triggers.delete(existing.id);
        this.cronState.delete(existing.id);
      } else if (existing !== undefined) {
        // Same-skill upsert (declarative re-save): drop the prior id silently
        // so the new registration replaces it cleanly. No log line.
        this.triggers.delete(existing.id);
        this.cronState.delete(existing.id);
      }
    }
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
      name: normalizedName,
      registeredAt: reg.registeredAt ?? Math.floor(this.now() / 1000),
      declarative: reg.declarative,
      enabled: reg.enabled ?? true,
      ...(reg.expiresAt !== undefined ? { expiresAt: reg.expiresAt } : {}),
      ...(reg.params !== undefined ? { params: reg.params } : {}),
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
   * Begin polling. Idempotent — calling start() twice has no extra effect.
   *
   * v0.19.0 — session-start / session-end dispatch removed (memory
   * `ceaf4579`). The previous behavior fired session triggers on
   * start/stop; session as a trigger source is gone (no crisp definition,
   * substrate-coupled). Adopters wanting boot-time orchestration POST to
   * the `/event` ingress from their own startup script.
   */
  start(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      this.tick().catch((err: unknown) => {
        this.log(`scheduler tick failed: ${(err as Error).message}`);
      });
    }, this.pollIntervalMs);
  }

  /** Stop polling. v0.19.0 — session-end dispatch removed (see start()). */
  async stop(): Promise<void> {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
    /**
     * v0.19.0 — when set, the runtime's TraceBuilder adopts this UUID
     * as its trace_id. Used by the `/event` HTTP ingress so the
     * synchronous `run_id` 200-response matches the trace later
     * written. Undefined → trace_id minted fresh (existing behavior).
     */
    preMintedTraceId?: string,
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
    // v0.19.0 — thread eventPayload values into compile-time inputs so
    // required `# Vars:` declared by the skill are resolved before the
    // required-var check fires. Pre-v0.19.0 dispatchSkill callers only
    // populated cron-clock vars (EVENT.fired_at_*) — no required-var
    // case. Event triggers carry actual params that need to resolve
    // at compile time.
    const compileInputs: Record<string, string> = {};
    if (eventPayload !== undefined) {
      for (const [k, v] of Object.entries(eventPayload)) {
        if (typeof v === "string") compileInputs[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") compileInputs[k] = String(v);
        else if (v !== null && v !== undefined) compileInputs[k] = JSON.stringify(v);
      }
    }
    const compiled = await compile(loaded.source, { inputs: compileInputs });
    const nowMs = this.now();
    const ctx: ExecuteContext = {
      registry: this.registry,
      enableUnsafeShell: this.enableUnsafeShell,
      ...(this.shellAllowlist !== undefined ? { shellAllowlist: this.shellAllowlist } : {}),
      ...(this.fsAllowlist !== undefined ? { fsAllowlist: this.fsAllowlist } : {}),
      ...(this.absoluteTimeoutMs !== undefined ? { absoluteTimeoutMs: this.absoluteTimeoutMs } : {}),
      ...(this.maxRecursionDepth !== undefined ? { maxRecursionDepth: this.maxRecursionDepth } : {}),
      ...(this.trace !== undefined ? { trace: this.trace } : {}),
      ...(this.traceStore !== undefined ? { traceStore: this.traceStore } : {}),
      // v0.9.6 — "manual" enum value dropped per audit Q12. Default fallback
      // is "inline" — "programmatic call without explicit trigger context"
      // per Perry's mapping. Specific callers (CLI, dashboard, agent-driven)
      // pass their own triggerCtx with the right source value.
      triggerCtx: triggerCtx ?? { source: "inline", name: "", fired_at_ms: nowMs },
      // v1.0 Gate #7 — the approval gate (evaluateApprovalGate above) passed, so
      // this trigger-fired skill is authorized to perform effects. cron + event
      // both reach here through the one dispatch path; this mints the capability
      // for both. An unapproved skill never reaches this line (gate skips it).
      effectsAuthorized: true,
      skillVersion: loaded.metadata.version,
      // v0.16.9 — identity follows the skill. Trigger-fired dispatch
      // (cron, scheduled, event-source) carries the skill's author as
      // ctx.agentId. Closes the `olsen-nightly` cron case from Scott's
      // original framing: a skill that writes to its author's mailbox
      // now dispatches under the author's identity even when fired by
      // the scheduler under a different process identity.
      //
      // v0.18.4 — `callerAgentId` (authenticated caller) is deliberately
      // NOT set here. Scheduler-fired skills have no human caller — the
      // timer fired them. Resulting DeliveryMeta.origin.caller_agent_id
      // is `undefined`, which is the contract's "no calling agent" form
      // per Q8 (cron / session / cli / dashboard / inline triggers).
      ...(loaded.metadata.author !== undefined ? { agentId: loaded.metadata.author } : {}),
      ...(preMintedTraceId !== undefined ? { preMintedTraceId } : {}),
    };
    const defaults = this.buildEventDefaults();
    return execute(
      compiled.parsed,
      { ...compiled.resolvedVariables, ...defaults, ...(eventPayload ?? {}) },
      compiled.targetOrder,
      ctx,
    );
  }

  /**
   * v0.19.1 — sync declarative triggers for a single skill against the
   * scheduler. Used by `skill_write` (re-register on body change) +
   * `skill_status` (Approved → register; Disabled/Draft → unregister).
   *
   * Closes the v0.19.0 friction where event triggers registered only at
   * boot, forcing a restart after every `skill_write`. External POSTers
   * waiting for `event_name X` to become live no longer have to wait
   * for the next process restart — the trigger is live immediately
   * after `skill_write` succeeds.
   *
   * Semantics:
   *   - status === "Approved": drop existing declarative triggers for
   *     this skill from the registry; register the parsed triggers
   *     from the new source. Event-trigger params auto-derive from
   *     the skill's `# Vars:` per v0.19.0 wireDeclarativeTriggers.
   *   - status !== "Approved" (Draft or Disabled): drop all
   *     declarative triggers for this skill. The skill's body still
   *     exists in the SkillStore but no triggers fire.
   *
   * Cron + event sources both flow through this path. Per v0.19.0
   * trigger model collapse, those are the only two valid sources.
   */
  syncDeclarativeTriggersForSkill(
    skillName: string,
    parsedTriggers: ReadonlyArray<{ source: string; name: string }>,
    parsedVars: ReadonlyArray<string>,
    status: "Approved" | "Draft" | "Disabled",
  ): { added: number; removed: number } {
    // Drop existing declarative triggers for this skill regardless of
    // status — Approved re-adds below; non-Approved doesn't.
    let removed = 0;
    for (const [id, t] of [...this.triggers.entries()]) {
      if (t.declarative && t.skillName === skillName) {
        this.triggers.delete(id);
        this.cronState.delete(id);
        removed++;
      }
    }
    let added = 0;
    if (status === "Approved") {
      for (const t of parsedTriggers) {
        // Per v0.19.0 trigger model: only cron + event accepted.
        if (t.source !== "cron" && t.source !== "event") continue;
        this.registerTrigger({
          skillName,
          source: t.source,
          name: t.name,
          declarative: true,
          ...(t.source === "event" ? { params: [...parsedVars] } : {}),
        });
        added++;
      }
    }
    return { added, removed };
  }

  /**
   * Drop ALL of a skill's triggers — declarative AND imperative. Used when the
   * skill is deleted: the record is gone, so every trigger pointing at it must
   * go (unlike `syncDeclarativeTriggersForSkill`, which only touches declarative
   * triggers). Fires `onTriggersChanged` once if any imperative trigger was
   * removed, so the persistent registry (`triggers.json`) drops them too.
   * Returns the number removed.
   */
  dropAllTriggersForSkill(name: string): { removed: number } {
    let removed = 0;
    let imperativeRemoved = false;
    for (const [id, t] of [...this.triggers.entries()]) {
      if (t.skillName === name) {
        this.triggers.delete(id);
        this.cronState.delete(id);
        removed++;
        if (!t.declarative) imperativeRemoved = true;
      }
    }
    if (imperativeRemoved) this.fireOnTriggersChanged();
    return { removed };
  }

  /**
   * v0.19.0 — fire an event-triggered skill from external POST. Returns
   * synchronously with `{ run_id }` after validation; the actual skill
   * dispatch runs async (caller does NOT await skill completion). The
   * run_id is the pre-minted trace_id — adopters paste it into the
   * dashboard `/fires` query or the `fires({ trace_id })` MCP tool to
   * look up completion status.
   *
   * Throws structured errors that the `/event` route maps to HTTP:
   *   - `EventNotFoundError`     → 404
   *   - `EventParamMismatchError` → 400 (missing/extra params)
   *
   * Per Perry's spec (memory `ceaf4579`): all declared params present,
   * no unknowns. Strict v1; defaults + types deferred to v2.
   *
   * Durability is in-memory v1 — accepting the event into THIS process's
   * queue means best-effort / at-most-once / not durable across restart.
   * The response self-describes via `durability: "in-process"`.
   */
  fireEvent(eventName: string, params: Record<string, unknown>): { run_id: string } {
    const normalized = eventName.toLowerCase();
    const trig = [...this.triggers.values()].find(
      (t) => t.source === "event" && t.name === normalized && t.enabled !== false,
    );
    if (trig === undefined) {
      throw new EventNotFoundError(eventName);
    }
    const declared = trig.params ?? [];
    const supplied = Object.keys(params);
    const missing = declared.filter((p) => !supplied.includes(p));
    const extra = supplied.filter((p) => !declared.includes(p));
    if (missing.length > 0 || extra.length > 0) {
      throw new EventParamMismatchError(eventName, declared, supplied, missing, extra);
    }
    const runId = randomUUID();
    // Fire-and-forget async dispatch. Errors are recorded in the trace;
    // the caller already received its 200 + run_id.
    const nowMs = this.now();
    void this.dispatchSkill(
      trig.skillName,
      params,
      { source: "event", name: trig.name, fired_at_ms: nowMs, trigger_id: trig.id },
      runId,
    ).catch((err: unknown) => {
      this.log(`event '${eventName}' dispatch failed: ${(err as Error).message}`);
    });
    return { run_id: runId };
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
