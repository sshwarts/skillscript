// Reference bootstrap — wires the bundled defaults (FilesystemSkillStore,
// SqliteMemoryStore, OllamaLocalModel, LocalModelMcpConnector +
// MemoryStoreMcpConnector bridges, FilesystemTraceStore, Scheduler,
// McpServer) so the CLI's `dashboard` / `serve` commands have a working
// out-of-the-box deployment.
//
// **Adopters: this file is a starting point, not a contract.** For custom
// substrate wiring (your own MemoryStore, your own LocalModel impl, a
// non-bundled AgentConnector, etc.), write your own bootstrap that imports
// the public APIs (`Registry`, `registerConnectorClass`, `loadConnectorsConfig`,
// `loadSkillscriptConfig`, the individual connector classes) and constructs
// the registry to match your environment. See `examples/custom-bootstrap.example.ts`
// for a worked walkthrough. Modifying this file in place is supported (the
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
import { OllamaLocalModel } from "./connectors/local-model.js";
import { SqliteMemoryStore } from "./connectors/memory-store.js";
import { LocalModelMcpConnector } from "./connectors/local-model-mcp.js";
import { MemoryStoreMcpConnector } from "./connectors/memory-store-mcp.js";
import { loadConnectorsConfig, detectGitignoreRisk } from "./connectors/config.js";
import { FilesystemTraceStore } from "./trace.js";
import { Scheduler, type ResolvableTriggerSource, type TriggerRegistration } from "./scheduler.js";
import type { TraceConfig } from "./trace.js";
import { McpServer } from "./mcp-server.js";
import { parse } from "./parser.js";
import type { SkillStore } from "./connectors/types.js";

export interface BootstrapOpts {
  skillsDir: string;
  traceDir: string;
  /** When set + existing, register `SqliteMemoryStore` as primary memory_store. */
  memoryDbPath?: string;
  /** Override `OLLAMA_BASE_URL` env default. */
  ollamaBaseUrl?: string;
  /** Scheduler poll interval (default 30s). */
  pollIntervalSeconds?: number;
  /** Forwarded to scheduler/runtime. Default false. */
  enableUnsafeShell?: boolean;
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
  skillStore: FilesystemSkillStore;
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

/** v0.2.7 — wire-format for `$SKILLSCRIPT_HOME/triggers.json`. */
interface PersistedTriggerFile {
  schema_version: 1;
  triggers: Array<{
    id: string;
    skill_name: string;
    source: string;
    name: string;
    declarative: false;
    registered_at: number;
    expires_at: number | null;
  }>;
}

const VALID_TRIGGER_SOURCES: ReadonlyArray<ResolvableTriggerSource> = [
  "cron", "session", "event", "agent-event", "file-watch", "sensor",
];

export interface DefaultRegistryOpts {
  skillsDir: string;
  memoryDbPath?: string;
  ollamaBaseUrl?: string;
}

/**
 * Build the default connector registry: primary SkillStore + primary
 * MemoryStore (if the db file/directory exists) + three named LocalModels
 * pointed at Ollama. Used by both `bootstrap()` (long-lived host) and the
 * `skillfile run` one-shot path so both surfaces wire the same defaults.
 */
export function defaultRegistry(opts: DefaultRegistryOpts): { registry: Registry; skillStore: FilesystemSkillStore } {
  const registry = new Registry();
  const skillStore = new FilesystemSkillStore(opts.skillsDir);
  registry.registerSkillStore("primary", skillStore);

  if (opts.memoryDbPath !== undefined && (existsSync(opts.memoryDbPath) || existsSync(dirname(opts.memoryDbPath)))) {
    registry.registerMemoryStore("primary", new SqliteMemoryStore({ dbPath: opts.memoryDbPath }));
  }

  const ollamaUrl = opts.ollamaBaseUrl ?? process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
  registry.registerLocalModel("default", new OllamaLocalModel({ baseUrl: ollamaUrl, defaultModelTag: "gemma2:9b" }));
  registry.registerLocalModel("gemma2", new OllamaLocalModel({ baseUrl: ollamaUrl, defaultModelTag: "gemma2:9b" }));
  registry.registerLocalModel("qwen", new OllamaLocalModel({ baseUrl: ollamaUrl, defaultModelTag: "qwen2.5:7b" }));

  // v0.7.2 — auto-wire bridge connectors so the canonical `$ llm` and
  // `$ memory` MCP-dispatch paths Just Work in default deployments. The
  // bridges wrap the LocalModel + MemoryStore impls registered above as
  // McpConnector instances. Adopters override by re-registering "llm"
  // or "memory" with their own connector (post-bootstrap) OR by adding
  // entries to connectors.json — connectors.json loading runs AFTER
  // defaultRegistry, so adopter overrides win.
  const defaultLocalModel = registry.getLocalModel("default");
  registry.registerMcpConnector("llm", new LocalModelMcpConnector(defaultLocalModel));
  const memoryStore = registry.listMemoryStores().find((e) => e.name === "primary");
  if (memoryStore !== undefined) {
    registry.registerMcpConnector("memory", new MemoryStoreMcpConnector(memoryStore.instance));
  }

  return { registry, skillStore };
}

/**
 * Construct the runtime surface with bundled-default substrate wiring.
 *
 * **Reference deployment.** This function wires `FilesystemSkillStore`,
 * `OllamaLocalModel` (`default` / `gemma2` / `qwen`), `SqliteMemoryStore`
 * (if `memoryDbPath` is set + the file/dir exists), the v0.7.2 bridge
 * connectors (`llm` + `memory`), and any `McpConnector` declared in
 * `connectors.json`. Adopters wanting custom substrate wiring should write
 * their own bootstrap that imports the public APIs (Registry, the
 * individual connector classes, `loadConnectorsConfig`, etc.) directly.
 *
 * Caller is expected to:
 *   1. Optionally call `wireDeclarativeTriggers(result)` to register
 *      `# Triggers:` headers from already-Approved skills.
 *   2. Call `result.scheduler.start()` to arm the tick loop.
 *   3. Mount any additional surfaces (e.g., `DashboardServer`) on top of
 *      `result.mcpServer`.
 */
export function bootstrap(opts: BootstrapOpts): BootstrapResult {
  const { registry, skillStore } = defaultRegistry(opts);
  const traceStore = new FilesystemTraceStore(opts.traceDir);
  const enableUnsafeShell = opts.enableUnsafeShell ?? false;
  const mode = opts.mode ?? "dashboard";

  // v0.4.0 — load and register configured MCP connectors from connectors.json.
  // Errors surface via the result; bootstrap doesn't throw (lets the caller
  // decide whether a malformed config should abort startup or warn).
  const configuredConnectorNames: string[] = [];
  const connectorConfigErrors: string[] = [];
  if (opts.connectorsConfigPath !== undefined) {
    const result = loadConnectorsConfig({ path: opts.connectorsConfigPath });
    connectorConfigErrors.push(...result.errors);
    for (const c of result.connectors) {
      if (c.instance !== undefined) {
        registry.registerMcpConnector(c.name, c.instance, c.allowedTools);
        configuredConnectorNames.push(c.name);
      }
    }
    if (result.errors.length > 0) {
      for (const err of result.errors) {
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
    // Informational; doesn't block startup.
    const giWarning = detectGitignoreRisk(opts.connectorsConfigPath);
    if (giWarning !== null) {
      process.stderr.write(`[bootstrap] WARNING: ${giWarning}\n`);
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
    ...(opts.triggersFilePath !== undefined ? { triggersFilePath: opts.triggersFilePath } : {}),
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
 * Read `triggers.json` (if present) and re-register each imperative trigger
 * into the scheduler with its persisted id. Prunes expired rows during the
 * load. Re-writes the file with the pruned set so future hydrations don't
 * re-scan dead entries.
 */
function hydratePersistedTriggers(
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
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.triggers)) {
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

/** Serialize the scheduler's imperative-trigger set to disk atomically. */
function writePersistedTriggers(
  path: string,
  triggers: ReadonlyArray<TriggerRegistration>,
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const imperative = triggers.filter((t) => !t.declarative);
  const payload: PersistedTriggerFile = {
    schema_version: 1,
    triggers: imperative.map((t) => ({
      id: t.id,
      skill_name: t.skillName,
      source: t.source,
      name: t.name,
      declarative: false as const,
      registered_at: t.registeredAt,
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
