import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { lint } from "../src/lint.js";
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

// v0.8.0 — tier-2 lint warns on `# Output: agent: X` / `template: X` mis-uses
// per Q4 lockdown.

class DummyAgent implements AgentConnector {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "agent_connector",
      implementation: "DummyAgent",
      contract_version: "1.0.0",
      features: {},
    };
  }
  async list_agents(): Promise<AgentDescriptor[]> { return [{ agent_id: "anyone" }]; }
  async deliver(_id: string, _payload: DeliveryPayload): Promise<DeliveryReceipt> { return { delivered_at: 0 }; }
  async wake(_id: string, _opts?: WakeOpts): Promise<WakeReceipt> { return { woken_at: 0 }; }
  async manifest(): Promise<ManifestInfo> { return { capabilities_version: "1", manifest: {} }; }
}

describe("v0.8.0 — tier-2 # Output: lint warns", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "v080-lint-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("warns when `# Output: agent: X` declared but skill has no emit() ops", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerAgentConnector("primary", new DummyAgent());

    const src = `# Skill: t\n# Status: Approved\n# Output: agent: oncall\nrun:\n    $set X = "no emit"\ndefault: run\n`;
    const result = await lint(src, { registry: wired.registry });
    const emitWarns = result.findings.filter((f) => f.rule === "output-agent-target-no-emit");
    expect(emitWarns).toHaveLength(1);
    expect(emitWarns[0]!.severity).toBe("warning");
    expect(emitWarns[0]!.message).toContain("agent: oncall");
    expect(emitWarns[0]!.message).toContain("no `emit()` ops");
  });

  it("warns when `# Output: template: X` declared but skill has no emit() ops", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerAgentConnector("primary", new DummyAgent());

    const src = `# Skill: t\n# Status: Approved\n# Output: template: assistant\nrun:\n    $set X = "no emit"\ndefault: run\n`;
    const result = await lint(src, { registry: wired.registry });
    const emitWarns = result.findings.filter((f) => f.rule === "output-agent-target-no-emit");
    expect(emitWarns).toHaveLength(1);
    expect(emitWarns[0]!.message).toContain("template: assistant");
  });

  it("does NOT warn when skill has emit() ops", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerAgentConnector("primary", new DummyAgent());

    const src = `# Skill: t\n# Status: Approved\n# Output: agent: oncall\nrun:\n    emit(text="hello")\ndefault: run\n`;
    const result = await lint(src, { registry: wired.registry });
    expect(result.findings.filter((f) => f.rule === "output-agent-target-no-emit")).toEqual([]);
  });

  it("warns when `# Output: agent: X` declared but no AgentConnector wired", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    // No AgentConnector registered — NoOp fallback would silently drop deliveries.

    const src = `# Skill: t\n# Status: Approved\n# Output: agent: oncall\nrun:\n    emit(text="hi")\ndefault: run\n`;
    const result = await lint(src, { registry: wired.registry });
    const connectorWarns = result.findings.filter((f) => f.rule === "output-agent-target-no-connector");
    expect(connectorWarns).toHaveLength(1);
    expect(connectorWarns[0]!.severity).toBe("warning");
    expect(connectorWarns[0]!.message).toContain("agent: oncall");
    expect(connectorWarns[0]!.message).toContain("no AgentConnector is wired");
  });

  it("does NOT warn (no-connector) when an AgentConnector IS wired", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerAgentConnector("primary", new DummyAgent());

    const src = `# Skill: t\n# Status: Approved\n# Output: agent: oncall\nrun:\n    emit(text="hi")\ndefault: run\n`;
    const result = await lint(src, { registry: wired.registry });
    expect(result.findings.filter((f) => f.rule === "output-agent-target-no-connector")).toEqual([]);
  });

  it("both warns fire together when declared + no emits + no connector", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });

    const src = `# Skill: t\n# Status: Approved\n# Output: agent: oncall\nrun:\n    $set X = "silent"\ndefault: run\n`;
    const result = await lint(src, { registry: wired.registry });
    expect(result.findings.filter((f) => f.rule === "output-agent-target-no-emit")).toHaveLength(1);
    expect(result.findings.filter((f) => f.rule === "output-agent-target-no-connector")).toHaveLength(1);
  });

  it("silent (no findings) when registry is not provided (caller can't know)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Output: agent: oncall\nrun:\n    emit(text="hi")\ndefault: run\n`;
    const result = await lint(src);
    expect(result.findings.filter((f) => f.rule === "output-agent-target-no-connector")).toEqual([]);
  });
});
