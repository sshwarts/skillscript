/**
 * v0.9.6 — AgentConnector audit Q1-Q12 lock.
 *
 * Locks the v1.0 contract shape per Perry's audit thread `b722bbf4`.
 * Tests reflect the locked decisions; references in comments point at
 * thread message memories for cross-trace.
 */
import { describe, it, expect } from "vitest";
import { Registry } from "../src/connectors/registry.js";
import { NoOpAgentConnector } from "../src/connectors/agent-noop.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import type { AgentConnector, AgentDescriptor, DeliveryPayload, DeliveryReceipt, RequestResponseOpts, Response } from "../src/connectors/agent.js";
import type { StaticCapabilities } from "../src/connectors/types.js";

class TestAgentConnector implements AgentConnector {
  static staticCapabilities(): StaticCapabilities {
    return { connector_type: "agent_connector", implementation: "TestAgentConnector", contract_version: "1.0.0", features: {} };
  }
  readonly delivered: Array<{ agent_id: string; payload: DeliveryPayload }> = [];
  private readonly knownAgents: string[];
  private readonly healthy: boolean;
  private readonly skipNext: boolean;
  constructor(knownAgents: string[] = [], opts: { healthy?: boolean; skipNext?: boolean } = {}) {
    this.knownAgents = knownAgents;
    this.healthy = opts.healthy ?? true;
    this.skipNext = opts.skipNext ?? false;
  }
  async list_agents(): Promise<AgentDescriptor[]> {
    return this.knownAgents.map((agent_id) => ({ agent_id }));
  }
  async deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt> {
    this.delivered.push({ agent_id, payload });
    return this.skipNext
      ? { delivered_at: Date.now(), delivery_skipped: true }
      : { delivered_at: Date.now() };
  }
  async wake(): Promise<{ woken_at: number }> { return { woken_at: Date.now() }; }
  async health_check(): Promise<boolean> { return this.healthy; }
  async request_response(_id: string, _p: DeliveryPayload, _o: RequestResponseOpts): Promise<Response> {
    throw new Error("not implemented in TestAgentConnector");
  }
}

describe("v0.9.6 Q6 — health_check bootstrap-throws on false", () => {
  it("registerAgentConnector throws when health_check returns false", async () => {
    const reg = new Registry();
    const broken = new TestAgentConnector([], { healthy: false });
    await expect(reg.registerAgentConnector("primary", broken)).rejects.toThrow(/health_check.*returned false/);
  });

  it("registerAgentConnector succeeds when health_check returns true", async () => {
    const reg = new Registry();
    const ok = new TestAgentConnector(["agent-a"]);
    await expect(reg.registerAgentConnector("primary", ok)).resolves.toBeUndefined();
  });
});

describe("v0.9.6 Q8 — DeliveryMeta envelope on lifecycle hook + notify()", () => {
  it("lifecycle hook delivery carries required meta fields (dispatch_id, sent_at, origin)", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["oncall"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: probe\n# Status: Approved\n# Output: agent: oncall\nm:\n    emit(text="hi")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect(t.delivered).toHaveLength(1);
    const { payload } = t.delivered[0]!;
    expect(typeof payload.meta.dispatch_id).toBe("string");
    expect(payload.meta.dispatch_id.length).toBeGreaterThan(0);
    expect(typeof payload.meta.sent_at).toBe("number");
    expect(payload.meta.origin.skill_name).toBe("probe");
    expect(payload.meta.origin.trigger_kind).toBe("inline");
  });

  it("notify() op carries event_type + correlation_id kwargs into meta", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["ops"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: alert\n# Status: Approved\nm:\n    notify(agent="ops", message="911", event_type="ticket-911", correlation_id="incident-42")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect(t.delivered).toHaveLength(1);
    const { payload } = t.delivered[0]!;
    expect(payload.meta.event_type).toBe("ticket-911");
    expect(payload.meta.correlation_id).toBe("incident-42");
  });

  it("frontmatter # Event-type: provides event_type fallback for lifecycle hooks", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["oncall"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: probe\n# Status: Approved\n# Event-type: routine-tick\n# Output: agent: oncall\nm:\n    emit(text="hi")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect(t.delivered[0]!.payload.meta.event_type).toBe("routine-tick");
  });

  it("trigger_kind reflects ctx.triggerCtx.source (cron path)", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["oncall"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: cron-fired\n# Status: Approved\n# Output: agent: oncall\nm:\n    emit(text="tick")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: reg,
      triggerCtx: { source: "cron", name: "0 9 * * *", fired_at_ms: 1779480000000 },
    });

    expect(t.delivered[0]!.payload.meta.origin.trigger_kind).toBe("cron");
  });

  it("caller_agent_id flows from ctx.agentId when present", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["ops"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: probe\n# Status: Approved\nm:\n    notify(agent="ops", message="x")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: reg,
      agentId: "scott",
    });

    expect(t.delivered[0]!.payload.meta.origin.caller_agent_id).toBe("scott");
  });

  it("caller_agent_id absent when ctx.agentId not set (cron/cli/inline path)", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["ops"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: probe\n# Status: Approved\nm:\n    notify(agent="ops", message="x")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect("caller_agent_id" in t.delivered[0]!.payload.meta.origin).toBe(false);
  });
});

describe("v0.9.6 Q8 — entry_skill_name propagation (Perry's plumbing-risk SHAPE test, cites 1bc9d7a2)", () => {
  // The lesson: every layer of a multi-layer promise must honor the meta
  // field consistently. If runtime sets entry_skill_name but the wire-
  // surface strips it, the test passing at unit-layer would mislead.

  it("top-level execute: entry_skill_name absent (emitter IS the entry)", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["ops"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: top-level\n# Status: Approved\nm:\n    notify(agent="ops", message="hi")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect(t.delivered[0]!.payload.meta.origin.skill_name).toBe("top-level");
    expect("entry_skill_name" in t.delivered[0]!.payload.meta.origin).toBe(false);
  });

  it("execute with ctx.entrySkillName set: entry_skill_name surfaces when distinct from skill_name", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["ops"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: inner-helper\n# Status: Approved\nm:\n    notify(agent="ops", message="from helper")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: reg,
      entrySkillName: "root-entry",
    });

    expect(t.delivered[0]!.payload.meta.origin.skill_name).toBe("inner-helper");
    expect(t.delivered[0]!.payload.meta.origin.entry_skill_name).toBe("root-entry");
  });

  // COMPOSITION WIRE-SURFACE test per Perry's `ce41bd4d` probe #1.
  // Not just unit-on-ExecuteContext — actual procedural composition
  // (`$ execute_skill skill_name="..."`) where the runtime constructs a
  // nested execute() call for the child. Validates composition.ts
  // plumbing of entrySkillName, not just runtime.ts reading it.
  it("PROCEDURAL composition: A executes B via $ execute_skill; B's emit shows skill_name=B + entry_skill_name=A", async () => {
    const { FilesystemSkillStore } = await import("../src/connectors/skill-store.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "v096-compose-"));
    try {
      const reg = new Registry();
      const store = new FilesystemSkillStore(join(dir, "skills"));
      reg.registerSkillStore("primary", store);
      const t = new TestAgentConnector(["ops"]);
      await reg.registerAgentConnector("primary", t);

      // Store the child skill B that emits notify().
      await store.store("helper-b", `# Skill: helper-b\n# Status: Approved\nm:\n    notify(agent="ops", message="from B")\ndefault: m\n`);

      // Parent A executes child B via $ execute_skill (procedural composition).
      const parentSrc = `# Skill: parent-a\n# Status: Approved\nm:\n    $ execute_skill skill_name="helper-b" -> R\ndefault: m\n`;
      const compiled = await compile(parentSrc);
      await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

      expect(t.delivered).toHaveLength(1);
      expect(t.delivered[0]!.payload.meta.origin.skill_name).toBe("helper-b");
      expect(t.delivered[0]!.payload.meta.origin.entry_skill_name).toBe("parent-a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Deeper-than-2-level chains intentionally lose middle (Perry's footnote 2).
  // A → B → C, C emits → skill_name=C, entry_skill_name=A (B is in trace).
  it("3-level chain: A→B→C, C emits → skill_name=C + entry_skill_name=A (middle lost)", async () => {
    const { FilesystemSkillStore } = await import("../src/connectors/skill-store.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "v096-3level-"));
    try {
      const reg = new Registry();
      const store = new FilesystemSkillStore(join(dir, "skills"));
      reg.registerSkillStore("primary", store);
      const t = new TestAgentConnector(["ops"]);
      await reg.registerAgentConnector("primary", t);

      await store.store("c-leaf", `# Skill: c-leaf\n# Status: Approved\nm:\n    notify(agent="ops", message="from C")\ndefault: m\n`);
      await store.store("b-middle", `# Skill: b-middle\n# Status: Approved\nm:\n    $ execute_skill skill_name="c-leaf" -> R\ndefault: m\n`);
      const aSrc = `# Skill: a-root\n# Status: Approved\nm:\n    $ execute_skill skill_name="b-middle" -> R\ndefault: m\n`;
      const compiled = await compile(aSrc);
      await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

      expect(t.delivered).toHaveLength(1);
      expect(t.delivered[0]!.payload.meta.origin.skill_name).toBe("c-leaf");
      expect(t.delivered[0]!.payload.meta.origin.entry_skill_name).toBe("a-root");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v0.9.6 Q9 — event_type precedence (4 shapes, Perry's signoff probe #2)", () => {
  // The precedence rule: notify() kwarg wins; frontmatter is fallback; neither = undefined.
  // All four shapes need coverage — one missing = silent regression risk.

  it("shape 1: frontmatter # Event-type: foo only → meta.event_type = 'foo'", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["oncall"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: p\n# Status: Approved\n# Event-type: from-frontmatter\n# Output: agent: oncall\nm:\n    emit(text="hi")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect(t.delivered[0]!.payload.meta.event_type).toBe("from-frontmatter");
  });

  it("shape 2: notify(event_type='bar') kwarg only → meta.event_type = 'bar'", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["ops"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: p\n# Status: Approved\nm:\n    notify(agent="ops", message="hi", event_type="from-kwarg")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect(t.delivered[0]!.payload.meta.event_type).toBe("from-kwarg");
  });

  it("shape 3: BOTH set → kwarg wins (notify kwarg overrides frontmatter)", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["ops"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: p\n# Status: Approved\n# Event-type: from-frontmatter\nm:\n    notify(agent="ops", message="hi", event_type="from-kwarg")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect(t.delivered[0]!.payload.meta.event_type).toBe("from-kwarg");
  });

  it("shape 4: NEITHER set → meta.event_type undefined (field absent from envelope)", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["ops"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: p\n# Status: Approved\nm:\n    notify(agent="ops", message="hi")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect("event_type" in t.delivered[0]!.payload.meta).toBe(false);
  });
});

describe("v0.9.6 Q7 — delivery_skipped on receipt contract", () => {
  it("runtime honors connector-set delivery_skipped on the receipt", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["oncall"], { skipNext: true });
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: probe\n# Status: Approved\n# Output: agent: oncall\nm:\n    emit(text="hi")\ndefault: m\n`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect(result.agentDeliveryReceipts).toHaveLength(1);
    expect(result.agentDeliveryReceipts[0]!.delivery_skipped).toBe(true);
  });

  it("NoOp fallback inference still fires when no real AgentConnector wired (v0.9.2 back-compat)", async () => {
    const reg = new Registry();
    const src = `# Skill: probe\n# Status: Approved\n# Output: agent: oncall\nm:\n    emit(text="hi")\ndefault: m\n`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect(result.agentDeliveryReceipts[0]!.delivery_skipped).toBe(true);
    expect(result.agentDeliveryReceipts[0]!.reason).toMatch(/No AgentConnector wired/);
  });
});

describe("v0.9.6 Q1 — request_response signature locked (impl deferred to v0.10)", () => {
  it("NoOpAgentConnector.request_response throws NotImplementedError", async () => {
    const noop = new NoOpAgentConnector();
    const meta = { dispatch_id: "t", sent_at: 0, origin: { skill_name: "t", trigger_kind: "inline" as const } };
    await expect(
      noop.request_response("agent-x", { kind: "augment", content: "ping", meta }, { timeout_ms: 1000 }),
    ).rejects.toThrow(/not implemented/i);
  });
});

describe("v0.9.6 Q9 — legacy-frontmatter-header advisory (Perry's signoff probe #4)", () => {
  // Silent-permissiveness anti-pattern fix: cold authors migrating from
  // pre-v0.9.6 skill examples write `# Delivery-context:`; parser silently
  // drops it. Without this advisory, they debug-loop on empty meta.event_type.

  it("fires tier-2 warning on `# Delivery-context:` legacy header", async () => {
    const { lint } = await import("../src/lint.js");
    const src = `# Skill: legacy\n# Status: Approved\n# Delivery-context: stale-author-from-old-docs\n# Output: agent: oncall\nm:\n    emit(text="hi")\ndefault: m\n`;
    const r = await lint(src);
    const finding = r.findings.find((f) => f.rule === "legacy-frontmatter-header");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toMatch(/renamed to `# Event-type:` in v0\.9\.6/);
    expect(finding!.extras?.legacy_header).toBe("# Delivery-context:");
    expect(finding!.extras?.new_header).toBe("# Event-type:");
  });

  it("does NOT fire when `# Event-type:` is used (canonical)", async () => {
    const { lint } = await import("../src/lint.js");
    const src = `# Skill: current\n# Status: Approved\n# Event-type: canonical\n# Output: agent: oncall\nm:\n    emit(text="hi")\ndefault: m\n`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "legacy-frontmatter-header")).toBeUndefined();
  });
});

describe("v0.9.6 Q8 — dispatch_id uniqueness (rule: one notify() invocation = one dispatch_id)", () => {
  it("sequential notify() calls produce distinct dispatch_ids", async () => {
    const reg = new Registry();
    const t = new TestAgentConnector(["ops"]);
    await reg.registerAgentConnector("primary", t);

    const src = `# Skill: probe\n# Status: Approved\nm:\n    notify(agent="ops", message="one")\n    notify(agent="ops", message="two")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect(t.delivered).toHaveLength(2);
    expect(t.delivered[0]!.payload.meta.dispatch_id).not.toBe(t.delivered[1]!.payload.meta.dispatch_id);
  });

  it("multi-connector broadcast (same agent_id, 2 wired connectors) shares dispatch_id", async () => {
    const reg = new Registry();
    const c1 = new TestAgentConnector(["shared-agent"]);
    const c2 = new TestAgentConnector(["shared-agent"]);
    await reg.registerAgentConnector("primary", c1);
    await reg.registerAgentConnector("secondary", c2);

    const src = `# Skill: probe\n# Status: Approved\nm:\n    notify(agent="shared-agent", message="broadcast")\ndefault: m\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg });

    expect(c1.delivered).toHaveLength(1);
    expect(c2.delivered).toHaveLength(1);
    // Same notify() op → same dispatch_id across both branches per Perry's footnote.
    expect(c1.delivered[0]!.payload.meta.dispatch_id).toBe(c2.delivered[0]!.payload.meta.dispatch_id);
  });
});
