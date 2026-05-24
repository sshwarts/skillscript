# Skillscript

*A language for agents to write themselves in.*

[![npm version](https://img.shields.io/npm/v/skillscript-runtime.svg)](https://www.npmjs.com/package/skillscript-runtime)
[![tests](https://img.shields.io/badge/tests-646%2F646-green)](#)
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
    ! Hello, $(WHO)!
    ! Welcome to Skillscript.

default: greet
```

That's a complete, runnable skill. Five lines, no dependencies, no boilerplate. The same shape scales to multi-stage DAGs that classify inputs, dispatch to local models, write to memory, branch on conditions, and orchestrate sub-agents, all in the same declarative grammar.

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
- **Static validation before admission.** A skill that fails the linter can't enter the library. Structural issues , missing dependencies, undeclared variables, mutation paths without confirmation gates are caught at authorship time, not at 3am.
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

The kinds compose. A Headless monitor fires on cron, evaluates a condition, and routes into an Augmenting skill that wakes an agent with context, which itself references a Template skill for the agent to execute. See the [Language Reference](https://github.com/sshwarts/skillscript/blob/main/docs/language-reference.md) §1 for the full taxonomy.

### Waking agents

Augmenting and Template skills don't just write somewhere; they deliver to a frontier agent through `AgentConnector`. The contract is substrate-neutral: a Headless monitor detects a condition, evaluates whether action is warranted, and either resolves silently or calls `AgentConnector.deliver(agent_id, payload)`. The implementation might write a memory the agent reads at next session, post to a chat thread the agent monitors, send a push notification, write to a tmux pane, or invoke a webhook. All the adopter's call.

The runtime ships `NoOpAgentConnector` by default; production deployments wire their own.

This is what makes *"Headless monitor → wake agent with context"* a real composition primitive, not just a pattern adopters bolt on. Skills don't know what substrate they're waking into; the substrate doesn't know what skill triggered it. The contract handles the seam.

### Local models as tools for the frontier

Most agent systems treat local models as *substitutes* for frontier inference. Call them instead of the frontier when latency or cost matters. Skillscript treats them as something different: *delegation targets the frontier orchestrates*. The frontier composes the workflow; each `~` op is the frontier dispatching a bounded sub-task (classify a message, extract a field, judge whether two strings refer to the same thing, summarize a chunk, format a response) to a local model and consuming the result.

In skillscript, this isn't a separate "local-model interplay" pattern adopters bolt on — it's a *first-class language operation*. `~ prompt="..." model="qwen" -> RESULT` lives next to `$ tool.call args="..." -> RESULT` in the skill body, with the same op-level discipline, the same trace surface, the same lint coverage. Local models become tools the frontier model can wield through skills, on the same footing as MCP tools and memory reads.

The cost shape that follows: routine work runs at local-model cost (free at scale, fast, private to the host); the frontier model intervenes only at orchestration boundaries and ambiguous cases. Customer data flowing through `~` ops never reaches an external API. The local-model layer becomes the privacy boundary, not a separate add-on.

### Composition: skills calling skills

A skill can invoke another skill via the `$ execute_skill` op:

```
parent:
    $ execute_skill skill_name="extract-json-number" JSON_BLOB=$(RAW) FIELD_PATH=total_count -> RESULT
    ! Extracted: $(RESULT.final_vars.VALUE|trim)
```

The child skill runs to completion against the runtime's wired connectors, returns its full execution record (final vars, transcript, outputs), and binds to the parent's named variable. Field access on the bound result (`$(RESULT.final_vars.X)`) lets the parent reach into whatever the child produced.

Composition is what makes skill libraries accumulate. Utility skills (`extract-json-number`, `summarize-thread`, `classify-urgency`) get authored once and orchestrated forever. The composition primitive is symmetric across the MCP surface — `execute_skill({skill_name, inputs?, mechanical?})` works the same way at the runtime entry point as it does inside a skill body. `mechanical: true` previews the dispatch graph without firing real ops, propagating through nested composition calls. TestFlight your multi-skill chains before commitment.

### Static vs dynamic skills

Skills have an execution model orthogonal to their kind. A **dynamic skill** requires the Skillscript runtime to execute — the runtime walks the DAG, fires dispatches against wired connectors, threads outputs. A **static skill** compiles to a portable artifact that any agent capable of reading prose can execute without the runtime.

The static case matters for shareable artifacts. A skill whose body has only emission ops (no dispatching `$` / `~` / `@` / `>` ops) compiles to a self-contained recipe. Email it, post it, hand it to a frontier agent in a different environment — they read the compiled output and execute the steps using their own tools. The skill becomes the deliverable.

Template-kind skills are the canonical static shape; their compiled artifact is the prompt the receiving agent acts on. Headless and Augmenting skills are usually dynamic. The axes are independent — author the combination the work calls for.

```
# A static recipe (no runtime dispatches; just procedure + data)
# Skill: triage-customer-tickets
# Status: Approved
# Vars: TICKETS_JSON=[...]

walk:
    ! For each ticket in the input, classify urgency as critical/normal/low.
    ! For critical tickets, suggest immediate owner from the runbook.
    ! Input: $(TICKETS_JSON)

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
    ! Hello, $(WHO)!

default: greet
EOF

# Start the runtime + dashboard
SKILLSCRIPT_HOME=./skills skillfile dashboard --port 7878

# In another terminal, run the skill
skillfile run hello

# Open the dashboard
open http://localhost:7878
```

Or via Docker / GHCR:

```bash
docker run -p 7878:7878 -v $(pwd)/skills:/skills \
  -e SKILLSCRIPT_HOME=/skills \
  ghcr.io/sshwarts/skillscript-runtime:latest
```

## Connector model

Skills don't know what they're talking to. Five contracts decouple language from substrate:

| Contract | Purpose | Routes |
|---|---|---|
| `SkillStore` | Skill source persistence | `.skill.md` files (filesystem default) |
| `MemoryStore` | Retrieval over an external knowledge store | `>` ops |
| `LocalModel` | Local LLM dispatch (Ollama default) | `~` ops |
| `McpConnector` | MCP tool invocation | `$` ops |
| `AgentConnector` | Delivery to a frontier agent | `prompt-context:` and `template:` outputs |

Wire your own by implementing the interface and registering in `connectors.json`. See [`docs/language-reference.md`](docs/language-reference.md) §10 for full contracts.

### `connectors.json` (v0.4.0)

Per-host MCP connector configuration. The runtime loads it at startup; each top-level entry becomes a named connector instance referenced via `$ name.tool` in skill source.

```json
{
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

Seven curated example skills in [`examples/`](examples/), covering:

- Multi-target DAG with `needs:` dependencies
- Cron triggers with `# OnError:` fallback
- Session-start `prompt-context:` delivery
- `??` interactive ask-user pattern
- `# Requires:` cascade for compile-time data
- `&` skill composition
- `$ execute_skill` skill-to-skill composition

Each example is annotated with the language pattern it demonstrates. Authored from spec by cold-context sub-agents — they double as conformance fixtures. The full regression-fixture set in `tests/fixtures/harness/` covers 60+ cold-author skills spanning one-shots, cron monitors, compositions, augmenting deliveries, and intentional edge-case probes — that's the broader cold-author corpus the language is hardened against.

## Architecture and deep documentation

- **[Language Reference](docs/language-reference.md)** — canonical spec (1600+ lines, 13 sections). The single source of truth on syntax + semantics.
- **ROADMAP** — *coming soon to docs/*

## Status

**v0.2.10** — pre-1.0, breaking changes expected. The language is stable enough to author production skills; the surrounding tooling (CLI, dashboard, MCP server contract) may evolve before v1.0.

Test coverage: 646/646 passing. Narrow-core LOC under the 5100/20-file ceiling per ERD.

What's coming next:
- AgentConnector reference adapters — bundled implementations for tmux pane / TTY-injection / file-watch / webhook substrates so adopters can plug `prompt-context:` / `template:` deliveries into real receivers without writing their own connector first
- **Dispatch discovery surface** — shell-binary inventory (what's on PATH) + MCP tool catalog aggregation (what each wired connector exposes), so cold authors can discover the full primitive surface before writing
- **Parallel dispatch primitive** — explicit concurrency for independent sub-skill invocations (the largest unanimous request from the cold-author harness)
- T8 — private AMP adapters consuming the now-complete public connector contracts

## Contributing

Bug reports and feature requests welcome via Issues. PRs accepted but please open an Issue first to discuss the design — skillscript's value proposition rests on a constrained grammar, and not every "small extension" earns its keep.

For language design questions, see the cold-agent-driven precedent in [Open spec questions](docs/language-reference.md#open-spec-questions): if cold-context sub-agents writing skills from spec alone hit the same syntactic friction across multiple authors, that's a signal to extend the language.

## License

MIT. See [LICENSE](LICENSE).

---

*"Made by agents, for agents."* Skills are the agent's programming language.
