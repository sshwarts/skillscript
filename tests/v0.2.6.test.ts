import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { lint } from "../src/lint.js";
import { execute } from "../src/runtime.js";
import { compile } from "../src/compile.js";
import { Registry } from "../src/connectors/registry.js";
import type { AgentConnector, DeliveryPayload, DeliveryReceipt, AgentDescriptor } from "../src/connectors/agent.js";
import type { StaticCapabilities } from "../src/connectors/types.js";

/**
 * v0.2.6 — Items 2 + 3 from Perry's v0.2.5 kickoff (thread f75477a4).
 *
 * v0.9.6 audit rewrote the DeliveryPayload contract:
 *   - `# Delivery-context:` frontmatter renamed to `# Event-type:` (Q9)
 *   - `# Templates:` no longer flows through DeliveryPayload (Q10);
 *     still parsed for unknown-template-reference lint
 *   - `source_skill?` removed (folded into `meta.origin.skill_name` per Q8)
 *   - `triggered_by?` removed (folded into `meta.origin.trigger_kind` +
 *     `meta.sent_at` per Q12; cron name + fired_at_ms drop to trace only)
 *   - `format?` removed (Q11)
 *
 * Original v0.2.6 intent preserved here against the new shape so the
 * spirit of the v0.2.6 tests survives the v1.0 contract lock.
 */

class RecordingAgentConnector implements AgentConnector {
  public deliveries: Array<{ agent_id: string; payload: DeliveryPayload }> = [];

  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "agent_connector",
      implementation: "RecordingAgentConnector",
      contract_version: "1.0.0",
      features: {},
    };
  }

  async list_agents(): Promise<AgentDescriptor[]> {
    return [];
  }

  async deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt> {
    this.deliveries.push({ agent_id, payload });
    return { delivered_at: Date.now() };
  }

  async wake(): Promise<{ woken_at: number }> {
    return { woken_at: Date.now() };
  }

  async health_check(): Promise<boolean> { return true; }
  async request_response(): Promise<never> { throw new Error("not implemented"); }
}

describe("v0.2.6 → v0.9.6 — Item 3: parser captures # Event-type: + # Templates:", () => {
  it("parses both frontmatter headers into ParsedSkill fields", () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "# Event-type: queue-backlog-threshold",
      "# Templates: queue-drain-procedure, ops-page",
      "# Output: agent: oncall",
      "",
      "main:",
      "    ! alert body",
      "default: main",
      "",
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.eventType).toBe("queue-backlog-threshold");
    expect(parsed.templates).toEqual(["queue-drain-procedure", "ops-page"]);
  });

  it("absence of both headers leaves fields at default null / empty array", () => {
    const src = "# Skill: x\n# Status: Approved\nm:\n    ! hi\ndefault: m\n";
    const parsed = parse(src);
    expect(parsed.eventType).toBeNull();
    expect(parsed.templates).toEqual([]);
  });

  it("# Templates: (none) parses as empty list", () => {
    const src = "# Skill: x\n# Status: Approved\n# Output: agent: a\n# Templates: (none)\nm:\n    ! hi\ndefault: m\n";
    const parsed = parse(src);
    expect(parsed.templates).toEqual([]);
  });
});

describe("v0.2.6 → v0.9.6 — Item 3: unused-augmenting-header lint rule", () => {
  it("fires tier-2 warning on Headless skill with # Event-type:", async () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "# Event-type: orphan",
      "m:",
      "    ! hi",
      "default: m",
      "",
    ].join("\n");
    const result = await lint(src);
    const warning = result.findings.find((f) => f.rule === "unused-augmenting-header");
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");
    expect(warning!.message).toMatch(/Event-type/);
  });

  it("does NOT fire when an agent-bound output is declared", async () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "# Event-type: legitimate-use",
      "# Templates: follow-up-skill",
      "# Output: agent: assistant",
      "m:",
      "    ! hi",
      "default: m",
      "",
    ].join("\n");
    const result = await lint(src);
    const warning = result.findings.find((f) => f.rule === "unused-augmenting-header");
    expect(warning).toBeUndefined();
  });

  it("does NOT fire when neither field is set", async () => {
    const src = "# Skill: x\n# Status: Approved\nm:\n    ! hi\ndefault: m\n";
    const result = await lint(src);
    const warning = result.findings.find((f) => f.rule === "unused-augmenting-header");
    expect(warning).toBeUndefined();
  });
});

describe("v0.2.6 → v0.9.6 — DeliveryPayload meta envelope (Q8 contract)", () => {
  it("augment payload carries meta.origin.skill_name + meta.event_type from frontmatter", async () => {
    const recording = new RecordingAgentConnector();
    const registry = new Registry();
    await registry.registerAgentConnector("primary", recording);

    const src = [
      "# Skill: queue-alert",
      "# Status: Approved",
      "# Event-type: queue-backlog",
      "# Output: agent: oncall",
      "",
      "main:",
      "    ! Queue at 47 items.",
      "default: main",
      "",
    ].join("\n");
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });

    expect(recording.deliveries).toHaveLength(1);
    const { agent_id, payload } = recording.deliveries[0]!;
    expect(agent_id).toBe("oncall");
    expect(payload.kind).toBe("augment");
    expect(payload.meta.origin.skill_name).toBe("queue-alert");
    expect(payload.meta.event_type).toBe("queue-backlog");
    expect(typeof payload.meta.dispatch_id).toBe("string");
    expect(typeof payload.meta.sent_at).toBe("number");
  });

  it("template payload also carries meta envelope (parity with augment)", async () => {
    const recording = new RecordingAgentConnector();
    const registry = new Registry();
    await registry.registerAgentConnector("primary", recording);

    const src = [
      "# Skill: morning-brief-template",
      "# Status: Approved",
      "# Event-type: daily-kickoff",
      "# Output: template: scott",
      "",
      "main:",
      "    ! morning brief body",
      "default: main",
      "",
    ].join("\n");
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });

    expect(recording.deliveries).toHaveLength(1);
    const { payload } = recording.deliveries[0]!;
    expect(payload.kind).toBe("template");
    expect(payload.meta.origin.skill_name).toBe("morning-brief-template");
    expect(payload.meta.event_type).toBe("daily-kickoff");
  });

  it("meta.origin.trigger_kind reflects ctx.triggerCtx.source (scheduler-fired path)", async () => {
    const recording = new RecordingAgentConnector();
    const registry = new Registry();
    await registry.registerAgentConnector("primary", recording);

    const src = [
      "# Skill: cron-fired-alert",
      "# Status: Approved",
      "# Output: agent: oncall",
      "",
      "main:",
      "    ! cron tick",
      "default: main",
      "",
    ].join("\n");
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry,
      triggerCtx: { source: "cron", name: "0 9 * * *", fired_at_ms: 1779480000000 },
    });

    expect(recording.deliveries).toHaveLength(1);
    const { payload } = recording.deliveries[0]!;
    expect(payload.meta.origin.trigger_kind).toBe("cron");
    // Q12: name and fired_at_ms no longer flow into payload (trace-only).
    expect("name" in payload.meta.origin).toBe(false);
  });

  it("absent event_type / caller_agent_id / entry_skill_name not present in meta (no undefined keys)", async () => {
    const recording = new RecordingAgentConnector();
    const registry = new Registry();
    await registry.registerAgentConnector("primary", recording);

    const src = [
      "# Skill: minimal",
      "# Status: Approved",
      "# Output: agent: anon",
      "",
      "main:",
      "    ! hi",
      "default: main",
      "",
    ].join("\n");
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });

    expect(recording.deliveries).toHaveLength(1);
    const { payload } = recording.deliveries[0]!;
    expect(payload.meta.origin.skill_name).toBe("minimal");
    expect("event_type" in payload.meta).toBe(false);
    expect("caller_agent_id" in payload.meta.origin).toBe(false);
    expect("entry_skill_name" in payload.meta.origin).toBe(false);
    expect("correlation_id" in payload.meta).toBe(false);
  });
});
