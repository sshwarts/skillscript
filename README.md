# Skillscript

*A language for agents to write themselves in.*

[![npm version](https://img.shields.io/npm/v/skillscript-runtime.svg)](https://www.npmjs.com/package/skillscript-runtime)
[![tests](https://img.shields.io/badge/tests-896%2F896-green)](#)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![status](https://img.shields.io/badge/status-pre--1.0-orange)](#status)

> **TL;DR** — `npm install -g skillscript-runtime`, then `skillfile dashboard`. See [Quickstart](#quickstart).

## Contents

- [The problem](#the-problem)
- [The frame](#the-frame)
- [Why a new language](#why-a-new-language)
- [Why not just have the agent write a Skill?](#why-not-just-have-the-agent-write-a-skill)
- [Three kinds of skill](#three-kinds-of-skill)
  - [Waking agents](#waking-agents)
  - [Local models as tools for the frontier](#local-models-as-tools-for-the-frontier)
  - [Composition: skills calling skills](#composition-skills-calling-skills)
  - [Static vs dynamic skills](#static-vs-dynamic-skills)
- [What you get](#what-you-get)
- [The bet](#the-bet)
- [Quickstart](#quickstart)
  - [A canonical autonomous skill](#a-canonical-autonomous-skill)
- [Connector model](#connector-model)
- [CLI](#cli)
- [MCP server surface](#mcp-server-surface)
- [Examples](#examples)
- [Architecture and deep documentation](#architecture-and-deep-documentation)
- [Status](#status)
- [Contributing](#contributing)
- [License](#license)

---

## The problem

AI agents are mostly transient. Every routine task is re-derived from prose reasoning. The agent that summarized a thread yesterday will summarize one tomorrow by reasoning from scratch about how to summarize threads, burning frontier inference on a procedure with a known shape, a known output format, and known failure modes.

The waste compounds in three directions: **cost** (every routine operation runs through the most expensive reasoning layer in the system), **latency** (every operation pays the full inference cost), and **drift** (the same task produces slightly different results each invocation because nothing crystallizes).

The deeper problem is that *agents have no substrate to write themselves down in*. Agents are partly defined by what they can do and what they can do is currently held entirely in a soft, transient form of reasoning at inference time. There's no hard form. No place for an agent to crystallize a learned procedure into something cheap to execute, cheap to inspect, and cheap to improve.

Most agent infrastructure projects today focus on **memory** — episodic recall, retrieval-augmented context, conversation summarization. Those projects answer *"what does the agent know."* They don't answer *"what can the agent do"* in any persistent, executable, inspectable form.

Skillscript intends to answer the second question.

## The frame

**Agents are code, and skillscript is the language they write themselves in.** Not memory in the recall sense. Not prompt templates. Not configuration. Code, in the strict sense of named, typed, composable, executable artifacts that constitute capability.

A skillscript skill is a declarative recipe, a small program with a dependency DAG of typed operations — that an agent authors once and the runtime fires many times. Where typical agent code is procedural (Python scripts, TypeScript handlers), skillscript is **orchestration-only**: it composes calls into tools, models, and memory stores through swappable connector contracts. Computation lives in tools; coordination lives in skills.

```
# Skill: hello
# Status: Approved
# Description: The canonical first-run example.
# Vars: WHO=world

greet:
    emit(text="Hello, ${WHO}!")
    emit(text="Welcome to Skillscript.")

default: greet
```

That's a complete, runnable skill. Five lines, no dependencies, no boilerplate. The same shape scales to multi-stage DAGs that classify inputs, dispatch to LLMs, query memory stores, branch on conditions, and orchestrate sub-agents, all in the same declarative grammar.

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
- **Declarative legibility.** Skills are DAGs of typed dispatches. A human reading a skill sees exactly which tools get called, which memory writes happen, which model prompts fire. The same source produces the same audit diagram every time.
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

The three kinds describe the skill's *role* (who consumes the output). Orthogonal to that is the skill's *delivery channel* — the actual op that ships the result. Three channels are first-class: `emit(text="...")` for embedded prompt-context, `$ memory_write content="..." addressed_to="<agent>"` for memory handoff, and `file_write(path="...", content="...")` for file handoff. A single skill can use any combination. See the [Language Reference](https://github.com/sshwarts/skillscript/blob/main/docs/language-reference.md) §1 for the full taxonomy.

### Waking agents

Augmenting and Template skills don't just write somewhere; they deliver to a frontier agent through `AgentConnector`. The contract is substrate-neutral: a Headless monitor detects a condition, evaluates whether action is warranted, and either resolves silently or calls `AgentConnector.deliver(agent_id, payload)`. The implementation might write a memory the agent reads at next session, post to a chat thread the agent monitors, send a push notification, write to a tmux pane, or invoke a webhook. All the adopter's call.

The runtime ships `NoOpAgentConnector` by default; production deployments wire their own. AgentConnector wiring is embedder-only in v0.7.0 — deployments instantiate a concrete impl in code at runtime startup and register it via the runtime's connector registry, rather than declaring it in `connectors.json`. Common wirings look like:

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

Adopter impls can write to memory, post to a chat thread, send a webhook, write to a tmux pane, or anything else that wakes the receiving agent.

This is what makes *"Headless monitor → wake agent with context"* a real composition primitive, not just a pattern adopters bolt on. Skills don't know what substrate they're waking into; the substrate doesn't know what skill triggered it. The contract handles the seam.

### Local models as tools for the frontier

Most agent systems treat local models as *substitutes* for frontier inference. Call them instead of the frontier when latency or cost matters. Skillscript treats them as something different: *delegation targets the frontier orchestrates*. The frontier composes the workflow; each LLM dispatch is the frontier handing off a bounded sub-task (classify a message, extract a field, judge whether two strings refer to the same thing, summarize a chunk, format a response) to a local or smaller model and consuming the result.

In skillscript, this isn't a separate "local-model interplay" pattern adopters bolt on — it's just **MCP dispatch through a connector named whatever your substrate calls it**. `$ llm prompt="..." -> RESULT` (one shop wires `llm` pointing at Ollama; another wires `openai_chat` against the OpenAI API; another wires `claude_messages` against Anthropic) lives next to any other `$ tool args -> RESULT` in the skill body, with the same op-level discipline, the same trace surface, the same lint coverage. The language has no built-in LLM keyword — adopters wire their substrate.

The cost shape that follows: routine work runs at local-model cost (free at scale, fast, private to the host); the frontier model intervenes only at orchestration boundaries and ambiguous cases. Customer data flowing through bounded sub-tasks never reaches an external API when the wired connector is local. The local-model layer becomes the privacy boundary, not a separate add-on.

### Composition: skills calling skills

A skill can invoke another skill via `execute_skill(...)`:

```
parent:
    execute_skill(skill_name="extract-json-number", JSON_BLOB="${RAW}", FIELD_PATH="total_count") -> RESULT
    emit(text="Extracted: ${RESULT.final_vars.VALUE|trim}")
```

The child skill runs to completion against the runtime's wired connectors, returns its full execution record (final vars, transcript, outputs), and binds to the parent's named variable. Field access on the bound result (`${RESULT.final_vars.X}`) lets the parent reach into whatever the child produced.

Composition is what makes skill libraries accumulate. Utility skills (`extract-json-number`, `summarize-thread`, `classify-urgency`) get authored once and orchestrated forever. The composition primitive is symmetric across the MCP surface — `execute_skill({skill_name, inputs?, mechanical?})` works the same way at the runtime entry point as it does inside a skill body. `mechanical: true` previews the dispatch graph without firing real ops, propagating through nested composition calls. TestFlight your multi-skill chains before commitment.

### Static vs dynamic skills

Skills have an execution model orthogonal to their kind. A **dynamic skill** requires the Skillscript runtime to execute — the runtime walks the DAG, fires dispatches against wired connectors, threads outputs. A **static skill** compiles to a portable artifact that any agent capable of reading prose can execute without the runtime.

The static case matters for shareable artifacts. A skill whose body has only `emit(...)` ops (no `$ tool` MCP dispatches, no `shell(...)`, no `file_read`/`file_write`) compiles to a self-contained recipe. Email it, post it, hand it to a frontier agent in a different environment — they read the compiled output and execute the steps using their own tools. The skill becomes the deliverable.

Template-kind skills are the canonical static shape; their compiled artifact is the prompt the receiving agent acts on. Headless and Augmenting skills are usually dynamic. The axes are independent — author the combination the work calls for.

```
# A static recipe (no runtime dispatches; just procedure + data)
# Skill: triage-customer-tickets
# Status: Approved
# Vars: TICKETS_JSON=[...]

walk:
    emit(text="For each ticket in the input, classify urgency as critical/normal/low.")
    emit(text="For critical tickets, suggest immediate owner from the runbook.")
    emit(text="Input: ${TICKETS_JSON}")

default: walk
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
# Install
npm install -g skillscript-runtime

# Author your first skill
mkdir -p ./skills && cat > ./skills/hello.skill.md <<'EOF'
# Skill: hello
# Status: Approved
# Vars: WHO=world

greet:
    emit(text="Hello, ${WHO}!")

default: greet
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

### A canonical autonomous skill

The hello example is a single static target. A more representative shape is a cron-fired skill that pulls data, processes it, and delivers via file. The example below uses only runtime-intrinsic ops (`shell`, `file_write`, `emit`) — no adopter-wired connectors required, so it runs against a fresh install:

```
# Skill: daily-disk-check
# Status: Approved
# Description: Cron-fired daily disk usage snapshot to /var/log/skillscript/disk.txt.
# Triggers: cron:"0 6 * * *"
# Autonomous: true

snapshot:
    shell(command="df -h --output=source,pcent,target") -> USAGE
    file_write(path="/var/log/skillscript/disk-${EVENT.fired_at_unix}.txt",
               content="${USAGE}",
               approved="cron-fired daily snapshot")
    emit(text="Snapshot written for ${NOW}")

default: snapshot
```

Three things to notice:

1. **`# Triggers: cron:"..."`** — the runtime registers the cron schedule at load time; no external scheduler.
2. **`# Autonomous: true`** — the skill-author's declaration that mutation ops (here `file_write`) are authorized to fire without per-call confirmation. Without this header, mutation ops require the inline `approved="<reason>"` kwarg shown above on each call site. Pick one; both work.
3. **`${EVENT.fired_at_unix}` + `${NOW}`** — ambient refs the runtime substitutes per-fire. `EVENT.*` covers the trigger payload; `NOW` is the ISO timestamp at op dispatch. See [Language Reference §3](docs/language-reference.md) for the full ambient list.

Swap in `$ ticketing_search`, `$ llm`, `$ memory_write` once you've wired connectors, and the same skill shape becomes a real triage pipeline.

## Connector model

Skills don't know what they're talking to. Five contracts decouple language from substrate:

| Contract | Purpose | v0.10 base config |
|---|---|---|
| `SkillStore` | Skill source persistence | `FilesystemSkillStore` (default); switch via `substrate.skill_store` in `connectors.json` |
| `MemoryStore` | Retrieval over a knowledge store | `SqliteMemoryStore` (conditional on dbPath); switch via `substrate.memory_store` |
| `LocalModel` | Local LLM dispatch | **null** (adopter wires explicitly via `substrate.local_model`) |
| `McpConnector` | MCP tool invocation — external dispatch | adopter wires named instances in `connectors.json` |
| `AgentConnector` | Delivery to a frontier agent | adopter wires explicitly (no bundled default) |

Runtime hosts (MCP server + web dashboard) honor whichever substrate the deployment configures. Authoring CLI commands (`skillfile compile`, `skillfile lint`, `skillfile audit`, `skillfile list`) stay filesystem-pinned by design — they're the FS-authoring loop.

See **[`docs/configuration.md`](docs/configuration.md)** for the full substrate config reference.

**v0.7.0 substrate framing.** The canonical syntax routes everything substrate-specific through MCP dispatch — `$ llm prompt="..."` rather than the legacy `~`, `$ memory mode=fts query="..."` rather than the legacy `>`. This keeps skill source portable across adopters who wire different substrates. Pick the connector names that read well at your call sites: `llm`, `memory`, `openai_chat`, `pinecone_query` — whatever matches the substrate.

**Today's reality.** The `LocalModel` and `MemoryStore` contracts back the *legacy* `~` and `>` ops which continue to work during the grace period — Ollama via `LocalModel` (default endpoint `http://localhost:11434`) and SQLite via `MemoryStore`. The canonical `$ llm` / `$ memory` MCP-dispatch paths require an adopter-wired MCP bridge. v0.7.1 will ship generic bridge classes (`LocalModelMcpConnector` + `MemoryStoreMcpConnector`) that wrap the existing contracts as MCP connectors, so any `LocalModel`/`MemoryStore` implementation gets a canonical `$ <name>` dispatch surface. Until then:

- **Use `~ prompt="..." model="qwen" -> R`** to call Ollama today (legacy syntax, fully functional)
- **Use `> mode=fts query="..." limit=10 -> R`** to query the SQLite memory store today
- **Use `$ llm prompt="..."`** only if you've wired an `llm` MCP connector in `connectors.json` (e.g., via `RemoteMcpConnector` pointing at an ollama-mcp server)

The migration tool that ran on `examples/` rewrote everything to canonical form on the assumption that v0.7.1's bridge connectors will land; until then, examples that use `$ llm` / `$ memory` need adopter-wired connectors to execute.

Wire your own by implementing the interface and registering in `connectors.json`. See [`docs/language-reference.md`](docs/language-reference.md) §10 for full contracts.

**Coming from v0.5.x or earlier?** v0.7.0 is a breaking-shape release: symbol-form ops (`~`, `>`, `@`, `!`, `??`, `&`) and `$(VAR)` substitution are deprecated. They still compile in v0.7.x during the grace period; v0.7.1 ships visibility-nudge lints (`deprecated-symbol-op`, `deprecated-substitution-shape`); removal slated for v0.8.x or v0.9. The mechanical rewrite rules are documented in [`CHANGELOG.md`](CHANGELOG.md) under `## 0.7.0 — Migration`. Most adopters writing new skills against canonical surface won't need to migrate anything.

### `connectors.json`

Per-host configuration. The runtime loads it at startup. Two top-level concerns:

1. **`substrate`** (v0.10+) — which `SkillStore` / `MemoryStore` / `LocalModel` the runtime hosts use
2. **Named MCP connector instances** (v0.4.0+) — each becomes a connector referenced via `$ <name>` in skill source

```json
{
  "substrate": {
    "skill_store": "sqlite",
    "memory_store": "sqlite",
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

Substrate short-form (`"sqlite"` etc.) wires bundled defaults. Object form (`{type, config}`) overrides config. See **[`docs/configuration.md`](docs/configuration.md)** for the full schema + adopter-custom impl path.

Two credential shapes:

- **Literal**: `"AUTH_HEADER": "Bearer plnt-XXX..."` — the credential lives in the file
- **Env-var substitution**: `"AUTH_HEADER": "Bearer ${YOUTRACK_TOKEN}"` — `${NAME}` resolves from `process.env` at load time. Missing env var → clear startup error (not silent empty string).

**Credential discipline (hard requirement):** `connectors.json` is secret-bearing. The repo's `.gitignore` excludes it by default. Use the version-controlled `connectors.json.example` as the template — copy it to `connectors.json` (gitignored), fill in real values. For deployments, prefer `${VAR}` substitution over in-file literals; commit the `${...}` references but keep the actual credentials in deployment env.

**Closed-set class registry:** the runtime ships a fixed list of `class:` values it recognizes. v0.4.0 ships with `CallbackMcpConnector` (wired via embedder code only, not configurable from JSON). v0.4.1 adds `RemoteMcpConnector` for the stdio-bridged remote MCP pattern. Plugin-style runtime-arbitrary class loading is deliberately out of scope — see [ARCHITECTURE.md](ARCHITECTURE.md) for the rationale. Use `runtime_capabilities({include:["mcpConnectorClasses"]})` to introspect the available set in your runtime.

## CLI

14 commands cover the full authoring + ops lifecycle:

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
| `skillfile serve [--port N]` | Headless: scheduler + MCP server, no SPA |
| `skillfile dashboard [--port N]` | Same as `serve` plus dashboard SPA at `/` |
| (Trigger management lives in the MCP surface, not the CLI) | |

Run `skillfile <command> --help` for per-command flags. Use `serve` for production / containerized deployments and `dashboard` for development. CLI command names mirror the MCP tool names where they overlap (`execute` ↔ `execute_skill`, `compile` ↔ `compile_skill`, `lint` ↔ `lint_skill`), so authors who learn one surface can transfer immediately to the other.

## MCP server surface

The runtime exposes 13 tools over MCP (HTTP at `/rpc`) for cold-client authoring + observability:

| Category | Tools |
|---|---|
| Skill management | `skill_list`, `skill_metadata`, `skill_status`, `skill_write` |
| Authoring | `lint_skill`, `compile_skill` |
| Composition | `execute_skill` |
| Triggers | `list_triggers`, `register_trigger`, `unregister_trigger` |
| Observability | `health_metrics` |
| Discovery | `runtime_capabilities`, `help` |

This is the "agent reaches MCP" path — an external agent (Claude, GPT, anything that speaks MCP) can author, validate, and deploy skills entirely over the wire. `help()` is the entry point — call with no arguments for a ~500-token quickstart, or with `{topic: "ops" | "frontmatter" | "examples" | "connectors" | "lint-codes"}` for deeper sections. `execute_skill` invokes any stored skill end-to-end against the runtime's connectors, with `mechanical: true` for dry-run preview.

## Examples

Nine curated example skills in [`examples/`](examples/), migrated to canonical v0.7.0 syntax, covering:

- Multi-target DAG with `needs:` dependencies
- Cron triggers with `# OnError:` fallback
- Session-start `prompt-context:` delivery
- `ask(prompt=...)` interactive pattern
- `# Requires:` cascade for compile-time data
- `inline(skill=...)` skill composition
- `execute_skill(...)` skill-to-skill composition

Each example is annotated with the language pattern it demonstrates. The pre-v0.7.0 cold-author harness corpus (R1/R2/R3 from v0.2.9 production) was retired in the v0.7.0 syntax revamp — pre-adoption means no external users depend on backwards-compat regression coverage. The R4 harness round will produce fresh canonical-form fixtures.

## Architecture and deep documentation

- **[Language Reference](docs/language-reference.md)** — canonical spec (1600+ lines, 13 sections). The single source of truth on syntax + semantics.
- **[Configuration](docs/configuration.md)** — `connectors.json` substrate selection + named MCP connector wiring + adopter-custom impl path.
- **[Adopter Playbook](docs/adopter-playbook.md)** — patterns for adopters embedding skillscript-runtime in their own deployment.
- **[Connector Contract Reference](docs/connector-contract-reference.md)** — interface contracts for adopters writing their own connector impls.
- **[SqliteSkillStore](docs/sqlite-skill-store.md)** — the bundled DB-backed SkillStore: schema, semantics, forking checklist.
- **ROADMAP** — *coming soon to docs/*

## Status

**v0.7.3** — pre-1.0, breaking changes still expected through the v0.7→v1.0 arc. The language *shape* locked at v0.7.2 (`${VAR}` substitution, function-call op grammar, substrate-portable connectors); v0.7.3 hardens the adopter surface (canonical config externalization, public `registerConnectorClass` API, onboarding scaffold + adopter playbook, OutputKind substrate-neutrality cleanup).

Test coverage: 998/999 passing (10 skipped, 1 env-gated YouTrack). Narrow-core LOC under the budget per ERD.

What's coming next (per the v0.7.3 → v1.0 roadmap settled in `076bdeac`):
- **v0.8.0** — auth model + `$ memory_write` bundled. Mixed model: op-level mutations passthrough (substrate enforces; runtime threads credentials); skill-level `Draft → Approved` runtime-enforced (non-author signer required). Drops `unconfirmed-mutation` lint under passthrough. New-version-of-same-name returns to Draft on content change. `MemoryStore.write()` contract extension ships `$ memory_write` against the new auth model. See thread `43178c86` for the settled design.
- **R7 cold-author harness** (post-v0.7.3 ship) — empirically tests NFR-6 agent-modifiability against the v0.7.3 file layout. Cold agent adds a filter, a lint rule, and a runtime-intrinsic op; failure modes target which extension point to refactor first. Evidence before refactor.
- **v0.8.x** — tool-schema introspection: `describe_connector(name)` MCP tool exposes per-tool JSON-Schema from MCP `tools/list`; compile-time `mcp-arg-out-of-range` + `mcp-unknown-kwarg` lints
- **v0.9** — pagination / `while` loop primitive; `search_skills` MCP tool for cross-agent discovery; skill-evaluation feedback loop
- **v0.10** — reference `AgentConnector` impls (webhook, memory-handoff) shipped concretely; `# Output:` channel posture explicit
- **v0.11** — Phase 2 trigger sources (event + agent-event + file-watch + sensor)
- **v0.12** — emit-as-binding + op-level `(fallback:)` uniformity; `# Tests:` block
- **v0.13+** — observability for scale-out (per-skill latency/error-rate/aggregate panels); portability stress-test scaffold (vector-DB memory + hosted-API LLM + webhook AgentConnector) as v1.0 gate prep
- **v1.0** — API stability commitment, gates on first external adopter shipping against canonical contracts against a substrate that isn't AMP (not just harness rounds)

## Contributing

Bug reports and feature requests welcome via Issues. PRs accepted but please open an Issue first to discuss the design — skillscript's value proposition rests on a constrained grammar, and not every "small extension" earns its keep.

For language design questions, see the cold-agent-driven precedent in [Open spec questions](docs/language-reference.md#open-spec-questions): if cold-context sub-agents writing skills from spec alone hit the same syntactic friction across multiple authors, that's a signal to extend the language.

## License

MIT. See [LICENSE](LICENSE).

---

*"Made by agents, for agents."* Skills are the agent's programming language.
