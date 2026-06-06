// Reference bootstrap — wires the runtime surface for the CLI's `dashboard`
// / `serve` commands. v0.10 base config:
//   skill_store   → FilesystemSkillStore (override via connectors.json substrate)
//   data_store  → SqliteDataStore (conditional on dataDbPath)
//   local_model   → null (adopter opts in via substrate.local_model)
//   mcp_connector → null (adopter wires named instances in connectors.json)
//   agent_connector → null (adopter wires explicitly)
// Plus v0.7.2 MCP bridges (`llm`, `memory`, `data_write`) auto-wired when
// their underlying substrates exist.
//
// **Adopters: this file is a starting point, not a contract.** For custom
// substrate wiring (your own DataStore, your own LocalModel impl, a
// non-bundled AgentConnector, etc.), write your own bootstrap that imports
// the public APIs (`Registry`, `registerConnectorClass`, `loadConnectorsConfig`,
// `loadSkillscriptConfig`, the individual connector classes) and constructs
// the registry to match your environment. See `docs/configuration.md` and
// `docs/adopter-playbook.md`. Modifying this file in place is supported (the
// codebase doesn't gate on it being unchanged) but creates merge friction
// with every upstream release — prefer writing your own bootstrap that
// imports from the public surface.
//
// The public `bootstrap()` function here will continue to work for default
// deployments and is part of the v0.7.x+ stable public surface.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Registry } from "./connectors/registry.js";
import { FilesystemSkillStore } from "./connectors/skill-store.js";
import { SqliteSkillStore } from "./connectors/sqlite-skill-store.js";
import { SqliteDataStore } from "./connectors/data-store.js";
import { OllamaLocalModel } from "./connectors/local-model.js";
import { LocalModelMcpConnector } from "./connectors/local-model-mcp.js";
import { DataStoreMcpConnector } from "./connectors/data-store-mcp.js";
import { SkillStoreMcpConnector } from "./connectors/skill-store-mcp.js";
import { loadConnectorsConfig, detectGitignoreRisk, type SubstrateConfig, type SubstrateChoice } from "./connectors/config.js";
import { FilesystemTraceStore } from "./trace.js";
import { Scheduler, type ResolvableTriggerSource, type TriggerRegistration } from "./scheduler.js";
import type { TraceConfig } from "./trace.js";
import { McpServer } from "./mcp-server.js";
import { parse } from "./parser.js";
import { join } from "node:path";
import type { SkillStore, DataStore, LocalModel } from "./connectors/types.js";
import type { AgentConnector } from "./connectors/agent.js";
import { NoOpAgentConnector } from "./connectors/agent-noop.js";

export interface BootstrapOpts {
  skillsDir: string;
  traceDir: string;
  /** When set + existing, register `SqliteDataStore` as primary data_store. */
  dataDbPath?: string;
  /** Override the bundled-default SkillStore. v0.10 — threaded by the CLI when
   * `connectors.json` substrate config selects sqlite / adopter-custom. */
  skillStore?: SkillStore;
  /** Override the conditional Sqlite DataStore wiring. */
  dataStore?: DataStore;
  /** Optional LocalModel to register as `"default"`. v0.10 — base config is
   * null; adopters wire explicitly via `connectors.json` or this opt. */
  localModel?: LocalModel;
  /**
   * v0.18.1 — optional AgentConnector to register as `"primary"`. Mirrors
   * the existing `skillStore` / `dataStore` / `localModel` opts shape;
   * closes the declarative-wiring asymmetry where AgentConnector was
   * programmatic-only (this opt + new `agent_connector` slot in
   * `connectors.json` substrate config). Omit → `NoOpAgentConnector` is
   * the silent default (existing behavior preserved). Adopters with a
   * substrate-mediated agent surface (HttpWebhookAgentConnector,
   * memory-store-backed adapter, etc.) supply an instance here.
   */
  agentConnector?: AgentConnector;
  /** Scheduler poll interval (default 30s). */
  pollIntervalSeconds?: number;
  /**
   * v0.18.7 — runtime absolute timeout in ms (the built-in fallback
   * when no per-op, skill, or connector default applies). Default
   * 300_000ms (5 min). Threaded into the Scheduler so every
   * trigger-fired dispatch inherits it. Adopter cascade (most-specific
   * wins): bootstrap opt > `SKILLSCRIPT_ABSOLUTE_TIMEOUT_MS` env >
   * `skillscript.config.json#absoluteTimeoutMs` > default.
   */
  absoluteTimeoutMs?: number;
  /**
   * v0.18.7 — composition recursion depth ceiling. Default 10
   * (`DEFAULT_MAX_RECURSION_DEPTH`). Threaded into the Scheduler's
   * ctx so every trigger-fired dispatch inherits it. Adopter cascade
   * (most-specific wins): bootstrap opt > `SKILLSCRIPT_MAX_RECURSION_DEPTH`
   * env > `skillscript.config.json#maxRecursionDepth` > default.
   */
  maxRecursionDepth?: number;
  /** Forwarded to scheduler/runtime. Default false. */
  enableUnsafeShell?: boolean;
  /**
   * v0.18.8 — operator-controlled allowlist of binaries reachable via
   * `shell(...)` ops. Default-deny when unset (BREAKING from v0.18.7).
   * See `SkillscriptConfig.shellAllowlist` for the full semantic +
   * Perry's safe-vs-unsafe reframe (thread `7aab6f3f`).
   */
  shellAllowlist?: string[];
  /**
   * v0.17.4 — approval-posture override. When true, the outside-MCP
   * `skill_write` handler forces every write to land in `Draft` status
   * regardless of what the body declares. Adopters wanting strict
   * posture ("every skill needs explicit human promotion regardless of
   * body claim") opt in. Default `false` — preserves the v0.9.1
   * self-approval-via-body-declaration behavior.
   *
   * The in-skill `$ skill_write` bridge has always been Draft-default
   * (v0.15.0); this flag is the outside-MCP equivalent that closes the
   * agent-self-approval path when adopters want a human approval gate.
   *
   * Adopter surfaces (cascade — most-specific wins):
   * 1. `bootstrap({ forceAlwaysDraft: true, ... })` — programmatic
   * 2. `SKILLSCRIPT_FORCE_ALWAYS_DRAFT=true` env var (CLI reads it)
   * 3. `{ "forceAlwaysDraft": true }` in `skillscript.config.json`
   */
  forceAlwaysDraft?: boolean;
  /** When set, scheduler-driven fires record traces via the result's traceStore. */
  trace?: TraceConfig;
  /**
   * Path to the imperative-trigger persistence file. When set, `bootstrap()`
   * hydrates the scheduler from this file at boot (pruning expired entries)
   * and writes-through on every imperative register/unregister. Declarative
   * triggers continue to live-derive from the SkillStore. v0.2.7 addition.
   */
  triggersFilePath?: string;
  /**
   * Runtime mode label surfaced via `runtime_capabilities`. `"dashboard"`
   * (default) when an SPA is mounted; `"serve"` for headless deployments.
   * v0.2.7 addition.
   */
  mode?: "serve" | "dashboard";
  /**
   * Path to `connectors.json` (v0.4.0). When set + existing, the loader
   * parses + validates the file and registers each declared MCP
   * connector instance into the Registry. Missing file is graceful;
   * malformed JSON / unknown class / unset `${VAR}` surface as
   * structured errors via the result's `connectorConfigErrors`.
   */
  connectorsConfigPath?: string;
}

export interface BootstrapResult {
  registry: Registry;
  scheduler: Scheduler;
  mcpServer: McpServer;
  /** v0.10 — generalized from concrete `FilesystemSkillStore` to the
   * `SkillStore` interface since the connector is now configurable via
   * `connectors.json` substrate config. */
  skillStore: SkillStore;
  traceStore: FilesystemTraceStore;
  /** Read back so runtime_capabilities can surface the active mode. */
  enableUnsafeShell: boolean;
  /** Runtime mode label (echoed from opts; defaults to "dashboard"). */
  mode: "serve" | "dashboard";
  /** Imperative-trigger persistence path, when configured. */
  triggersFilePath?: string;
  /**
   * Names of MCP connectors wired from `connectors.json` (v0.4.0).
   * Surfaced through `runtime_capabilities` for cold-author discovery.
   */
  configuredConnectorNames: string[];
  /** Errors from the `connectors.json` load pass (v0.4.0). Empty when no file is configured or load was clean. */
  connectorConfigErrors: string[];
}

/**
 * Wire-format for `$SKILLSCRIPT_HOME/triggers.json`.
 *
 * v0.2.7 introduced `schema_version: 1`. v0.9.0 bumps to `2` with the
 * `enabled` field on each trigger record. The loader honors both versions:
 * v1 records are hydrated with `enabled: true` (the v0.9.x default).
 */
interface PersistedTriggerV1 {
  id: string;
  skill_name: string;
  source: string;
  name: string;
  declarative: false;
  registered_at: number;
  expires_at: number | null;
}

interface PersistedTriggerV2 extends PersistedTriggerV1 {
  enabled: boolean;
}

interface PersistedTriggerFileV1 {
  schema_version: 1;
  triggers: PersistedTriggerV1[];
}

interface PersistedTriggerFileV2 {
  schema_version: 2;
  triggers: PersistedTriggerV2[];
}

type PersistedTriggerFile = PersistedTriggerFileV1 | PersistedTriggerFileV2;

const VALID_TRIGGER_SOURCES: ReadonlyArray<ResolvableTriggerSource> = [
  "cron", "session", "event", "agent-event", "file-watch", "sensor",
];

export interface DefaultRegistryOpts {
  skillsDir: string;
  dataDbPath?: string;
  /**
   * Override the bundled-default SkillStore. When supplied, used instead of
   * `new FilesystemSkillStore(skillsDir)`. Threaded through by the CLI when
   * `connectors.json` substrate config selects sqlite or adopter-custom.
   */
  skillStore?: SkillStore;
  /**
   * Override the conditional-Sqlite DataStore wiring. When supplied, used
   * instead of the `dataDbPath`-conditional `SqliteDataStore`.
   */
  dataStore?: DataStore;
  /**
   * Optional LocalModel to register as `"default"`. **v0.10 — base config:
   * LocalModel is NULL unless explicitly provided.** Adopters wanting Ollama
   * (or any other LocalModel) wire it explicitly via `connectors.json`
   * substrate config or by passing here.
   */
  localModel?: LocalModel;
  /**
   * v0.18.1 — optional AgentConnector to register as `"primary"`. When
   * omitted, the Registry falls back to NoOpAgentConnector via
   * `getAgentConnectorOrDefault`. Adopters wanting a substrate-mediated
   * agent surface (memory-store-backed, webhook, etc.) supply an
   * instance here.
   */
  agentConnector?: AgentConnector;
}

/**
 * Build the default connector registry: primary SkillStore (configurable),
 * primary DataStore (configurable / conditional), and optional LocalModel
 * (null by default — v0.10). Used by both `bootstrap()` (long-lived host)
 * and the `skillfile run` one-shot path so both surfaces wire the same
 * defaults.
 *
 * **v0.10 base config**:
 *   skill_store   → FilesystemSkillStore (override via `opts.skillStore`)
 *   data_store  → SqliteDataStore (conditional on `dataDbPath`)
 *   local_model   → null (override via `opts.localModel`)
 *   mcp_connector → null (adopter wires via `connectors.json`)
 *   agent_connector → null (adopter wires explicitly)
 */
export function defaultRegistry(opts: DefaultRegistryOpts): { registry: Registry; skillStore: SkillStore } {
  const registry = new Registry();
  const skillStore = opts.skillStore ?? new FilesystemSkillStore(opts.skillsDir);
  registry.registerSkillStore("primary", skillStore);

  let dataStore: DataStore | undefined = opts.dataStore;
  if (dataStore === undefined && opts.dataDbPath !== undefined && (existsSync(opts.dataDbPath) || existsSync(dirname(opts.dataDbPath)))) {
    dataStore = new SqliteDataStore({ dbPath: opts.dataDbPath });
  }
  if (dataStore !== undefined) {
    registry.registerDataStore("primary", dataStore);
  }

  // v0.10 — LocalModel default is null. Only register if explicitly provided.
  if (opts.localModel !== undefined) {
    registry.registerLocalModel("default", opts.localModel);
  }

  // v0.18.1 — AgentConnector. Default is unregistered → Registry falls
  // back to NoOpAgentConnector via getAgentConnectorOrDefault on each
  // call. Adopters supply an instance via opts.agentConnector
  // (programmatic) or substrate.agent_connector in connectors.json
  // (declarative — buildSubstrateInstances resolves it into this opt).
  if (opts.agentConnector !== undefined) {
    // registerAgentConnector is async (runs health_check). Fire and
    // forget within defaultRegistry — the Registry's contract surfaces
    // failures via the returned promise; defaultRegistry itself is sync.
    // For health-check-throwing semantics at boot, callers using the
    // declarative path should await `registerAgentConnector` directly
    // post-bootstrap if they need that ordering.
    void registry.registerAgentConnector("primary", opts.agentConnector);
  }

  // v0.7.2 — auto-wire bridge connectors when their substrate exists.
  // Adopters override by re-registering the bridge name post-bootstrap OR
  // by adding entries to connectors.json (which loads after defaultRegistry).
  if (registry.hasLocalModel("default")) {
    // Pass the registry handle so `$ llm prompt="..." model="X"` resolves
    // X to a registered LocalModel alias when X matches one. Falls through
    // to the default LocalModel when X is unset or doesn't resolve.
    registry.registerMcpConnector("llm", new LocalModelMcpConnector(registry.getLocalModel("default"), registry));
  }
  if (dataStore !== undefined) {
    // v0.8.0 — register the SAME bridge instance under both names so
    // bare-form `$ data_read mode=fts ...` and `$ data_write content=...`
    // both route to it. The bridge dispatches on toolName internally.
    const bridge = new DataStoreMcpConnector(dataStore);
    registry.registerMcpConnector("data_read", bridge);
    registry.registerMcpConnector("data_write", bridge);
  }

  // v0.15.0 — SkillStore-as-bridge. Same instance registered under both
  // names so `$ skill_write` / `$ skill_read` from inside an executing skill
  // route here. Closes the substrate-symmetry gap where DataStore was
  // in-skill dispatchable but SkillStore was wire-only. In-skill writes are
  // forced to `# Status: Draft` per the bridge's threat-model boundary; see
  // src/connectors/skill-store-mcp.ts header.
  const skillBridge = new SkillStoreMcpConnector(skillStore);
  registry.registerMcpConnector("skill_read", skillBridge);
  registry.registerMcpConnector("skill_write", skillBridge);

  return { registry, skillStore };
}

/**
 * Construct the runtime surface with configurable substrate wiring.
 *
 * **Reference deployment, v0.10.** Base config:
 *   - `FilesystemSkillStore` (override via `opts.skillStore` or `connectors.json` substrate)
 *   - `SqliteDataStore` (conditional on `dataDbPath`; override via `opts.dataStore`)
 *   - LocalModel `null` (provide via `opts.localModel` or `connectors.json` substrate)
 *   - v0.7.2 MCP bridges (`llm`, `memory`, `data_write`) wired when their
 *     substrates exist
 *   - Any `McpConnector` declared in `connectors.json`
 *
 * Adopters wanting custom substrate wiring write `connectors.json` with a
 * `substrate` section (per `docs/sqlite-skill-store.md`) OR write their own
 * bootstrap that imports the public APIs (Registry, individual connector
 * classes, `loadConnectorsConfig`, etc.) directly.
 *
 * Caller is expected to:
 *   1. Optionally call `wireDeclarativeTriggers(result)` to register
 *      `# Triggers:` headers from already-Approved skills.
 *   2. Call `result.scheduler.start()` to arm the tick loop.
 *   3. Mount any additional surfaces (e.g., `DashboardServer`) on top of
 *      `result.mcpServer`.
 */
export function bootstrap(opts: BootstrapOpts): BootstrapResult {
  // v0.10 — pre-load connectors.json (if configured) to extract substrate
  // intent BEFORE defaultRegistry runs. The substrate section selects
  // SkillStore / DataStore / LocalModel impls; the MCP-connector entries
  // are registered after defaultRegistry below.
  const configuredConnectorNames: string[] = [];
  const connectorConfigErrors: string[] = [];
  let loadedConnectors: ReturnType<typeof loadConnectorsConfig> | undefined;
  if (opts.connectorsConfigPath !== undefined) {
    loadedConnectors = loadConnectorsConfig({ path: opts.connectorsConfigPath });
    connectorConfigErrors.push(...loadedConnectors.errors);
  }

  // Convert substrate intent → instances. Programmatic opts (opts.skillStore
  // etc.) win over connectors.json substrate config — explicit wiring beats
  // declarative. connectors.json beats built-in defaults.
  const substrateResult = buildSubstrateInstances(loadedConnectors?.substrate, opts);
  connectorConfigErrors.push(...substrateResult.errors);

  // Precedence: programmatic opts > substrate config > built-in default.
  // Explicit wiring (`opts.skillStore = ...`) beats declarative substrate;
  // declarative beats the FilesystemSkillStore fallback inside defaultRegistry.
  const skillStoreToUse = opts.skillStore ?? substrateResult.skillStore;
  const dataStoreToUse = opts.dataStore ?? substrateResult.dataStore;
  const localModelToUse = opts.localModel ?? substrateResult.localModel;
  // v0.18.1 — agentConnector follows the same precedence: programmatic
  // opt wins over substrate config wins over Registry default (NoOp).
  const agentConnectorToUse = opts.agentConnector ?? substrateResult.agentConnector;

  const { registry, skillStore } = defaultRegistry({
    ...opts,
    ...(skillStoreToUse !== undefined ? { skillStore: skillStoreToUse } : {}),
    ...(dataStoreToUse !== undefined ? { dataStore: dataStoreToUse } : {}),
    ...(localModelToUse !== undefined ? { localModel: localModelToUse } : {}),
    ...(agentConnectorToUse !== undefined ? { agentConnector: agentConnectorToUse } : {}),
  });
  const traceStore = new FilesystemTraceStore(opts.traceDir);
  const enableUnsafeShell = opts.enableUnsafeShell ?? false;
  const mode = opts.mode ?? "dashboard";

  // v0.4.0 — register the MCP connectors from the pre-loaded connectors.json
  // result. Errors surface via the result; bootstrap doesn't throw (lets the
  // caller decide whether a malformed config should abort startup or warn).
  if (loadedConnectors !== undefined) {
    for (const c of loadedConnectors.connectors) {
      if (c.instance !== undefined) {
        registry.registerMcpConnector(c.name, c.instance, c.allowedTools);
        configuredConnectorNames.push(c.name);
      }
    }
    if (loadedConnectors.errors.length > 0) {
      for (const err of loadedConnectors.errors) {
        process.stderr.write(`[bootstrap] ${err}\n`);
      }
    }
    if (configuredConnectorNames.length > 0) {
      process.stderr.write(
        `[bootstrap] connectors.json: wired ${configuredConnectorNames.length} connector(s): ${configuredConnectorNames.join(", ")}\n`,
      );
    }
    // v0.4.1 — credential-discipline backstop. One-time stderr warning if
    // connectors.json is in a git-tracked dir without a .gitignore entry.
    if (opts.connectorsConfigPath !== undefined) {
      const giWarning = detectGitignoreRisk(opts.connectorsConfigPath);
      if (giWarning !== null) {
        process.stderr.write(`[bootstrap] WARNING: ${giWarning}\n`);
      }
    }
  }

  // v0.2.7 — wire write-through to the persistent registry, then hydrate
  // any existing imperative triggers from disk before scheduler.start()
  // is called downstream. Declarative triggers are layered on top via
  // wireDeclarativeTriggers() after bootstrap returns.
  const onTriggersChanged = opts.triggersFilePath !== undefined
    ? (snapshot: ReadonlyArray<TriggerRegistration>) => {
        writePersistedTriggers(opts.triggersFilePath!, snapshot);
      }
    : undefined;

  const scheduler = new Scheduler({
    registry,
    skillStore,
    traceStore,
    ...(opts.pollIntervalSeconds !== undefined ? { pollIntervalSeconds: opts.pollIntervalSeconds } : {}),
    ...(opts.absoluteTimeoutMs !== undefined ? { absoluteTimeoutMs: opts.absoluteTimeoutMs } : {}),
    ...(opts.maxRecursionDepth !== undefined ? { maxRecursionDepth: opts.maxRecursionDepth } : {}),
    ...(opts.shellAllowlist !== undefined ? { shellAllowlist: opts.shellAllowlist } : {}),
    ...(opts.trace !== undefined ? { trace: opts.trace, traceStore } : {}),
    ...(onTriggersChanged !== undefined ? { onTriggersChanged } : {}),
    enableUnsafeShell,
  });

  if (opts.triggersFilePath !== undefined) {
    hydratePersistedTriggers(scheduler, opts.triggersFilePath);
  }

  const mcpServer = new McpServer({
    skillStore,
    scheduler,
    traceStore,
    registry,
    enableUnsafeShell,
    runtimeMode: mode,
    ...(opts.shellAllowlist !== undefined ? { shellAllowlist: opts.shellAllowlist } : {}),
    ...(opts.triggersFilePath !== undefined ? { triggersFilePath: opts.triggersFilePath } : {}),
    ...(opts.forceAlwaysDraft === true ? { forceAlwaysDraft: true } : {}),
  });

  return {
    registry,
    scheduler,
    mcpServer,
    skillStore,
    traceStore,
    enableUnsafeShell,
    mode,
    configuredConnectorNames,
    connectorConfigErrors,
    ...(opts.triggersFilePath !== undefined ? { triggersFilePath: opts.triggersFilePath } : {}),
  };
}

/**
 * v0.10 — translate parsed substrate intent into concrete connector instances
 * for `defaultRegistry()` to register. Defaults to db paths under the
 * deployment's `skillsDir` so adopters get sensible out-of-box behavior
 * without explicit config.
 *
 * Programmatic opts (`opts.skillStore`, etc.) take precedence over substrate
 * intent. Substrate intent takes precedence over built-in defaults (which
 * `defaultRegistry` applies when nothing is supplied).
 *
 * **Custom substrate impls** (`type: "custom"` in connectors.json) require
 * dynamic import. Today's sync `bootstrap()` doesn't support that — surfaces
 * a clear error and falls back to defaults. Adopters wanting custom impls
 * write their own bootstrap script (existing pattern). Promoting bootstrap()
 * to async + supporting custom-via-connectors.json is future work.
 */
function buildSubstrateInstances(
  substrate: SubstrateConfig | undefined,
  opts: BootstrapOpts,
): { skillStore?: SkillStore; dataStore?: DataStore; localModel?: LocalModel; agentConnector?: AgentConnector; errors: string[] } {
  const errors: string[] = [];
  const result: { skillStore?: SkillStore; dataStore?: DataStore; localModel?: LocalModel; agentConnector?: AgentConnector; errors: string[] } = { errors };
  if (substrate === undefined) return result;

  // skill_store
  if (substrate.skill_store !== undefined && substrate.skill_store !== null) {
    const built = buildSkillStoreFromChoice(substrate.skill_store, opts);
    if (built.error !== undefined) errors.push(built.error);
    else if (built.instance !== undefined) result.skillStore = built.instance;
  }
  // data_store
  if (substrate.data_store !== undefined && substrate.data_store !== null) {
    const built = buildDataStoreFromChoice(substrate.data_store, opts);
    if (built.error !== undefined) errors.push(built.error);
    else if (built.instance !== undefined) result.dataStore = built.instance;
  }
  // local_model (null → explicit "no LocalModel", which is also the v0.10 default)
  if (substrate.local_model !== undefined && substrate.local_model !== null) {
    const built = buildLocalModelFromChoice(substrate.local_model);
    if (built.error !== undefined) errors.push(built.error);
    else if (built.instance !== undefined) result.localModel = built.instance;
  }
  // v0.18.1 — agent_connector (null → explicit "no AgentConnector",
  // which is also the silent default; NoOpAgentConnector fallback fires
  // automatically via Registry.getAgentConnectorOrDefault).
  if (substrate.agent_connector !== undefined && substrate.agent_connector !== null) {
    const built = buildAgentConnectorFromChoice(substrate.agent_connector);
    if (built.error !== undefined) errors.push(built.error);
    else if (built.instance !== undefined) result.agentConnector = built.instance;
  }
  return result;
}

function buildAgentConnectorFromChoice(choice: SubstrateChoice): { instance?: AgentConnector; error?: string } {
  if (choice.type === "noop") {
    // Explicit "noop" declaration — surface the silent default as an
    // intentional choice. Equivalent to omitting the slot, but visible
    // in connectors.json for adopters who want the no-agent posture
    // documented rather than implicit.
    return { instance: new NoOpAgentConnector() };
  }
  if (choice.type === "custom") {
    return { error: `connectors.json: substrate.agent_connector — 'custom' type not yet supported via connectors.json (sync bootstrap can't dynamic-import). Wire your custom AgentConnector via a programmatic bootstrap script that passes bootstrap({ agentConnector: new MyAgentConnector(...) }) or calls registry.registerAgentConnector() directly.` };
  }
  return { error: `connectors.json: substrate.agent_connector — unknown type '${(choice as { type: string }).type}'.` };
}

function buildSkillStoreFromChoice(choice: SubstrateChoice, opts: BootstrapOpts): { instance?: SkillStore; error?: string } {
  if (choice.type === "filesystem") {
    return { instance: new FilesystemSkillStore(opts.skillsDir) };
  }
  if (choice.type === "sqlite") {
    const dbPath = (choice.config?.["dbPath"] as string | undefined) ?? join(opts.skillsDir, "skills.db");
    return { instance: new SqliteSkillStore({ dbPath }) };
  }
  if (choice.type === "custom") {
    return { error: `connectors.json: substrate.skill_store — 'custom' type not yet supported via connectors.json (sync bootstrap can't dynamic-import). Wire your custom SkillStore via a programmatic bootstrap script that calls registry.registerSkillStore() directly.` };
  }
  return { error: `connectors.json: substrate.skill_store — unknown type '${(choice as { type: string }).type}'.` };
}

function buildDataStoreFromChoice(choice: SubstrateChoice, opts: BootstrapOpts): { instance?: DataStore; error?: string } {
  if (choice.type === "sqlite") {
    const dbPath = (choice.config?.["dbPath"] as string | undefined)
      ?? opts.dataDbPath
      ?? join(opts.skillsDir, "memories.db");
    return { instance: new SqliteDataStore({ dbPath }) };
  }
  if (choice.type === "custom") {
    return { error: `connectors.json: substrate.data_store — 'custom' type not yet supported via connectors.json (sync bootstrap can't dynamic-import). Wire your custom DataStore via a programmatic bootstrap script.` };
  }
  return { error: `connectors.json: substrate.data_store — unknown type '${(choice as { type: string }).type}'.` };
}

function buildLocalModelFromChoice(choice: SubstrateChoice): { instance?: LocalModel; error?: string } {
  if (choice.type === "ollama") {
    const baseUrl = (choice.config?.["baseUrl"] as string | undefined)
      ?? process.env["OLLAMA_BASE_URL"]
      ?? "http://localhost:11434";
    // v0.13.1 — defaultModelTag is REQUIRED (was silently defaulted to
    // "gemma2:9b", which may not be pulled on the adopter's Ollama). Pin
    // the model explicitly so cold authors see what they're running against.
    const defaultModelTag = choice.config?.["defaultModelTag"] as string | undefined;
    if (typeof defaultModelTag !== "string" || defaultModelTag === "") {
      return { error: `connectors.json: substrate.local_model — \`config.defaultModelTag\` is required (e.g., "gemma2:9b", "llama3.1:8b"). Pin the Ollama model tag explicitly; was silently defaulted pre-v0.13.1.` };
    }
    return { instance: new OllamaLocalModel({ baseUrl, defaultModelTag }) };
  }
  if (choice.type === "custom") {
    return { error: `connectors.json: substrate.local_model — 'custom' type not yet supported via connectors.json. Wire via programmatic bootstrap.` };
  }
  return { error: `connectors.json: substrate.local_model — unknown type '${(choice as { type: string }).type}'.` };
}

/**
 * Read `triggers.json` (if present) and re-register each imperative trigger
 * into the scheduler with its persisted id. Prunes expired rows during the
 * load. Re-writes the file with the pruned set so future hydrations don't
 * re-scan dead entries.
 */
/**
 * Hydrate persisted triggers from `triggers.json` into a scheduler. Exported
 * as a public surface for adopter bootstraps that wire their own scheduler
 * but want the same on-disk format. v0.9.0.
 */
export function hydratePersistedTriggers(
  scheduler: Scheduler,
  path: string,
  log: (msg: string) => void = (msg) => process.stderr.write(`[bootstrap] ${msg}\n`),
): { loaded: number; pruned: number } {
  if (!existsSync(path)) return { loaded: 0, pruned: 0 };
  let parsed: PersistedTriggerFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedTriggerFile;
  } catch (err) {
    log(`triggers.json parse failed at '${path}': ${(err as Error).message}; ignoring file`);
    return { loaded: 0, pruned: 0 };
  }
  if ((parsed.schema_version !== 1 && parsed.schema_version !== 2) || !Array.isArray(parsed.triggers)) {
    log(`triggers.json at '${path}' has unsupported shape (schema_version=${parsed.schema_version}); ignoring`);
    return { loaded: 0, pruned: 0 };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  let loaded = 0;
  let pruned = 0;
  for (const t of parsed.triggers) {
    if (t.expires_at !== null && t.expires_at <= nowSec) {
      pruned++;
      continue;
    }
    if (!VALID_TRIGGER_SOURCES.includes(t.source as ResolvableTriggerSource)) {
      log(`triggers.json: skipped '${t.id}' — unknown source '${t.source}'`);
      pruned++;
      continue;
    }
    scheduler.registerTrigger(
      {
        id: t.id,
        skillName: t.skill_name,
        source: t.source as ResolvableTriggerSource,
        name: t.name,
        declarative: false,
        registeredAt: t.registered_at,
        // v0.9.0 — schema-v2 round-trips `enabled`; v1 records default to true.
        enabled: "enabled" in t ? (t as PersistedTriggerV2).enabled : true,
        ...(t.expires_at !== null ? { expiresAt: t.expires_at } : {}),
      },
      { seedFromPersistence: true },
    );
    loaded++;
  }
  if (pruned > 0) {
    // Re-write the file without the pruned rows.
    writePersistedTriggers(path, scheduler.listTriggers().filter((t) => !t.declarative));
    log(`triggers.json: loaded ${loaded}, pruned ${pruned} expired`);
  } else if (loaded > 0) {
    log(`triggers.json: loaded ${loaded} imperative trigger(s)`);
  }
  return { loaded, pruned };
}

/**
 * Serialize the scheduler's imperative-trigger set to disk atomically.
 * Exported as a public surface for adopter bootstraps; v0.9.0.
 */
export function writePersistedTriggers(
  path: string,
  triggers: ReadonlyArray<TriggerRegistration>,
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const imperative = triggers.filter((t) => !t.declarative);
  // v0.9.0 — always write schema_version 2 with `enabled` field. Older
  // runtimes loading a v2 file will reject (schema_version mismatch) — no
  // installed base to worry about pre-1.0; matches pre-adoption-rule.
  const payload: PersistedTriggerFile = {
    schema_version: 2,
    triggers: imperative.map((t) => ({
      id: t.id,
      skill_name: t.skillName,
      source: t.source,
      name: t.name,
      declarative: false as const,
      registered_at: t.registeredAt,
      enabled: t.enabled,
      expires_at: t.expiresAt ?? null,
    })),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
}

/**
 * Walk the SkillStore for Approved skills with declared `# Triggers:`
 * headers and register each into the scheduler. Returns the number of
 * triggers registered. Skips skills whose body fails to parse rather
 * than crashing boot — operators can fix the offender and restart.
 *
 * Implementation note: the SkillStore's `query()` returns SkillMeta with
 * an *optional* `triggers` field; not all impls populate it (the bundled
 * FilesystemSkillStore does not). This helper loads + parses each skill
 * source directly so it works against any SkillStore.
 */
export async function wireDeclarativeTriggers(
  result: Pick<BootstrapResult, "scheduler" | "skillStore">,
  log: (msg: string) => void = (msg) => process.stderr.write(`[bootstrap] ${msg}\n`),
): Promise<{ registered: number; skipped: number }> {
  let registered = 0;
  let skipped = 0;
  const approved = await safeQueryApproved(result.skillStore, log);
  for (const meta of approved) {
    let triggers: ReadonlyArray<{ source: string; name: string }>;
    try {
      const loaded = await result.skillStore.load(meta.name);
      const parsed = parse(loaded.source);
      triggers = parsed.triggers;
    } catch (err) {
      log(`skill '${meta.name}': skipped (parse failed: ${(err as Error).message})`);
      skipped++;
      continue;
    }
    for (const t of triggers) {
      if (!VALID_TRIGGER_SOURCES.includes(t.source as ResolvableTriggerSource)) {
        log(`skill '${meta.name}': skipped trigger '${t.source}: ${t.name}' (unknown source)`);
        skipped++;
        continue;
      }
      result.scheduler.registerTrigger({
        skillName: meta.name,
        source: t.source as ResolvableTriggerSource,
        name: t.name,
        declarative: true,
      });
      registered++;
    }
  }
  if (registered > 0 || skipped > 0) {
    log(`wired ${registered} declarative trigger(s)${skipped > 0 ? `, skipped ${skipped}` : ""} from ${approved.length} Approved skill(s)`);
  }
  return { registered, skipped };
}

async function safeQueryApproved(store: SkillStore, log: (msg: string) => void): Promise<Array<Awaited<ReturnType<SkillStore["query"]>>[number]>> {
  try {
    return await store.query({ status: "Approved" });
  } catch (err) {
    log(`declarative-trigger scan: SkillStore query failed (${(err as Error).message}); proceeding with empty set`);
    return [];
  }
}
