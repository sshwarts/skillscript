#!/usr/bin/env node
// Programmatic Scheduler demo — exercises the library API surface that
// embedders (not just CLI users) would use. Wires:
//   - FilesystemSkillStore for skill sources
//   - FilesystemTraceStore for dispatch traces
//   - Scheduler with trace recording enabled
// Then registers a cron trigger, dispatches a few times, and queries
// traces + metrics back. ~60 lines of operator-shaped code.
//
// Run:   node examples/programmatic-trace-demo.mjs
// Uses:  /tmp/skillscript-prog-demo as a sandbox.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Scheduler,
  FilesystemSkillStore,
  FilesystemTraceStore,
  Registry,
  healthMetrics,
} from "../dist/index.js";

const HOME = "/tmp/skillscript-prog-demo";
rmSync(HOME, { recursive: true, force: true });
mkdirSync(join(HOME, "skills"), { recursive: true });
mkdirSync(join(HOME, "traces"), { recursive: true });

const skillStore = new FilesystemSkillStore(join(HOME, "skills"));
const traceStore = new FilesystemTraceStore(join(HOME, "traces"));

const SKILL_SRC = `# Skill: heartbeat
# Description: Per-fire heartbeat exercising the observability surface.
# Status: Approved
# Triggers: cron: */1 * * * *

emit:
    emit(text="heartbeat at $(EVENT.fired_at_unix)")

default: emit
`;
await skillStore.store("heartbeat", SKILL_SRC);
console.log(`stored skill at ${HOME}/skills/heartbeat.skill.md\n`);

const sched = new Scheduler({
  registry: new Registry(),
  skillStore,
  traceStore,
  trace: { mode: "on" },
});

sched.registerTrigger({
  skillName: "heartbeat",
  source: "cron",
  name: "*/1 * * * *",
  declarative: true,
});

// Fire 5 times via direct dispatch (the scheduler would also fire these
// via the poll loop; direct dispatch is faster for the demo).
console.log("dispatching 5 fires...");
for (let i = 0; i < 5; i++) {
  const firedAtMs = Date.now();
  const result = await sched.dispatchSkill("heartbeat", undefined, {
    source: "cron",
    name: "*/1 * * * *",
    fired_at_ms: firedAtMs,
    trigger_id: `demo-${i}`,
  });
  const status = result.errors.length === 0 ? "ok" : `err:${result.errors[0].class}`;
  console.log(`  fire ${i + 1}: ${status} (${result.emissions[0]})`);
  // Brief sleep so fired_at_ms timestamps don't collide.
  await new Promise((r) => setTimeout(r, 20));
}

console.log("\nquerying traces back:");
const traces = await traceStore.query({ skill_name: "heartbeat", limit: 10 });
for (const t of traces) {
  const ts = new Date(t.fired_at_ms).toISOString();
  console.log(`  ${ts}  ${t.trace_id}  ops=${t.ops.length}  errors=${t.errors.length}`);
}

console.log("\nhealth metrics:");
const metrics = await healthMetrics(traceStore, { since_ms: Date.now() - 60_000 });
console.log(`  total fires: ${metrics.totalFires}`);
for (const [name, m] of Object.entries(metrics.perSkill)) {
  console.log(`  ${name}: ${m.fireCount} fires, successRate=${(m.successRate * 100).toFixed(0)}%`);
}

console.log(`\ntrace files on disk: ${HOME}/traces/heartbeat/`);
