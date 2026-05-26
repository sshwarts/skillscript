import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { lint } from "../src/lint.js";
import { execute } from "../src/runtime.js";
import { compile } from "../src/compile.js";
import { Registry } from "../src/connectors/registry.js";
import type { AgentConnector, DeliveryPayload, DeliveryReceipt, AgentDescriptor } from "../src/connectors/agent.js";
import type { ManifestInfo, StaticCapabilities } from "../src/connectors/types.js";

/**
 * v0.2.6 — Items 2 + 3 from Perry's v0.2.5 kickoff (thread f75477a4).
 *
 *   Item 2: AgentConnector DeliveryPayload provenance
 *     - `source_skill?` added to augment variant (template already had it)
 *     - `triggered_by?: TriggerProvenance` added to both variants
 *
 *   Item 3: `# Delivery-context:` + `# Templates:` headers
 *     - Parser captures both frontmatter keys into ParsedSkill fields
 *     - Runtime threads them through DeliveryPayload as delivery_context
 *       + templates fields
 *     - Tier-2 lint `unused-augmenting-header` fires when present on a
 *       Headless skill (no agent-bound output)
 */

/** Test-only AgentConnector that records every deliver() payload. */
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

  async manifest(): Promise<ManifestInfo> {
    return { capabilities_version: "1.0", manifest: {} };
  }
}

describe("v0.2.6 — Item 3: parser captures # Delivery-context: + # Templates:", () => {
  it("parses both new headers into ParsedSkill fields", () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "# Delivery-context: Heads up — overnight queue depth has crossed the alert threshold.",
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
    expect(parsed.deliveryContext).toBe("Heads up — overnight queue depth has crossed the alert threshold.");
    expect(parsed.templates).toEqual(["queue-drain-procedure", "ops-page"]);
  });

  it("absence of both headers leaves fields at default null / empty array", () => {
    const src = "# Skill: x\n# Status: Approved\nm:\n    ! hi\ndefault: m\n";
    const parsed = parse(src);
    expect(parsed.deliveryContext).toBeNull();
    expect(parsed.templates).toEqual([]);
  });

  it("# Templates: (none) parses as empty list", () => {
    const src = "# Skill: x\n# Status: Approved\n# Output: agent: a\n# Templates: (none)\nm:\n    ! hi\ndefault: m\n";
    const parsed = parse(src);
    expect(parsed.templates).toEqual([]);
  });
});

describe("v0.2.6 — Item 3: unused-augmenting-header lint rule", () => {
  it("fires tier-2 warning on Headless skill with # Delivery-context:", async () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "# Delivery-context: this won't reach anyone",
      "m:",
      "    ! hi",
      "default: m",
      "",
    ].join("\n");
    const result = await lint(src);
    const warning = result.findings.find((f) => f.rule === "unused-augmenting-header");
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");
    expect(warning!.message).toMatch(/Delivery-context/);
  });

  it("fires tier-2 warning on Headless skill with # Templates:", async () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "# Templates: drain, page",
      "m:",
      "    ! hi",
      "default: m",
      "",
    ].join("\n");
    const result = await lint(src);
    const warning = result.findings.find((f) => f.rule === "unused-augmenting-header");
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/Templates/);
  });

  it("does NOT fire when an agent-bound output is declared", async () => {
    const src = [
      "# Skill: x",
      "# Status: Approved",
      "# Delivery-context: legitimate use",
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

describe("v0.2.6 — Item 2 + 3 end-to-end: DeliveryPayload threading", () => {
  it("augment payload carries source_skill, delivery_context, templates", async () => {
    const recording = new RecordingAgentConnector();
    const registry = new Registry();
    registry.registerAgentConnector("primary", recording);

    const src = [
      "# Skill: queue-alert",
      "# Status: Approved",
      "# Delivery-context: Queue backlog exceeds threshold — drain procedure recommended.",
      "# Templates: queue-drain, ops-page",
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
    if (payload.kind === "augment") {
      expect(payload.source_skill).toBe("queue-alert");
      expect(payload.delivery_context).toBe("Queue backlog exceeds threshold — drain procedure recommended.");
      expect(payload.templates).toEqual(["queue-drain", "ops-page"]);
      expect(payload.content).toMatch(/Queue at 47 items/);
    }
  });

  it("template payload also carries the new common fields (parity with augment)", async () => {
    const recording = new RecordingAgentConnector();
    const registry = new Registry();
    registry.registerAgentConnector("primary", recording);

    const src = [
      "# Skill: morning-brief-template",
      "# Status: Approved",
      "# Delivery-context: Daily kickoff brief delivered as a Template.",
      "# Templates: midday-status",
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
    if (payload.kind === "template") {
      expect(payload.source_skill).toBe("morning-brief-template");
      expect(payload.delivery_context).toMatch(/Daily kickoff/);
      expect(payload.templates).toEqual(["midday-status"]);
    }
  });

  it("triggered_by populated when triggerCtx is passed (scheduler-fired path)", async () => {
    const recording = new RecordingAgentConnector();
    const registry = new Registry();
    registry.registerAgentConnector("primary", recording);

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
    if (payload.kind === "augment") {
      expect(payload.triggered_by).toBeDefined();
      expect(payload.triggered_by!.source).toBe("cron");
      expect(payload.triggered_by!.name).toBe("0 9 * * *");
      expect(payload.triggered_by!.fired_at_ms).toBe(1779480000000);
    }
  });

  it("absent fields are not included in the payload (no undefined keys)", async () => {
    const recording = new RecordingAgentConnector();
    const registry = new Registry();
    registry.registerAgentConnector("primary", recording);

    // No delivery_context, no templates, no triggerCtx.
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

    const { payload } = recording.deliveries[0]!;
    if (payload.kind === "augment") {
      expect(payload.source_skill).toBe("minimal");
      expect("delivery_context" in payload).toBe(false);
      expect("templates" in payload).toBe(false);
      expect("triggered_by" in payload).toBe(false);
    }
  });
});

describe("v0.2.6 — Signal 1: queue-length-monitor example lints clean", () => {
  it("the bundled queue-length-monitor example parses + lints with no findings", async () => {
    const path = new URL("../examples/queue-length-monitor.skill.md", import.meta.url);
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(path, "utf8");
    const parsed = parse(src);
    expect(parsed.parseErrors).toEqual([]);
    const result = await lint(src);
    const errors = result.findings.filter((f) => f.severity === "error");
    expect(errors).toEqual([]);
  });
});
