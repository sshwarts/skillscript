// `skillscript-runtime/connectors` entry point. Adapter authors implementing
// custom substrate backings import the connector contracts from here:
//
//   import { type SkillStore, type MemoryStore } from "skillscript-runtime/connectors";
//   class MySkillStore implements SkillStore { ... }
//
// Bundled reference implementations (FilesystemSkillStore, SqliteSkillStore,
// SqliteMemoryStore, OllamaLocalModel, CallbackMcpConnector) are also
// re-exported for embedders who want a one-import wiring path. v0.10 base
// config: SkillStore = filesystem, MemoryStore = sqlite, LocalModel = null;
// see docs/configuration.md for substrate selection via connectors.json.

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
  // v0.13.7 — per-kind Capabilities interfaces. Fork templates (e.g.
  // examples/connectors/SkillStoreTemplate/) need these to declare what their
  // impl supports. Were previously not re-exported, forcing template imports
  // to dig into `../../../src/connectors/types.js` — a path that doesn't
  // resolve from `node_modules` after install. Phase 2 dogfood finding.
  SkillStoreCapabilities,
  MemoryStoreCapabilities,
  LocalModelCapabilities,
  McpConnectorCapabilities,
  AgentConnectorCapabilities,
  // Per-kind Manifest interfaces — adopters returning `ManifestInfo<K>` from
  // their connector's `manifest()` need the typed payload shape.
  SkillStoreManifest,
  MemoryStoreManifest,
  LocalModelManifest,
  McpConnectorManifest,
} from "./types.js";
export { CURATED_MEMORY_FIELDS, VALID_SKILL_STATUSES, isSkillStatus } from "./types.js";

export type {
  AgentConnector,
  AgentConnectorClass,
  AgentDescriptor,
  AgentStatus,
  DeliveryPayload,
  DeliveryReceipt,
  DeliveryMeta,
  RequestResponseOpts,
  Response,
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
