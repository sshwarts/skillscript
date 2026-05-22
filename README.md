# Skillscript

> A small declarative language for authoring agent workflows.

**Status: v1 in progress (current release: 0.2.3).** The public API, language syntax, and connector contracts may change before v1.0.0. Expect breakage until then.

A skillscript is a declarative recipe — a small program with a dependency DAG of named targets, each composed of typed operations. Skills are authored once and executed many times, either by the interpreter (autonomous, cron-fired) or by an agent reading a compiled prompt artifact.

The runtime is substrate-neutral. Bundled reference connectors back filesystem, SQLite, Ollama, and an MCP scaffold; adapter implementations against other backings (cloud key-value stores, hosted LLMs, vector DBs) live in separate packages that consume the public connector contracts exported here.

---

## Table of contents

1. [Installation](#installation)
2. [Quickstart: author and run a skill](#quickstart-author-and-run-a-skill)
3. [CLI reference](#cli-reference)
4. [Browser dashboard](#browser-dashboard)
5. [Container deployment](#container-deployment)
6. [Language overview](#language-overview)
7. [Connector model](#connector-model)
8. [External adapters](#external-adapters)
9. [Library API](#library-api)
10. [Contributing](#contributing)
11. [License](#license)

---

## Installation

### npm (recommended)

```sh
npm install -g skillscript-runtime
skillfile --version
```

This installs the `skillfile` binary globally. Requires Node.js ≥ 22.5 (the runtime uses `node:sqlite` and other features that landed in 22.5+).

### From source

```sh
git clone https://github.com/sshwarts/skillscript-runtime.git
cd skillscript-runtime
pnpm install
pnpm run build
node dist/cli.js --help
```

The repo uses pnpm for reproducible installs. `pnpm run build` compiles TypeScript to `dist/` and copies dashboard assets into place.

---

## Quickstart: author and run a skill

```sh
# 1. Scaffold the config tree
skillfile init

# 2. Inspect the bundled hello example
cat ~/.skillscript/examples/hello.skill.md

# 3. Run it (no Ollama, no MCP, no external state required)
skillfile run examples/hello.skill.md
# → Hello, world!

# 4. Override an input
skillfile run hello --input WHO=Scott
# → Hello, Scott!
```

A minimal `.skill.md` looks like:

```skillscript
# Skill: greet
# Status: Draft
# Vars: WHO=world

greet:
    ! Hello, $(WHO)!

default: greet
```

Save that as `greet.skill.md` and run `skillfile run ./greet.skill.md`. The `!` op emits a message; the dispatcher walks the dependency DAG from `default:` backward.

Lint as you go:

```sh
skillfile lint ./greet.skill.md
```

Compile to a prompt artifact (the form an agent consumes when it dispatches a skill mid-conversation):

```sh
skillfile compile ./greet.skill.md
# Writes greet.skill.provenance.json sidecar with content hashes
```

---

## CLI reference

All 13 commands. Run `skillfile <command> --help` for per-command options + examples.

| Command | Purpose |
|---|---|
| `init` | Scaffold `~/.skillscript/` tree + bundled example |
| `run <path\|name>` | Compile + execute a skill end-to-end |
| `compile <path\|name>` | Render the compiled artifact (no execution) |
| `audit <provenance-path>` | Detect recompile-staleness via `.provenance.json` sidecar |
| `lint <path\|name>` | Run static validation, print findings |
| `list` | List available skills in the configured SkillStore |
| `fires <skill>` | List recent trace records for a skill |
| `diagram <path\|name>` | Emit mermaid graph of the skill's control flow |
| `sign <path\|name>` | Content-hash sign the skill source (SHA-256) |
| `verify <path\|name> <hash>` | Verify the skill matches a signature |
| `replay <trace_id>` | Re-run a recorded trace mechanically |
| `health` | Aggregate runtime metrics across all traces |
| `dashboard` | Start the runtime host: scheduler + MCP server + browser dashboard SPA |

> Trigger registration is handled through the MCP server exposed by `skillfile dashboard` (`register_trigger` / `unregister_trigger` / `list_triggers` tools). The v0.2.0 CLI register-trigger family was removed in v0.2.1 — those commands constructed throwaway in-memory schedulers and never fired.

Environment variables:

| Var | Default | Purpose |
|---|---|---|
| `SKILLSCRIPT_HOME` | `~/.skillscript` | Config + data root |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint for LocalModel dispatch |

---

## Browser dashboard

The runtime ships with a browser dashboard for non-CLI operators. Five views: overview, skills, triggers, connectors, plus a skill detail drilldown. 30-second polling; write paths for status transitions and trigger CRUD. Localhost-only by default — no authentication in v1.

```sh
skillfile dashboard
# → http://127.0.0.1:7878
```

Options:

```sh
skillfile dashboard --port 8080            # custom port
skillfile dashboard --host 0.0.0.0         # bind all interfaces (container only)
```

The dashboard talks to the runtime via an MCP server contract (JSON-RPC 2.0 over HTTP at `/rpc`). Real MCP clients (Claude Desktop, Cursor, future tools) can consume the same endpoint — the SPA is one of several possible UIs over the same contract. **Eleven tools** today: `skill_list`, `skill_metadata`, `skill_status` (write), `list_triggers`, `register_trigger` (write), `unregister_trigger` (write), `health_metrics`, `runtime_capabilities`, `lint_skill`, `compile_skill`, `skill_write` (write). The last three (v0.2.3) close the over-the-wire authoring lifecycle — foreign clients can lint → compile → write → status → register_trigger end-to-end without filesystem access.

---

## Container deployment

The repo ships a multi-stage Dockerfile + `docker-compose.yml`. The image bundles the runtime, CLI, and dashboard SPA in one Node process.

```sh
docker compose up --build              # default profile: dashboard
# → http://127.0.0.1:7878
```

Profiles:

```sh
docker compose --profile tools run --rm tools lint my-skill.skill.md
docker compose --profile ollama up     # adds Ollama for LocalModel
```

Persistent state (`SKILLSCRIPT_HOME=/data`) mounts as a volume so skills + traces survive restarts. The host port mapping (`127.0.0.1:7878:7878`) keeps the dashboard reachable only from localhost even though the container itself binds `0.0.0.0` internally.

### Pulling from a registry

Images publish to GitHub Container Registry:

```sh
docker pull ghcr.io/sshwarts/skillscript-runtime:latest
# or pin to a specific version
docker pull ghcr.io/sshwarts/skillscript-runtime:v0.2.3
```

Authentication (`gh auth login` then `gh auth token | docker login ghcr.io -u sshwarts --password-stdin`) is only required for pushes; pulls are public.

---

## Language overview

A skill is markdown with structured headers and a body of named targets:

```skillscript
# Skill: weather-brief
# Status: Approved
# Vars: CITY=Asheville
# Requires: user-var:home_location -> CITY (fallback: Asheville)
# Triggers: cron: */30 * * * *

fetch needs:
    ~ memory-store.get key="weather:$(CITY|url)" -> CACHED

forecast: fetch
    if $(CACHED):
        $set FORECAST = $(CACHED)
    else:
        > local-model.complete prompt="Brief weather for $(CITY)" -> FORECAST
        ~ memory-store.set key="weather:$(CITY|url)" value=$(FORECAST)

emit: forecast
    ! Weather for $(CITY): $(FORECAST)

default: emit
```

Eight typed operations (`!` emit, `?` ask, `??` ask-for-input, `$` set, `~` retrieve, `>` complete, `@` shell, `&` invoke-skill), three control-flow constructs (`if`/`elif`/`else`, `foreach`, `needs:`), and a small set of headers (`# Skill:`, `# Status:`, `# Vars:`, `# Requires:`, `# Triggers:`, `# Output:`, `# Timeout:`, `# OnError:`, `# Type:`).

**Full canonical reference**: [`docs/language-reference.md`](./docs/language-reference.md) — syntax, ops, semantics, lifecycle, connectors, error handling, all 1500+ lines.

---

## Connector model

The runtime depends on five pluggable connector contracts:

| Contract | Purpose | Bundled reference impl |
|---|---|---|
| `SkillStore` | Persist + version + filter skills | `FilesystemSkillStore` (filesystem) |
| `MemoryStore` | Cache + query memory data with TTL | `SqliteMemoryStore` (`node:sqlite`) |
| `LocalModel` | Dispatch `>` and `~` ops to a local LLM | `OllamaLocalModel` (HTTP to Ollama) |
| `McpConnector` | Dispatch `$` and `~` ops via MCP tools | `CallbackMcpConnector` (in-process) |
| `AgentConnector` | Deliver to / wake a frontier agent (T7.1) | `NoOpAgentConnector` (warns + discards) |

Wire your own impls through `Registry`:

```typescript
import { Registry } from "skillscript-runtime";
import { MyRedisSkillStore } from "./my-adapter.js";

const registry = new Registry();
registry.registerSkillStore(new MyRedisSkillStore({ url: "redis://..." }));
registry.registerLocalModel(new OllamaLocalModel());
// ... use with execute() or Scheduler
```

The connector resolution cascade (`# Requires:` → static capability check → runtime dispatch) is described in detail in [`docs/ERD.md`](./docs/ERD.md) §3 and the [language reference](./docs/language-reference.md).

---

## External adapters

The connector contracts are exported under `skillscript-runtime/connectors`:

```typescript
import type {
  SkillStore, MemoryStore, LocalModel, McpConnector, AgentConnector,
  StaticCapabilities, ManifestInfo,
} from "skillscript-runtime/connectors";

export class MyCloudMemoryStore implements MemoryStore {
  staticCapabilities(): StaticCapabilities {
    return { connector_type: "memory-store", features: { ttl: true, query: true } };
  }
  // ... implement get / set / delete / query / snapshot / manifestInfo
}
```

Adapter packages can ship publicly (npm) or privately (internal registries). The runtime treats all adapters identically as long as they conform to the typed contract. The `skillscript-runtime/testing` entry point exports `SkillStoreConformance`, `MemoryStoreConformance`, `LocalModelConformance`, `McpConnectorConformance`, and `AgentConnectorConformance` — drop-in test suites that adapter authors run against their implementation to verify contract conformance before shipping.

### AgentConnector — delivery to frontier agents

Augmenting and Template skill outputs (`# Output: prompt-context: <agent>` and `# Output: template: <agent>`) deliver through `AgentConnector.deliver`. The contract surfaces three verbs (`list_agents`, `deliver`, `wake`) plus an optional `agent_status` probe. Substrate examples:

| Substrate | `deliver` impl | `wake` impl |
|---|---|---|
| tmux session | `tmux send-keys` to a pane | `tmux send-keys` with wake prompt |
| webhook | POST to `/augment` or `/template` endpoint | POST to `/wake` endpoint |
| file-watch | write to `<path>/augment-<id>.txt` | write to `<path>/wake-<id>.txt` |
| Slack thread | post to monitored thread | post + @mention |
| IPC named pipe | write to delivery pipe | write to wake pipe |

The bundled `NoOpAgentConnector` is the default — it logs a one-line warning and discards the payload, so the runtime starts cleanly when no agent substrate is wired. Production deployments wire a real impl through `Registry.registerAgentConnector()`.


```typescript
import { describe } from "vitest";
import { SkillStoreConformance } from "skillscript-runtime/testing";
import { MyCloudSkillStore } from "./my-cloud-skill-store.js";

describe("MyCloudSkillStore", () => {
  SkillStoreConformance(() => new MyCloudSkillStore({ /* fixture config */ }));
});
```

---

## Library API

Embedders consume the runtime as a library rather than via CLI:

```typescript
import { compile, execute, lint, Registry, Scheduler } from "skillscript-runtime";
import { FilesystemSkillStore } from "skillscript-runtime/connectors";
import { FilesystemTraceStore } from "skillscript-runtime/trace";

const skillStore = new FilesystemSkillStore("./skills");
const traceStore = new FilesystemTraceStore("./traces");
const registry = new Registry();
registry.registerSkillStore(skillStore);

const scheduler = new Scheduler({ registry, skillStore, traceStore });
const result = await scheduler.dispatchSkill("hello", { WHO: "Scott" });
console.log(result.emissions);
```

Subpath exports for adapter authors and embedders who want narrower imports:

| Path | Content |
|---|---|
| `skillscript-runtime` | Main barrel — everything |
| `skillscript-runtime/connectors` | Connector contracts + Registry + bundled impls |
| `skillscript-runtime/errors` | `OpError` + subclasses, `LintFailureError`, `ConnectorError` |
| `skillscript-runtime/runtime` | `execute()` + helpers |
| `skillscript-runtime/trace` | `TraceStore`, `FilesystemTraceStore`, sampling |
| `skillscript-runtime/metrics` | `healthMetrics()` aggregator |
| `skillscript-runtime/scheduler` | `Scheduler` + `TriggerRegistration` |
| `skillscript-runtime/mcp-server` | `McpServer` + JSON-RPC types |
| `skillscript-runtime/testing` | Contract conformance suites |

---

## Contributing

The codebase prioritizes a small, agent-modifiable core. The narrow runtime + compiler + lint + connectors set lives under 5K LOC; CLI, dashboard, MCP server, and observability surfaces are tracked separately. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for a file-by-file map and [`docs/ERD.md`](./docs/ERD.md) for the engineering requirements.

Pre-flight checks:

```sh
pnpm run typecheck
pnpm run loc-check       # enforces ERD §1 LOC ceiling
pnpm test                # 473+ tests
```

Full `CONTRIBUTING.md` lands in v1.x.

---

## License

MIT. See [`LICENSE`](./LICENSE).
