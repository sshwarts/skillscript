// Onboarding scaffold: complete bootstrap wiring file-backed memory +
// OpenAI LLM + tmux-shell AgentConnector. v0.7.3.
//
// Copy this file into your deployment and modify substrate choices to
// match your environment. The shape is:
//   1. Construct a Registry
//   2. Register your substrate impls (SkillStore + LocalModel + MemoryStore + AgentConnector)
//   3. Wire bridges so canonical `$ llm` / `$ memory` dispatch works
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
// Note: LocalModelMcpConnector + MemoryStoreMcpConnector are bridge classes
// already exported from skillscript-runtime/connectors. They wrap any
// typed-contract impl as an MCP-dispatchable connector.
import {
  LocalModelMcpConnector,
  MemoryStoreMcpConnector,
} from "skillscript-runtime/connectors";

import { FileMemoryStore } from "./file-memory-store.js";
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

// File-backed memory at $SKILLSCRIPT_HOME/memory.json
const memoryStore = new FileMemoryStore({
  filePath: config.memoryDbPath ?? `${HOME}/memory.json`,
});
registry.registerMemoryStore("primary", memoryStore);

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

// Step 3: wire bridges so `$ llm` / `$ memory` dispatch through the
// adopter substrates above (case 1 typed-contract wiring — portable).
registry.registerMcpConnector("llm", new LocalModelMcpConnector(openai));
registry.registerMcpConnector("memory", new MemoryStoreMcpConnector(memoryStore));

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
