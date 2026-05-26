import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parse } from "../src/parser.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentConnector,
  AgentDescriptor,
  DeliveryPayload,
  DeliveryReceipt,
  WakeOpts,
  WakeReceipt,
  ManifestInfo,
  StaticCapabilities,
} from "../src/connectors/agent.js";

// v0.8.0 — notify() runtime-intrinsic op per the locked design (`42a0cc41`,
// `bb34de4e`). Mid-skill synchronous alert via wired AgentConnector(s).
// Default behavior: message kwarg defaults to joined accumulated emissions;
// fan-out to all wired AgentConnectors claiming the agent in list_agents();
// best-effort failure (per-connector errors recorded in ACK, not propagated).

class FakeAgentConnector implements AgentConnector {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "agent_connector",
      implementation: "FakeAgentConnector",
      contract_version: "1.0.0",
      features: {},
    };
  }
  public delivered: Array<{ agent_id: string; payload: DeliveryPayload }> = [];
  public failOnAgent?: string;
  constructor(private readonly knownAgents: string[]) {}
  async list_agents(): Promise<AgentDescriptor[]> {
    return this.knownAgents.map((agent_id) => ({ agent_id, capabilities: ["deliver"] as const }));
  }
  async deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt> {
    if (this.failOnAgent === agent_id) throw new Error(`simulated delivery failure for ${agent_id}`);
    this.delivered.push({ agent_id, payload });
    return { delivered_at: Date.now() };
  }
  async wake(agent_id: string, _opts?: WakeOpts): Promise<WakeReceipt> {
    return { woken_at: Date.now(), session_id: `wake:${agent_id}` };
  }
  async manifest(): Promise<ManifestInfo> {
    return { capabilities_version: "1", manifest: { kind: "fake-agent-connector" } };
  }
}

describe("v0.8.0 — notify() runtime-intrinsic op", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "v080-notify-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("parses notify(agent='X', message='...') as a runtime-intrinsic op", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    notify(agent="oncall", message="urgent")\ndefault: run\n`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    const ops = p.targets.get("run")!.ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("notify");
    expect(ops[0]!.notifyParams).toEqual({ agent: "oncall", message: "urgent" });
  });

  it("parses notify with connectors=[\"webhook\",\"tmux\"] restriction list", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    notify(agent="oncall", message="urgent", connectors=["webhook","tmux"])\ndefault: run\n`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    expect(p.targets.get("run")!.ops[0]!.notifyParams).toEqual({
      agent: "oncall",
      message: "urgent",
      connectors: ["webhook", "tmux"],
    });
  });

  it("rejects malformed connectors kwarg (non-JSON-array)", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    notify(agent="oncall", connectors="not-an-array")\ndefault: run\n`;
    const p = parse(src);
    expect(p.parseErrors.length).toBeGreaterThan(0);
    expect(p.parseErrors[0]).toMatch(/connectors=/);
  });

  it("dispatches to AgentConnector that claims the agent in list_agents()", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const fake = new FakeAgentConnector(["oncall"]);
    wired.registry.registerAgentConnector("primary", fake);

    const src = `# Skill: t\n# Status: Approved\nrun:\n    notify(agent="oncall", message="urgent alert") -> ACK\n    emit(text="dispatched")\ndefault: run\n`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(result.errors).toEqual([]);
    expect(fake.delivered).toHaveLength(1);
    expect(fake.delivered[0]!.agent_id).toBe("oncall");
    expect(fake.delivered[0]!.payload.kind).toBe("augment");
    expect((fake.delivered[0]!.payload as { content: string }).content).toBe("urgent alert");
  });

  it("defaults message to joined accumulated emissions when message kwarg absent", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const fake = new FakeAgentConnector(["X"]);
    wired.registry.registerAgentConnector("primary", fake);

    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="line one")\n    emit(text="line two")\n    notify(agent="X")\ndefault: run\n`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(result.errors).toEqual([]);
    expect(fake.delivered).toHaveLength(1);
    expect((fake.delivered[0]!.payload as { content: string }).content).toBe("line one\nline two");
  });

  it("skips AgentConnectors that don't claim the target agent", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const claimsX = new FakeAgentConnector(["X"]);
    const claimsY = new FakeAgentConnector(["Y"]);
    wired.registry.registerAgentConnector("primary", claimsX);
    wired.registry.registerAgentConnector("secondary", claimsY);

    const src = `# Skill: t\n# Status: Approved\nrun:\n    notify(agent="X", message="hi")\ndefault: run\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(claimsX.delivered).toHaveLength(1);
    expect(claimsY.delivered).toHaveLength(0);
  });

  it("connectors=[...] restricts the fan-out to a named subset", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const c1 = new FakeAgentConnector(["X"]);
    const c2 = new FakeAgentConnector(["X"]);
    wired.registry.registerAgentConnector("webhook", c1);
    wired.registry.registerAgentConnector("tmux", c2);

    const src = `# Skill: t\n# Status: Approved\nrun:\n    notify(agent="X", message="hi", connectors=["webhook"])\ndefault: run\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(c1.delivered).toHaveLength(1);
    expect(c2.delivered).toHaveLength(0);
  });

  it("returns structured ACK with per-connector dispatched record", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const c1 = new FakeAgentConnector(["X"]);
    const c2 = new FakeAgentConnector(["X"]);
    wired.registry.registerAgentConnector("webhook", c1);
    wired.registry.registerAgentConnector("tmux", c2);

    const src = `# Skill: t\n# Status: Approved\nrun:\n    notify(agent="X", message="hi") -> ACK\n    emit(text="connectors: \${ACK.dispatched|length}")\ndefault: run\n`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe("connectors: 2");
  });

  it("best-effort: per-connector failure recorded in ACK, doesn't error the op", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const c1 = new FakeAgentConnector(["X"]);
    const c2 = new FakeAgentConnector(["X"]);
    c2.failOnAgent = "X";
    wired.registry.registerAgentConnector("webhook", c1);
    wired.registry.registerAgentConnector("tmux", c2);

    const src = `# Skill: t\n# Status: Approved\nrun:\n    notify(agent="X", message="hi") -> ACK\ndefault: run\n`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    // Best-effort: skill succeeds even though one connector failed.
    expect(result.errors).toEqual([]);
    // Successful connector dispatched; failing one did not.
    expect(c1.delivered).toHaveLength(1);
    expect(c2.delivered).toHaveLength(0);
  });

  it("agent kwarg resolves \${VAR} substitution at runtime", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const fake = new FakeAgentConnector(["dynamic-target"]);
    wired.registry.registerAgentConnector("primary", fake);

    const src = `# Skill: t\n# Status: Approved\n# Vars: TARGET_AGENT=dynamic-target\nrun:\n    notify(agent="\${TARGET_AGENT}", message="hi")\ndefault: run\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(fake.delivered).toHaveLength(1);
    expect(fake.delivered[0]!.agent_id).toBe("dynamic-target");
  });

  it("notify() between emits: captures emissions-so-far when message absent", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const fake = new FakeAgentConnector(["X"]);
    wired.registry.registerAgentConnector("primary", fake);

    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="before notify")\n    notify(agent="X")\n    emit(text="after notify")\ndefault: run\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    // Mid-skill notify captures emissions-so-far (just "before notify");
    // "after notify" emits AFTER the notify call and is not retroactively
    // delivered. This is the documented "synchronous mid-skill fire" semantic.
    expect(fake.delivered).toHaveLength(1);
    expect((fake.delivered[0]!.payload as { content: string }).content).toBe("before notify");
  });
});
