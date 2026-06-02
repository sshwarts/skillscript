// `skillscript-runtime/connectors` entry point. Adapter authors implementing
// custom substrate backings import the connector contracts from here:
//
//   import { type SkillStore, type DataStore } from "skillscript-runtime/connectors";
//   class MySkillStore implements SkillStore { ... }
//
// Bundled reference implementations (FilesystemSkillStore, SqliteSkillStore,
// SqliteDataStore, OllamaLocalModel, CallbackMcpConnector) are also
// re-exported for embedders who want a one-import wiring path. v0.10 base
// config: SkillStore = filesystem, DataStore = sqlite, LocalModel = null;
// see docs/configuration.md for substrate selection via connectors.json.

export type {
  SkillStore,
  SkillStoreClass,
  SkillSource,
  SkillMeta,
  SkillStatus,
  SkillFilter,
  VersionInfo,
  DataStore,
  DataStoreClass,
  PortableData,
  QueryFilters,
  DataWrite,
  DataWriteRecord,
  LocalModel,
  LocalModelClass,
  McpConnector,
  McpConnectorClass,
  McpDispatchCtx,
  StaticCapabilities,
  ManifestInfo,
  ConnectorType,
  CuratedDataField,
  // v0.13.7 — per-kind Capabilities interfaces. Fork templates (e.g.
  // examples/connectors/SkillStoreTemplate/) need these to declare what their
  // impl supports. Were previously not re-exported, forcing template imports
  // to dig into `../../../src/connectors/types.js` — a path that doesn't
  // resolve from `node_modules` after install. Phase 2 dogfood finding.
  SkillStoreCapabilities,
  DataStoreCapabilities,
  LocalModelCapabilities,
  McpConnectorCapabilities,
  AgentConnectorCapabilities,
  // Per-kind Manifest interfaces — adopters returning `ManifestInfo<K>` from
  // their connector's `manifest()` need the typed payload shape.
  SkillStoreManifest,
  DataStoreManifest,
  LocalModelManifest,
  McpConnectorManifest,
} from "./types.js";
export { CURATED_DATA_FIELDS, VALID_SKILL_STATUSES, isSkillStatus } from "./types.js";

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
export { SqliteDataStore } from "./data-store.js";
export type { SqliteDataStoreConfig } from "./data-store.js";
export { CallbackMcpConnector } from "./mcp.js";
export type { DispatchFn } from "./mcp.js";
// v0.16.5 — bundled generic HTTP MCP connector (Streamable HTTP transport).
// Adopters declare instances via connectors.json (`class: "HttpMcpConnector"`).
export { HttpMcpConnector } from "./http-mcp.js";
export type { HttpMcpConfig } from "./http-mcp.js";
export { NoOpAgentConnector } from "./agent-noop.js";

// v0.7.2 — typed-contract → MCP bridge classes. Wrap LocalModel /
// DataStore impls as McpConnector for canonical `$ llm` / `$ data_read`
// dispatch surfaces.
export { LocalModelMcpConnector } from "./local-model-mcp.js";
export { DataStoreMcpConnector } from "./data-store-mcp.js";
// v0.15.0 — SkillStore-as-bridge. Makes `$ skill_write` / `$ skill_read` /
// `$ skill_delete` work as in-skill dispatch. Closes substrate-symmetry
// asymmetry with DataStoreMcpConnector. See src/connectors/skill-store-mcp.ts.
export { SkillStoreMcpConnector } from "./skill-store-mcp.js";

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
