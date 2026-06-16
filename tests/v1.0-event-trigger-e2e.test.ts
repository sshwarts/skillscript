/**
 * v1.0 runtime-semantics test battery — Lane (c): event-trigger e2e.
 *
 * Pins the event-trigger primitive's runtime semantics for the v1.0 freeze:
 * `Scheduler.fireEvent` happy path → trigger registration → skill execute,
 * strict v1 param validation (declared params present + no unknown extras +
 * no defaults), and unknown-event lookup error.
 *
 * Full HTTP-ingress + bearer-auth coverage lives in `v0.19.0-trigger-event-
 * ring.test.ts`; this file isolates the runtime-layer freeze guards so a
 * regression in trigger semantics surfaces clearly under `pnpm vitest run
 * tests/v1.0-*`.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";
import { EventNotFoundError, EventParamMismatchError } from "../src/errors.js";
import { stampApprovalToken } from "../src/approval.js";

const APPROVED = "# Status: Approved";

async function buildScheduler() {
  const home = mkdtempSync(join(tmpdir(), "v1-event-"));
  const skillStore = new FilesystemSkillStore(join(home, "skills"));
  const traceStore = new FilesystemTraceStore(join(home, "traces"));
  const registry = new Registry();
  registry.registerSkillStore("primary", skillStore);
  const scheduler = new Scheduler({
    registry,
    skillStore,
    traceStore,
    trace: { mode: "on" },
  });
  return { scheduler, skillStore, home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe("v1.0 freeze — event-trigger runtime layer", () => {
  it("fireEvent happy path: registered event → fires → returns UUID run_id", async () => {
    const { scheduler, skillStore, cleanup } = await buildScheduler();
    try {
      await skillStore.store("relay",
        `# Skill: relay\n${APPROVED}\n# Description: relays event payload\nm:\n    emit(text="\${MESSAGE}")\ndefault: m\n`);
      scheduler.registerTrigger({
        skillName: "relay",
        source: "event",
        name: "site-distress",
        params: ["MESSAGE"],
        declarative: false,
      });

      const { run_id } = scheduler.fireEvent("site-distress", { MESSAGE: "page-1" });
      expect(run_id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      cleanup();
    }
  });

  it("unknown event_name → throws EventNotFoundError", async () => {
    const { scheduler, cleanup } = await buildScheduler();
    try {
      expect(() => scheduler.fireEvent("not-registered", {})).toThrow(EventNotFoundError);
    } finally {
      cleanup();
    }
  });

  it("strict v1 param validation: missing declared param → EventParamMismatchError", async () => {
    const { scheduler, skillStore, cleanup } = await buildScheduler();
    try {
      await skillStore.store("relay",
        `# Skill: relay\n${APPROVED}\n# Description: requires MESSAGE\nm:\n    emit(text="\${MESSAGE}")\ndefault: m\n`);
      scheduler.registerTrigger({
        skillName: "relay",
        source: "event",
        name: "site-distress",
        params: ["MESSAGE"],
        declarative: false,
      });

      expect(() => scheduler.fireEvent("site-distress", {})).toThrow(EventParamMismatchError);
    } finally {
      cleanup();
    }
  });

  it("strict v1 param validation: extra unknown param → EventParamMismatchError", async () => {
    const { scheduler, skillStore, cleanup } = await buildScheduler();
    try {
      await skillStore.store("relay",
        `# Skill: relay\n${APPROVED}\n# Description: only MESSAGE declared\nm:\n    emit(text="\${MESSAGE}")\ndefault: m\n`);
      scheduler.registerTrigger({
        skillName: "relay",
        source: "event",
        name: "site-distress",
        params: ["MESSAGE"],
        declarative: false,
      });

      expect(() => scheduler.fireEvent("site-distress", {
        MESSAGE: "hi",
        UNDECLARED: "should-reject",
      })).toThrow(EventParamMismatchError);
    } finally {
      cleanup();
    }
  });

  it("event_name lookup is case-insensitive (normalized at register + fire)", async () => {
    const { scheduler, skillStore, cleanup } = await buildScheduler();
    try {
      await skillStore.store("relay",
        `# Skill: relay\n${APPROVED}\nm:\n    emit(text="ran")\ndefault: m\n`);
      scheduler.registerTrigger({
        skillName: "relay",
        source: "event",
        name: "SiteDistress",
        params: [],
        declarative: false,
      });

      // Mixed-case lookup variants all hit the same registration.
      expect(() => scheduler.fireEvent("sitedistress", {})).not.toThrow();
      expect(() => scheduler.fireEvent("SITEDISTRESS", {})).not.toThrow();
      expect(() => scheduler.fireEvent("SiteDistress", {})).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it("deliver leg — fired skill executes to completion and produces its declared output (run_id ↔ trace lookup)", async () => {
    // Closes Perry's `0a42b363` probe 1: lanes above cover the FIRE
    // (registration → fireEvent → run_id). This test covers DELIVER —
    // the canonical site-distress-relay shape: event fires → skill runs
    // to completion → output recorded under run_id (= trace_id per
    // v0.19.0 preMintedTraceId plumbing). Skill body must carry a
    // stamped approval token; the scheduler's universal execution gate
    // (v0.9.0) refuses naked `# Status: Approved` and silently logs
    // "approval gate refused" — production-correct, but the test must
    // stamp explicitly.
    const { scheduler, skillStore, home, cleanup } = await buildScheduler();
    try {
      const body = `# Skill: relay\n# Status: Approved\n# Description: site-distress relay\n# Vars: MESSAGE\nm:\n    emit(text="dispatched: \${MESSAGE}")\ndefault: m\n`;
      await skillStore.store("relay", stampApprovalToken(body));
      scheduler.registerTrigger({
        skillName: "relay",
        source: "event",
        name: "site-distress",
        params: ["MESSAGE"],
        declarative: false,
      });

      const { run_id } = scheduler.fireEvent("site-distress", { MESSAGE: "page-1" });

      // Async dispatch — poll the trace store for the run_id (= trace_id).
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      const deadline = Date.now() + 5000;
      let trace = null as Awaited<ReturnType<typeof traceStore.get>>;
      while (Date.now() < deadline) {
        trace = await traceStore.get(run_id);
        if (trace) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(trace, "trace record should land within 5s of fireEvent").not.toBeNull();
      expect(trace!.trace_id).toBe(run_id);
      expect(trace!.skill_name).toBe("relay");
      expect(trace!.trigger.source).toBe("event");
      expect(trace!.trigger.name).toBe("site-distress");
      expect(trace!.errors).toEqual([]);
      expect(trace!.emissions).toContain("dispatched: page-1");
    } finally {
      cleanup();
    }
  });

  it("multiple events on the same skill — each fires independently (idempotency-shape check)", async () => {
    const { scheduler, skillStore, cleanup } = await buildScheduler();
    try {
      await skillStore.store("relay",
        `# Skill: relay\n${APPROVED}\nm:\n    emit(text="\${MESSAGE}")\ndefault: m\n`);
      scheduler.registerTrigger({
        skillName: "relay",
        source: "event",
        name: "site-distress",
        params: ["MESSAGE"],
        declarative: false,
      });

      // Two fires of the same event get distinct run_ids.
      const a = scheduler.fireEvent("site-distress", { MESSAGE: "first" });
      const b = scheduler.fireEvent("site-distress", { MESSAGE: "second" });
      expect(a.run_id).not.toBe(b.run_id);
      expect(a.run_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(b.run_id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      cleanup();
    }
  });
});
