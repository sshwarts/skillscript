# Adopter playbook

How to wire skillscript-runtime into your deployment. Written for Joe-Programmer: you have your own substrate stack (memory system, agent harness, LLM endpoint, filesystem), and you want skillscript to slot in rather than dictate.

This playbook covers the load-bearing decisions, the two wiring patterns, and the conventions that keep your local modifications upstream-merge-friendly.

## The four substrates skillscript expects

Skillscript-runtime is substrate-neutral and assumes you have (or will choose):

1. **A filesystem** — for skill source files (`.skill.md`), trace records, possibly a memory database. Sandbox via container, chroot, or limited-privilege process — operator's call.
2. **A memory system** — for knowledge retrieval and (in v0.8.x+) memory writes. Could be SQLite-FTS (bundled), a vector database, an in-house store, an Obsidian-style notes system — whatever you already have.
3. **An LLM endpoint** — Ollama running locally (bundled), a hosted API like OpenAI / Anthropic / Azure, or your own inference server.
4. **An agent harness** — where skill output is delivered. Could be tmux sessions, a webhook receiver, an in-house agent runtime, or no harness at all (skills run for their text output only).

Each of these maps to a typed connector contract: `SkillStore`, `MemoryStore`, `LocalModel`, `AgentConnector`. Plus `McpConnector` for any external tool you want to invoke from a skill body.

## Case 1 vs Case 2 — the load-bearing wiring decision

This is the most important architectural choice you'll make.

### Case 1 — typed-contract wiring (substrate-portable)

You implement the typed connector contracts (`MemoryStore`, `LocalModel`, etc.) against your substrate. The v0.7.2 bridge classes (`MemoryStoreMcpConnector`, `LocalModelMcpConnector`) surface them as canonical `$ memory` / `$ llm` dispatch.

```typescript
class MyMemoryStore implements MemoryStore {
  async query(filters: QueryFilters): Promise<PortableMemory[]> { /* ... */ }
  async manifest(): Promise<ManifestInfo> { /* ... */ }
}

registry.registerMemoryStore("primary", new MyMemoryStore());
registry.registerMcpConnector("memory", new MemoryStoreMcpConnector(new MyMemoryStore()));
```

**In skills:**
```
$ memory mode=fts query="customer feedback" limit=10 -> CONTEXT
```

This same skill body runs unchanged against your substrate, against SQLite-FTS (bundled), against Pinecone, against any substrate that conforms to the typed contract. **Skills are portable.**

### Case 2 — MCP-tools wiring (substrate-locked)

Your substrate exposes itself as MCP tools (via a local MCP server or remote one). You wire it as an `McpConnector` (typically `RemoteMcpConnector` for spawned MCP processes) and skills reference its tools by name with substrate-specific kwargs.

```typescript
// connectors.json:
{
  "my_memory": {
    "class": "RemoteMcpConnector",
    "config": {
      "command": "my-memory-mcp-server",
      "args": ["--db", "/var/memory"]
    }
  }
}
```

**In skills:**
```
$ my_memory.search query="customer feedback" vault="team" tags=["urgent"] -> CONTEXT
```

This skill body is locked to `my_memory` — its specific kwargs (`vault`, `tags`) and response shape. To move to a different substrate, every call site has to be rewritten.

### Picking — the tradeoff

| Aspect | Case 1 (typed) | Case 2 (MCP) |
|---|---|---|
| Skill portability | ✓ portable | ✗ substrate-locked |
| Substrate feature coverage | Limited to typed contract | Full substrate surface |
| Implementation effort | Implement typed interface | Wire existing MCP server |
| Best for | Skills you want to ship | Substrate-specific power features |

**The choice is per-skill, not per-substrate.** You can wire both — register `memory` (typed-contract via bridge) AND `my_memory` (MCP) — and let skills opt into portability by which connector name they reference.

For the substrate-portability claim to hold, **the substrates you care about must be Case-1-wired**.

## Joe Programmer setup walkthrough

### 1. Install + initialize

```bash
npm install -g skillscript-runtime
skillfile init --here
```

This creates `~/.skillscript/` with `skills/`, `traces/`, an empty `connectors.json`, and a `config.toml` stub.

### 2. Decide on substrate wiring

For each of the four substrates (memory, LLM, agent harness, MCP tools), decide Case 1 or Case 2. The onboarding scaffold (`examples/onboarding-scaffold/`) is Case 1 end-to-end against file-backed memory + OpenAI + tmux.

### 3. Configure runtime knobs

Create `skillscript.config.json` (v0.7.3) in your `$SKILLSCRIPT_HOME`:

```json
{
  "skillsDir": "${SKILLSCRIPT_HOME}/skills",
  "traceDir": "${SKILLSCRIPT_HOME}/traces",
  "memoryDbPath": "${SKILLSCRIPT_HOME}/memory.json",
  "dashboard": { "port": 7878 }
}
```

`${VAR}` substitutes against `process.env`. See `skillscript.config.json.example` in the repo for the full surface.

### 4. Wire your substrates

**For the bundled CLI path** (no custom code): use `connectors.json` to declare your MCP servers; use `OPENAI_API_KEY` / `OLLAMA_BASE_URL` env vars; run `skillfile dashboard --config ./skillscript.config.json`.

**For custom substrates**: write your own bootstrap. See `examples/custom-bootstrap.example.ts` and `examples/onboarding-scaffold/bootstrap.ts` for complete worked walkthroughs.

If you have a custom JSON-instantiable `McpConnector` class, register it with `registerConnectorClass` before loading config:

```typescript
import { registerConnectorClass, loadConnectorsConfig } from "skillscript-runtime";
import { MyAdopterConnector } from "./my-adopter-connector.js";

registerConnectorClass("MyAdopterConnector", {
  ctor: MyAdopterConnector,
  fromConfig: (cfg) => new MyAdopterConnector(cfg),
});

const { connectors } = loadConnectorsConfig({ path: "./connectors.json" });
```

### 5. Two-instance posture

Running dev-skillscript alongside an adopter-wiring instance on the same machine:

```bash
# dev
skillfile dashboard

# adopter (different port + paths)
SKILLSCRIPT_HOME=/path/to/adopter skillfile dashboard --config /path/to/adopter/skillscript.config.json
```

Each instance reads its own config; ports/paths/db files don't collide.

## Conventions for upstream-merge-friendly modifications

If your wiring needs require modifying skillscript-runtime source (rather than just configuration), follow these conventions to minimize merge friction:

### 1. Prefer dedicated adopter files over editing upstream

Put your code in dedicated paths upstream won't touch:

```
src/connectors/local/my-memory-adapter.ts    ← adopter-owned
src/connectors/local/my-llm-adapter.ts       ← adopter-owned
```

Upstream changes to `src/connectors/memory-store.ts` won't conflict with your `local/` files.

### 2. Use the public registration API; don't edit the closed-set Map

`KNOWN_CONNECTOR_CLASSES` in `src/connectors/config.ts` is upstream-owned. Add your classes via `registerConnectorClass(name, entry)` from your bootstrap instead. Closes the merge-conflict bait of editing that file every release.

### 3. Mark unavoidable upstream-file edits with sentinels

When you genuinely have to edit an upstream file, mark the change:

```typescript
// ADOPTER:myorg — extend dispatch to call our auditor before forward
if (process.env["MYORG_AUDIT"] === "1") { /* ... */ }
```

The `// ADOPTER:myorg —` prefix is greppable across merges; your future-self can re-evaluate whether the modification is still needed when upstream changes the surrounding code.

### 4. Treat `src/bootstrap.ts` as reference, not canonical

The bundled `bootstrap()` is a starting point. For deployments with custom substrates, write your own bootstrap that imports the public APIs (`Registry`, the connector classes, `loadConnectorsConfig`, `loadSkillscriptConfig`, etc.). Modifying the bundled bootstrap creates churn on every upstream release.

See `examples/custom-bootstrap.example.ts` for a worked walkthrough.

## Substrate ship-status (v0.7.3)

| Substrate | Shipped contract | Shipped impls | Shipped bridge |
|---|---|---|---|
| SkillStore | ✓ `load`/`query`/`store`/`update_status` | `FilesystemSkillStore` | n/a |
| MemoryStore | ✓ `query` (read-only) | `SqliteMemoryStore` | ✓ `MemoryStoreMcpConnector` |
| LocalModel | ✓ `run` | `OllamaLocalModel` | ✓ `LocalModelMcpConnector` |
| McpConnector | ✓ `call` | `RemoteMcpConnector`, `CallbackMcpConnector` | n/a |
| AgentConnector | ✓ `list_agents`/`deliver`/`wake`/`manifest` | `NoOpAgentConnector` (default) | n/a |

**Notable v0.7.x gaps the playbook should be honest about:**

- **`MemoryStore.write()` is deferred to v0.8.x** bundled with the auth model. `$ memory_write` documented in v0.7.x docs is paper; the corresponding contract method ships when the auth model lands.
- **4-of-6 trigger sources parse but don't fire.** `cron` and `session: start` work; `event`, `agent-event`, `file-watch`, `sensor` are parser-only stubs. Lands in v0.11+ when the event-bus design completes.
- **Output kinds shrunk in v0.7.3.** `# Output:` accepts `text` / `prompt-context: <agent>` / `template: <agent>` / `file: <path>` / `none`. The pre-v0.7.3 `slack:` and `card:` values were substrate-specific and were dropped — adopters wanting Slack / WhatsApp / Discord / etc. delivery use either `$ slack.post ...` MCP dispatch inside the skill body OR deliver via `prompt-context: <agent>` and let the agent decide.
- **Authorization model is self-permit today.** `approved="..."` kwarg is a non-empty-string check; `# Status: Draft → Approved` is self-promotable by the authoring agent. v0.8.x replaces both with a passthrough-substrate-enforces + non-author-signer model.

## Skill discovery + cross-agent composition

Under Case-1 wiring against a memory substrate that holds skill payloads (e.g., AMP's payload_type model where compiled `.skill.md` artifacts live alongside thread / prose / document entries), skill discovery uses the canonical `$ memory` surface:

```
$ memory mode=fts query="incident triage" limit=5 -> SKILLS
foreach S in ${SKILLS.items}:
    execute_skill(skill_name="${S.name}", ...) -> RESULT
```

This works *only* when the memory substrate is Case-1 wired (typed-contract via bridge). Under Case-2 wiring, you'd need substrate-specific tool calls (`$ amp.search query=... payload_type=skill`) which are non-portable.

## Resources

- **Onboarding scaffold** — `examples/onboarding-scaffold/` — complete adopter deployment with file-backed memory + OpenAI + tmux
- **Custom bootstrap walkthrough** — `examples/custom-bootstrap.example.ts` — registering custom MCP connector classes
- **Connectors example** — `scaffold/connectors.json` — annotated `connectors.json` shape
- **Language reference** — `docs/language-reference.md` — skill syntax + frontmatter + lint codes
- **Architecture** — `docs/ERD.md` — engineering requirements + design rationale
