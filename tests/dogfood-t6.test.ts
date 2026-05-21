import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { healthMetrics } from "../src/metrics.js";
import { Registry } from "../src/connectors/registry.js";

/**
 * T6 dogfood pass (mandatory per `a046164f`).
 *
 * Exercises observability end-to-end: real cron-fired skill, scheduler
 * dispatches, trace records accumulate, metrics aggregate correctly,
 * CLI-shaped queries return the right shapes, error remediation surfaces.
 *
 * Discipline streak: four-for-four bugs found in T3/T4/T5/cold-agent.
 * Whatever this surfaces gets documented in dev log §11.
 */

function withTemp(): { home: string; skillStore: FilesystemSkillStore; traceStore: FilesystemTraceStore; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "skillscript-dogfood-t6-"));
  return {
    home,
    skillStore: new FilesystemSkillStore(join(home, "skills")),
    traceStore: new FilesystemTraceStore(join(home, "traces")),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe("T6 dogfood pass — observability end-to-end", () => {
  it("cron-fired heartbeat skill: 5 dispatches → 5 traces → metrics aggregate cleanly", async () => {
    const { skillStore, traceStore, cleanup } = withTemp();
    try {
      // Author a realistic heartbeat skill: emits + $set + nothing fancy.
      // Note: $set is literals-only on RHS per language ref §3.
      // Use direct $(EVENT.fired_at_unix) substitution in the emission.
      // (Dogfood observation: cold agents reach for $set as an intermediate
      // binding — surfaces this footgun. Filed as v1.x clarification.)
      const src = `# Skill: t6-heartbeat
# Description: Per-minute heartbeat exercising trace + metrics surfaces.
# Status: Approved
# Triggers: cron: */1 * * * *

emit:
    ! heartbeat at $(EVENT.fired_at_unix)

default: emit
`;
      await skillStore.store("t6-heartbeat", src);

      let mockNow = new Date("2026-05-21T09:00:00.000Z").getTime();
      const sched = new Scheduler({
        registry: new Registry(),
        skillStore,
        traceStore,
        trace: { mode: "on" },
        now: () => mockNow,
      });
      sched.registerTrigger({
        skillName: "t6-heartbeat",
        source: "cron",
        name: "*/1 * * * *",
        declarative: true,
      });

      // Five direct dispatches simulating 5 cron fires (each at minute boundary).
      for (let i = 0; i < 5; i++) {
        mockNow = new Date("2026-05-21T09:00:00.000Z").getTime() + i * 60_000;
        await sched.dispatchSkill("t6-heartbeat", undefined, {
          source: "cron",
          name: "*/1 * * * *",
          fired_at_ms: mockNow,
          trigger_id: `trig-${i}`,
        });
      }

      // Verify traces accumulated
      const records = await traceStore.query({ skill_name: "t6-heartbeat" });
      expect(records.length).toBe(5);
      // Verify ordering: newest first
      for (let i = 0; i < records.length - 1; i++) {
        expect(records[i]!.fired_at_ms).toBeGreaterThanOrEqual(records[i + 1]!.fired_at_ms);
      }
      // Verify each trace has the expected ops + clean emission
      for (const rec of records) {
        expect(rec.skill_name).toBe("t6-heartbeat");
        expect(rec.errors).toEqual([]);
        expect(rec.ops.length).toBe(1); // just the `!` op
        expect(rec.emissions[0]).toMatch(/heartbeat at \d+/);
      }
    } finally {
      cleanup();
    }
  });

  it("metrics aggregate across cron heartbeat fires: 100% success rate", async () => {
    const { skillStore, traceStore, cleanup } = withTemp();
    try {
      const src = `# Skill: t6-metrics
# Status: Approved
emit:
    ! ping
default: emit
`;
      await skillStore.store("t6-metrics", src);
      const sched = new Scheduler({
        registry: new Registry(),
        skillStore,
        traceStore,
        trace: { mode: "on" },
      });
      const base = 1_700_000_000_000;
      for (let i = 0; i < 3; i++) {
        const r = await sched.dispatchSkill("t6-metrics", undefined, {
          source: "cron", name: "* * * * *", fired_at_ms: base + i * 1000, trigger_id: `t-${i}`,
        });
        expect(r, `dispatch ${i} returned null`).not.toBeNull();
      }
      const direct = await traceStore.query({ skill_name: "t6-metrics" });
      expect(direct.length, `direct query found ${direct.length} traces (expected 3)`).toBe(3);
      // Use base time for since_ms so we don't filter out the fixed past timestamps.
      const m = await healthMetrics(traceStore, { since_ms: base - 1000 });
      expect(m.totalFires).toBe(3);
      expect(m.perSkill["t6-metrics"]!.fireCount).toBe(3);
      expect(m.perSkill["t6-metrics"]!.successRate).toBe(1);
      expect(m.perSkill["t6-metrics"]!.errorCount).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("error remediation surfaces in trace.errors[] + metrics errorCategories", async () => {
    const { skillStore, traceStore, cleanup } = withTemp();
    try {
      // Skill uses `@ unsafe` without enableUnsafeShell wired — should fail.
      const src = `# Skill: t6-error
# Status: Approved
fail:
    @ unsafe echo "this fails"
default: fail
`;
      await skillStore.store("t6-error", src);
      const sched = new Scheduler({
        registry: new Registry(),
        skillStore,
        traceStore,
        trace: { mode: "on" },
        // enableUnsafeShell intentionally NOT set → false
      });
      const result = await sched.dispatchSkill("t6-error");
      expect(result).not.toBeNull();
      expect(result!.errors.length).toBe(1);
      const err = result!.errors[0]!;
      expect(err.class).toBe("UnsafeShellDisabledError");
      expect(err.remediation).toMatch(/enableUnsafeShell/);
      // Verify error surfaced into trace record
      const traces = await traceStore.query({ skill_name: "t6-error" });
      expect(traces.length).toBe(1);
      expect(traces[0]!.errors[0]!.class).toBe("UnsafeShellDisabledError");
      // Verify metrics roll up the error category
      const m = await healthMetrics(traceStore, {});
      expect(m.perSkill["t6-error"]!.errorCategories["@"]!["UnsafeShellDisabledError"]).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("trace mode 'off' produces no records (NFR-11 floor still tracks errors via result)", async () => {
    const { skillStore, traceStore, cleanup } = withTemp();
    try {
      const src = `# Skill: t6-silent
# Status: Approved
t:
    ! silent
default: t
`;
      await skillStore.store("t6-silent", src);
      const sched = new Scheduler({
        registry: new Registry(),
        skillStore,
        traceStore,
        trace: { mode: "off" },
      });
      await sched.dispatchSkill("t6-silent");
      const records = await traceStore.query({ skill_name: "t6-silent" });
      expect(records.length).toBe(0);
    } finally {
      cleanup();
    }
  });
});
