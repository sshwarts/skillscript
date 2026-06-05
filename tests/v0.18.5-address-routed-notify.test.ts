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
import { lint } from "../src/lint.js";
import type {
  AgentConnector,
  AgentDescriptor,
  DeliveryPayload,
  DeliveryReceipt,
  WakeOpts,
  WakeReceipt,
} from "../src/connectors/agent.js";

/**
 * v0.18.5 — Address-routed notify() / lifecycle hooks per Perry's
 * design call (thread c453afa2):
 *
 *   bare `notify(agent="X")` → AgentConnector.deliver()
 *   `notify(agent="X@session")` → AgentConnector.wake()
 *
 *   bare `# Output: agent: X` → deliver()
 *   `# Output: agent: X@session` → wake()
 *
 * The `@session` suffix on the address IS the wake signal — no separate
 * `wake=true` kwarg, no separate wake() op. Same convention as
 * waiting_on/mailbox/broker. Three-test discipline:
 *   1. Lint — info-level surfacing makes the routing visible at author time
 *   2. Runtime — notify() and lifecycle hooks dispatch to the correct method
 *   3. End-to-end — MCP /rpc → execute_skill → connector receives wake() not deliver()
 */

class RecordingConnector implements AgentConnector {
  public delivers: Array<{ agent_id: string; payload: DeliveryPayload }> = [];
  public wakes: Array<{ agent_id: string; opts?: WakeOpts }> = [];
  constructor(private readonly knownAgents: string[]) {}
  async list_agents(): Promise<AgentDescriptor[]> {
    return this.knownAgents.map((agent_id) => ({ agent_id }));
  }
  async deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt> {
    this.delivers.push({ agent_id, payload });
    return { delivered_at: Date.now(), delivery_id: `d-${this.delivers.length}` };
  }
  async wake(agent_id: string, opts?: WakeOpts): Promise<WakeReceipt> {
    this.wakes.push({ agent_id, opts });
    return { woken_at: Date.now(), woken: true, session_id: agent_id.split("@")[1] };
  }
  async health_check(): Promise<boolean> {
    return true;
  }
  async request_response(): Promise<never> {
    throw new Error("not impl");
  }
}

async function buildRegistry(agents: string[]): Promise<{ registry: Registry; conn: RecordingConnector }> {
  const registry = new Registry();
  const conn = new RecordingConnector(agents);
  await registry.registerAgentConnector("primary", conn);
  return { registry, conn };
}

// ────────────────────────────────────────────────────────────────────────
// (1) LINT — informational `address-routed-wake` surfacing
// ────────────────────────────────────────────────────────────────────────

describe("v0.18.5 lint — address-routed-wake info surfacing", () => {
  it("fires info on notify(agent=\"X@session\")", async () => {
    const src = `# Skill: probe
# Status: Draft
# Description: ping
m:
    notify(agent="cc@kitchen-terminal", message="hi")
default: m
`;
    const result = await lint(src);
    const finding = result.findings.find((f) => f.rule === "address-routed-wake");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
    expect(finding!.extras?.surface).toBe("notify");
    expect(finding!.extras?.agent).toBe("cc@kitchen-terminal");
  });

  it("does NOT fire on bare notify(agent=\"X\")", async () => {
    const src = `# Skill: probe
# Status: Draft
# Description: ping
m:
    notify(agent="perry", message="hi")
default: m
`;
    const result = await lint(src);
    const finding = result.findings.find((f) => f.rule === "address-routed-wake");
    expect(finding).toBeUndefined();
  });

  it("fires info on # Output: agent: X@session", async () => {
    const src = `# Skill: probe
# Status: Draft
# Description: ping
# Output: agent: cc@kitchen-terminal
m:
    emit(text="hi")
default: m
`;
    const result = await lint(src);
    const finding = result.findings.find((f) => f.rule === "address-routed-wake");
    expect(finding).toBeDefined();
    expect(finding!.extras?.surface).toBe("output-agent");
  });

  it("fires info on # Output: template: X@session", async () => {
    const src = `# Skill: probe
# Status: Draft
# Description: template
# Output: template: cc@browser-tab-3
m:
    emit(text="run this")
default: m
`;
    const result = await lint(src);
    const finding = result.findings.find((f) => f.rule === "address-routed-wake");
    expect(finding).toBeDefined();
    expect(finding!.extras?.surface).toBe("output-template");
  });

  it("fires on every offending op + decl in one skill (not just first)", async () => {
    const src = `# Skill: probe
# Status: Draft
# Description: multi-surface
# Output: agent: cc@kitchen-terminal
m:
    notify(agent="alice@session-a", message="hi")
    notify(agent="bob@session-b", message="bye")
default: m
`;
    const result = await lint(src);
    const findings = result.findings.filter((f) => f.rule === "address-routed-wake");
    expect(findings.length).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────
// (2) RUNTIME — notify() + lifecycle hooks dispatch to the correct method
// ────────────────────────────────────────────────────────────────────────

describe("v0.18.5 runtime — notify() address-routes deliver vs. wake", () => {
  it("bare notify(agent=\"X\") → calls deliver()", async () => {
    const { registry, conn } = await buildRegistry(["perry"]);
    const src = `# Skill: probe
# Status: Draft
# Description: bare deliver
m:
    notify(agent="perry", message="ping")
default: m
`;
    await executeSkillFromSource(src, {}, { ctx: { registry } });
    expect(conn.delivers.length).toBe(1);
    expect(conn.wakes.length).toBe(0);
    expect(conn.delivers[0]!.agent_id).toBe("perry");
  });

  it("notify(agent=\"X@session\") → calls wake() with the composite agent_id preserved", async () => {
    const { registry, conn } = await buildRegistry(["cc"]);
    const src = `# Skill: probe
# Status: Draft
# Description: session wake
m:
    notify(agent="cc@kitchen-terminal", message="look here")
default: m
`;
    await executeSkillFromSource(src, {}, { ctx: { registry } });
    expect(conn.wakes.length).toBe(1);
    expect(conn.delivers.length).toBe(0);
    expect(conn.wakes[0]!.agent_id).toBe("cc@kitchen-terminal");
    // Message rides as WakeOpts.context
    expect(conn.wakes[0]!.opts?.context).toBe("look here");
  });

  it("notify(agent=\"X@session\") with no message → wake() with empty context", async () => {
    const { registry, conn } = await buildRegistry(["cc"]);
    const src = `# Skill: probe
# Status: Draft
# Description: content-less wake
m:
    notify(agent="cc@kitchen-terminal")
default: m
`;
    await executeSkillFromSource(src, {}, { ctx: { registry } });
    expect(conn.wakes.length).toBe(1);
    // No accumulated emissions yet at the notify() call site → empty
    // context (or absent kwarg). Either is acceptable — the substrate
    // gets called either way.
  });
});

describe("v0.18.5 runtime — # Output: agent: lifecycle hook address-routes too", () => {
  it("# Output: agent: X (bare) → calls deliver()", async () => {
    const { registry, conn } = await buildRegistry(["perry"]);
    const src = `# Skill: probe
# Status: Draft
# Description: lifecycle deliver
# Output: agent: perry
m:
    emit(text="overnight clean")
default: m
`;
    const result = await executeSkillFromSource(src, {}, { ctx: { registry } });
    expect(conn.delivers.length).toBe(1);
    expect(conn.wakes.length).toBe(0);
    expect(result.agent_delivery_receipts.length).toBe(1);
    expect(result.agent_wake_receipts.length).toBe(0);
  });

  it("# Output: agent: X@session → calls wake()", async () => {
    const { registry, conn } = await buildRegistry(["cc"]);
    const src = `# Skill: probe
# Status: Draft
# Description: lifecycle wake
# Output: agent: cc@kitchen-terminal
m:
    emit(text="overnight clean")
default: m
`;
    const result = await executeSkillFromSource(src, {}, { ctx: { registry } });
    expect(conn.wakes.length).toBe(1);
    expect(conn.delivers.length).toBe(0);
    expect(conn.wakes[0]!.agent_id).toBe("cc@kitchen-terminal");
    // Lifecycle-hook wake content rides in WakeOpts.context
    expect(conn.wakes[0]!.opts?.context).toBe("overnight clean");
    expect(result.agent_wake_receipts.length).toBe(1);
    expect(result.agent_delivery_receipts.length).toBe(0);
  });

  it("# Output: template: X@session → calls wake() with source_kind=template on the record", async () => {
    const { registry, conn } = await buildRegistry(["cc"]);
    const src = `# Skill: probe
# Status: Draft
# Description: template wake
# Output: template: cc@browser-tab-3
m:
    emit(text="execute this playbook")
default: m
`;
    const result = await executeSkillFromSource(src, {}, { ctx: { registry } });
    expect(conn.wakes.length).toBe(1);
    expect(result.agent_wake_receipts[0]!.source_kind).toBe("template");
  });
});

describe("v0.18.5 runtime — discoverability via receipt.warnings", () => {
  it("lifecycle-hook wake receipt carries runtime-emitted routing-note in warnings", async () => {
    const { registry } = await buildRegistry(["cc"]);
    const src = `# Skill: probe
# Status: Draft
# Description: routing note discoverability
# Output: agent: cc@kitchen-terminal
m:
    emit(text="hi")
default: m
`;
    const result = await executeSkillFromSource(src, {}, { ctx: { registry } });
    const warnings = result.agent_wake_receipts[0]!.receipt.warnings;
    expect(warnings).toBeDefined();
    expect(warnings![0]).toMatch(/routed to wake-class/);
    expect(warnings![0]).toMatch(/@session/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// (3) END-TO-END — MCP /rpc → execute_skill → connector receives wake()
// ────────────────────────────────────────────────────────────────────────

describe("v0.18.5 e2e — MCP execute_skill with address-routed notify", () => {
  it("skill stored + executed via MCP routes @session to wake() on the substrate", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0185-mcp-"));
    try {
      const skillStore = new FilesystemSkillStore(join(home, "skills"));
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      const registry = new Registry();
      registry.registerSkillStore("primary", skillStore);
      const conn = new RecordingConnector(["cc", "perry"]);
      await registry.registerAgentConnector("primary", conn);
      const scheduler = new Scheduler({ registry, skillStore, traceStore });
      const server = new McpServer({ skillStore, scheduler, traceStore, registry });

      const writeReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "skill_write",
          arguments: {
            name: "wake-cc-session",
            source: `# Skill: wake-cc-session
# Status: Approved
# Description: address-routed wake
m:
    notify(agent="cc@kitchen-terminal", message="look here")
default: m
`,
          },
        },
      };
      await server.handle(writeReq, { callerIdentity: "alice" });

      const execReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "execute_skill", arguments: { name: "wake-cc-session" } },
      };
      await server.handle(execReq, { callerIdentity: "alice" });

      // The substrate received wake(), not deliver()
      expect(conn.wakes.length).toBe(1);
      expect(conn.delivers.length).toBe(0);
      expect(conn.wakes[0]!.agent_id).toBe("cc@kitchen-terminal");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
