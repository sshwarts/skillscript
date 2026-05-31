# Onboarding scaffold — file-backed data store + OpenAI + tmux-shell

A complete adopter-deployment example demonstrating substrate-portable wiring for skillscript-runtime. **~200 LOC across three adapter files** plus bootstrap. Copy this directory and modify for your own deployment.

## What this scaffold demonstrates

Skillscript's substrate-portability story is conditional: **typed-contract wiring (Case 1)** keeps skills portable across substrates; **MCP-tools wiring (Case 2)** locks skills to a specific substrate. This scaffold is Case 1 end-to-end.

- **DataStore** → `FileDataStore` (JSON file with simple substring FTS)
- **LocalModel** → `OpenAILocalModel` (HTTP to Chat Completions API)
- **AgentConnector** → `TmuxShellAgentConnector` (delivers to tmux sessions via `send-keys`)

Each impl conforms to the typed contract from `skillscript-runtime/connectors`. Skills authored against this scaffold use the canonical `$ llm prompt=...` and `$ data_read mode=fts query=...` surfaces — *the same calls would work against any other Case-1-wired substrate* (Pinecone, Ollama, Anthropic API, etc.).

## Quick start

```bash
# 1. Install runtime
npm install -g skillscript-runtime

# 2. Copy this directory into your deployment
cp -r examples/onboarding-scaffold ~/my-skillscript-deployment
cd ~/my-skillscript-deployment

# 3. Set up env
export SKILLSCRIPT_HOME=$(pwd)
export OPENAI_API_KEY=sk-...
cp data.example.json data.json  # initial data store seed

# 4. Init skillscript dir layout
skillfile init --here

# 5. (Optional) start a tmux session for the on-call agent
tmux new-session -d -s agent-oncall

# 6. Run via the bundled CLI:
skillfile dashboard --config ./skillscript.config.json

# OR run via the custom bootstrap:
node --loader ts-node/esm bootstrap.ts
```

## Files

| File | Purpose | LOC |
|---|---|---|
| `file-data-store.ts` | `DataStore` impl — JSON file substrate | ~95 |
| `openai-local-model.ts` | `LocalModel` impl — Chat Completions API | ~85 |
| `tmux-shell-agent-connector.ts` | `AgentConnector` impl — tmux send-keys | ~75 |
| `bootstrap.ts` | Wiring — Registry, bridges, scheduler, MCP server | ~75 |
| `connectors.json` | Example adopter-MCP wiring (empty by default) | — |
| `data.example.json` | Seed data file with three example records | — |

## Two-instance posture

To run this scaffold *alongside* an existing skillscript dev instance, just copy the scaffold to a separate directory with its own `skillscript.config.json` pointing at different `dashboard.port` + `skillsDir` + `dataDbPath` etc. The `--config <path>` CLI flag selects which config to use; no two instances will collide on disk or port.

```bash
# dev instance on default port
skillfile dashboard

# adopter instance on a different port
skillfile dashboard --config ./adopter.config.json  # contains "dashboard": { "port": 7879 }
```

## What to modify

For your real deployment, swap each adapter:

- `FileDataStore` → your actual data store (Pinecone, Postgres-pgvector, Obsidian-backed, in-house store, memory broker, etc.)
- `OpenAILocalModel` → your actual LLM (Ollama via the bundled `OllamaLocalModel`, Anthropic via your own adapter, hosted-OpenAI as shown, etc.)
- `TmuxShellAgentConnector` → your actual agent delivery (webhook POST, named-pipe write, your harness's API, etc.)

The skill bodies don't need to change. `$ llm prompt=...` keeps working; `$ data_read mode=fts query=...` keeps working. That's the substrate-portability claim, validated by you wiring different substrates against the same typed contracts.

## Where to go next

- **Adopter playbook** — `docs/adopter-playbook.md` walks through Case 1 vs Case 2 wiring patterns
- **Custom bootstrap walkthrough** — `examples/custom-bootstrap.example.ts` shows registering custom McpConnector classes via `registerConnectorClass`
