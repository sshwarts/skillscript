# Skillscript Language Reference — syntax, ops, semantics

Canonical language reference for skillscript. Audience: skill authors (human + agent). Specifies what is valid syntax, what behavior to expect at compile + runtime, and what is currently pending implementation.

Source-of-truth replaces the historical `d9dbb2a6` spec atom (which lived as a section of the AMP architecture doc). Implementation state cross-referenced to commit hashes; pending items mark v2/v3 work.

Companion docs under the Skillscript project anchor (`cc2d7cfb`):
- `skillscript-prd` — product positioning, value prop, roadmap
- `skillscript-erd` — engineering requirements, system architecture, runtime mechanics

## Overview & language model — declarative dispatch DAG, goal-directed execution

Skillscript is a constrained domain-specific language for authoring agent workflows. A skillscript is a declarative recipe: a small program with a dependency DAG of named targets, each composed of typed operations. Skillscripts are written once and executed many times.

## Language model

**Declarative DAG, not imperative script.** A skillscript declares targets and their dependencies (`needs:` keyword); the interpreter topologically sorts and executes them in dependency order. Write blocks in any order — the runtime walks the graph.

**Goal-directed, not entry-point-directed.** The `default:` declaration names the *goal target* — the terminal node whose result is the skill's output. The runtime walks dependencies backward from the goal through the topo-sort. A skill with a single target obscures this (goal == entry trivially); skills with multi-target DAGs make the shape visible.

**Authored by agents, executed by interpreter or compiled to agent prompts.** Two execution paths from the same source:
- **Runtime-mediated** — the interpreter walks ops and dispatches them directly through configured connectors (MemoryStore, LocalModel, MCP). Used for autonomous fires (cron, session-triggered, event-triggered). Safety boundary is the connector config.
- **Agent-mediated** — the compiler renders the skill as a prompt; an agent reads the prompt and executes ops through its own tools (Bash, MCP clients, etc.). Used when an agent invokes a skill mid-conversation. Safety boundary is the agent's harness tool permissions.

The language is identical in both paths. The execution model is a deployment-time + invocation-time decision.

## Anatomy of a skill

```
# Skill: get-weather
# Description: Fetch current weather for the user's location
# Vars: LOCATION=ip-based, UNITS=imperial
# Requires: user-var:location -> LOCATION (fallback: ip-based)
# Triggers:
# Output: text

fetch:
    @ curl -s "wttr.in/$(LOCATION|url)?format=j1" -> RAW
    ~ prompt="Format weather summary: $(RAW)" -> SUMMARY
    ! $(SUMMARY)

default: fetch
```

Three layers of declaration:
1. **Header metadata** (`# Key: value` lines) — name, description, declared variables, dependencies, triggers, output routing, error fallbacks
2. **Targets** — named blocks of typed ops, optionally with `needs:` dependencies
3. **`default:`** — names the goal target the runtime walks toward

## Storage and identity

Skillscripts are stored in AMP as memories with `payload_type: "skill"`. Vault: `team` (shared infrastructure, not private data). Unique by name within team vault — writing a skill with an existing name updates in place (same ID, same `created_at`, `reinforced_at` bumped). Sweep-exempt from `amp_prune`, `amp_expire_memories`, `amp_consolidate` — skillscripts are infrastructure, not knowledge atoms.

Skillscripts can also live as files (e.g., for version-control workflows or distribution) when running under a non-AMP SkillStore backend. The language is storage-agnostic; the interpreter accepts a skillscript body as text regardless of source.

## Ops reference — the eight typed operations

Each op character starts the body of a line, after leading indent. The language has eight typed operations, each with distinct semantics, grammar, and execution behavior.

## Shipped ops

### `$` — tool invocation (MCP dispatch)

Calls a tool through a configured `McpConnector`. Bare-name `$ <tool> kwarg=value` routes through the `primary` connector; dotted `$ <connector>.<tool>` routes through a named connector. Output binds to `$(target.output)` by default; `-> VAR` explicitly names the binding.

```
$ amp_write_memory summary="..." detail="..." vault=private -> ACK
$ scotts-personal.write_note title="..." body="$(SUMMARY)"
```

Tool args are unconstrained `key=value` pairs — the connector forwards them to the underlying MCP tool. If `$` returns `isError: true`, the executor throws via `makeOpError`, which routes through `else:` / `# OnError:` fallback machinery if declared. The inner tool's error text is preserved in `result.errors[]`.

### `~` — local-model call

Invokes a configured `LocalModel` connector. **Strict-keyword grammar**: only `prompt` (required), `model` (optional, defaults to `"default"` instance), and `maxTokens` (optional int) are accepted. Anything else is a parse error.

```
~ prompt="Classify: $(INPUT)" -> VERDICT
~ prompt="Decompose into atoms: $(DOC)" model=qwen maxTokens=2000 -> ATOMS
```

Authors interpolate context via `$(...)` substitution inside the prompt string. Response binds to the named variable. Two LocalModel instances ship bundled: `default` (`gemma2:9b`, fast classification) and `qwen` (`qwen2.5:7b`, long-context structured extraction).

### `>` — typed retrieval

Resolves through a configured `MemoryStore` connector. All-keyword grammar with `query`, `mode`, `limit` required. Additional keys forward to the connector as `QueryFilters` extra fields. Returns `PortableMemory[]` bound to the named variable.

```
> mode=fts query="$(TOPIC)" limit=5 -> RESULTS
> mode=rerank query="auth flow" limit=3 connector=project -> CANDIDATES
```

### `@` — shell command

Runs a shell command and binds its stdout to the target output (or an explicit `-> VAR`).

**Current state:** Runtime-mediated execution renders `@` lines as echo-only — the interpreter does not shell-exec. In the agent-mediated path, the compiled prompt instructs the agent to run the command via its Bash tool, which provides actual execution.

**v3 plan:** Sandboxed bash with PATH-restricted allowlist for real runtime execution. Pending design (ERD).

### `!` — tell user

Emits a message to the agent's response surface. Substitutions resolved at runtime; no return value.

```
! Found settings at $(find_settings.output)
```

`!` ordering within a block: ops execute sequentially in source order. `!` can appear before or after `$`/`~`/`>` ops in the same target.

### `??` — ask user

Prompts the user for input; binds the response to a variable.

```
?? "Approve fix A+B?" -> APPROVED
```

**Autonomous mode** (cron/event-fired): `??` fails fast — routes to `else:` or `# OnError:` fallback.

**Interactive mode**: response binds to the output variable. **Decline semantics (REVISION PENDING — see open questions):** when the user response is "no"/"n"/falsey, dependent targets are skipped (treated as soft op-error so `else:` fires). Spec must commit to this explicitly to avoid the "silent fall-through to subsequent `apply:`" security bug.

### `$set` — explicit variable binding

Binds a literal value to a variable. Compiler-side outer-quote stripping. No `$(REF)` substitution on RHS — literals only.

```
$set RESULT = ""
$set MODE = "production"
```

### `?` — agent reasoning step (REVISION PENDING)

Asks an agent to reason about its current context and produce an output. The legacy form is bare `?` with the reasoning task implied by the surrounding block name, dependencies' outputs, and `# Use when:` metadata.

**Critical issue:** the bare `?` form synthesizes its task implicitly. This is the most fragile primitive in the language — it drifts subtly across model versions because the implicit context interpretation changes. Every skill using bare `?` is silently affected when the backing model changes.

**v3 spec revision:** `?` requires an explicit prompt. Even terse (`? "decide whether to escalate"`) gives the runtime something stable to dispatch. The implicit form is deprecated; new skills must declare the reasoning task.

## Pending ops

### `&` — skill invocation

Invokes another skill at execution time. Resolution: skill-name lookup against `payload_type=skill` memories, same as `amp_compile_skill`. The invoked skill compiles independently, executes, and returns its output bound to the named variable.

```
& mailbox-triage scope=last-12h -> TRIAGE
```

Open: output binding semantics — what does the bound variable contain? Probable answer: the `default:` target's output of the called skill. To be made explicit when the op ships.

## Op grammar summary

| Op | Shape | Routes through | Output binding |
|----|-------|----------------|----------------|
| `$` | `$ [connector.]tool kwarg=value...` | `McpConnector.call()` | `-> VAR` or `$(target.output)` |
| `~` | `~ prompt="..." [model=name] [maxTokens=N]` | `LocalModel.run()` | `-> VAR` (required) |
| `>` | `> query=... mode=... limit=N [extra=...]` | `MemoryStore.query()` | `-> VAR` (required) |
| `@` | `@ <shell-command>` | echo (runtime) / Bash tool (agent-mediated) | `-> VAR` or `$(target.output)` |
| `!` | `! <text with $(SUBS)>` | response surface | none |
| `??` | `?? "<prompt>"` | response surface (interactive) | `-> VAR` (required) |
| `$set` | `$set NAME = value` | compile-time binding | `NAME` (no arrow) |
| `?` | `? "<reasoning task>"` (revised) | agent reasoning | `-> VAR` or implicit |
| `&` | `& <skill-name> kwarg=value...` (pending) | skill-name resolver | `-> VAR` |

## Variable resolution — substitution, ambient refs, # Requires: cascade

Skillscript supports four tiers of variables, each with distinct resolution timing and scope.

## Tier 1: Ambient

Injected automatically at runtime; never declared by the author.

| Var | Value |
|-----|-------|
| `$(NOW)` | Current timestamp |
| `$(VAULT_ROOT)` | Obsidian vault root path |
| `$(USER)` | The configured user identity |
| `$(SESSION_CONTEXT)` | Current AMP project/entity context |
| `$(TRIGGER_TYPE)` | What event fired this skill (v2) |
| `$(TRIGGER_PAYLOAD)` | Event-specific data (v2) |
| `$(EVENT.*)` | Broker-populated event payload fields (v2) |
| `$(ERROR_CONTEXT)` | In `# OnError:` fallback skills: type + target where failure occurred |

Iterator vars from `foreach` and output bindings from `>` / `~` also pass through ambient at compile time; the runtime substitutes them per iteration / per op completion.

## Tier 2: Input

Required at invocation; declared in `# Vars:` without a default. Compile fails cleanly if missing.

```
# Vars: NOTE_PATH, TOPIC
```

## Tier 3: Default

Optional input with fallback declared inline.

```
# Vars: FORMAT=prompt, UNITS=imperial
```

Bracketed list literals supported (`# Vars: TAGS=[a, b, c]`).

## Tier 4: Local

Bound to a previous target's output mid-execution. Two forms:
- `$(target.output)` — the bound output of a target
- `$(VAR)` — an explicit `-> VAR` binding from any op
- `$(target.output.field)` or `$(MEMORY.field)` — dotted field access into structured output

**Field access resolution tiers** for `$(MEMORY.field)`:
1. Core `PortableMemory` fields (id, summary, detail, score)
2. Curated substrate subset (thread_status, pinned, confidence, domain_tags, payload_type, knowledge_type, recipients, expires_at, created_at, agent_id, vault)
3. `metadata.X` for everything else
4. Ambient passthrough as literal `$(MEMORY.field)` if unresolved

## Resolution order

In `compileSkill`, variables resolve in priority order:
1. Caller inputs (from `amp_compile_skill({ inputs: { ... } })`)
2. `# Requires:` cascade
3. `# Vars:` defaults
4. Ambient passthrough (left as `$(NAME)` for runtime substitution)
5. Missing → compile error

## `# Requires:` cascade (shipped)

Pulls values from AMP at compile time. One declaration per line. Both `→` (Unicode) and `->` (ASCII) accepted.

```
# Requires: user-var:location -> LOCATION (fallback: ip-based)
# Requires: system-var:morning-brief-delivered -> DELIVERED (fallback: false)
```

Resolution cascade by namespace:
- `user-var:<key>` — `user-var:<key>` memory → `user-profile.<key>` JSON key → declared fallback
- `system-var:<key>` — `system-var:<key>` memory → declared fallback (no profile tier)

Lookups query `payload_type='data'` memories in the calling agent's private vault, filtered by `domain_tags`, respecting `expires_at`. Caller-supplied `# Vars:` inputs short-circuit the cascade for any matching target name.

**Vars-namespace conventions** (all `payload_type='data'`, `vault='private'`):
- `user-profile` — single JSON blob per agent, no expiry, static facts
- `user-var:<key>` — dynamic per-key memory, typically with `expires_at`
- `system-var:<key>` — agent/process state flags

## `$set` — explicit variable binding

The `$set` op binds a literal value to a variable at runtime. Literal RHS only (no `$(REF)` substitution on RHS). Compiler-side outer-quote stripping (`"foo"` and `'foo'` both stripped; whitespace inside quotes preserved verbatim).

```
$set RESULT = ""
$set MODE = "production"
```

Useful inside `else:` blocks to provide a fallback value the rest of the skill can consume.

## Scoping rules

- `# Vars:` declarations are skill-global (visible to all targets)
- `-> VAR` bindings are skill-global (visible to all targets after the op runs)
- `foreach IDENT in EXPR:` iterator vars are loop-local — `$set` bindings inside the loop don't persist after the loop ends
- Target outputs (`$(target.output)`) are accessible after the target completes

## Pipe filters — url, shell, json, trim (+ pending head/tail/lines/field/length/summary/pluck)

Pipe filters apply transforms to resolved variables before substitution. Syntax: `$(VAR|filter)`. Filters operate at compile time for static values; for runtime-bound variables, filters apply at substitution time.

## Shipped filters

| Filter | Effect | Example | Output |
|--------|--------|---------|--------|
| `url` | `encodeURIComponent(value)` | `$(location|url)` for "Asheville, NC" | `Asheville%2C%20NC` |
| `shell` | POSIX single-quote escape with outer quotes | `$(arg|shell)` for `it's safe` | `'it'\''s safe'` |
| `json` | `JSON.stringify(value)` | `$(payload|json)` for `{k:"v"}` | `"{\"k\":\"v\"}"` |
| `trim` | Whitespace trim | `$(VERDICT|trim)` for `"urgent\n"` | `urgent` |

## Filter chaining

Filters chain left-to-right. The output of each filter becomes input to the next.

```
$(VERDICT|trim|json)
```

First trims whitespace, then JSON-stringifies the result.

## Filter use in conditionals

Filters may appear on the LHS of conditional expressions. Useful for whitespace-tolerant equality checks against LocalModel output (which often has trailing newlines).

```
if $(VERDICT|trim) == "urgent":
    ...
```

## Filter use in `in` / `not in` set membership

Filters may appear on the LHS of `in` / `not in` checks (the comparison side). The RHS must resolve to an array at runtime.

```
if $(M.id|trim) in $(SEEN):
    ! already processed
```

## Error handling

Unknown filter on a resolved variable produces a compile-time error. Filter chains that fail at runtime (e.g., `|json` on a non-serializable value) produce op errors that route through `else:` / `# OnError:` machinery.

Bare `$(NAME)` without a filter is unchanged.

## Pending filters (v2/v3)

Several filters are planned but not yet shipped:

| Filter | Effect | Use case |
|--------|--------|----------|
| `head:N` | First N lines | Truncate long output for embedding in prompts |
| `tail:N` | Last N lines | Recent log entries |
| `lines:M-N` | Range of lines | Specific slice |
| `field:N` | Nth whitespace-separated field | Awk-like extraction |
| `length` | Count of items (array) or chars (string) | Numeric comparison in conditions (paired with future numeric grammar) |
| `summary` | One-line abbreviation | Compress for human-facing emissions |
| `pluck:<field>` | Project array of objects to array of field values | Paired with `in`/`not in` for dedup-by-id workflows |

`pluck` is the highest-priority pending filter — it closes the structural-dedup gap for skills that iterate retrieval results and want to exclude already-seen items by ID without manual comparison loops.

## Composition philosophy

Filters are pure functions (input → output, no side effects). Stay small and orthogonal — each filter does one thing. Composition emerges from chaining, not from elaborate per-filter parameter spaces. The shipped set covers ~80% of real-world string-shaping needs; the pending set extends to array projection and numeric work.

## Conditionals & iteration — if/elif/else, foreach, supported operators

Skillscript supports narrow conditionals and bounded iteration. Both are deliberately constrained — composition over expressiveness.

## Conditionals

`if COND:` / `elif COND:` / `else:` chain. Supported condition shapes:

### Truthy

```
if $(VAR):
    ! VAR was set and non-empty
```

### Equality

```
if $(VERDICT) == "urgent":
    ...
elif $(VERDICT) != "quiet":
    ...
```

Both `==` and `!=` against quoted string literals. No comparison against other variables; literals only.

### Set membership (v2, shipped 2026-05-13)

```
if $(M.id|trim) in $(SEEN):
    ! already processed
elif $(M.id) not in $(SEEN):
    $ amp_write_memory ...
```

Both sides are explicit refs. RHS must resolve to an array at runtime; clean error otherwise. LHS-undefined evaluates to `false` for both polarities. Optional filter on LHS.

### What's NOT supported

- *No arithmetic comparison* — no `>`, `<`, `>=`, `<=`. (Pending: numeric grammar + `|length` filter would unlock this.)
- *No `and`/`or` combinators* — compose via nested `if` blocks instead. The line where composition forces a real parser hasn't been crossed.
- *No filter math* — filters apply to substitution, not to condition evaluation arithmetic.

### Disambiguation: `else:` after target body vs `else:` after `if:`

Both shapes use the keyword `else:`. Distinguished by parser scope-stack at parse time:
- `else:` after a target's primary body → error handler (runs when any op in the body errors). See Error handling section.
- `else:` after `if:` / `elif:` chain → conditional branch.

Both can coexist in the same target.

## Iteration: `foreach`

`foreach IDENT in EXPR:` block iterates over a list, binding `IDENT` to each item per iteration. Body indented under the header; indent-based dedent returns to outer scope.

```
foreach M in $(RESULTS):
    ! Processing $(M.id) — $(M.summary)
    if $(M.id|trim) not in $(SEEN):
        $ amp_update_memory memory_id=$(M.id) pinned=true -> ACK
```

### Iterator vars

`$(M)` and `$(M.field)` pass through ambient at compile; runtime substitutes per iteration. Dotted field access against `PortableMemory` shape applies (core fields → curated subset → metadata).

### Loop-local scope

`$set` bindings inside the loop don't persist after the loop ends. Each iteration starts fresh from the loop binding.

### What's NOT supported

- *No `while` loop* — iteration is bounded by the iterable's length. Unbounded loops are not expressible.
- *No `break` or `continue`* — every iteration runs to completion. Filter the iterable beforehand if you need exclusion.
- *No nested-loop variable capture* — inner-loop `$set` doesn't escape to outer scope.

## Composition philosophy

The grammar is deliberately narrow. The threshold for adding new grammar (numeric comparison, `and`/`or`, `while`, `break`) is "an authored skill demonstrates the gap is load-bearing." Composition through nested blocks + filter chains covers most real cases.

Authors writing complex conditional logic should consider:
- *Push the logic into a `~` LocalModel call* — let the model classify, return a one-word verdict, branch on equality
- *Push the logic into a connector* — wrap the complex check as an MCP tool, dispatch via `$`
- *Decompose into multiple skills* via `&` invocation (when shipped)

Skills are orchestration, not computation. When the conditional logic feels Turing-complete, the work belongs in a connector.

## Triggers — # Triggers: header, declarative + imperative registration, source types

Triggers declare what events fire a skill autonomously. A skill without triggers must be invoked explicitly (via `amp_compile_skill` or `amp_execute_skill`); a skill with triggers fires automatically when matching events occur.

## Declarative registration via `# Triggers:` header

The skill body declares triggers via metadata header. Multiple triggers permitted, comma-separated or one per line.

```
# Triggers: cron: 0 8 * * *, session: start
```

On skill write (`amp_write_memory` with `payload_type: skill`), the runtime's trigger registry parses the header and auto-registers each trigger. Editing the skill body updates registrations.

## Imperative registration via `amp_register_trigger`

For dynamic, one-shot, or runtime-decided triggers, use the imperative API:

```
amp_register_trigger({
  skill_name: "my-skill",
  source: "cron",
  name: "55 2 * * *",
  expires_at: 1779107400  // optional auto-cleanup
})
```

Imperative triggers default to `expires_at = now + 30 days` (cleanup via expiry sweep). Pass `null` for indefinite retention; author must clean up via `amp_unregister_trigger`.

## Trigger sources

### `cron: <expression>` — time-based (shipped)

Standard 5-field cron. Sliding-window evaluation by a 30s poll loop. No catch-up replay if the runtime was down at fire time.

```
# Triggers: cron: 0 3 * * *
```

### `session: start | end` — session lifecycle hooks (shipped)

Fires when an agent session begins (`session: start`) or ends (`session: end`). The load-bearing primitive for "Perry arrives shaped" — a session-start skill produces `prompt-context:` output that prepends to the next inference.

```
# Triggers: session: start
# Output: prompt-context: perry
```

### `event: <event-name>` — broker-emitted events (parse-only, dispatch pending)

Header parses, but the event bus that would emit `event:` triggers isn't wired yet. Phase 2 work.

Planned events:
- `event: thread.replied` — a thread receives a new reply
- `event: mailbox.dangle` — addressed prose memory expires unprocessed
- `event: olsen.flagged` — Olsen surfaces an urgent finding
- (extensible via broker event registration)

### `agent-event: <agent>.<event>` — cross-agent event hooks (parse-only)

Subscribes to another agent's events. Same phase-2 dispatch status as `event:`.

```
# Triggers: agent-event: cc.task.completed
```

### `file-watch: <path>` — filesystem change (parse-only)

Fires when the named path changes. Relies on inotify (Linux) or kqueue (macOS) on the host. Phase 2.

Open spec question: recursive vs directory-only default. Current lean: directory-only by default, opt-in via `file-watch-recursive:` or `file-watch: <path> (recursive)`.

### `sensor: <sensor-name>` — external sensor stream (parse-only)

Extension surface for multimodal inputs — camera, microphone, presence, screen state. Designed as a category distinct from tools: sensors are continuous channels the agent reads but doesn't emit on. Privacy gating is a structural precondition.

```
# Triggers: sensor: presence
```

Phase 3 work (per the original v2 roadmap).

## Trigger context

When a skill fires from a trigger, the broker populates ambient refs accessible inside the skill body:

- `$(TRIGGER_TYPE)` — the trigger source (`cron`, `session`, etc.)
- `$(TRIGGER_PAYLOAD)` — source-specific data
- `$(EVENT.*)` — event-payload fields for `event:` / `agent-event:` triggers

## Trigger lifecycle

- **Registration:** declarative via header (auto on skill write) or imperative via `amp_register_trigger`
- **Storage:** registered triggers are `payload_type: trigger` memories in the registering agent's private vault, indexed by source + name + agent_id + skill_id
- **Inspection:** `amp_list_triggers({ skill_name?, agent_id?, source? })` returns the live registry
- **Archival:** `amp_unregister_trigger(trigger_id)` archives the trigger (audit trail preserved); declarative triggers are removed by editing the skill body to drop the declaration

## Multiple triggers

A skill may declare multiple triggers; each fires an independent execution. The compiled output is identical regardless of trigger; the runtime distinguishes via `$(TRIGGER_TYPE)`.

Open spec question: dedup on near-simultaneous fires. If `cron: 0 8 * * *` and `event: scott.present` both fire within seconds, the runtime currently runs the skill twice (one per trigger). Author dedups via state if needed. Affects the broker dispatch layer.

## Output targets — # Output: header, delivery kinds

The `# Output:` header declares where a skill's result is delivered. Default behavior (no header) is `text` — return string to caller.

## Output kinds

### `text` (default, bare-only)

Returns the skill's result as a string to whatever invoked `amp_execute_skill` or read the compiled prompt artifact. Bare-only — no target accepted; parse error if a target is supplied.

```
# Output: text
```

### `slack: <channel>` — Slack delivery

Posts to a Slack channel. Routes through the broker's notification dispatch path.

```
# Output: slack: scott
```

Phase-2 — header parses, broker routing pending implementation.

### `prompt-context: <agent>` — prepend to next-turn prompt context (shipped)

The load-bearing primitive for "hot-ready" briefings. Output prepends to the named agent's next-turn prompt context as a `<skill_output>` block.

```
# Output: prompt-context: perry
```

Shipped end-to-end 2026-05-12: nanoclaw renders the block ahead of next chat, broker's `POST /trigger/fire` endpoint dispatches with synchronous 3s timeout-fallback. "Perry arrives shaped" is no longer aspirational.

### `file: <path>` — write to file

Writes output to a filesystem path. Phase-2 — header parses, file router pending.

### `card: <spec>` — structured UI card

Renders output as a structured card to the appropriate UI surface. Phase-2 — pending NanoClaw card-render surface.

### `none` (bare-only)

Side-effects only — the skill's purpose is the AMP writes / shell ops it performs, not the returned value. Bare-only; parse error if a target is supplied.

```
# Output: none
```

## Multiple output targets

A skill may declare multiple output targets, one per line. Each target receives the same content.

```
# Output: slack: scott
# Output: prompt-context: perry
```

Same morning brief skill posts to Scott's Slack and prepends to Perry's session-start prompt context simultaneously.

## Per-kind output value semantics (shipped 2026-05-12)

Different output kinds consume the skill's execution result differently:

- **Presentation surfaces** (`slack:`, `prompt-context:`, `card:`) consume joined emissions — all `!` ops in the skill body concatenated in execution order
- **Programmatic surfaces** (`text`, `file:`) consume the `lastBoundVar` — the most recently bound `-> VAR` value from any op

Single source of truth in `executor.ts:perKindOutput()`; routers stay dumb (just consume what the executor hands them per kind).

## Grammar

- Kinds with no target (`text`, `none`) are bare-only — `# Output: text` is valid, `# Output: text: anything` is a parse error.
- Kinds with a target (`slack`, `prompt-context`, `file`, `card`) require `<kind>: <target>` — `# Output: slack` without a target is a parse error.
- Authoring friction-fix: parse errors on bare-only kinds suggest the corrected shape inline.

## Output routing failures

If `# Output: slack: scott` and Slack is down, the runtime's behavior is currently unspecified. Spec question: queue-and-retry, error-to-caller, or silent best-effort? Pending decision. Affects broker dispatch layer.

## Lifecycle and status — # Status: header, six canonical states, compile + runtime enforcement

Skillscripts carry an explicit lifecycle state via the `# Status:` header. The compiler and runtime enforce status — a Disabled skillscript cannot fire under any path, regardless of who invokes it.

## Header syntax

```
# Skill: support-response-draft
# Status: Approved
# Description: ...
```

If `# Status:` is omitted, the default state is **Draft**. This forces authors to explicitly promote a skillscript through its lifecycle rather than relying on "newly written = ready for use."

## The three canonical states (v1)

- **Draft** — being authored or under revision; not ready for production use. Compile warns; runtime refuses unless explicitly invoked with `--force-draft` for the author's own testing. Triggers don't fire under default dispatch.
- **Approved** — passed authoring + lint and is ready to fire. The canonical "in use" state. Compile is clean; runtime allows everywhere; declared triggers fire freely.
- **Disabled** — explicitly off. Compile rejects; runtime rejects; triggers don't fire. Source and version history preserved, but the skillscript cannot execute under any path.

These three states have crisp, universal operational meaning across every deployment. Every operator understands what each state means; no judgment calls about edge-case distinctions.

## Compile + runtime behavior table

| State | Compile | Runtime invocation | Test harness | Default trigger fire |
|-------|---------|-------------------|--------------|---------------------|
| Draft | warn | refuse (unless `--force-draft`) | allow (with flag) | refuse |
| Approved | OK | allow | allow | allow |
| Disabled | refuse | refuse | refuse | refuse |

## Trigger registry interaction

The trigger registry respects status. A skillscript in Draft or Disabled state has its declared triggers held in a non-firing state — the trigger is registered (visible via `list_triggers`) but the scheduler skips dispatch. This lets authors register triggers while still in Draft mode without risking accidental production fires.

When a skillscript transitions to Approved, its triggers activate. When it transitions to Disabled, its triggers deactivate.

## State transitions

For v1, status transitions are freeform — any author with write authority on the skillscript can flip the status by editing the header. v2 may add transition rules (Draft → Approved with lint-pass requirement; Disabled requiring admin-level permission) once a real authorship-permissions story is in place.

## Audit trail

Status changes are visible via the storage substrate's versioning. For AMP-backed skillscripts, each header change is a new memory revision; the version history shows the lifecycle. For file-backed skillscripts, status changes show up in git history. The audit trail is part of the substrate, not part of the language.

## States deferred from v1

Three additional states were considered for v1 and deferred — each is cheap to add later when justified by real operational need:

- **Test** — distinct "passed compile but not production-ready" state. In v1, Draft covers this case (same behavior — refuse to fire under default dispatch). If authors find Draft and Test are operationally distinct in practice, Test ships then.
- **Deployed** — distinct "currently shipping" state separate from Approved. In v1, Approved + active triggers IS deployed; no operational difference. If a deployment finds Approved-vs-Deployed meaningfully different (e.g., a release-gating workflow that distinguishes "ready" from "live"), Deployed ships then.
- **Deprecated** — soft-warn state for "still works but new authoring should use a successor." In v1, deprecation is carried in metadata (`deprecated: true` in frontmatter) + a lint warning at invocation sites. When deprecated skills accumulate enough that the metadata pattern is awkward, Deprecated promotes to a first-class state.

Adding states is additive — existing skills with the three-state model continue to work when new states are added.

## Why this matters

The lifecycle states are the language's answer to operational safety at scale. A traditional "all skillscripts compile and run" model relies on author discipline to keep broken or untested work out of production. Status states enforce the discipline at the language level — a Disabled skill cannot fire even if every author downstream forgets it's broken. The constraint IS the safety story, here as elsewhere.

## Open questions

- **Status + composition.** When a procedural skillscript references a data skill via `&`, what happens if the data skill is Disabled? Probable answer: compile-time error if any referenced skill is Disabled. Specify when `&` ships.
- **Bulk status operations.** "Disable all skills tagged with project:legacy" is a useful operational primitive. v2 may add a `skillscript bulk-status <pattern> <state>` CLI affordance.

## Error handling — else: blocks, # OnError: fallback, op-level fallback values

Skillscript provides three layers of error handling, working from local to global. All three shipped 2026-05-10 (commit `fdcaab9`).

## Layer 1: Target-level `else:` block

Runs if any op in the target's primary body errors. Local to the failing target. Downstream targets that depend on this one can still proceed using whatever the `else:` branch produced.

```
fetch:
    > mode=fts query=$(TOPIC) limit=5 -> RESULT
else:
    ! AMP query failed, falling back to empty result
    $set RESULT = ""
```

### Distinguished from conditional `else:`

The keyword `else:` is shared between two purposes:
- Conditional `else:` — appears after `if:` / `elif:` chain inside a target body
- Target `else:` — appears as a sibling block after a target's primary body, as an error handler

The parser's scope-stack discriminates at parse time. Both kinds coexist in the same target.

### Constraint

`else:` blocks may not declare their own error handlers (no nested catch). If an `else:` block fails, the whole target fails through `# OnError:` if present.

## Layer 2: Skill-level `# OnError:` header

Names a fallback skill to invoke if anything in the skill fails — including target-level errors that aren't caught by `else:`, compile errors, or the executing context running out of resources.

```
# Skill: morning-brief
# OnError: morning-brief-degraded
```

Compile-time existence check — fails clean if the referenced fallback doesn't exist. The fallback skill is itself a skill (same compilation, same execution model) and can do real work (file an issue, post a Slack ack, write a degraded result, etc.).

The fallback skill receives:
- The same inputs as the failing skill
- An additional `$(ERROR_CONTEXT)` ambient ref containing the error type and the target where it failed

### Constraint

Nested `# OnError:` is *not* supported. If `# OnError: degraded-skill` fires and `degraded-skill` itself errors, the runtime hard-exits with no further fallback. Spec is explicit on this.

## Layer 3: Op-level fallback values for `>` and `~`

Inline fallback declared on the op line. Used when the call fails or returns empty.

```
weather:
    > mode=fts query="weather $(LOCATION)" limit=1 -> CURRENT (fallback: "weather unavailable")
```

Same pattern as the `# Requires:` cascade's `(fallback: ...)` syntax — consistent across compile-time (`# Requires:`) and runtime (`>` / `~`).

## Error propagation rules

- Op error → caught by `else:` if present, otherwise propagates to target
- Target error → caught by `# OnError:` if present, otherwise propagates to caller
- Caller can still catch via standard exception handling on `amp_compile_skill` / runtime invocation
- `else:` blocks are not allowed to declare their own error handlers
- If an `else:` block itself fails, the whole target fails through `# OnError:` (if present)

## Visibility into errors

Open spec question: should `$(ERROR)` be ambient inside `else:` blocks (same shape as `$(ERROR_CONTEXT)` in `# OnError:` fallbacks)? Current lean: yes. Useful for telemetry skills that need to know what failed before falling back. Not yet specified or shipped.

## The fallback pattern is consistent across scopes

Same idea at every scope:
- Compile-time: `# Requires: ... (fallback: value)`
- Runtime op: `> ... (fallback: value)` and `~ ... (fallback: value)`
- Runtime target: `else:` block
- Whole skill: `# OnError:` header

Authors composing complex skills use these in combination — op-level for transient errors, target-level for cohesive error paths, skill-level for last-resort degradation.

## Connection to runtime observability

The error-propagation chain is what makes CC's surface-1+2 fix (commit `c580de5`, 2026-05-18) work. When `$` returns `isError: true`, the executor's `unwrapToolResult` was previously swallowing the error and binding the error text to the output var. Fix throws via `makeOpError` instead, routing through `else:` / `# OnError:` machinery and surfacing in `result.errors[]` for the scheduler to log to stderr. Without that fix, the cascading fallbacks couldn't see op-level failures and silent-fail was the default.

## Connectors — MemoryStore / LocalModel / McpConnector interfaces, three-layer resolution

The three substrate-routing ops — `$` (MCP tool), `>` (retrieval), `~` (local-model) — do not call AMP or Olsen directly. They route through a thin connector interface. This is the programmable surface through which authors compose information topology per skill and per moment.

## Three connector types

### MemoryStore

Routes `>` retrieval ops. Interface: `MemoryStore.query(filters) → PortableMemory[]`.

Default impl: `AmpMemoryStore` (DB-direct inside amp-mcp; MCP-client when skillfile extracts to standalone). Registered as `primary`.

### LocalModel

Routes `~` local-model ops. Interface: `LocalModel.run(prompt, opts) → string`.

Default impl: `OllamaLocalModel` (Ollama HTTP wrapper, exposing only the basic `run` interface — no leaked deployment-wrapper affordances). Constructor takes `{ model: string }` (required) — no class-level implicit default.

Bundled instances:
- `default` → `OllamaLocalModel({ model: "gemma2:9b" })` — back-compat alias; resolved when `model=` is omitted
- `gemma2` → `OllamaLocalModel({ model: "gemma2:9b" })` — explicit alias for the same model; matches the model-selection convention
- `qwen` → `OllamaLocalModel({ model: "qwen2.5:7b" })` — long-context, latency-sensitive

### McpConnector

Routes `$` MCP-tool ops. Interface: `McpConnector.call(toolName, args, ctxOverrides?) → unknown`.

Default impl: `AmpMcpConnector` (adapter wrapping the in-process `toolDispatch` callback supplied to `executeSkillTool`). Registered as `primary`. Per-request init carries the post-`ecb6e1b` effective-agent identity overrides into the adapter so `$ amp_*` writes inherit the skill's authority, not the scheduler's.

## Capabilities discovery

All three connectors expose `capabilities()` for runtime discovery. Three consumers:
1. Static `# Requires:` matching (future — pending header enforcement)
2. Dynamic queries via `listMemoryStores()` / `listLocalModels()` / `listMcpConnectors()` to pick a connector for the moment
3. Authoring tools that surface the registered set

## Multi-instance by design

Multiple instances of the same connector type are the *normal case*, not the exception.

```
{
  primary: AmpMemoryStore,
  project: SqliteProjectStore,
  scratch: InMemoryStore
}
```

```
{
  default: OllamaLocalModel({model: "gemma2:9b"}),
  gemma2:  OllamaLocalModel({model: "gemma2:9b"}),
  qwen:    OllamaLocalModel({model: "qwen2.5:7b"})
}
```

```
{
  primary: AmpMcpConnector,
  personal: HttpMcpConnector,
  project: HttpMcpConnector
}
```

Per-skill resolution against named connectors is first-class; an unnamed lookup returns the configured default. Multiple keys pointing at the same underlying instance configuration are allowed and useful — see the `default`/`gemma2` alias below.

## Model selection — choosing among LocalModel instances

The LocalModel registry holds multiple instances by design. Skill authors choose which to dispatch to via `~ model="<name>"`. Two layers of indirection are involved, and the distinction matters for both authoring and adopter configuration:

1. **Skillscript name → registered instance.** `~ model="qwen"` references the instance keyed `qwen` in the registry. The registry resolves to the configured connector implementation.
2. **Registered instance → underlying model.** Each `OllamaLocalModel` is constructed with the actual Ollama tag (e.g. `qwen2.5:7b`). The skill never sees the tag directly.

### Bundled instance names

| Name | Underlying model | Notes |
| --- | --- | --- |
| `default` | `gemma2:9b` | Resolved when `model=` is omitted; alias of `gemma2` |
| `gemma2` | `gemma2:9b` | Explicit name; matches the convention below |
| `qwen` | `qwen2.5:7b` | Interactive, latency-sensitive |

`default` and `gemma2` point at the same `OllamaLocalModel` configuration. The alias exists so skill syntax can match the convention ("use gemma2 for batch") rather than the back-compat name (`default`). Existing skills that wrote `model="default"` continue to work unchanged; new skills should prefer the explicit name.

### Convention: model tier by use case

- **gemma2** (or any classification-class small model) for *batch and scan work* — Olsen scan, atomization, large-batch classification, anything async or background-scheduled.
- **qwen** (or any dispatch-class long-context model) for *interactive verdicts in skills* — single-shot decisions inside an active dispatch where latency matters and queue contention with batch work would block forward progress.

When in doubt: gemma2 if the call is asynchronous from a user/agent's perspective, qwen if a downstream op depends on the response.

### Contention property

Any skill that calls `~` shares the underlying Ollama runner with every other process on the deployment that dispatches to the same model. Ollama serializes per-model dispatch. A skill that fires asynchronous gemma2 work via `$` (e.g. `amp_olsen_task task_type="scan"`) and then immediately calls `~ model="gemma2"` will race itself — the synchronous call queues behind the dispatched batch.

The runtime does not promise concurrency-safe model dispatch. Skill authors and operators own model-tier allocation. The canonical mitigation: use distinct models for the synchronous and asynchronous paths (qwen for the interactive verdict, gemma2 for the batch). This was the root cause of the olsen-nightly failure arc (2026-05-15 through 2026-05-20); see footgun atom `901da99e` for the full diagnosis.

### Adopter deployments

Adopters override the bundled set via `connectors.json`:

```jsonc
{
  "localModels": {
    "default": { "type": "OllamaLocalModel", "model": "llama3.2:3b" },
    "fast":    { "type": "OllamaLocalModel", "model": "phi3:mini" }
  }
}
```

Adopters with no local models register no LocalModel instances. Skills with `~` ops fail at dispatch with `LocalModel '<name>' not registered`. Phase 5 `# Requires:` capability declarations promote this to a compile-time fail-fast — a skill that requires LocalModel won't compile if none is configured. Substrate-blind skills (no `~` ops) work unchanged.

## Per-skill connector selection

Skills declare which connector they use, by name, when they care:

```
# Connectors: memorystore=project, localmodel=qwen, mcp=[primary, personal]
```

Meaning: *"this skill requires the named connectors, or compatible alternatives declared via Phase 5 `# Requires:` capabilities."* Discipline about declared intent. A skill that depends on a project-scoped store or a personal MCP says so; a substrate-blind skill omits the header.

Runtime fails fast if a named connector is unavailable. The `mcp=[...]` header is enforcement-pending (Phase 3 of the connector-routed `$` work, deferred until 2-3 skills cite non-primary connectors and authoring discipline benefits).

## Connector resolution chain

Connectors are runtime-resolved — the compiler stays pure read+transform. Compiled artifacts are generic; any runtime can dispatch them through whatever connectors it has configured. Resolution chain for *which connectors are wired up* (first match wins):

1. **Env var** — `SKILLFILE_MEMORY_STORE`, `SKILLFILE_LOCAL_MODEL`, or `SKILLFILE_CONNECTORS_CONFIG` for multi-store. Ad-hoc / test override.
2. **Working-dir / agent-scoped `connectors.json`** — persistent per-agent override, supports multiple named connectors per type.
3. **Server default** — bundled with the compiler. Common-case fallback.

Per-deployment naming lives in config, not the contract. A given deployment registers concrete instances under whatever names make sense locally; skill authors reference those names.

## Per-call identity overrides (McpConnector)

A skill running as Perry can dispatch against a personal MCP server under a different identity without needing connector-internal state. The merge order at dispatch (top wins):

1. **Registry-configured per-connector identity** — set in `connectors.json` (`identity: { agentId: "scotts", isAdmin: false }`) at connector instantiation. Locks an identity to a connector.
2. **Per-call `ctxOverrides`** — threaded by the runtime per the post-`ecb6e1b` security boundary. A skill running as Perry passes `{ agentId: "perry", isAdmin: false }` into every `$` op.
3. **(no intrinsic identity)** — adapter forwards whatever the merge produces.

Configured identity is a *partial merge* — unmentioned keys (e.g., `isAdmin`) flow through from the per-call ctx. Lets a connector lock `agentId` without clobbering the runtime's admin-drop discipline. The default `primary` connector configures no identity, so `ctxOverrides` always wins for AMP — preserving the pre-connector-routing semantics intact.

## Portable shapes

```typescript
interface PortableMemory {
  // Core fields — mandatory on every connector return.
  id: string;
  summary: string;
  detail?: string;
  score?: number;

  // Curated substrate subset — concept-portable, value-substrate-specific.
  // Top-level access via $(MEMORY.field). Connectors populate when the
  // concept applies. MUST NOT also be duplicated into metadata.
  thread_status?: string;
  pinned?: boolean;
  confidence?: number;
  domain_tags?: string[];
  payload_type?: string;
  knowledge_type?: string;
  recipients?: string[];
  expires_at?: number;
  created_at?: number;
  agent_id?: string;
  vault?: string;

  // Substrate-specific bag. Accessed via $(MEMORY.metadata.X).
  metadata?: Record<string, unknown>;
}

interface QueryFilters {
  query: string;
  limit: number;
  mode: "fts" | "semantic" | "rerank" | string;
  [key: string]: unknown;
}

interface McpDispatchCtx {
  agentId?: string;
  isAdmin?: boolean;
}
```

## Field access semantics

`$(MEMORY.field)` resolves in tiers:
1. Core fields (id, summary, detail, score)
2. Curated substrate subset (thread_status, pinned, etc.)
3. `metadata.X` for everything else
4. Ambient passthrough as literal `$(MEMORY.field)` if unresolved

**Connector duplication is a contract violation.** If a field is in the curated subset, the connector populates it at top-level only — `metadata.<same_name>` MUST be absent. Otherwise `$(M.thread_status)` and `$(M.metadata.thread_status)` can return different values (silent data divergence). Connectors enforce.

## Why connector abstraction matters

Hard-coupling skills to specific substrates would make information-flow decisions infrastructural rather than skill-authored, defeating the point of skills as the agent's programming language. The connector layer is what lets the same skill body run against AMP today and run against Postgres-backed storage tomorrow without rewriting.

## Tests — # Tests: block, given/expect assertions (pending v2)

The `# Tests:` header introduces a block of test cases that travel with the skill body. Each case has `given:` (variable overrides) and `expect:` (assertions on the compiled output or runtime side effects).

## Status: pending v2

Header parsing and test runner not yet shipped. The grammar below is the agreed design but the implementation is queued behind shipping `&` skill-invocation and broker dispatch.

## Proposed grammar

```
# Tests:
  - name: "basic_url_filter"
    given:
      LOCATION: "Asheville, NC"
    expect:
      compiled_output_contains: "wttr.in/Asheville%2C%20NC"

  - name: "missing_required_var_errors"
    given:
      LOCATION: null
    expect:
      compile_error: "Missing required variable: LOCATION"

  - name: "fetch_failure_runs_else_block"
    given:
      TOPIC: "definitely-not-a-real-topic-xyz"
    expect:
      target_else_executed: "fetch"
      result_value: ""
```

## Execution

Run via `amp_compile_skill({ skill_name, format: "test", test_case: "<name>" })`. All cases run when `test_case` is omitted. Returns pass/fail per assertion with diagnostic detail.

Normal `prompt` / `prose` compilation ignores the `# Tests:` section entirely — tests travel with the skill without affecting production use.

## Assertion types

### Compile-time assertions

- `compiled_output_contains: "<substring>"` — the rendered prompt artifact contains the given substring
- `compile_error: "<substring>"` — compilation fails with an error message containing the substring
- `compiled_output_does_not_contain: "<substring>"` — negative assertion

### Runtime assertions (for `format: "test"` execution)

- `target_else_executed: "<target_name>"` — verifies the `else:` branch ran
- `onerror_invoked: "<fallback_skill>"` — verifies the `# OnError:` skill was called
- `op_fallback_used: "<target.op_index>"` — verifies an op-level fallback value was substituted
- `result_value: "<expected_string>"` — the skill's final output value

## Open spec questions

### Runtime assertion sandboxing

`# Tests:` cases that exercise runtime behavior (AMP writes, shell ops, LocalModel calls) need a sandbox so they don't pollute production data. Two approaches:
- Scratch DB / scratch connector overrides for tests
- Skip-and-warn for non-deterministic ops, only assert deterministic compile-time properties

Out of v2 scope; deferred until the test runner ships.

### Discovery and naming collisions

When the skill library grows past ~20 skills, name typos in `&` invocations become a real risk. No "list available skills with their inputs" surface yet. Probably wants a `skill_list` MCP tool and/or an IDE plugin.

### Property-based tests

The current design covers example-based tests. Property-based tests (`for all inputs in {...}, output matches pattern X`) would be a useful future addition but require a generator framework. Out of v2 scope.

## Connection to authoring discipline

The PRD's pitch — *authoring loop becomes "author → lint → revise → store"* — depends on tests-as-preflight being cheap to author and cheap to run. The `# Tests:` block makes this possible at skill-source-level; the lint pass enforces structural correctness; together they raise the bar for what enters the library.

## Future grammar extensions — sensors, time primitives, suppression, persistent state, capability declarations, debounce

The roadmap atom `88a1c3ca` documents language-design additions planned for future phases. These aren't yet shipped, but the design has been thought through enough that authors should know what's coming and what categories of work the language is reaching toward. Rationale lives in `88a1c3ca`; this section captures the grammar shapes.

## Sensors as a language category (Phase 3)

Currently `# Triggers:` includes `sensor:` as a trigger source. The v3 redesign splits sensors into their own category:

```
# Sensors: presence, screen-state, voice-prosody
# Triggers: cron: 0 8 * * *
```

**Distinction:** Sensors are continuous channels Perry reads but doesn't emit on. Triggers are discrete events that fire the skill. Conflating them in one header produces a worse language for both — sensors need different semantics (continuous read, accessible via ambient refs, privacy-gated) than triggers (discrete fire, dispatch semantics).

Pending: ambient refs for sensor values (`$(SENSOR.presence)`, `$(SENSOR.voice-prosody.affect)`) and the privacy-gating discipline that determines when a sensor is readable.

## Time as first-class primitives (Phase 3)

Current ambient time: `$(NOW)` (wall-clock timestamp). Pending:

```
$(SECONDS_SINCE_LAST_USER_MESSAGE)
$(MINUTES_SINCE_SESSION_START)
$(SECONDS_SINCE_LAST_FIRE_OF.<skill-name>)
```

**Rationale:** Most "right time" reasoning is relative, not wall-clock. Authoring relative-time guards requires either runtime-state tracking (which authors then rebuild manually) or first-class primitives. The latter wins.

## Absence as trigger (Phase 3)

Different shape from event triggers — "fire if user hasn't messaged in N minutes" is a wait-for-nothing primitive, not a wait-for-event primitive. Proposed grammar:

```
# Triggers: idle: 5m
```

Runtime tracks the relevant idleness counter and fires when the threshold crosses. Separate dispatch mechanism from event triggers.

## Time-windowed aggregation (Phase 3)

Filter-like primitives that operate on state across firings:

```
~ prompt="..." -> VERDICT
# pseudo-syntax pending: aggregate over a window
$(VERDICT|last-5|count-where:value=="frustrated")
```

**Rationale:** "User has shown frustration in 3 of 5 recent turns" is a canonical sensor-derived condition. Without first-class windowing, every skill rebuilds ring buffers. Pending design: filter syntax vs new op kind.

## Backpressure / debouncing (Phase 3)

Sensors produce floods. First-class primitives for rate limiting:

```
# Debounce: 5s
# RateLimit: 1/minute
# Coalesce: latest
```

Headers declare the runtime's queueing policy. Runtime enforces; skill body doesn't reimplement.

## Suppression as valid output (Phase 1, pending)

Current behavior: a skill that fires must produce *some* output (even empty string). Pending: explicit "fire-and-suppress" — the skill considered the situation and decided not to emit. Different from `# Output: none` (which signals "I do side effects only").

Proposed: `! suppress` or `$set OUTPUT = null` triggers suppression-detection in the runtime. Output routers skip delivery; trigger fire counts increment for telemetry; no consumer surface receives noise.

**Rationale:** Without suppression, signal pipelines become noisy. "Fire everything, hope the right one wins" turns the inbox-to-context into spam. Discipline that makes pub-sub tractable.

## Persistent state with declared scope (Phase 1, pending)

Current `$set` is per-execution; no lifecycle beyond the fire. Pending:

```
$set NAME = value scope=skill-local
$set NAME = value scope=agent-global
$set NAME = value scope=session
```

**Scopes:**
- `skill-local` — persists across fires of this skill, not visible to other skills
- `agent-global` — visible to all skills of the same agent
- `session` — alive for the duration of the current session, cleared at session end

Backed by AMP `payload_type=data` with conventionally-namespaced summary (e.g., `state:skill-local:morning-brief:last-fired`).

**Rationale:** Most interesting skills need memory across firings — change-detection, windowing, dedup-against-recent. Without lifecycle, every skill rebuilds state tracking via raw `amp_write_memory` / `amp_query_memories`.

## Cross-skill pub-sub (Phase 4)

Procedural `&` invocation handles one-to-one composition. Pub-sub handles many-to-many.

```
# Publishes: signal.frustration-detected
# Subscribes: signal.user-confused
```

When a skill publishes a signal, all subscribed skills fire (independent executions, parallel dispatch). Decouples emitters from consumers — the inverse of `&`'s direct invocation.

**Rationale:** When signal flow is many-to-many, `&` couples everything to everything. Pub-sub keeps emitters ignorant of consumers.

## Confidence/threshold gating (Phase 4)

Declarative guards on skill firing:

```
# RequiresConfidence: olsen >= 0.8
# RequiresThreshold: change-delta >= 0.3
```

Runtime evaluates the guard before dispatching the skill body. Lets sensitive skills opt out of low-confidence triggers without each skill's body rebuilding the same guard expression.

## Channel/locality awareness (Phase 4)

Ambient refs for current channel state:

```
$(CHANNEL_TYPE)       # slack-dm, slack-channel, voice, web, etc.
$(CHANNEL_PRIVACY)    # private, public, group
$(CHANNEL_NAME)
```

Privacy gating uses these. A sensor-fired skill that reads `voice-prosody` should not emit to a public channel. Runtime enforces; ambient refs let skill bodies make routing decisions.

**This is the structural gate** that makes the sensor direction socially defensible — privacy as precondition, not feature.

## Introspection primitives (Phase 5)

Self-state queries:

```
$(PROMPT_CONTEXT.size)
$(SKILLS_FIRED_RECENTLY.last-1h)
$(SELF.confidence-trend)
```

**Rationale:** Skills can't reason about other skills' state today. Introspection closes the gap.

## Capability declarations (Phase 5)

Skill declares its required surfaces:

```
# Requires-Capabilities: sensors=[mic, camera], tools=[amp_write_memory, slack_post]
# Requires-Privacy: private-channel-only
```

Runtime fails-fast on missing capabilities. Trust precondition for sensor work — operators can audit which skills touch which surfaces.

## Build order rationale

Phases must land in order:
- Phase 0 → 1 → 2 are foundation; without them, sensor work compounds problems
- Phase 3 (sensors) needs Phase 1 (suppression, state) and Phase 2 (core ops, session triggers) solid first
- Phase 4 (routing) has nothing to route until sensors produce traffic
- Phase 5 (introspection) is ergonomic, not foundational — useful but skippable

See roadmap atom `88a1c3ca` for full phase ordering and "why each phase is where it is" rationale.

## When the language extends, this section moves

When any of these primitives ship, the relevant grammar moves into its canonical section (Ops reference, Variables, Triggers, etc.) and this section's entry is replaced with a cross-reference. Future-extensions section stays alive for the next horizon of unshipped work — it's a continuous staging area, not a once-and-done document.

## Open spec questions — unresolved language design decisions

Questions surfaced during design that haven't been resolved. Each carries a Perry-leans answer where applicable; spec must commit at implementation time.

## 1. `?` op explicit prompt — confirm v3 requirement

The bare `?` form is the most fragile primitive in the language. Implicit-context-reading drifts subtly across model versions. Perry leans: require an explicit prompt in v3, deprecate bare `?`. Authoring migration: existing bare `?` ops compile-warn, then compile-error after a deprecation window. **Resolve before v3 ships.**

## 2. `??` decline semantics

When the user responds "no"/"n"/falsey to a `??` prompt in interactive mode, what happens to dependent targets? Perry leans: bind the response to the output variable AND short-circuit downstream targets (treat as soft op-error so `else:` fires). Silent fall-through to subsequent `apply:` is exactly the security bug pattern; spec must commit explicitly. **Resolve in language reference revision.**

## 3. Block execution model — write down the rules

Within a target body, op ordering and variable binding conventions aren't fully written down. Specific questions:
- Can `!` directives precede `$` ops in the same target? (Yes; `!` has no dependency on subsequent ops.)
- What's the default output binding when `-> NAME` is omitted? (`$(target.output)` — same as bare `target` referenced from other blocks.)
- How do cross-block references work syntactically? (`$(other_target.output)` or `$(VAR_BOUND_THERE)`.)

**Write a "Block execution model" subsection.** No semantic change, just documentation gap.

## 4. `$` op prose suffix — disallow in v3

Example: `$ Edit file_path=... — merge hooks.PreToolUse block from $(plan.output)`. The em-dash + prose only works in agent-mediated execution because the agent interprets prose. Runtime-mediated execution ignores or errors on the trailing prose.

Perry leans: disallow prose in `$` for standalone v3. Args only, structured. Prose moves to a `~` op (LocalModel) that produces structured instructions; `$` consumes them. Keeps `$` semantics deterministic across both execution paths. **Resolve in language reference revision.**

## 5. `default:` semantics — make goal-directed shape explicit

`default:` names the *goal target*, not the entry point. The runtime walks dependencies backward through topo-sort. Skills with one target obscure this; multi-target skills make it visible. Authors writing imperative-style ("do A, then B") will be surprised by execution order otherwise.

**Status:** Already covered in the Overview section. Surface again in operator-of-skills tutorial material.

## 6. `&` skill-invocation output binding

What does `$(WEATHER)` contain after `& get-weather -> WEATHER`? Probable answer: the called skill's `default:` target output. Should be made explicit when `&` ships. Affects compiler; affects how authors reason about composed output.

## 7. `else:` block visibility into the error

Should `$(ERROR)` be an ambient ref inside `else:` blocks, populated with the error type/message? Perry leans: yes, same shape as `$(ERROR_CONTEXT)` in `# OnError:`. Useful for logging/telemetry skills. **Not yet shipped.**

## 8. Nested `# OnError:`

If `# OnError: degraded-skill` fires and `degraded-skill` itself errors, what happens? Perry leans: hard exit, no nested fallbacks. **Spec committed; documented in Error handling section.**

## 9. Multiple triggers — concurrency

If `cron: 0 8 * * *` and `event: scott.present` both fire within seconds, does the skill run twice (independent) or get deduped? Perry leans: independent. Author dedups via state if needed. Affects broker dispatch.

## 10. `&` invocation vs trigger firing

When skill A invokes skill B via `&`, do skill B's `# Triggers:` fire? Almost certainly no — `&` is direct invocation, distinct from the trigger event surface. **Worth saying explicitly when `&` ships.**

## 11. File-watch path semantics

Recursive or directory-only by default? Inotify supports both. Perry leans: directory-only default; offer recursive via `file-watch-recursive:` or `file-watch: <path> (recursive)`. Affects broker.

## 12. Output target delivery failures

If `# Output: slack: scott` and Slack is down, what happens? Perry leans: delivery failure is its own retryable error; queue if possible, else error to caller. Worth a separate small spec section. Affects broker.

## 13. Compile-time vs runtime fallback evaluation timing

`# Requires:` fallbacks are compile-time. Op-level `(fallback: ...)` and `else:` blocks are runtime. Authoring clarification needed. **One-table summary in the spec would close the gap.**

## 14. Skill versioning rollback UX

Edits via upsert preserve history through memory versioning, but no first-class "rollback" affordance. Probably needs a `--version <N>` flag on `amp_compile_skill` or a sister tool. **Out of v2 scope; track as future work.**

## 15. Skill discoverability

When the library grows past ~20 skills, name typos in `&` invocations become a real risk. No "list available skills with their inputs" surface yet. **Out of v2 scope; track as future work.**

## 16. `?` op explicit prompt — migration path

Pairs with #1. When the language deprecates bare `?`, existing skills in the library need to be migrated. Migration tool: a lint pass that surfaces bare-`?` usage and proposes explicit prompts based on surrounding context. Authoring assistance, not automated rewrite.

## 17. Connector capability declarations

Skills can declare required connector capabilities via `# Requires:` (Phase 5). Examples: "needs semantic search," "needs structured-extraction model with 32K context." Useful for the substrate-portable story. **Pending design.**

## 18. Per-op timeouts

No timeout mechanism today; hung dispatches hang the skill. Perry leans: skill-level `# Timeout:` header + per-op `timeoutSeconds=N` kwarg + runtime defaults. **Pending; surfaced by olsen-nightly cold-start incident 2026-05-18.**

## 19. Data-skill primitive — which op fetches a data skill?

If we adopt the procedural-skills vs data-skills distinction (the compiler produces separate artifact types, the procedural skill is unchanged when data updates), an open question remains: which op references a data skill from a procedural one? Four viable shapes:

- **Extend `# Requires:` to data skills.** Keeps data lookup compile-time, baking the data value into the compiled artifact. Loses runtime flexibility but gains determinism + reproducibility.
- **Use `>` retrieval.** Data skills are a tagged memory class returned by `>` queries. Composes with existing primitives; data is runtime-fetched.
- **Dedicated data-fetch op** (e.g., `^ skill_name -> VAR`). Explicitly different from procedure-call `&`; signals intent at read time. Adds one more op kind to the grammar.
- **Same `&` op, compiler inlines at compile time.** Uniform syntax with procedure invocation, but compiler treats data-skill references as compile-time includes. Author syntax is the same; semantics diverge based on the referenced artifact's type.

Perry leans: option 4 (uniform `&` with compile-time inline for data skills). Best of both — uniform call surface for authors, deterministic compile-time semantics for data, runtime-execution semantics for procedural. Compiler tracks "compiled against version N of data skill X" for staleness tracking; data update triggers recompile of dependent procedural skills.

Operational implication differs by choice: compile-time inline means data update → recompile dependent skills → new compiled artifacts published (more rebuild churn but deterministic at runtime). Runtime fetch means data update is invisible to the procedural skill until next invocation (less churn but less predictable).

**Resolve before data-skill payload type ships.** Affects compiler, lint pass, and the `# Requires:` cascade design.

---

*Rendered from `skillscript/skillscript-language-reference` — 2026-05-20 13:56 EDT*  
*Source of truth: AMP (`amp_render_document("skillscript/skillscript-language-reference")`)*