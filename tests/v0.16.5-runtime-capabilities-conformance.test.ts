import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { NoOpAgentConnector } from "../src/connectors/agent-noop.js";
import { RuntimeCapabilitiesConformance } from "../src/testing/conformance.js";
import type { RuntimeCapabilitiesFixture, RuntimeCapabilitiesFixtureRuntime } from "../src/testing/conformance.js";

/**
 * v0.16.5 — RuntimeCapabilitiesConformance integration tests.
 *
 * Validates the conformance suite itself by wiring it against the bundled
 * `bootstrap()` runtime. This is the "the fixture validates the runtime
 * AND we validate the fixture" loop.
 *
 * The suite is intended for adopter use: a fork-template author writing a
 * custom McpConnector + custom DataStore wires the suite against their
 * runtime, gets schema validation + flag-probe orchestration for free.
 * Closes Perry's `adf47c0b` discipline-only-contracts pattern.
 */

function buildBootstrapFixture(): RuntimeCapabilitiesFixture {
  return {
    buildRuntime: async (): Promise<RuntimeCapabilitiesFixtureRuntime> => {
      const home = mkdtempSync(join(tmpdir(), "v0165-cap-conf-"));
      const wired = bootstrap({
        skillsDir: join(home, "skills"),
        traceDir: join(home, "traces"),
        dataDbPath: join(home, "data.db"),
      });
      await wired.registry.registerAgentConnector("noop", new NoOpAgentConnector());
      return { mcpServer: wired.mcpServer };
    },
  };
}

describe("v0.16.5 — RuntimeCapabilitiesConformance against bundled bootstrap", () => {
  const fixture = buildBootstrapFixture();
  const tests = RuntimeCapabilitiesConformance.buildTests(fixture);

  for (const t of tests) {
    it(`[${t.category}] ${t.name}`, t.run);
  }

  it("generates a stable minimum number of tests (schema-only fixture)", () => {
    // 6 schema tests when no probes/required-flags supplied.
    expect(tests.length).toBe(6);
  });
});

describe("v0.16.5 — RuntimeCapabilitiesConformance with flag probes + required-flags coverage", () => {
  it("runs each provided probe + verifies required-flag coverage", async () => {
    let probeRan = false;
    const fixture: RuntimeCapabilitiesFixture = {
      ...buildBootstrapFixture(),
      flagProbes: {
        "shellExecution.unsafe_enabled": async () => {
          // Adopter-side probe: would test that unsafe shell ops respect
          // the unsafe_enabled config. For this fixture-validation test,
          // just record that the probe was invoked.
          probeRan = true;
        },
      },
      requiredFlags: ["shellExecution.unsafe_enabled"],
    };

    const tests = RuntimeCapabilitiesConformance.buildTests(fixture);
    // 6 schema + 1 probe + 1 coverage = 8 total.
    expect(tests.length).toBe(8);

    for (const t of tests) await t.run();
    expect(probeRan).toBe(true);
  });

  it("coverage test FAILS when a required flag has no probe (the load-bearing close)", async () => {
    const fixture: RuntimeCapabilitiesFixture = {
      ...buildBootstrapFixture(),
      flagProbes: {
        "shellExecution.unsafe_enabled": async () => { /* noop probe */ },
      },
      requiredFlags: ["shellExecution.unsafe_enabled", "shellExecution.mode"],
    };

    const tests = RuntimeCapabilitiesConformance.buildTests(fixture);
    const coverageTest = tests.find((t) => t.name.startsWith("coverage:"));
    expect(coverageTest).toBeDefined();

    await expect(coverageTest!.run()).rejects.toThrow(/shellExecution\.mode/);
  });

  it("no coverage test when requiredFlags is empty (only schema + per-probe tests)", () => {
    const fixture: RuntimeCapabilitiesFixture = {
      ...buildBootstrapFixture(),
      flagProbes: {
        "shellExecution.unsafe_enabled": async () => { /* noop */ },
      },
    };

    const tests = RuntimeCapabilitiesConformance.buildTests(fixture);
    expect(tests.some((t) => t.name.startsWith("coverage:"))).toBe(false);
    // 6 schema + 1 probe + 0 coverage = 7 total.
    expect(tests.length).toBe(7);
  });
});
