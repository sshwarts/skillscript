// Onboarding scaffold: complete bootstrap wiring file-backed data store +
// OpenAI LLM + tmux-shell AgentConnector.
//
// Copy this file into your deployment and modify substrate choices to
// match your environment. The shape is:
//   1. Construct a Registry
//   2. Register your substrate impls (SkillStore + LocalModel + DataStore + AgentConnector)
//   3. Wire bridges so canonical `$ llm` / `$ data_read` dispatch works
//   4. Load connectors.json + skillscript.config.json
//   5. Wire scheduler + MCP server
//   6. Start

import {
  Registry,
  FilesystemSkillStore,
  loadConnectorsConfig,
  loadSkillscriptConfig,
  wireDeclarativeTriggers,
} from "skillscript-runtime";
import { Scheduler } from "skillscript-runtime/scheduler";
import { FilesystemTraceStore } from "skillscript-runtime/trace";
import { McpServer } from "skillscript-runtime/mcp-server";
// Note: LocalModelMcpConnector + DataStoreMcpConnector + SkillStoreMcpConnector
// are bridge classes already exported from skillscript-runtime/connectors.
// They wrap any typed-contract impl as an MCP-dispatchable connector.
import {
  LocalModelMcpConnector,
  DataStoreMcpConnector,
  SkillStoreMcpConnector,
} from "skillscript-runtime/connectors";

import { FileDataStore } from "./file-data-store.js";
import { OpenAILocalModel } from "./openai-local-model.js";
import { TmuxShellAgentConnector } from "./tmux-shell-agent-connector.js";

const HOME = process.env["SKILLSCRIPT_HOME"] ?? `${process.env["HOME"]}/.skillscript`;

// Step 1: load config files.
const { config } = loadSkillscriptConfig({ path: `${HOME}/skillscript.config.json` });
const { connectors } = loadConnectorsConfig({ path: `${HOME}/connectors.json` });

// Step 2: construct registry + substrate impls.
const registry = new Registry();
const skillStore = new FilesystemSkillStore(config.skillsDir ?? `${HOME}/skills`);
registry.registerSkillStore("primary", skillStore);

// File-backed data store at $SKILLSCRIPT_HOME/data.json
const dataStore = new FileDataStore({
  filePath: config.dataDbPath ?? `${HOME}/data.json`,
});
registry.registerDataStore("primary", dataStore);

// OpenAI LLM — reads OPENAI_API_KEY from env.
const openai = new OpenAILocalModel({ defaultModel: "gpt-4o-mini" });
registry.registerLocalModel("default", openai);

// tmux-shell agent delivery — map agent IDs to tmux session names.
// Adopters: extend sessionMap with your live agent sessions.
const agentConnector = new TmuxShellAgentConnector({
  sessionMap: {
    "oncall": "agent-oncall",
    "support-lead": "agent-support",
  },
});
registry.registerAgentConnector("primary", agentConnector);

// Step 3: wire bridges so canonical in-skill `$ llm` / `$ data_read` /
// `$ data_write` / `$ skill_read` / `$ skill_write` dispatch through the
// adopter substrates above (case 1 typed-contract wiring — portable). Each
// bridge handles its multi-verb surface via toolName discrimination;
// register the same instance under each connector name so bare-form
// name-match resolution picks the right route.
registry.registerMcpConnector("llm", new LocalModelMcpConnector(openai));
const dataBridge = new DataStoreMcpConnector(dataStore);
registry.registerMcpConnector("data_read", dataBridge);
registry.registerMcpConnector("data_write", dataBridge);
// SkillStore-as-bridge. Makes `$ skill_write` / `$ skill_read` dispatchable
// from inside an executing skill (Lisp-shape: skills program skills).
// In-skill writes are forced to `# Status: Draft` at the bridge layer —
// see `src/connectors/skill-store-mcp.ts` header for the threat-model
// rationale. Outside-MCP `skill_write` (via the wire surface) keeps its
// existing "body declares status" behavior.
const skillBridge = new SkillStoreMcpConnector(skillStore);
registry.registerMcpConnector("skill_read", skillBridge);
registry.registerMcpConnector("skill_write", skillBridge);

// Step 4: wire connectors.json instances (adopter-defined MCP servers).
for (const c of connectors) {
  if (c.instance !== undefined) registry.registerMcpConnector(c.name, c.instance, c.allowedTools);
}

// Step 5: scheduler + MCP server.
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

// Step 6: start.
await wireDeclarativeTriggers({ scheduler, skillStore });
scheduler.start();

// Mount your dashboard / HTTP / MCP-stdio surface on top of `mcpServer` here.

export { registry, scheduler, mcpServer, skillStore, traceStore };
