/**
 * v0.9.0 — trigger enable/disable + triggers.json schema-v2 round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { Registry } from "../src/connectors/registry.js";
import { Scheduler } from "../src/scheduler.js";
import { hydratePersistedTriggers as loadPersistedTriggers, writePersistedTriggers as persistTriggers } from "../src/bootstrap.js";

describe("v0.9.0 — trigger enable/disable", () => {
  let home: string;
  let store: FilesystemSkillStore;
  let registry: Registry;
  let scheduler: Scheduler;
  let triggersPath: string;
  let lastWrittenPayload: unknown[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0.9-triggers-"));
    store = new FilesystemSkillStore(join(home, "skills"));
    registry = new Registry();
    registry.registerSkillStore("primary", store);
    triggersPath = join(home, "triggers.json");
    scheduler = new Scheduler({
      registry,
      skillStore: store,
      onTriggersChanged: (triggers) => {
        lastWrittenPayload = triggers.filter((t) => !t.declarative);
        persistTriggers(triggersPath, triggers);
      },
    });
    lastWrittenPayload = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("registers triggers with enabled: true by default", () => {
    const r = scheduler.registerTrigger({
      skillName: "hello",
      source: "cron",
      name: "0 9 * * *",
      declarative: false,
    });
    expect(r.enabled).toBe(true);
  });

  it("setTriggerEnabled toggles state + fires write-through hook", () => {
    const r = scheduler.registerTrigger({
      skillName: "hello",
      source: "cron",
      name: "0 9 * * *",
      declarative: false,
    });
    lastWrittenPayload = [];
    const updated = scheduler.setTriggerEnabled(r.id, false);
    expect(updated?.enabled).toBe(false);
    expect(lastWrittenPayload).toHaveLength(1);
    expect((lastWrittenPayload[0] as { enabled: boolean }).enabled).toBe(false);
  });

  it("setTriggerEnabled returns null for unknown id", () => {
    expect(scheduler.setTriggerEnabled("nope", false)).toBeNull();
  });

  it("setTriggerEnabled on declarative trigger skips write-through", () => {
    const r = scheduler.registerTrigger({
      skillName: "hello",
      source: "cron",
      name: "0 9 * * *",
      declarative: true,
    });
    lastWrittenPayload = [];
    const updated = scheduler.setTriggerEnabled(r.id, false);
    expect(updated?.enabled).toBe(false);
    // Declarative triggers are rederived at bootstrap; they don't roundtrip via the hook.
    expect(lastWrittenPayload).toHaveLength(0);
  });

  it("disabled cron triggers are skipped by tick()", async () => {
    const fakeNow = { ms: new Date("2026-05-26T09:00:00Z").getTime() };
    const dispatched: string[] = [];
    scheduler = new Scheduler({
      registry,
      skillStore: store,
      now: () => fakeNow.ms,
    });
    // Wire a stub for dispatchSkill via overriding listTriggers via prototype is messy;
    // simplest: register two triggers, disable one, observe via internal state probe.
    const enabledTrig = scheduler.registerTrigger({
      skillName: "skill-A",
      source: "cron",
      name: "* * * * *", // every minute
      declarative: false,
    });
    const disabledTrig = scheduler.registerTrigger({
      skillName: "skill-B",
      source: "cron",
      name: "* * * * *",
      declarative: false,
    });
    scheduler.setTriggerEnabled(disabledTrig.id, false);

    // Stub dispatchSkill to capture which triggers reach dispatch.
    scheduler.dispatchSkill = async (skillName: string) => {
      dispatched.push(skillName);
      return null;
    };

    await scheduler.tick();
    expect(dispatched).toContain("skill-A");
    expect(dispatched).not.toContain("skill-B");
    void enabledTrig;
  });

  it("persists enabled state to triggers.json schema v2", () => {
    const r = scheduler.registerTrigger({
      skillName: "hello",
      source: "cron",
      name: "0 9 * * *",
      declarative: false,
    });
    scheduler.setTriggerEnabled(r.id, false);
    const raw = JSON.parse(readFileSync(triggersPath, "utf8"));
    expect(raw.schema_version).toBe(2);
    expect(raw.triggers).toHaveLength(1);
    expect(raw.triggers[0].enabled).toBe(false);
  });

  it("hydrates schema-v1 triggers as enabled: true (back-compat)", () => {
    const v1 = {
      schema_version: 1,
      triggers: [
        {
          id: "old-trig-1",
          skill_name: "legacy",
          source: "cron",
          name: "0 9 * * *",
          declarative: false,
          registered_at: 1700000000,
          expires_at: null,
        },
      ],
    };
    writeFileSync(triggersPath, JSON.stringify(v1), "utf8");
    const newScheduler = new Scheduler({ registry, skillStore: store });
    const res = loadPersistedTriggers(newScheduler, triggersPath, () => {});
    expect(res).toEqual({ loaded: 1, pruned: 0 });
    const hydrated = newScheduler.listTriggers()[0]!;
    expect(hydrated.enabled).toBe(true);
  });

  it("hydrates schema-v2 triggers preserving enabled state", () => {
    const v2 = {
      schema_version: 2,
      triggers: [
        {
          id: "new-trig-1",
          skill_name: "modern",
          source: "cron",
          name: "0 9 * * *",
          declarative: false,
          registered_at: 1700000000,
          enabled: false,
          expires_at: null,
        },
      ],
    };
    writeFileSync(triggersPath, JSON.stringify(v2), "utf8");
    const newScheduler = new Scheduler({ registry, skillStore: store });
    loadPersistedTriggers(newScheduler, triggersPath, () => {});
    const hydrated = newScheduler.listTriggers()[0]!;
    expect(hydrated.enabled).toBe(false);
  });
});
