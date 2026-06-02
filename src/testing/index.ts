// `skillscript-runtime/testing` entry point. ContractConformance suites for
// the four connector contracts. Imported by impl authors writing conformance
// tests against their substrate; not part of the runtime hot path.

export {
  SkillStoreConformance,
  DataStoreConformance,
  LocalModelConformance,
  McpConnectorConformance,
  AgentConnectorConformance,
  // v0.16.5 — discovery-surface conformance for runtime_capabilities.
  // Validates the 3-state manifest schema (v0.16.3) + orchestrates
  // adopter-supplied flag → execution-path probes. Closes the
  // discipline-only-contracts pattern per Perry's adf47c0b.
  RuntimeCapabilitiesConformance,
} from "./conformance.js";

export type {
  ConformanceTest,
  ConformanceCategory,
  SkillStoreFixture,
  DataStoreFixture,
  LocalModelFixture,
  McpConnectorFixture,
  AgentConnectorFixture,
  RuntimeCapabilitiesFixture,
  RuntimeCapabilitiesFixtureRuntime,
  RuntimeCapabilityProbe,
} from "./conformance.js";
