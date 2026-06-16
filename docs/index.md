---
title: Skillscript
description: "A language for agents to write themselves in."
---

## The problem

AI agents are mostly transient. Every routine task is re-derived from prose reasoning. The agent that summarized a thread yesterday will summarize one tomorrow by reasoning from scratch about how to summarize threads, burning frontier inference on a procedure with a known shape, a known output format, and known failure modes.

The waste compounds in three directions: **cost** (every routine operation runs through the most expensive reasoning layer in the system), **latency** (every operation pays the full inference cost), and **drift** (the same task produces slightly different results each invocation because nothing crystallizes).

The deeper problem is that *agents have no substrate to write themselves down in*. Agents are partly defined by what they can do and what they can do is currently held entirely in a soft, transient form of reasoning at inference time. There's no hard form. No place for an agent to crystallize a learned procedure into something cheap to execute, cheap to inspect, and cheap to improve.

Most agent infrastructure projects today focus on **memory** — episodic recall, retrieval-augmented context, conversation summarization. Those projects answer *"what does the agent know."* They don't answer *"what can the agent do"* in any persistent, executable, inspectable form.

Skillscript intends to answer the second question.

## The frame

**Agents are code, and skillscript is the language they write themselves in.** Not memory in the recall sense. Not prompt templates. Not configuration. Code, in the strict sense of named, typed, composable, executable artifacts that constitute capability.

A skillscript skill is a declarative recipe, a small program with a dependency DAG of typed operations — that an agent authors once and the runtime fires many times. Where typical agent code is procedural (Python scripts, TypeScript handlers), skillscript is **orchestration-only**: it composes calls into tools, models, and data stores through swappable connector contracts. Computation lives in tools; coordination lives in skills.

```
# Skill: hello
# Status: Approved
# Description: The canonical first-run example.
# Vars: WHO=world

Hello, ${WHO}!
Welcome to Skillscript.
```

That's a complete, runnable skill — and the body text **is** the output. No target, no boilerplate, no `emit()` ceremony: the runtime renders the body against the skill's variables and publishes it. The same shape scales to multi-stage DAGs that classify inputs, dispatch to LLMs, query data stores, branch on conditions, and orchestrate sub-agents, all in the same declarative grammar.

## Why a new language

The obvious alternative is "let the agent write Python." Python is Turing-complete, has mature tooling, and models write it well. For one-shot exploratory work or where computation matters, Python is the right tool, and we're not proposing anyone stop using it for that.

But agent-authored *persistent* automation has a different shape:

- An **agent** (not a human) writes the code.
- The code runs **autonomously** — cron-fired, event-triggered — with no human in the loop at execution time.
- The work is **dispatch-shaped**: call a tool, classify a result, branch, call another tool. Not algorithmic computation.
- The code needs to be **auditable by humans at human tempo** even though it's authored at agent tempo.

For this shape, Python's strengths invert into liabilities:

- **Turing completeness becomes a liability.** An agent-authored script can do anything including things the agent didn't realize were dangerous. `subprocess.run`, arbitrary network calls, file writes. None of these are gated. The blast radius of a buggy agent-authored script is the whole host.
- **Mature tooling doesn't help when the author isn't human.** Debuggers and REPLs are for human iteration. Agents don't iterate that way.
- **Direct execution magnifies failure.** When an agent ships a broken Python script to production cron, there's no validation layer. The script fails silently at 3am and the human discovers it the next day.
- **The package ecosystem becomes an unbounded attack surface.** Agents that can `pip install` anything can install anything — including supply-chain-compromised packages. The package ecosystem assumes human review before adoption; agent adoption breaks that assumption.

Skillscript deliberately constrains expressiveness. It's not Turing complete. It can't `eval`, can't `subprocess`, can't import arbitrary code. **The constraint *is* the safety story** — enforced at the language level, not as an aspiration. In exchange:

- **Sandboxed grammar.** The language can only do what configured connectors permit.
- **Declarative legibility.** Skills are DAGs of typed dispatches. A human reading a skill sees exactly which tools get called, which data writes happen, which model prompts fire. The same source produces the same audit diagram every time.
- **Connector-mediated capability.** Skills don't import packages, they invoke connectors, gated artifacts with curated tool surfaces. Python doesn't disappear from the system; it moves out of the agent's hands and into the connector implementations adopters write deliberately. The safety boundary moves to the connector edge.
- **Static validation before admission.** A skill that fails the linter can't enter the library. Structural issues, missing dependencies, undeclared variables, mutation paths without confirmation gates are caught at authorship time, not at 3am.
- **Asymmetric cost.** Routine work (classify, dispatch, transform) costs local-model tokens. The frontier model is reserved for the small fraction of work that actually needs frontier judgment.

## Why not just have the agent write a Skill?

Skills (Anthropic/OpenAI) are the existing convention for giving agents named, reusable capabilities, hand-authored markdown that loads instructions into the model's context. They work, and skillscript is complementary to them, not competing.

The problem with hand-authoring is that **both authoring populations produce badly-shaped artifacts when working in prose:**

- **Agents authoring markdown produce artifacts shaped for humans, not agents** — verbose explanations, hedging language, redundant context-setting, prose where structure would do. The result is expensive to load, noisy to parse, and hard to maintain.
- **Humans authoring markdown produce the opposite failure modes**. Either ultra-terse and missing context, or kitchen-sink comprehensive in ways that bury the actual procedure under hedges and edge cases.

Making this a programming problem disciplines both populations into the right shape. The grammar doesn't permit rambling. The compiler emits structure, not prose-pretending-to-be-structure.

A skillscript skill **compiles** into an artifact of the same shape as a hand-authored Skill — `# Skill: <name>` header, instructional markdown body — and that artifact can be loaded into an agent's context the same way. Skillscript is what you author *in*; the compiled Skill is what runs. Mature deployments use both: Skills as agent-facing capability descriptions, skillscript as the higher-leverage authoring layer underneath.

## Three kinds of skill

Every skillscript skill is one of three shapes, determined by the relationship to a frontier agent:

| Kind | Output goes to | Use case |
|---|---|---|
| **Headless** | a downstream system or human, consumed asynchronously | Cron-fired monitors, batch processors, autonomous workflows |
| **Augmenting** | a frontier agent's reasoning context, immediately at session start or wake | Session-start briefings, alerts, prepared context |
| **Template** | a frontier agent's execution loop, as a prompt the agent runs itself | Reusable recipes the agent fetches and follows |

The kinds compose. A Headless monitor fires on cron, evaluates a condition, and routes into an Augmenting skill that wakes an agent with context, which itself references a Template skill for the agent to execute.

The three kinds describe the skill's *role* (who consumes the output). Orthogonal to that is *how* the result ships. The default is the **body-text output template**: any non-op text in the skill body is rendered against the skill's final variables and published as its canonical output — no ceremony, as in the `hello` skill above. For what the template can't express, three explicit delivery ops are first-class: `emit(text="...")` for incremental or per-item output, `$ data_write content="..." recipients=[...]` for data handoff, and `file_write(path="...", content="...")` for file handoff. Template and ops coexist — the body template is the canonical output, `emit` lines are additional. See the [Language Reference](/docs/language-reference) §1 for the full taxonomy.

The canonical use for `emit` is per-item output inside a loop, where there's no single template to render — one line per iteration:

```
# Vars: TICKETS=[...]

process:
    foreach T in ${TICKETS}:
        emit(text="${T.id}: ${T.urgency}")

default: process
```

### Local models as tools for the frontier

Most agent systems treat local models as *substitutes* for frontier inference. Call them instead of the frontier when latency or cost matters. Skillscript treats them as something different: *delegation targets the frontier orchestrates*. The frontier composes the workflow; each LLM dispatch is the frontier handing off a bounded sub-task (classify a message, extract a field, judge whether two strings refer to the same thing, summarize a chunk, format a response) to a local or smaller model and consuming the result.

In skillscript, this isn't a separate "local-model interplay" pattern adopters bolt on — it's just **MCP dispatch through a connector named whatever your substrate calls it**. `$ llm prompt="..." -> RESULT` (one shop wires `llm` pointing at Ollama; another wires `openai_chat` against the OpenAI API; another wires `claude_messages` against Anthropic) lives next to any other `$ tool args -> RESULT` in the skill body, with the same op-level discipline, the same trace surface, the same lint coverage. The language has no built-in LLM keyword — adopters wire their substrate.

The cost shape that follows: routine work runs at local-model cost (free at scale, fast, private to the host); the frontier model intervenes only at orchestration boundaries and ambiguous cases. Customer data flowing through bounded sub-tasks never reaches an external API when the wired connector is local. The local-model layer becomes the privacy boundary, not a separate add-on.

### Composition: skills calling skills

A skill can invoke another skill via `execute_skill(...)`:

```
Extracted: ${RESULT.final_vars.VALUE|trim}

parent:
    execute_skill(name="extract-json-number", JSON_BLOB="${RAW}", FIELD_PATH="total_count") -> RESULT

default: parent
```

The child skill runs to completion against the runtime's wired connectors, returns its full execution record (final vars, transcript, outputs), and binds to the parent's named variable. Field access on the bound result (`${RESULT.final_vars.X}`) lets the parent reach into whatever the child produced.

Composition is what makes skill libraries accumulate. Utility skills (`extract-json-number`, `summarize-thread`, `classify-urgency`) get authored once and orchestrated forever. The composition primitive is symmetric across the MCP surface — `execute_skill({name, inputs?, mechanical?})` works the same way at the runtime entry point as it does inside a skill body. `mechanical: true` previews the dispatch graph without firing real ops, propagating through nested composition calls. TestFlight your multi-skill chains before commitment.

### Waking agents

Augmenting and Template skills don't just write somewhere; they deliver to a frontier agent through `AgentConnector`. The contract is substrate-neutral: a Headless monitor detects a condition, evaluates whether action is warranted, and either resolves silently or calls `AgentConnector.deliver(agent_id, payload)`. The implementation might write to a data store the agent reads at next session, post to a chat thread the agent monitors, send a push notification, write to a tmux pane, or invoke a webhook. All the adopter's call.

The runtime ships `NoOpAgentConnector` by default; production deployments wire their own and register it via the runtime's connector registry, rather than declaring it in `connectors.json`. Common wirings look like:

```typescript
// At runtime startup
import { Runtime, AgentConnector } from "skillscript-runtime";

class TmuxAgentConnector implements AgentConnector {
  async deliver(agent_id, payload) {
    // tmux send-keys to the pane for agent_id with payload.content
  }
  async wake(agent_id, opts) { /* ... */ }
  async list_agents() { /* ... */ }
}

const runtime = new Runtime({
  agentConnector: new TmuxAgentConnector(),
  // ...
});
```

Adopter impls can write to a data store, post to a chat thread, send a webhook, write to a tmux pane, or anything else that wakes the receiving agent.

This is what makes *"Headless monitor → wake agent with context"* a real composition primitive, not just a pattern adopters bolt on. Skills don't know what substrate they're waking into; the substrate doesn't know what skill triggered it. The contract handles the seam.

### Static vs dynamic skills

Skills have an execution model orthogonal to their kind. A **dynamic skill** requires the Skillscript runtime to execute — the runtime walks the DAG, fires dispatches against wired connectors, threads outputs. A **static skill** compiles to a portable artifact that any agent capable of reading prose can execute without the runtime.

The static case matters for shareable artifacts. A skill whose body is just an output template or `emit(...)` lines — no `$ tool` MCP dispatches, no `shell(...)`, no `file_read`/`file_write` — compiles to a self-contained recipe. Email it, post it, hand it to a frontier agent in a different environment — they read the compiled output and execute the steps using their own tools. The skill becomes the deliverable.

Template-kind skills are the canonical static shape; their compiled artifact is the prompt the receiving agent acts on. Headless and Augmenting skills are usually dynamic. The axes are independent — author the combination the work calls for.

```
# A static recipe (no runtime dispatches; just procedure + data)
# Skill: triage-customer-tickets
# Status: Approved
# Vars: TICKETS_JSON=[...]

For each ticket in the input, classify urgency as critical/normal/low.
For critical tickets, suggest immediate owner from the runbook.
Input: ${TICKETS_JSON}
```

That compiles to a procedure + data bundle a recipient can run anywhere.

## What you get

**For operators:**

- *Cost reduction at scale.* Routine operations stop hitting frontier inference. As the library matures, an increasing fraction of agent work executes on cheaper substrate, with the frontier model invoked only for orchestration and judgment.
- *Auditability.* Agent behavior becomes inspectable by reading skills, not by trusting agent narration. Renderer, linter, and conformance tests operate on parsed skillscript regardless of where it's stored.
- *Safety boundaries that scale.* The runtime bounds what skills can do via connector configuration, independent of what the authoring agent's tool surface looks like. Mutating operations require explicit user confirmation as a language primitive — visible to static analysis, not dependent on author discipline.
- *Behavioral consistency.* Procedures don't drift across invocations because the procedure is stored, not re-derived. When the procedure needs to change, the change is a versioned edit, not a hope that the agent reasons identically next time.

**For agent capability:**

- *Reduced token budget on routine work.* Authoring a skill is a one-time cost paid against an indefinite stream of cheap executions.
- *Composition over re-derivation.* New tasks built by orchestrating existing skills rather than starting from scratch. Capability accumulates rather than evaporating at the end of each invocation.

## The bet

Skillscript bets that **the majority of agent-authored automation work is dispatch-shaped, not computation-shaped**. Neither agents nor humans produce well-shaped procedural artifacts when authoring in prose. Both populations need the structural discipline of a programming language to converge on the right shape for the work, the audience that runs it, and the audit tooling that has to operate on it.

If that bet is wrong, skillscript stays a nice niche tool. If it's right, skillscript becomes a default substrate for agent-fired automation in the same way SQL became the default substrate for data access: declarative, composable, auditable, and outliving any specific runtime underneath it.

---

## Quickstart

```bash
# Install (global for single-instance use)
npm install -g skillscript-runtime

# Author your first skill — body text IS the output, no target needed
mkdir -p ./skills && cat > ./skills/hello.skill.md <<'EOF'
# Skill: hello
# Status: Approved
# Vars: WHO=world

Hello, ${WHO}!
EOF

# Start the runtime + dashboard
SKILLSCRIPT_HOME=./skills skillfile dashboard --port 7878

# In another terminal, run the skill
skillfile execute hello

# Open the dashboard
open http://localhost:7878
```

Or via Docker / GHCR:

```bash
docker run -p 7878:7878 -v $(pwd)/skills:/skills \
  -e SKILLSCRIPT_HOME=/skills \
  ghcr.io/sshwarts/skillscript-runtime:latest
```

Then add the MCP to your agent. The simplest path on Claude Code (and similar hosts) is to just ask: *"Add the skillscript MCP server at `http://localhost:7878/rpc`"* — the host writes the config for you. Or wire it manually:

```json
{
  "mcpServers": {
    "skillscript": {
      "type": "http",
      "url": "http://localhost:7878/rpc"
    }
  }
}
```

For stdio-only clients, bridge it the same way you'd bridge any HTTP MCP — via `mcp-remote`:

```json
{
  "mcpServers": {
    "skillscript": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:7878/rpc"]
    }
  }
}
```

### A canonical autonomous skill

The hello example is a single static target. A more representative shape is a cron-fired skill that pulls data, processes it, and delivers via file. The example below uses only runtime-intrinsic ops (`shell`, `file_write`, `emit`) — no adopter-wired connectors required, so it runs against a fresh install:

```
# Skill: daily-disk-check
# Status: Approved
# Description: Cron-fired daily disk usage snapshot to /var/log/skillscript/disk.txt.
# Triggers: cron:"0 6 * * *"
# Autonomous: true

Snapshot written for ${NOW}.

snapshot:
    shell(command="df -h --output=source,pcent,target") -> USAGE
    file_write(path="/var/log/skillscript/disk-${EVENT.fired_at_unix}.txt",
               content="${USAGE}")

default: snapshot
```

Four things to notice:

1. **`# Triggers: cron:"..."`** — the runtime registers the cron schedule at load time; no external scheduler.
2. **`# Autonomous: true`** — the skill-author's declaration that mutation ops (here `file_write`) are authorized to fire without per-call confirmation. Without this header, mutation ops require an inline `approved="<reason>"` kwarg on each call site.
3. **`${EVENT.fired_at_unix}` + `${NOW}`** — ambient refs the runtime substitutes per-fire. `EVENT.*` covers the trigger payload; `NOW` is the ISO timestamp at op dispatch. See [Language Reference](/docs/language-reference) for the full ambient list.
4. **Body text above `snapshot:` is the output template** — the runtime renders `Snapshot written for ${NOW}.` against final vars and publishes it as the skill's canonical output. No `emit()` ceremony needed for declarative outputs; see the adopter-playbook's "Output template" section.

Swap in `$ ticketing_search`, `$ llm`, `$ data_write` once you've wired connectors, and the same skill shape becomes a real triage pipeline.

## Connector model

Skills don't know what they're talking to. Five contracts decouple language from substrate:

| Contract | Purpose | Base config |
|---|---|---|
| `SkillStore` | Skill source persistence | `FilesystemSkillStore` (default); switch via `substrate.skill_store` in `connectors.json` |
| `DataStore` | Generic data persistence with query | `SqliteDataStore` (conditional on dbPath); switch via `substrate.data_store` |
| `LocalModel` | Local LLM dispatch | **null** (adopter wires explicitly via `substrate.local_model`) |
| `McpConnector` | MCP tool invocation — external dispatch | adopter wires named instances in `connectors.json` |
| `AgentConnector` | Delivery to a frontier agent | adopter wires explicitly (no bundled default) |

Runtime hosts (MCP server + web dashboard) honor whichever substrate the deployment configures. Authoring CLI commands (`skillfile compile`, `skillfile lint`, `skillfile audit`, `skillfile list`) stay filesystem-pinned by design — they're the FS-authoring loop.

See the [Configuration reference](/docs/configuration) for the full substrate config reference.

Wire your own by implementing the interface and registering in `connectors.json`. See the [Language Reference](/docs/language-reference) for full contracts.

### `connectors.json`

Per-host configuration. The runtime loads it at startup. Two top-level concerns:

1. **`substrate`** — which `SkillStore` / `DataStore` / `LocalModel` the runtime hosts use
2. **Named MCP connector instances** — each becomes a connector referenced via `$ <name>` in skill source

```json
{
  "substrate": {
    "skill_store": "sqlite",
    "data_store": "sqlite",
    "local_model": null
  },

  "youtrack": {
    "class": "RemoteMcpConnector",
    "config": {
      "command": "npx",
      "args": ["mcp-remote", "https://example.youtrack.cloud/mcp"],
      "env": { "AUTH_HEADER": "Bearer ${YOUTRACK_TOKEN}" }
    }
  }
}
```

Substrate short-form (`"sqlite"` etc.) wires bundled defaults. Object form (`{type, config}`) overrides config. See the [Configuration reference](/docs/configuration) for the full schema + adopter-custom impl path.

Two credential shapes:

- **Literal**: `"AUTH_HEADER": "Bearer plnt-XXX..."` — the credential lives in the file
- **Env-var substitution**: `"AUTH_HEADER": "Bearer ${YOUTRACK_TOKEN}"` — `${NAME}` resolves from `process.env` at load time. Missing env var → clear startup error (not silent empty string).

**Credential discipline (hard requirement):** `connectors.json` is secret-bearing. The repo's `.gitignore` excludes it by default. Use the version-controlled `connectors.json.example` as the template — copy it to `connectors.json` (gitignored), fill in real values. For deployments, prefer `${VAR}` substitution over in-file literals; commit the `${...}` references but keep the actual credentials in deployment env.

**Closed-set class registry:** the runtime ships a fixed list of `class:` values it recognizes. `RemoteMcpConnector` is the JSON-instantiable class for the stdio-bridged remote MCP pattern; `CallbackMcpConnector` is wired via embedder code only (not configurable from JSON). Plugin-style runtime-arbitrary class loading is deliberately out of scope. Use `runtime_capabilities({include:["mcpConnectorClasses"]})` to introspect the available set in your runtime.

## CLI

The CLI covers the full authoring + ops lifecycle:

| Command | Purpose |
|---|---|
| `skillfile compile <path\|name>` | Compile a skill to its rendered artifact |
| `skillfile audit <path\|name>` | Compile + content-hash check |
| `skillfile lint <path\|name>` | Tier-1/2/3 lint diagnostics |
| `skillfile execute <path\|name>` | Execute a skill against configured connectors (mirrors `execute_skill` MCP tool; `skillfile run` retained as deprecated alias) |
| `skillfile fires <skill>` | Recent fire history with trace IDs |
| `skillfile diagram <path\|name>` | Mermaid DAG visualization |
| `skillfile sign <path\|name>` | Generate content-hash signature |
| `skillfile verify <path\|name> <hash>` | Verify against a known signature |
| `skillfile replay <trace_id>` | Re-run from a captured trace |
| `skillfile health` | Aggregate runtime health metrics |
| `skillfile register-trigger <skill> <source> <name>` | Register an imperative trigger |
| `skillfile unregister-trigger <trigger_id>` | Remove a registered trigger |
| `skillfile list-triggers` | List registered triggers |
| `skillfile serve [--port N]` | Headless: scheduler + MCP server, no SPA |
| `skillfile dashboard [--port N]` | Same as `serve` plus dashboard SPA at `/` |

Run `skillfile <command> --help` for per-command flags. Use `serve` for production / containerized deployments and `dashboard` for development. CLI command names mirror the MCP tool names where they overlap (`execute` ↔ `execute_skill`, `compile` ↔ `compile_skill`, `lint` ↔ `lint_skill`), so authors who learn one surface can transfer immediately to the other.

## MCP server surface

The runtime exposes its tools over MCP (HTTP at `/rpc`) for cold-client authoring + observability. It also serves `POST /event` for external HTTP-triggered skills when `SKILLSCRIPT_EVENT_INGRESS_ENABLED=true`:

| Category | Tools |
|---|---|
| Skill management | `skill_list`, `skill_metadata`, `skill_read`, `skill_status`, `skill_write` |
| Data | `data_read` |
| Authoring | `lint_skill`, `compile_skill` |
| Composition | `execute_skill` |
| Triggers | `list_triggers`, `register_trigger`, `unregister_trigger`, `set_trigger_enabled` |
| Observability | `health_metrics`, `blocked_shell_attempts` |
| Discovery | `runtime_capabilities`, `help` |

This is the "agent reaches MCP" path — an external agent (Claude, GPT, anything that speaks MCP) can author, validate, and deploy skills entirely over the wire. `help()` is the entry point — call with no arguments for a ~500-token quickstart, or with `{topic: "ops" | "frontmatter" | "examples" | "connectors" | "lint-codes" | "composition"}` for deeper sections. `execute_skill` runs a skill end-to-end against the runtime's connectors in either of two modes: `{name}` invokes a stored skill (subject to the hash-token approval gate); `{source}` runs an ad-hoc inline body that's never persisted (one-off scripting without polluting the store). Both modes honor `mechanical: true` for dispatch-graph preview, and enforce the mutation gate at runtime so `$ data_write` / `file_write` without `# Autonomous: true` / `??` / `approved=...` throw `UnconfirmedMutationError` regardless of which mode invoked them.

## Examples

Curated example skills in [`examples/`](https://github.com/sshwarts/skillscript/tree/main/examples), covering:

- Multi-target DAG with `needs:` dependencies
- Cron triggers with `# OnError:` fallback
- Session-start `# Output: agent:` delivery
- `# Requires:` cascade for compile-time data
- `inline(skill=...)` skill composition
- `execute_skill(...)` skill-to-skill composition

Each example is annotated with the language pattern it demonstrates.

## Architecture and deep documentation

- **[Language Reference](/docs/language-reference)** — canonical spec. The single source of truth on syntax + semantics.
- **[Configuration](/docs/configuration)** — `connectors.json` substrate selection + named MCP connector wiring + adopter-custom impl path.
- **[Adopter Playbook](/docs/adopter-playbook)** — patterns for adopters embedding skillscript-runtime in their own deployment.
- **[Adopter Agent Guide](/docs/adopter-agent-guide)** — how to wire your agent's instruction file so it uses Skillscript instead of ignoring it.
- **[Connector Contract Reference](/docs/connector-contract-reference)** — interface contracts for adopters writing their own connector impls.
- **[SqliteSkillStore](/docs/sqlite-skill-store)** — the bundled DB-backed SkillStore: schema, semantics, forking checklist.

## Status

Pre-1.0, no external adopters. Core language stable; connector contracts locked; distribution polish in progress.

## Contributing

Bug reports and feature requests welcome via [Issues](https://github.com/sshwarts/skillscript/issues). PRs accepted but please open an Issue first to discuss the design — skillscript's value proposition rests on a constrained grammar, and not every "small extension" earns its keep.

## License

MIT. See [LICENSE](https://github.com/sshwarts/skillscript/blob/main/LICENSE).

---

*"Made by agents, for agents."* Skills are the agent's programming language.
