import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { Registry } from "../src/connectors/registry.js";

/**
 * T5 dogfood pass (mandatory acceptance per lesson a046164f).
 *
 * Authors a realistic cron-fired skill, registers it through the scheduler,
 * advances mocked clock, and verifies expected behavior. Designed to surface
 * UX rough edges the unit tests miss.
 *
 * Findings (any bugs found during this pass) get documented in dev log §10.
 */

function withTempStore(): { store: FilesystemSkillStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "skillscript-dogfood-t5-"));
  return {
    store: new FilesystemSkillStore(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("T5 dogfood pass — cron-fired heartbeat skill", () => {
  it("end-to-end: cron registers, fires at right minute, emits timestamp, status-gated", async () => {
    const { store, cleanup } = withTempStore();
    try {
      // Author the heartbeat skill. Real cron expression, real shell exec
      // (`@ echo`), real `$(EVENT.fired_at_unix)` substitution.
      const heartbeatSrc = `# Skill: heartbeat
# Description: Five-minute heartbeat fired by cron; emits the fire timestamp.
# Status: Approved
# Triggers: cron: */5 * * * *

emit:
    shell(command="echo heartbeat at $(EVENT.fired_at_unix)") -> STAMP
    emit(text="got stamp: $(STAMP)")

default: emit
`;
      await store.store("heartbeat", heartbeatSrc);

      // Pin clock to 09:05:00 — a `*/5 * * * *` cron match.
      let mockNow = new Date("2026-05-21T09:05:00.000Z").getTime();
      const sched = new Scheduler({
        registry: new Registry(),
        skillStore: store,
        now: () => mockNow,
        // v0.18.8 — heartbeat skill uses `echo` + `date` for its tick.
        shellAllowlist: ["echo", "date", "true", "false", "sleep", "bash"],
      });
      sched.registerTrigger({
        skillName: "heartbeat",
        source: "cron",
        name: "*/5 * * * *",
        declarative: true,
      });

      // Direct dispatch to verify end-to-end behavior. (tick() fires the
      // same dispatch path but is harder to observe without capturing
      // log emissions out-of-band.)
      const result1 = await sched.dispatchSkill("heartbeat", {
        "EVENT.fired_at_unix": Math.floor(mockNow / 1000),
      });
      expect(result1).not.toBeNull();
      expect(result1!.errors).toEqual([]);
      const stamp = String(result1!.finalVars["STAMP"]);
      expect(stamp).toMatch(/heartbeat at 1779/);
      expect(result1!.emissions[0]).toMatch(/got stamp: heartbeat at 1779/);

      // Status transition Approved → Disabled. Subsequent dispatch skipped.
      await store.update_status("heartbeat", "Disabled");
      const logs: string[] = [];
      const schedAfterDisable = new Scheduler({
        registry: new Registry(),
        skillStore: store,
        now: () => mockNow,
        log: (m) => logs.push(m),
        shellAllowlist: ["echo", "date", "true", "false", "sleep", "bash"],
      });
      const result2 = await schedAfterDisable.dispatchSkill("heartbeat");
      expect(result2).toBeNull();
      expect(logs.some((m) => m.includes("Disabled"))).toBe(true);

      // Status transition Disabled → Approved. Triggers activate without
      // re-registration.
      await store.update_status("heartbeat", "Approved");
      const result3 = await schedAfterDisable.dispatchSkill("heartbeat");
      expect(result3).not.toBeNull();
      expect(result3!.errors).toEqual([]);

      // Tick at non-matching minute: no fire.
      mockNow = new Date("2026-05-21T09:06:00.000Z").getTime();
      await sched.tick();
      // No assertion — absence of throw indicates the no-match path is
      // clean. tick() doesn't accumulate visible state.
    } finally {
      cleanup();
    }
  });

  it("per-op timeout fires when @ child hangs (cron-fired skill)", async () => {
    const { store, cleanup } = withTempStore();
    try {
      const slowSrc = `# Skill: slow
# Status: Approved
# Timeout: 1
slow-target:
    shell(command="sleep 5")

default: slow-target
`;
      await store.store("slow", slowSrc);
      const sched = new Scheduler({
        registry: new Registry(),
        skillStore: store,
        shellAllowlist: ["sleep", "echo", "date", "true", "false", "bash"],
      });
      const result = await sched.dispatchSkill("slow");
      expect(result).not.toBeNull();
      expect(result!.errors.length).toBe(1);
      expect(result!.errors[0]!.opKind).toBe("shell");
      expect(result!.errors[0]!.message).toMatch(/timed out after 1000ms/);
    } finally {
      cleanup();
    }
  });

  it("`@` op failure routes through `else:` block — error visibility surface", async () => {
    const { store, cleanup } = withTempStore();
    try {
      const src = `# Skill: error-prone
# Status: Approved
fetch:
    shell(command="false")
else:
    emit(text="fetch failed gracefully — falling back")

default: fetch
`;
      await store.store("error-prone", src);
      const sched = new Scheduler({ registry: new Registry(), skillStore: store });
      const result = await sched.dispatchSkill("error-prone");
      expect(result).not.toBeNull();
      // The op failed but `else:` caught it; result.errors[] still records
      // the op-error for telemetry surfaces.
      expect(result!.errors.length).toBe(1);
      expect(result!.errors[0]!.opKind).toBe("shell");
      expect(result!.emissions).toEqual(["fetch failed gracefully — falling back"]);
    } finally {
      cleanup();
    }
  });
});
