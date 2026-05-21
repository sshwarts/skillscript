// `skillscript-runtime/testing` entry point. ContractConformance suites for
// the four connector contracts. Imported by impl authors writing conformance
// tests against their substrate; not part of the runtime hot path.

export {
  SkillStoreConformance,
  MemoryStoreConformance,
  LocalModelConformance,
  McpConnectorConformance,
  AgentConnectorConformance,
} from "./conformance.js";

export type {
  ConformanceTest,
  ConformanceCategory,
  SkillStoreFixture,
  MemoryStoreFixture,
  LocalModelFixture,
  McpConnectorFixture,
  AgentConnectorFixture,
} from "./conformance.js";
