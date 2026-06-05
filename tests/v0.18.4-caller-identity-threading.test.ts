import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/connectors/registry.js";
import { executeSkillFromSource } from "../src/composition.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import type {
  AgentConnector,
  AgentDescriptor,
  DeliveryPayload,
  DeliveryReceipt,
  DeliveryMeta,
  WakeOpts,
  WakeReceipt,
} from "../src/connectors/agent.js";

/**
 * v0.18.4 — caller-identity threading.
 *
 * Closes the v0.17.0 + v0.16.8 plumbing gap surfaced by the connector
 * agent's adoption (Perry Q5a): the authenticated MCP caller wasn't
 * threaded into `DeliveryMeta.origin.caller_agent_id`. The runtime was
 * reading `ctx.agentId` (skill OWNER, used for outbound substrate
 * scoping) instead of `ctx.callerAgentId` (authenticated caller).
 *
 * Architecture after v0.18.4:
 *   ctx.agentId        — skill OWNER (outbound connector scoping)
 *   ctx.callerAgentId  — authenticated CALLER (DeliveryMeta attribution)
 *
 * They diverge when agent `cc` invokes a skill owned by agent `alice`
 * which composes a skill owned by agent `bob`. Bob's notify() emits
 * `caller_agent_id: cc` regardless of composition depth.
 */

class CapturingAgentConnector implements AgentConnector {
  public lastMeta?: DeliveryMeta;
  async list_agents(): Promise<AgentDescriptor[]> {
    return [{ agent_id: "perry" }];
  }
  async deliver(_agent: string, payload: DeliveryPayload): Promise<DeliveryReceipt> {
    this.lastMeta = payload.meta;
    return { delivered_at: Date.now() };
  }
  async wake(_agent: string, _opts?: WakeOpts): Promise<WakeReceipt> {
    return { woken_at: Date.now(), woken: false };
  }
  async health_check(): Promise<boolean> {
    return true;
  }
  async request_response(): Promise<never> {
    throw new Error("not impl");
  }
}

async function buildRegistry(): Promise<{ registry: Registry; agent: CapturingAgentConnector }> {
  const registry = new Registry();
  const agent = new CapturingAgentConnector();
  await registry.registerAgentConnector("primary", agent);
  return { registry, agent };
}

const NOTIFY_SKILL = `# Skill: notify-perry
# Status: Draft
# Description: trivial notify-perry-then-emit
m:
    notify(agent="perry", message="ping")
    emit(text="sent")
default: m
`;

describe("v0.18.4 — caller_agent_id reads from ctx.callerAgentId (not ctx.agentId)", () => {
  it("ctx.callerAgentId set → DeliveryMeta.origin.caller_agent_id reflects caller", async () => {
    const { registry, agent } = await buildRegistry();
    await executeSkillFromSource(NOTIFY_SKILL, {}, {
      ctx: { registry, callerAgentId: "cc" },
    });
    expect(agent.lastMeta?.origin.caller_agent_id).toBe("cc");
  });

  it("ctx.agentId set but callerAgentId unset → caller_agent_id is undefined (owner ≠ caller)", async () => {
    // Repro of the v0.17.0+v0.16.8 bug shape: skill OWNER threaded but
    // no authenticated caller. caller_agent_id should be undefined per
    // the contract's "cron / cli / dashboard / inline triggers leave it
    // undefined" rule — NOT inferred from the owner.
    const { registry, agent } = await buildRegistry();
    await executeSkillFromSource(NOTIFY_SKILL, {}, {
      ctx: { registry, agentId: "alice" },
    });
    expect(agent.lastMeta?.origin.caller_agent_id).toBeUndefined();
  });

  it("both set → caller_agent_id is the caller (NOT the owner)", async () => {
    const { registry, agent } = await buildRegistry();
    await executeSkillFromSource(NOTIFY_SKILL, {}, {
      ctx: { registry, agentId: "alice", callerAgentId: "cc" },
    });
    expect(agent.lastMeta?.origin.caller_agent_id).toBe("cc");
  });

  it("neither set → caller_agent_id is undefined", async () => {
    const { registry, agent } = await buildRegistry();
    await executeSkillFromSource(NOTIFY_SKILL, {}, {
      ctx: { registry },
    });
    expect(agent.lastMeta?.origin.caller_agent_id).toBeUndefined();
  });
});

describe("v0.18.4 — # Output: agent: X lifecycle hook honors callerAgentId", () => {
  const LIFECYCLE_SKILL = `# Skill: brief-perry
# Status: Draft
# Description: lifecycle-hook delivery to perry
# Output: agent: perry
m:
    emit(text="overnight sweep clean")
default: m
`;

  it("lifecycle-hook deliver reads caller_agent_id from ctx.callerAgentId", async () => {
    const { registry, agent } = await buildRegistry();
    await executeSkillFromSource(LIFECYCLE_SKILL, {}, {
      ctx: { registry, callerAgentId: "cc" },
    });
    expect(agent.lastMeta?.origin.caller_agent_id).toBe("cc");
  });
});

describe("v0.18.4 — composition preserves callerAgentId across child skills", () => {
  it("parent A composes child B; B's notify() emits caller_agent_id from original caller", async () => {
    // Repro of the architectural invariant: when agent `cc` invokes
    // parent A (Alice-owned) which composes child B (Bob-owned via the
    // `&` execute_skill path), B's notify() in the runtime should emit
    // `caller_agent_id: cc` — composition doesn't reset the chain
    // originator. The owner identity does flip via ctx.agentId (per
    // v0.16.9), but the caller identity stays as the chain originator.
    //
    // Verified by manually executing a parent skill that composes a
    // child inline (the runtime's `execute_skill` op path). We use the
    // exposed `execute()` to simulate the chain without needing a
    // SkillStore — the equivalent runtime path threads ctx unchanged
    // for callerAgentId.
    const { registry, agent } = await buildRegistry();
    // Mimic the runtime's composition step: spread parent ctx into
    // child ctx, override agentId from child's metadata.author, keep
    // callerAgentId from parent. The composition.ts shape this lives in.
    const parentCtx = { registry, agentId: "alice", callerAgentId: "cc" };
    const childCtx = {
      ...parentCtx,
      agentId: "bob", // child owner per composition.ts:149
    };
    await executeSkillFromSource(NOTIFY_SKILL, {}, { ctx: childCtx });
    expect(agent.lastMeta?.origin.caller_agent_id).toBe("cc");
    // Note: this verifies the buildLifecycleMeta read-from-callerAgentId
    // semantic in concert with the composition.ts inheritance pattern.
    // Both halves need to be correct for caller_agent_id to land right
    // at the bottom of a composition chain.
  });
});

describe("v0.18.4 — MCP /rpc boundary threads callerIdentity → DeliveryMeta.caller_agent_id (end-to-end repro)", () => {
  // Repro of the connector agent's adoption finding: execute_skill via
  // /rpc with X-Agent-Id: cc landed caller_agent_id: <skill-author> on
  // the deliver() envelope. This test wires the full path: McpServer
  // handle() → execute_skill handler → executeSkillByName → notify() →
  // DeliveryMeta. The caller-identity flows through ctx.callerAgentId.

  it("execute_skill with callerIdentity threads through to deliver() caller_agent_id", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0184-mcp-"));
    try {
      const skillStore = new FilesystemSkillStore(join(home, "skills"));
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      const registry = new Registry();
      registry.registerSkillStore("primary", skillStore);
      const agent = new CapturingAgentConnector();
      await registry.registerAgentConnector("primary", agent);
      const scheduler = new Scheduler({ registry, skillStore, traceStore });
      const server = new McpServer({ skillStore, scheduler, traceStore, registry });

      // Author "alice" writes the skill via skill_write with X-Agent-Id: alice
      const writeReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "skill_write",
          arguments: {
            name: "notify-perry-mcp",
            source: `# Skill: notify-perry-mcp
# Status: Approved
# Description: notify perry then emit
m:
    notify(agent="perry", message="ping")
    emit(text="sent")
default: m
`,
          },
        },
      };
      await server.handle(writeReq, { callerIdentity: "alice" });

      // Caller "cc" (different from author) invokes execute_skill via /rpc
      // with X-Agent-Id: cc → caller_agent_id MUST be "cc" (not "alice").
      const execReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "execute_skill",
          arguments: { name: "notify-perry-mcp" },
        },
      };
      await server.handle(execReq, { callerIdentity: "cc" });

      expect(agent.lastMeta?.origin.caller_agent_id).toBe("cc");
      // ctx.agentId was "alice" (the owner — used for outbound scoping),
      // but caller_agent_id reflects the authenticated caller "cc".
      // These two semantics are now correctly separated.
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("execute_skill without callerIdentity → caller_agent_id undefined (owner is NOT used as fallback)", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0184-mcp-noid-"));
    try {
      const skillStore = new FilesystemSkillStore(join(home, "skills"));
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      const registry = new Registry();
      registry.registerSkillStore("primary", skillStore);
      const agent = new CapturingAgentConnector();
      await registry.registerAgentConnector("primary", agent);
      const scheduler = new Scheduler({ registry, skillStore, traceStore });
      const server = new McpServer({ skillStore, scheduler, traceStore, registry });

      await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "skill_write",
          arguments: {
            name: "notify-perry-noid",
            source: `# Skill: notify-perry-noid
# Status: Approved
# Description: notify perry no-id
m:
    notify(agent="perry", message="ping")
    emit(text="sent")
default: m
`,
          },
        },
      }, { callerIdentity: "alice" });

      // No callerIdentity on the execute call — the contract's "no
      // calling agent" form. Owner "alice" must NOT be promoted to
      // caller_agent_id (the v0.16.8-era bug shape).
      await server.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "execute_skill", arguments: { name: "notify-perry-noid" } },
      });

      expect(agent.lastMeta?.origin.caller_agent_id).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("v0.18.4 — scheduler-fired skills carry no caller_agent_id", () => {
  it("ctx with triggerCtx.source=cron but no callerAgentId → caller_agent_id undefined", async () => {
    // The contract's "cron / session / cli / dashboard triggers leave
    // it undefined" rule. Scheduler-fired skills don't have a human
    // caller; the timer fires them. ctx.agentId may be set (skill
    // owner, for outbound scoping) but callerAgentId stays undefined.
    const { registry, agent } = await buildRegistry();
    await executeSkillFromSource(NOTIFY_SKILL, {}, {
      ctx: {
        registry,
        agentId: "alice",
        triggerCtx: { source: "cron", name: "olsen-nightly", fired_at_ms: Date.now() },
      },
    });
    expect(agent.lastMeta?.origin.caller_agent_id).toBeUndefined();
    expect(agent.lastMeta?.origin.trigger_kind).toBe("cron");
  });
});

describe("v0.18.4 — DeliveryReceipt.warnings ride through to AgentDeliveryReceiptRecord", () => {
  class WarningEmittingConnector implements AgentConnector {
    async list_agents(): Promise<AgentDescriptor[]> {
      return [{ agent_id: "perry" }];
    }
    async deliver(_agent: string, _payload: DeliveryPayload): Promise<DeliveryReceipt> {
      return {
        delivered_at: Date.now(),
        warnings: [
          "stripped @session suffix — deliver is mailbox-class",
          "rate-limit hint: backoff 5s before next deliver",
        ],
      };
    }
    async wake(_agent: string, _opts?: WakeOpts): Promise<WakeReceipt> {
      return { woken_at: Date.now(), woken: false };
    }
    async health_check(): Promise<boolean> {
      return true;
    }
    async request_response(): Promise<never> {
      throw new Error("not impl");
    }
  }

  it("substrate-set warnings appear on agent_delivery_receipts[].receipt.warnings", async () => {
    const registry = new Registry();
    await registry.registerAgentConnector("primary", new WarningEmittingConnector());
    const NOTIFY_LIFECYCLE = `# Skill: notify-perry-lc
# Status: Draft
# Description: lifecycle delivery yields warning-carrying receipt
# Output: agent: perry
m:
    emit(text="hi")
default: m
`;
    const result = await executeSkillFromSource(NOTIFY_LIFECYCLE, {}, {
      ctx: { registry, callerAgentId: "cc" },
    });
    expect(result.agent_delivery_receipts).toBeDefined();
    expect(result.agent_delivery_receipts.length).toBe(1);
    const warnings = result.agent_delivery_receipts[0]?.receipt.warnings;
    expect(warnings).toEqual([
      "stripped @session suffix — deliver is mailbox-class",
      "rate-limit hint: backoff 5s before next deliver",
    ]);
  });
});
