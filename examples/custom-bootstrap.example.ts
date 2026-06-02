// Worked example: writing a custom bootstrap that wires adopter-specific
// substrates against skillscript-runtime's public APIs.
//
// **When to write your own bootstrap.** The bundled `bootstrap()` from
// `skillscript-runtime` wires `FilesystemSkillStore` + `OllamaLocalModel` +
// `SqliteDataStore` + the typed-contract bridges. If your deployment uses
// different substrates (your own data store, a hosted LLM API, an MCP
// server for agent delivery, etc.), write your own bootstrap rather than
// modifying the bundled one. Prevents merge conflicts on every upstream
// release that touches `src/bootstrap.ts`.
//
// **What to copy from this file.** Take what fits your deployment and
// drop the rest. The shape is: construct a Registry, register your
// concrete substrate impls, optionally register custom JSON-wireable
// connector classes, load connectors.json + skillscript.config.json,
// wire the scheduler + MCP server. The order doesn't matter as long as
// registration happens before any dispatch.

import {
  Registry,
  FilesystemSkillStore,
  registerConnectorClass,
  loadConnectorsConfig,
  loadSkillscriptConfig,
  type McpConnector,
  type ManifestInfo,
  type StaticCapabilities,
  type McpDispatchCtx,
} from "skillscript-runtime";
import { Scheduler } from "skillscript-runtime/scheduler";
import { FilesystemTraceStore } from "skillscript-runtime/trace";
import { McpServer } from "skillscript-runtime/mcp-server";
import { wireDeclarativeTriggers } from "skillscript-runtime";

// ─── Step 1: your custom McpConnector class ─────────────────────────────
//
// If you have a substrate exposed as MCP tools (e.g., your in-house agent
// API), implement `McpConnector` and register the class so connectors.json
// can reference it by name. This is the "case 2" wiring from the
// adopter playbook — substrate-locked but expressive.

class MyAdopterConnector implements McpConnector {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "mcp_connector",
      implementation: "MyAdopterConnector",
      contract_version: "1.0.0",
      features: { /* feature flags your skills can `# Requires:` */ },
    };
  }

  constructor(private readonly config: Record<string, unknown>) {}

  async call(toolName: string, args: Record<string, unknown>, _ctx?: McpDispatchCtx): Promise<unknown> {
    // Dispatch to your substrate. Auth/credentials per the passthrough
    // model: the substrate enforces; runtime threads credentials via ctx.
    void toolName; void args;
    return { ok: true };
  }

  async manifest(): Promise<ManifestInfo> {
    return { capabilities_version: "1", manifest: { kind: "my-adopter" } };
  }
}

// ─── Step 2: register your class with the loader BEFORE config loads ────

registerConnectorClass("MyAdopterConnector", {
  ctor: MyAdopterConnector as never,
  fromConfig: (config) => new MyAdopterConnector(config),
});

// ─── Step 3: load config files ───────────────────────────────────────────

const HOME = process.env["SKILLSCRIPT_HOME"] ?? "/var/skillscript";

const { config } = loadSkillscriptConfig({ path: `${HOME}/skillscript.config.json` });
const { connectors } = loadConnectorsConfig({ path: `${HOME}/connectors.json` });

// ─── Step 4: construct the registry ──────────────────────────────────────

const registry = new Registry();
const skillStore = new FilesystemSkillStore(config.skillsDir ?? `${HOME}/skills`);
registry.registerSkillStore("primary", skillStore);

// Wire your own LocalModel, DataStore, AgentConnector here. For typed-
// contract impls, this is the "case 1" wiring — substrate-portable.
//   registry.registerLocalModel("default", new MyHostedLlmAdapter(...));
//   registry.registerDataStore("primary", new MyDataStoreAdapter(...));
//   registry.registerAgentConnector("primary", new MyAgentHarnessAdapter(...));

// Then wire bridges if you want the canonical in-skill `$ llm` /
// `$ data_read` / `$ data_write` / `$ skill_read` / `$ skill_write`
// surfaces. Each bridge handles its multi-verb tool surface via toolName
// discrimination; register the same instance under each connector name so
// bare-form name-match resolution picks the right route.
//   import { LocalModelMcpConnector, DataStoreMcpConnector, SkillStoreMcpConnector } from "skillscript-runtime";
//   // Pass the registry handle so `$ llm prompt="..." model="X"` resolves
//   // X to a registered LocalModel alias. Without it, model= falls through
//   // as an upstream hint to the default LocalModel's substrate (e.g., Ollama tag).
//   registry.registerMcpConnector("llm", new LocalModelMcpConnector(registry.getLocalModel("default"), registry));
//   const ms = registry.listDataStores().find((e) => e.name === "primary");
//   if (ms !== undefined) {
//     const dataBridge = new DataStoreMcpConnector(ms.instance);
//     registry.registerMcpConnector("data_read", dataBridge);
//     registry.registerMcpConnector("data_write", dataBridge);
//   }
//   // SkillStore-as-bridge. Makes `$ skill_write` / `$ skill_read`
//   // dispatchable from inside an executing skill (Lisp-shape: skills program
//   // skills). In-skill writes are Draft-forced at the bridge layer; outside-MCP
//   // skill_write keeps the existing "body declares status" behavior.
//   const ss = registry.listSkillStores().find((e) => e.name === "primary");
//   if (ss !== undefined) {
//     const skillBridge = new SkillStoreMcpConnector(ss.instance);
//     registry.registerMcpConnector("skill_read", skillBridge);
//     registry.registerMcpConnector("skill_write", skillBridge);
//   }

// Wire any connectors.json instances.
for (const c of connectors) {
  if (c.instance !== undefined) registry.registerMcpConnector(c.name, c.instance, c.allowedTools);
}

// ─── Step 5: wire scheduler + MCP server ─────────────────────────────────

const traceStore = new FilesystemTraceStore(config.traceDir ?? `${HOME}/traces`);
const scheduler = new Scheduler({
  registry,
  skillStore,
  traceStore,
  ...(config.pollIntervalSeconds !== undefined ? { pollIntervalSeconds: config.pollIntervalSeconds } : {}),
  enableUnsafeShell: config.enableUnsafeShell ?? false,
});
const mcpServer = new McpServer({
  skillStore,
  scheduler,
  traceStore,
  registry,
  enableUnsafeShell: config.enableUnsafeShell ?? false,
  runtimeMode: config.mode ?? "dashboard",
});

// ─── Step 6: register declarative triggers + start ───────────────────────

await wireDeclarativeTriggers({ scheduler, skillStore });
scheduler.start();

// Mount whatever surface fits your deployment (DashboardServer, your own
// HTTP wrapper, an MCP stdio entry point, etc.) on top of `mcpServer`.

export { registry, scheduler, mcpServer, skillStore, traceStore };
