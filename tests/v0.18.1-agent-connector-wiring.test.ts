import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { loadConnectorsConfig } from "../src/connectors/config.js";
import { NoOpAgentConnector } from "../src/connectors/agent-noop.js";
import type { AgentConnector, AgentDescriptor, DeliveryPayload, DeliveryReceipt, WakeOpts, WakeReceipt } from "../src/connectors/agent.js";

/**
 * v0.18.1 — AgentConnector declarative-wiring symmetry.
 *
 * Closes the gap where AgentConnector was programmatic-only while
 * SkillStore/DataStore/LocalModel had `connectors.json` substrate
 * support. Adds:
 *   - `agent_connector` slot in SubstrateConfig
 *   - `agentConnector?: AgentConnector` in BootstrapOpts
 *   - `"noop"` + `"custom"` built-in types (custom blocked by sync-bootstrap,
 *     same constraint as the other slots)
 */

class FakeAgentConnector implements AgentConnector {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  constructor() {}
  async list_agents(): Promise<AgentDescriptor[]> {
    return [{ id: "fake-agent", connector_kind: "fake" }];
  }
  async deliver(_agent: string, _payload: DeliveryPayload): Promise<DeliveryReceipt> {
    return { delivered_at_ms: Date.now(), connector_kind: "fake" };
  }
  async wake(_agent: string, _opts?: WakeOpts): Promise<WakeReceipt> {
    return { woken_at_ms: Date.now(), connector_kind: "fake" };
  }
  async health_check(): Promise<boolean> {
    return true;
  }
  async request_response(): Promise<never> {
    throw new Error("not implemented in fake");
  }
}

describe("v0.18.1 — AgentConnector via connectors.json substrate", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "v0181-agent-"));
    configPath = join(tmpDir, "connectors.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses substrate.agent_connector: \"noop\" (short form)", () => {
    writeFileSync(configPath, JSON.stringify({ substrate: { agent_connector: "noop" } }));
    const result = loadConnectorsConfig({ path: configPath });
    expect(result.errors).toEqual([]);
    expect(result.substrate?.agent_connector).toEqual({ type: "noop" });
  });

  it("parses substrate.agent_connector: { type: \"noop\" } (object form)", () => {
    writeFileSync(configPath, JSON.stringify({ substrate: { agent_connector: { type: "noop", config: { foo: "bar" } } } }));
    const result = loadConnectorsConfig({ path: configPath });
    expect(result.errors).toEqual([]);
    expect(result.substrate?.agent_connector).toEqual({ type: "noop", config: { foo: "bar" } });
  });

  it("parses substrate.agent_connector: null as explicit \"no agent connector\"", () => {
    writeFileSync(configPath, JSON.stringify({ substrate: { agent_connector: null } }));
    const result = loadConnectorsConfig({ path: configPath });
    expect(result.errors).toEqual([]);
    expect(result.substrate?.agent_connector).toBeNull();
  });

  it("rejects unknown agent_connector type", () => {
    writeFileSync(configPath, JSON.stringify({ substrate: { agent_connector: "magic" } }));
    const result = loadConnectorsConfig({ path: configPath });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/agent_connector.*unknown type 'magic'/);
  });

  it("rejects custom-as-short-form (must use object form with module)", () => {
    writeFileSync(configPath, JSON.stringify({ substrate: { agent_connector: "custom" } }));
    const result = loadConnectorsConfig({ path: configPath });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/'custom' requires object form/);
  });

  it("accepts custom object form at parse time (instantiation deferred)", () => {
    writeFileSync(configPath, JSON.stringify({
      substrate: { agent_connector: { type: "custom", module: "./my-agent.js", export: "MyAgentConnector", config: { x: 1 } } },
    }));
    const result = loadConnectorsConfig({ path: configPath });
    expect(result.errors).toEqual([]);
    expect(result.substrate?.agent_connector).toEqual({
      type: "custom",
      module: "./my-agent.js",
      export: "MyAgentConnector",
      config: { x: 1 },
    });
  });
});

describe("v0.18.1 — bootstrap wires AgentConnector from substrate + BootstrapOpts", () => {
  let home: string;
  let configPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0181-boot-"));
    configPath = join(home, "connectors.json");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("BootstrapOpts.agentConnector — explicit instance registered as primary", async () => {
    const fake = new FakeAgentConnector();
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      agentConnector: fake,
    });
    // Wait a tick for the async registerAgentConnector to complete.
    await new Promise((r) => setImmediate(r));
    expect(wired.registry.hasAgentConnector("primary")).toBe(true);
    expect(wired.registry.getAgentConnector("primary")).toBe(fake);
  });

  it("substrate.agent_connector: \"noop\" — NoOp instance registered as primary", async () => {
    writeFileSync(configPath, JSON.stringify({ substrate: { agent_connector: "noop" } }));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      connectorsConfigPath: configPath,
    });
    await new Promise((r) => setImmediate(r));
    expect(wired.registry.hasAgentConnector("primary")).toBe(true);
    expect(wired.registry.getAgentConnector("primary")).toBeInstanceOf(NoOpAgentConnector);
  });

  it("no slot declared — Registry falls back to NoOp via getAgentConnectorOrDefault", () => {
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
    });
    expect(wired.registry.hasAgentConnector("primary")).toBe(false);
    // getAgentConnectorOrDefault returns NoOp even without registration.
    expect(wired.registry.getAgentConnectorOrDefault("primary")).toBeInstanceOf(NoOpAgentConnector);
  });

  it("BootstrapOpts.agentConnector beats substrate.agent_connector (precedence: programmatic > declarative)", async () => {
    writeFileSync(configPath, JSON.stringify({ substrate: { agent_connector: "noop" } }));
    const fake = new FakeAgentConnector();
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      connectorsConfigPath: configPath,
      agentConnector: fake,
    });
    await new Promise((r) => setImmediate(r));
    // Programmatic opt wins — FakeAgentConnector registered, not NoOp.
    expect(wired.registry.getAgentConnector("primary")).toBe(fake);
  });

  it("custom type via connectors.json surfaces a clear error (sync bootstrap limitation)", () => {
    writeFileSync(configPath, JSON.stringify({
      substrate: { agent_connector: { type: "custom", module: "./does-not-exist.js", export: "Whatever", config: {} } },
    }));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      connectorsConfigPath: configPath,
    });
    expect(wired.connectorConfigErrors.length).toBeGreaterThan(0);
    expect(wired.connectorConfigErrors.join("\n")).toMatch(/agent_connector.*custom.*not yet supported/);
    // Custom type that errored doesn't register anything → falls back to NoOp.
    expect(wired.registry.getAgentConnectorOrDefault("primary")).toBeInstanceOf(NoOpAgentConnector);
  });
});
