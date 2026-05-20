// Library entrypoint. Embedders use named exports:
//
//   import { compile, execute, lint, parse, Registry } from "skillscript-runtime";
//   import { FilesystemSkillStore, OllamaLocalModel, SqliteMemoryStore, CallbackMcpConnector }
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
  SkillVar,
  SkillRequire,
  TriggerDecl,
  TriggerSource,
  OutputDecl,
  OutputKind,
} from "./parser.js";

export { compile } from "./compile.js";
export type { CompileOptions, CompileResult, RenderFormat, RequireResolver } from "./compile.js";

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
export { OllamaLocalModel } from "./connectors/local-model.js";
export type { OllamaConfig } from "./connectors/local-model.js";
export { SqliteMemoryStore } from "./connectors/memory-store.js";
export type { SqliteMemoryStoreConfig } from "./connectors/memory-store.js";
export { CallbackMcpConnector } from "./connectors/mcp.js";
export type { DispatchFn } from "./connectors/mcp.js";

export type {
  SkillStore,
  SkillRecord,
  SkillSummary,
  MemoryStore,
  PortableMemory,
  QueryFilters,
  LocalModel,
  McpConnector,
  McpDispatchCtx,
  Capabilities,
  CuratedMemoryField,
} from "./connectors/types.js";
export { CURATED_MEMORY_FIELDS } from "./connectors/types.js";
