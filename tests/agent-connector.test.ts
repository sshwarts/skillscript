import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { NoOpAgentConnector } from "../src/connectors/agent-noop.js";
import type {
  AgentConnector,
  AgentDescriptor,
  DeliveryPayload,
  DeliveryReceipt,
} from "../src/connectors/agent.js";
import type { StaticCapabilities } from "../src/connectors/types.js";
import type { RequestResponseOpts, Response } from "../src/connectors/agent.js";
import { AgentConnectorConformance } from "../src/testing/conformance.js";

/**
 * T7.1 — AgentConnector contract + dispatch wiring tests.
 *
 * Covers:
 *   1. NoOpAgentConnector ships as Registry fallback (no explicit register call needed)
 *   2. `# Output: agent: <agent>` dispatch routes through deliver(kind=augment)
 *   3. `# Output: template: <agent>` dispatch routes through deliver(kind=template)
 *   4. Mechanical mode skips agent dispatch (placeholders don't reach substrates)
 *   5. Multiple agent-targeted outputs dispatch independently
 *   6. Delivery failures surface to stderr but don't fail the skill
 *   7. NoOpAgentConnector passes the conformance suite
 */

class RecordingAgentConnector implements AgentConnector {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "agent_connector",
      implementation: "RecordingAgentConnector",
      contract_version: "1.0.0",
      features: { deliver: true, wake: true, list_agents: true },
    };
  }

  readonly deliveries: Array<{ agent_id: string; payload: DeliveryPayload }> = [];
  readonly wakes: Array<{ agent_id: string }> = [];

  async list_agents(): Promise<AgentDescriptor[]> {
    return [{ agent_id: "perry", capabilities: ["deliver", "wake", "augment", "template"] }];
  }

  async deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt> {
    this.deliveries.push({ agent_id, payload });
    return { delivered_at: Date.now(), delivery_id: `rec-${this.deliveries.length}` };
  }

  async wake(agent_id: string): Promise<{ woken_at: number }> {
    this.wakes.push({ agent_id });
    return { woken_at: Date.now() };
  }

  async health_check(): Promise<boolean> { return true; }
  async request_response(_agent_id: string, _payload: DeliveryPayload, _opts: RequestResponseOpts): Promise<Response> {
    throw new Error("not implemented in RecordingAgentConnector");
  }
}

class FailingAgentConnector implements AgentConnector {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "agent_connector",
      implementation: "FailingAgentConnector",
      contract_version: "1.0.0",
      features: {},
    };
  }
  async list_agents(): Promise<AgentDescriptor[]> { return []; }
  async deliver(): Promise<DeliveryReceipt> { throw new Error("substrate down"); }
  async wake(): Promise<{ woken_at: number }> { throw new Error("substrate down"); }
  async health_check(): Promise<boolean> { return true; }
  async request_response(): Promise<Response> { throw new Error("not implemented"); }
}

async function executeSkill(source: string, registry: Registry, mechanical = false) {
  const compiled = await compile(source);
  return execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
    registry,
    ...(mechanical ? { mechanical: true } : {}),
  });
}

describe("AgentConnector — dispatch wiring", () => {
  it("1. Registry returns NoOpAgentConnector when no adapter is registered", () => {
    const reg = new Registry();
    expect(reg.hasAgentConnector()).toBe(false);
    const agent = reg.getAgentConnector();
    expect(agent).toBeInstanceOf(NoOpAgentConnector);
  });

  it("2. # Output: agent: <agent> routes through deliver(kind=augment)", async () => {
    const reg = new Registry();
    const recorder = new RecordingAgentConnector();
    await reg.registerAgentConnector("primary", recorder);
    const result = await executeSkill(`# Skill: ctx-out
# Status: Approved
# Output: agent: perry

greet:
    ! morning brief one
    ! morning brief two

default: greet
`, reg);
    expect(recorder.deliveries.length).toBe(1);
    expect(recorder.deliveries[0]!.agent_id).toBe("perry");
    expect(recorder.deliveries[0]!.payload.kind).toBe("augment");
    expect((recorder.deliveries[0]!.payload as { kind: "augment"; content: string }).content)
      .toContain("morning brief one");
    expect(result.agentDeliveryReceipts.length).toBe(1);
    expect(result.agentDeliveryReceipts[0]!.output_kind).toBe("agent");
  });

  it("3. # Output: template: <agent> routes through deliver(kind=template) with source_skill", async () => {
    const reg = new Registry();
    const recorder = new RecordingAgentConnector();
    await reg.registerAgentConnector("primary", recorder);
    const result = await executeSkill(`# Skill: tmpl-out
# Status: Approved
# Output: template: perry

build:
    ! draft template body

default: build
`, reg);
    expect(recorder.deliveries.length).toBe(1);
    const payload = recorder.deliveries[0]!.payload;
    expect(payload.kind).toBe("template");
    if (payload.kind === "template") {
      expect(payload.prompt).toContain("draft template body");
      // v0.9.6 — source_skill folded into meta.origin.skill_name per Q8
      expect(payload.meta.origin.skill_name).toBe("tmpl-out");
    }
    expect(result.agentDeliveryReceipts[0]!.output_kind).toBe("template");
  });

  it("4. mechanical mode skips agent dispatch", async () => {
    const reg = new Registry();
    const recorder = new RecordingAgentConnector();
    await reg.registerAgentConnector("primary", recorder);
    const result = await executeSkill(`# Skill: mech-skip
# Status: Approved
# Output: agent: perry

greet:
    ! preview only

default: greet
`, reg, /* mechanical */ true);
    expect(recorder.deliveries.length).toBe(0);
    expect(result.agentDeliveryReceipts.length).toBe(0);
  });

  it("5. multiple agent-targeted outputs dispatch independently", async () => {
    const reg = new Registry();
    const recorder = new RecordingAgentConnector();
    await reg.registerAgentConnector("primary", recorder);
    await executeSkill(`# Skill: multi-out
# Status: Approved
# Output: agent: perry
# Output: template: claude

emit:
    ! shared payload

default: emit
`, reg);
    expect(recorder.deliveries.length).toBe(2);
    const kinds = recorder.deliveries.map((d) => d.payload.kind).sort();
    expect(kinds).toEqual(["augment", "template"]);
  });

  it("6. delivery failure logs to stderr but doesn't fail the skill", async () => {
    const reg = new Registry();
    await reg.registerAgentConnector("primary", new FailingAgentConnector());
    const result = await executeSkill(`# Skill: fail-out
# Status: Approved
# Output: agent: perry

greet:
    ! still emits

default: greet
`, reg);
    expect(result.errors.length).toBe(0);
    expect(result.emissions).toContain("still emits");
    expect(result.agentDeliveryReceipts.length).toBe(0);
  });
});

describe("NoOpAgentConnector — conformance suite", () => {
  const fixture = {
    build: () => new NoOpAgentConnector(),
    ctor: NoOpAgentConnector,
    testAgentId: "test-agent",
  };
  const tests = AgentConnectorConformance.buildTests(fixture);

  for (const t of tests) {
    it(`(${t.category}) ${t.name}`, async () => {
      await t.run();
    });
  }
});
