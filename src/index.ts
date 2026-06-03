// Library entrypoint. Embedders use named exports:
//
//   import { compile, execute, lint, parse, Registry } from "skillscript-runtime";
//   import { FilesystemSkillStore, OllamaLocalModel, SqliteDataStore, CallbackMcpConnector }
//     from "skillscript-runtime";
//
// T1 ships parse + compile + lint + execute against the bundled-default
// connectors. Trigger registration, MCP server contract, richer compile-time
// semantics, and the full v1 lint set land in later threads (see
// ARCHITECTURE.md "Out-of-scope for T1").

export { parse, tokenizeKeywordArgs, processSetValue } from "./parser.js";
export { toposort } from "./compile.js";
export { applyFilter } from "./filters.js";
export type {
  ParsedSkill,
  SkillOp,
  OpKind,
  SkillTarget,
  SkillType,
  SkillVar,
  SkillRequire,
  TriggerDecl,
  TriggerSource,
  OutputDecl,
  OutputKind,
} from "./parser.js";

export { compile } from "./compile.js";
export type { CompileOptions, CompileResult, RenderFormat, RequireResolver, InlinedDataSkillRef } from "./compile.js";
export {
  buildProvenance,
  renderInlineProvenance,
  renderSidecarProvenance,
  PROVENANCE_VERSION,
  LANGUAGE_VERSION,
  COMPILER_VERSION,
} from "./provenance.js";
export type { ProvenanceBlock, SourceSkillRef, BuildProvenanceInput } from "./provenance.js";

export { lint } from "./lint.js";
export type { LintFinding, LintResult, LintSeverity } from "./lint.js";

export {
  execute,
  substituteRuntime,
  resolveRef,
  stringifyValue,
  evalCondition,
} from "./runtime.js";
export type { ExecuteContext, ExecuteResult, ExecutionError } from "./runtime.js";

export { Registry } from "./connectors/registry.js";

export { FilesystemSkillStore } from "./connectors/skill-store.js";
export { SqliteSkillStore } from "./connectors/sqlite-skill-store.js";
export type { SqliteSkillStoreConfig } from "./connectors/sqlite-skill-store.js";
export { OllamaLocalModel } from "./connectors/local-model.js";
export type { OllamaConfig } from "./connectors/local-model.js";
export { SqliteDataStore } from "./connectors/data-store.js";
export type { SqliteDataStoreConfig } from "./connectors/data-store.js";
export { CallbackMcpConnector } from "./connectors/mcp.js";
export type { DispatchFn } from "./connectors/mcp.js";
export { HttpMcpConnector } from "./connectors/http-mcp.js";
export type { HttpMcpConfig } from "./connectors/http-mcp.js";
export { LocalModelMcpConnector } from "./connectors/local-model-mcp.js";
export { DataStoreMcpConnector } from "./connectors/data-store-mcp.js";
export { SkillStoreMcpConnector } from "./connectors/skill-store-mcp.js";
export { NoOpAgentConnector } from "./connectors/agent-noop.js";
export type {
  AgentConnector,
  AgentConnectorClass,
  AgentDescriptor,
  AgentStatus,
  DeliveryPayload,
  DeliveryReceipt,
  WakeOpts,
  WakeReceipt,
} from "./connectors/agent.js";

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
  LocalModel,
  LocalModelClass,
  McpConnector,
  McpConnectorClass,
  McpDispatchCtx,
  StaticCapabilities,
  ManifestInfo,
  ConnectorType,
  CuratedDataField,
} from "./connectors/types.js";
export { CURATED_DATA_FIELDS } from "./connectors/types.js";

// v0.7.3 — canonical runtime config + adopter-extensible connector class registration.
export { loadSkillscriptConfig } from "./runtime-config.js";
export type { SkillscriptConfig, LoadSkillscriptConfigOpts, LoadSkillscriptConfigResult } from "./runtime-config.js";

// Bootstrap helpers (v0.7.3+ public): adopters wiring custom substrates import
// `Registry` + the connector classes + `wireDeclarativeTriggers`. The bundled
// `bootstrap()` is a reference implementation for default deployments — see
// `examples/onboarding-scaffold/bootstrap.ts` for a custom-substrate walkthrough.
export { bootstrap, defaultRegistry, wireDeclarativeTriggers } from "./bootstrap.js";
export type { BootstrapOpts, BootstrapResult, DefaultRegistryOpts } from "./bootstrap.js";
export {
  registerConnectorClass,
  unregisterConnectorClass,
  getConnectorClass,
  listKnownConnectorClasses,
  loadConnectorsConfig,
} from "./connectors/config.js";
export type {
  ConnectorClassEntry,
  ConfiguredConnector,
  LoadConnectorsConfigOpts,
  LoadConnectorsConfigResult,
} from "./connectors/config.js";

export {
  ConnectorError,
  SkillNotFoundError,
  VersionNotFoundError,
  LintFailureError,
  StorageConflictError,
  QueryError,
  DispatchError,
  ModelError,
  TimeoutError,
  OpError,
  ConnectorNotFoundError,
  OpTimeoutError,
  UnsafeShellDisabledError,
  UnresolvedVariableError,
  MissingSkillReferenceError,
  UnconfirmedMutationError,
  UnsupportedFilterError,
} from "./errors.js";
export type { LintDiagnostic, OpErrorMetadata } from "./errors.js";

export {
  ReferenceIndex,
  ReferentialIntegrityError,
  buildReferenceIndex,
  extractReferences,
  storeSkill,
  deleteSkill,
  invalidateConnector,
} from "./skill-manager.js";
export type { DeleteSkillOptions } from "./skill-manager.js";

export { audit, formatAuditResult } from "./audit.js";
export type { AuditResult, AuditFinding, AuditRule } from "./audit.js";

export { Scheduler, cronMatches } from "./scheduler.js";
export type { SchedulerConfig, TriggerRegistration, ResolvableTriggerSource } from "./scheduler.js";

export {
  FilesystemTraceStore,
  TraceBuilder,
  shouldSample,
  shouldTraceFire,
  TRACE_DEFAULTS,
} from "./trace.js";
export type {
  TraceStore,
  TraceConfig,
  TraceMode,
  TraceRecord,
  TraceOpRecord,
  TraceQueryFilter,
} from "./trace.js";

export { healthMetrics } from "./metrics.js";
export type {
  HealthMetrics,
  HealthMetricsFilter,
  PerSkillMetrics,
  PerConnectorMetrics,
} from "./metrics.js";

export { McpServer } from "./mcp-server.js";
export type {
  McpServerDeps,
  McpTool,
  McpRequestCtx,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
} from "./mcp-server.js";

export { DashboardServer } from "./dashboard/server.js";
export type { DashboardServerConfig } from "./dashboard/server.js";

// v0.9.0 — approval-gate surface for adopters wanting stronger threat models.
export {
  computeApprovalToken,
  verifyApprovalToken,
  evaluateApprovalGate,
  stampApprovalToken,
  registerApprovalFn,
  setPreferredApprovalVersion,
  getPreferredApprovalVersion,
  parseApprovalToken,
  registeredApprovalVersions,
  extractStatusFromBody,
} from "./approval.js";
export type { ApprovalToken, ApprovalVerification } from "./approval.js";
export { ApprovalRejectedError } from "./errors.js";
