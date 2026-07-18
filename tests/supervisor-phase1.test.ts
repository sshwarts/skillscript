/**
 * Autonomous-fire failure supervision — Phase 1 (Perry spec 967ed739).
 *
 * The scheduler's trace-sweeper reads the durable trace for non-clean fires and
 * routes each to a governed handler skill. These cover the applicability
 * predicate, the sidecar dedup state, and the end-to-end sweep (route + vars +
 * per-fire dedup + loop-guard) plus the boot-refuse invariant.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { SweeperState, isNonCleanFire, classifyOutcome } from "../src/supervisor.js";
import type { TraceRecord } from "../src/trace.js";

let idSeq = 0;
function trace(over: Partial<TraceRecord> = {}): TraceRecord {
  const now = 1_700_000_000_000 + idSeq;
  return {
    version: 1,
    trace_id: `t-${idSeq++}`,
    skill_name: "some-cron",
    skill_version: "1",
    trigger: { source: "cron", name: "0 3 * * *", fired_at_ms: now },
    identity: {},
    ops: [],
    emissions: [],
    outputs: {},
    errors: [],
    fired_at_ms: now,
    completed_at_ms: now + 10,
    duration_ms: 10,
    ...over,
  };
}
const anError = { target: "run", opKind: "$", message: "boom", class: "OpError" };

const HANDLER = `# Skill: test-handler
# Status: Approved
# Autonomous: true
# Vars: FAILED_SKILL=none, OUTCOME=none, TRACE_ID=none
default: run
run:
    emit(text="handled: \${FAILED_SKILL} / \${OUTCOME} / \${TRACE_ID}")
`;

describe("Phase 1 — applicability predicate", () => {
  it("isNonCleanFire: errored / deadline / uncertain are non-clean; a clean fire is not", () => {
    expect(isNonCleanFire(trace({ errors: [anError] }))).toBe(true);
    expect(isNonCleanFire(trace({ deadline_exceeded: true }))).toBe(true);
    expect(isNonCleanFire(trace({ uncertain_effects: [{ opKind: "$", op: "x.send", reason: "issued, outcome uncertain", retry: false }] }))).toBe(true);
    expect(isNonCleanFire(trace())).toBe(false);
  });

  it("classifyOutcome ranks uncertain-effects > deadline > errored", () => {
    expect(classifyOutcome(trace({ uncertain_effects: [{ opKind: "$", op: "x", reason: "issued, outcome uncertain", retry: false }], deadline_exceeded: true, errors: [anError] }))).toBe("uncertain-effects");
    expect(classifyOutcome(trace({ deadline_exceeded: true, errors: [anError] }))).toBe("deadline-exceeded");
    expect(classifyOutcome(trace({ errors: [anError] }))).toBe("errored");
  });
});

describe("Phase 1 — SweeperState sidecar (cursor + notified, persist/load/prune)", () => {
  it("persists and reloads the cursor + notified-set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    try {
      const path = join(dir, "state.json");
      const a = new SweeperState(path);
      a.markNotified("t-1", 100);
      a.advanceCursor(500);
      await a.persist();

      const b = new SweeperState(path);
      await b.load();
      expect(b.cursor).toBe(500);
      expect(b.isNotified("t-1")).toBe(true);
      expect(b.isNotified("t-2")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prune drops notified ids below the floor", () => {
    const s = new SweeperState(undefined);
    s.markNotified("old", 100);
    s.markNotified("new", 900);
    s.prune(500);
    expect(s.isNotified("old")).toBe(false);
    expect(s.isNotified("new")).toBe(true);
  });
});

describe("Phase 1 — the sweep (route + vars + dedup + loop-guard)", () => {
  const homes: string[] = [];
  const wire = (extra: Record<string, unknown> = {}) => {
    const home = mkdtempSync(join(tmpdir(), "sup-"));
    homes.push(home);
    return bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      trace: { mode: "on" },
      ...extra,
    });
  };
  const cleanup = () => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); };

  it("routes a non-clean fire to the handler with the failure vars", async () => {
    const w = wire({ supervisorSkill: "test-handler" });
    try {
      await w.skillStore.store("test-handler", HANDLER);
      await w.traceStore.write(trace({ trace_id: "fail-1", skill_name: "failing-cron", errors: [anError] }));

      await w.scheduler.tick();

      const handlerFires = await w.traceStore.query({ skill_name: "test-handler" });
      expect(handlerFires.length).toBe(1);
      // vars were passed through: FAILED_SKILL + OUTCOME + TRACE_ID
      expect(handlerFires[0]!.emissions.join("")).toBe("handled: failing-cron / errored / fail-1");
    } finally { cleanup(); }
  });

  it("per-fire dedup: a second tick does NOT re-route the same fire", async () => {
    const w = wire({ supervisorSkill: "test-handler" });
    try {
      await w.skillStore.store("test-handler", HANDLER);
      await w.traceStore.write(trace({ trace_id: "fail-2", skill_name: "failing-cron", errors: [anError] }));

      await w.scheduler.tick();
      await w.scheduler.tick();

      // Exactly one handler fire despite two sweeps (the handler's own clean
      // trace is skipped by the applicability filter, so it can't loop either).
      expect((await w.traceStore.query({ skill_name: "test-handler" })).length).toBe(1);
    } finally { cleanup(); }
  });

  it("loop-guard: the handler's OWN failed fire is NOT routed back through itself", async () => {
    const w = wire({ supervisorSkill: "test-handler" });
    try {
      await w.skillStore.store("test-handler", HANDLER);
      // A non-clean fire whose skill_name IS the supervisor skill.
      await w.traceStore.write(trace({ trace_id: "self-fail", skill_name: "test-handler", errors: [anError] }));

      await w.scheduler.tick();

      // Only the injected record exists — the sweep did NOT dispatch a fresh
      // handler fire to notify about the handler's own failure (no loop).
      const handlerTraces = await w.traceStore.query({ skill_name: "test-handler" });
      expect(handlerTraces.length).toBe(1);
      expect(handlerTraces[0]!.trace_id).toBe("self-fail");
    } finally { cleanup(); }
  });

  it("[Perry #1] a long unbounded run that COMPLETES after the cursor is still caught (completion-time keying)", async () => {
    const w = wire({ supervisorSkill: "test-handler" });
    try {
      await w.skillStore.store("test-handler", HANDLER);
      const now = Date.now();
      // First a normal recent failure → the first tick routes it and advances
      // the cursor to ~now (its handler fire completes at real-now).
      await w.traceStore.write(trace({ trace_id: "recent", skill_name: "recent-fail", fired_at_ms: now - 1000, completed_at_ms: now - 1000, errors: [anError] }));
      await w.scheduler.tick();

      // Now a LONG run: FIRED 30 min ago (long before the cursor) but only just
      // COMPLETED. A fired_at window would miss it; completion-time keying can't.
      await w.traceStore.write(trace({ trace_id: "longrun", skill_name: "slow-cron", fired_at_ms: now - 30 * 60 * 1000, completed_at_ms: now, errors: [anError] }));
      await w.scheduler.tick();

      const emitted = (await w.traceStore.query({ skill_name: "test-handler" })).map((t) => t.emissions.join("")).join("\n");
      expect(emitted).toContain("handled: slow-cron"); // the long run's failure was notified
      expect(emitted).toContain("handled: recent-fail");
    } finally { cleanup(); }
  });

  it("routes MULTIPLE un-notified fires in one tick (not just the first)", async () => {
    const w = wire({ supervisorSkill: "test-handler" });
    try {
      await w.skillStore.store("test-handler", HANDLER);
      await w.traceStore.write(trace({ trace_id: "m1", skill_name: "cron-a", errors: [anError] }));
      await w.traceStore.write(trace({ trace_id: "m2", skill_name: "cron-b", deadline_exceeded: true, errors: [{ ...anError, class: "RunDeadlineExceeded" }] }));
      await w.traceStore.write(trace({ trace_id: "m3", skill_name: "cron-c", uncertain_effects: [{ opKind: "$", op: "x.send", reason: "issued, outcome uncertain", retry: false }] }));

      await w.scheduler.tick();

      const emitted = (await w.traceStore.query({ skill_name: "test-handler" })).map((t) => t.emissions.join("")).join("\n");
      expect(emitted).toContain("handled: cron-a");
      expect(emitted).toContain("handled: cron-b");
      expect(emitted).toContain("handled: cron-c");
    } finally { cleanup(); }
  });

  it("degrades gracefully on a corrupt sidecar (starts fresh, still routes)", async () => {
    const w = wire({ supervisorSkill: "test-handler" });
    try {
      await w.skillStore.store("test-handler", HANDLER);
      // Corrupt the sidecar at its known path before the first sweep loads it.
      const { writeFileSync, mkdirSync } = await import("node:fs");
      // The bootstrap derives <traceDir>/.supervisor-state.json; write garbage there.
      const home = homes[homes.length - 1]!;
      mkdirSync(join(home, "traces"), { recursive: true });
      writeFileSync(join(home, "traces", ".supervisor-state.json"), "{ this is not json ]");

      await w.traceStore.write(trace({ trace_id: "c1", skill_name: "cron-x", errors: [anError] }));
      await expect(w.scheduler.tick()).resolves.toBeUndefined();
      expect((await w.traceStore.query({ skill_name: "test-handler" })).length).toBe(1);
    } finally { cleanup(); }
  });

  it("absence: no supervisor configured → sweep is a no-op, non-clean fires ignored", async () => {
    const w = wire(); // no supervisorSkill
    try {
      await w.traceStore.write(trace({ skill_name: "failing-cron", errors: [anError] }));
      await expect(w.scheduler.tick()).resolves.toBeUndefined();
      // nothing routed (no handler skill even exists)
      expect((await w.traceStore.query({ skill_name: "test-handler" })).length).toBe(0);
    } finally { cleanup(); }
  });
});

describe("Phase 1 — boot invariant (configured-but-defeated hard-refuses)", () => {
  const homes: string[] = [];
  const opts = (extra: Record<string, unknown>) => {
    const home = mkdtempSync(join(tmpdir(), "sup-boot-"));
    homes.push(home);
    return { skillsDir: join(home, "skills"), traceDir: join(home, "traces"), ...extra };
  };
  const cleanup = () => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); };

  it("supervisor configured + autonomous tracing OFF → throws at boot", () => {
    try {
      expect(() => bootstrap(opts({ supervisorSkill: "test-handler", trace: { mode: "off" } }))).toThrow(/tracing/i);
      expect(() => bootstrap(opts({ supervisorSkill: "test-handler" }))).toThrow(/tracing/i); // no trace config at all
    } finally { cleanup(); }
  });

  it("supervisor configured + tracing ON → boots fine; no supervisor → boots fine (absence is not a failure)", () => {
    try {
      expect(() => bootstrap(opts({ supervisorSkill: "test-handler", trace: { mode: "on" } }))).not.toThrow();
      expect(() => bootstrap(opts({ trace: { mode: "off" } }))).not.toThrow();
    } finally { cleanup(); }
  });
});
