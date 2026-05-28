// `skillscript-runtime/connectors` entry point. Adapter authors implementing
// custom substrate backings import the connector contracts from here:
//
//   import { type SkillStore, type MemoryStore } from "skillscript-runtime/connectors";
//   class MySkillStore implements SkillStore { ... }
//
// Bundled reference implementations (FilesystemSkillStore, OllamaLocalModel,
// SqliteMemoryStore, CallbackMcpConnector) are also re-exported for embedders
// who want a one-import wiring path.

export type {
  SkillStore,
  SkillStoreClass,
  SkillSource,
  SkillMeta,
  SkillStatus,
  SkillFilter,
  VersionInfo,
  MemoryStore,
  MemoryStoreClass,
  PortableMemory,
  QueryFilters,
  LocalModel,
  LocalModelClass,
  McpConnector,
  McpConnectorClass,
  McpDispatchCtx,
  StaticCapabilities,
  ManifestInfo,
  ConnectorType,
  CuratedMemoryField,
} from "./types.js";
export { CURATED_MEMORY_FIELDS } from "./types.js";

export type {
  AgentConnector,
  AgentConnectorClass,
  AgentDescriptor,
  AgentStatus,
  DeliveryPayload,
  DeliveryReceipt,
  WakeOpts,
  WakeReceipt,
} from "./agent.js";

export { Registry } from "./registry.js";

export { FilesystemSkillStore } from "./skill-store.js";
export { SqliteSkillStore } from "./sqlite-skill-store.js";
export type { SqliteSkillStoreConfig } from "./sqlite-skill-store.js";
export { OllamaLocalModel } from "./local-model.js";
export type { OllamaConfig } from "./local-model.js";
export { SqliteMemoryStore } from "./memory-store.js";
export type { SqliteMemoryStoreConfig } from "./memory-store.js";
export { CallbackMcpConnector } from "./mcp.js";
export type { DispatchFn } from "./mcp.js";
export { NoOpAgentConnector } from "./agent-noop.js";

// v0.7.2 — typed-contract → MCP bridge classes. Wrap LocalModel /
// MemoryStore impls as McpConnector for canonical `$ llm` / `$ memory`
// dispatch surfaces.
export { LocalModelMcpConnector } from "./local-model-mcp.js";
export { MemoryStoreMcpConnector } from "./memory-store-mcp.js";

// v0.7.3 — adopter-extensible connector class registry. Adopters with a
// custom `McpConnector` class that's JSON-instantiable via `connectors.json`
// call `registerConnectorClass(name, entry)` from their bootstrap BEFORE
// `loadConnectorsConfig` runs. Closes the merge-conflict bait of editing
// the bundled `KNOWN_CONNECTOR_CLASSES` directly.
export {
  registerConnectorClass,
  unregisterConnectorClass,
  getConnectorClass,
  listKnownConnectorClasses,
  loadConnectorsConfig,
} from "./config.js";
export type {
  ConnectorClassEntry,
  ConfiguredConnector,
  LoadConnectorsConfigOpts,
  LoadConnectorsConfigResult,
  SubstrateChoice,
  SubstrateConfig,
} from "./config.js";
