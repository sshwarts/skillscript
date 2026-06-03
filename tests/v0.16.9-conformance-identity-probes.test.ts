import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { HttpMcpConnector } from "../src/connectors/http-mcp.js";
import { RuntimeCapabilitiesConformance } from "../src/testing/conformance.js";
import type {
  RuntimeCapabilitiesFixture,
  RuntimeCapabilitiesFixtureRuntime,
} from "../src/testing/conformance.js";

/**
 * v0.16.9 item 3 — RuntimeCapabilitiesConformance auto-coverage for
 * `supports_identity_propagation` Level 1 + Level 2 probes.
 *
 * Closes the structural-honesty gate per Perry's `9af842f7` charter +
 * `33fefa0f` ack: declaring the flag without execution-path probes is a
 * discipline-only-contract instance. Adopters wire identity-propagation
 * probes via `flagProbes` keyed by
 * `mcpConnectors.<name>.supports_identity_propagation.{level1,level2}`.
 *
 * Sibling probe shape to v0.16.5's `requiredFlags`/`flagProbes` mechanism;
 * fires automatically when ANY connector declares the flag true.
 */

function buildFixtureWithHttpConnector(): RuntimeCapabilitiesFixture {
  return {
    buildRuntime: async (): Promise<RuntimeCapabilitiesFixtureRuntime> => {
      const home = mkdtempSync(join(tmpdir(), "v0169-id-probe-"));
      const wired = bootstrap({
        skillsDir: join(home, "skills"),
        traceDir: join(home, "traces"),
        dataDbPath: join(home, "data.db"),
      });
      // Register HttpMcpConnector — bare endpoint, never called by the
      // schema-shape probe; only its `staticCapabilities()` is read.
      wired.registry.registerMcpConnector(
        "external_mcp",
        new HttpMcpConnector({ endpoint: "http://127.0.0.1:0/", identityHeader: "X-Agent-Id" }),
      );
      return { mcpServer: wired.mcpServer };
    },
  };
}

describe("v0.16.9 — auto-coverage probe for supports_identity_propagation", () => {
  it("FAILS when a connector declares the flag without Level 1 + Level 2 probes (the load-bearing close)", async () => {
    const fixture = buildFixtureWithHttpConnector();
    const tests = RuntimeCapabilitiesConformance.buildTests(fixture);
    const autoCoverageTest = tests.find((t) => t.name.startsWith("auto-coverage:"));
    expect(autoCoverageTest).toBeDefined();
    await expect(autoCoverageTest!.run()).rejects.toThrow(
      /supports_identity_propagation: true.*Level 1\/2 probes are missing.*external_mcp/s,
    );
  });

  it("PASSES when both Level 1 + Level 2 probes are supplied via flagProbes", async () => {
    let l1Ran = false;
    let l2Ran = false;
    const base = buildFixtureWithHttpConnector();
    const fixture: RuntimeCapabilitiesFixture = {
      ...base,
      flagProbes: {
        "mcpConnectors.external_mcp.supports_identity_propagation.level1": async () => {
          l1Ran = true;
        },
        "mcpConnectors.external_mcp.supports_identity_propagation.level2": async () => {
          l2Ran = true;
        },
      },
    };
    const tests = RuntimeCapabilitiesConformance.buildTests(fixture);
    for (const t of tests) await t.run();
    expect(l1Ran).toBe(true);
    expect(l2Ran).toBe(true);
  });

  it("FAILS specifically when only Level 1 is wired (Level 2 gap — the false-positive scenario)", async () => {
    // Per warm-adopter's `1e1c9305`: per-call-header connectors against
    // session-pinning substrates pass Level 1 (header reaches transport)
    // but silently fail Level 2 (substrate observes pinned identity, not
    // ctx.agentId). The auto-coverage probe must catch this gap.
    const base = buildFixtureWithHttpConnector();
    const fixture: RuntimeCapabilitiesFixture = {
      ...base,
      flagProbes: {
        "mcpConnectors.external_mcp.supports_identity_propagation.level1": async () => {
          // Naive adopter wires Level 1 only.
        },
      },
    };
    const tests = RuntimeCapabilitiesConformance.buildTests(fixture);
    const autoCoverageTest = tests.find((t) => t.name.startsWith("auto-coverage:"));
    expect(autoCoverageTest).toBeDefined();
    await expect(autoCoverageTest!.run()).rejects.toThrow(/level2/);
  });

  it("PASSES vacuously when no connector declares supports_identity_propagation: true", async () => {
    // Bare bootstrap fixture — bundled connectors (llm, data_*, skill_*)
    // are intra-runtime bridges; none declare the flag.
    const fixture: RuntimeCapabilitiesFixture = {
      buildRuntime: async () => {
        const home = mkdtempSync(join(tmpdir(), "v0169-id-probe-vac-"));
        const wired = bootstrap({
          skillsDir: join(home, "skills"),
          traceDir: join(home, "traces"),
          dataDbPath: join(home, "data.db"),
        });
        return { mcpServer: wired.mcpServer };
      },
    };
    const tests = RuntimeCapabilitiesConformance.buildTests(fixture);
    const autoCoverageTest = tests.find((t) => t.name.startsWith("auto-coverage:"));
    expect(autoCoverageTest).toBeDefined();
    // Should pass — nothing to gate.
    await autoCoverageTest!.run();
  });
});
