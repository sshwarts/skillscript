# Skillscript Language Reference — syntax, ops, semantics

Canonical language reference for skillscript. Audience: skill authors (human + agent). Specifies what is valid syntax, what behavior to expect at compile + runtime, and what is currently pending implementation.

Implementation state is cross-referenced to commit hashes; pending items mark v2/v3 work.


## Not yet implemented, but planned

These are features designed or anticipated but not yet implemented in the current build. Authors should not use these forms; they will not compile.

## Control flow

- **`while CONDITION:` loops** — today's iteration is `foreach IDENT in EXPR:` only. While loops are planned for ad-hoc orchestration patterns ("loop until response contains 'done'").
- **Arithmetic in `$set`** — today accepts literals + `${VAR}` interpolation; no `+ - * /` operators. Planned alongside `while` for turn counters and orchestration bookkeeping.

## Pipe filter extensions

- **Array aggregation primitives** — `|max`, `|min`, `|sum`, `|reduce` over arrays. Today the language tops out at "shape one record" — aggregating across an array requires `foreach` accumulator ceremony. Planned as a design question: is `foreach` the deliberate ceiling for aggregation, or do we add primitives?

## Triggers (parse-clean today, don't fire — no event-bus surface yet)

- `event:` — generic event-bus subscription
- `agent-event:` — agent-emitted events
- `file-watch:` — filesystem change events
- `sensor:` — continuous sensor channels

## Synchronous agent exchange

- **`exchange()` runtime-intrinsic op** — synchronous send + wait pattern for multi-agent conferences. Awaits adopter-substrate queue impl + AgentConnector contract grow.

## Tests

- **`# Tests:` block** with `given:` / `expect:` assertions — author-authored test cases. Will land when adopter signal demands test infrastructure.

## Output kinds

- **`# Output: file: <path>`** — file-output routing parses but no router exists today.
- **`# Output: card:`** — depends on a substrate-side card render surface; not implemented.

## Persistent state with declared scope

```
$set NAME = value scope=skill-local
$set NAME = value scope=agent-global
$set NAME = value scope=session
```

Scopes: skill-local (persists across fires of this skill, not visible to other skills), agent-global (visible to all skills of the same agent), session (alive for the duration of the current session, cleared at session end). Backed by a configured data-records connector.

## Sensors as a language category

Distinct from triggers. Sensors are continuous channels the agent reads but doesn't emit on. Planned syntax:

```
# Sensors: presence, screen-state, voice-prosody
```

Ambient refs `$(SENSOR.presence)`, `$(SENSOR.voice-prosody.affect)` for read access. Privacy-gating discipline determines when a sensor is readable.

## Time as first-class primitives

Currently `$(NOW)` (wall-clock). Planned relative-time primitives:

```
$(SECONDS_SINCE_LAST_USER_MESSAGE)
$(MINUTES_SINCE_SESSION_START)
$(SECONDS_SINCE_LAST_FIRE_OF.<skill-name>)
```

Most "right time" reasoning is relative, not wall-clock.

## Other planned

- **Absence-as-trigger** — `# Triggers: idle: 5m` fire-on-quiet primitive
- **Time-windowed aggregation** — filter-like primitives across firings (e.g., "user has shown frustration in 3 of 5 recent turns")
- **Debounce / rate-limit / coalesce** — declarative queueing policy headers
- **Suppression as valid output** — explicit "fire-and-suppress" (different from `# Output: none`)
- **Cross-skill pub-sub** — `# Publishes: signal.X` / `# Subscribes: signal.Y` decoupling
- **Confidence/threshold gating** — `# RequiresConfidence: classifier >= 0.8` / `# RequiresThreshold:`
- **Invocation-control axis** — `# Invocable-By: user | agent | trigger` (sensitive ops shouldn't leak across invocation boundaries)
- **Channel/locality awareness** — `$(CHANNEL_TYPE)`, `$(CHANNEL_PRIVACY)` ambient refs for routing decisions
- **Introspection primitives** — `$(PROMPT_CONTEXT.size)`, `$(SKILLS_FIRED_RECENTLY.last-1h)`, `$(SELF.confidence-trend)`
- **Capability declarations** — `# Requires-Capabilities: sensors=[mic, camera], tools=[...]` (audit surface for operators)

## When the language extends, this section shrinks

When any of these primitives ship, the relevant grammar moves into its canonical section (Ops reference, Variables, Triggers, etc.) and the entry here is removed. This section stays alive as a continuous staging area for the next horizon of unshipped work.

## Overview & language model

Skillscript is a constrained domain-specific language for authoring agent workflows. A skillscript is a declarative recipe: a small program with a dependency DAG of named targets, each composed of typed operations. Skillscripts are written once and executed many times.

## Language model — trigger → process → deliver

Every skill follows the same shape:

1. **Trigger** — what fires the skill: cron, command, session-start, agent-event, file-watch, webhook, etc.
2. **Process** — pull data (MCP / data store / file), classify or compose via sub-LLM + iteration, build the deliverable.
3. **Deliver** — emit the result via one or more delivery channels (see below).

Skillscript's job is to express this pipeline declaratively. When there is an agent above the skill, the agent's job is to act on the delivered artifact. When there isn't (autonomous fires), the delivery channel IS the outcome.

**Declarative DAG, not imperative script.** A skillscript declares targets and their dependencies (`needs:` keyword); the interpreter topologically sorts and executes them in dependency order. Write blocks in any order — the runtime walks the graph.

**Goal-directed, not entry-point-directed.** The `default:` declaration names the *goal target* — the terminal node whose result is the skill's output. The runtime walks dependencies backward from the goal through the topo-sort. A skill with a single target obscures this (goal == entry trivially); skills with multi-target DAGs make the shape visible.

## Two execution paths

**Runtime-mediated** — the interpreter walks ops and dispatches them directly through configured connectors. Used for autonomous fires (cron, session-triggered, event-triggered). Safety boundary is the connector config + per-op gating (see Ops Reference).

**Agent-mediated** — the compiler renders the skill as a prompt; an agent reads the prompt and executes ops through its own tools. Used when an agent invokes a skill mid-conversation. Safety boundary is the agent's harness tool permissions.

The language is identical in both paths. The execution model is a deployment-time + invocation-time decision.

## Three delivery channels

A skill delivers its work via one or more of three channels. Delivery channel is not a property of skill type — it's just which ops a skill ends with.

| Channel | Op | When you'd use it |
|---|---|---|
| **Augmenting (context to agent)** | `emit(text="...")` + `# Output: agent: <name>` | Skill output is augment-kind payload for the receiving agent's next turn; joined emit stream becomes the delivered context. Pattern: agent-augmenting skills (briefing skills, session-start prepared context). |
| **Template (playbook to agent)** | `emit(text="...")` + `# Output: template: <name>` | Skill output is a template-kind payload (recipe/playbook) the receiving agent executes. Pattern: instructional skills, reusable recipes. |
| **Data handoff** | `$ data_write content="..." recipients=[<agent>] -> R` | Skill writes data the target agent picks up via mailbox at next session. Pattern: async carrier skills, autonomous fires that hand off to a future session. |

A single skill can use any combination. An autonomous cron-fired sweep might write data to one agent AND emit augment-kind context to another. The combinations are unconstrained — the per-op gating model governs which mutating ops are authorized, not which channels a skill uses.

## Three op classes

The op surface is three classes, each with its own grammar:

| Class | Shape | Resolution |
|---|---|---|
| **Mutation statements** | `$set VAR = value`, `$append VAR <value>` | Reserved keywords. |
| **Runtime-intrinsic function-calls** | `verb(kwarg=value, ...) [-> BINDING]` | Closed built-in list (see Ops Reference). Unknown verb → tier-1 lint `unknown-runtime-op`. |
| **External MCP dispatch** | `$ <connector> kwarg=value, ... [-> BINDING]` | Resolved against `connectors.json`. Unknown connector → tier-1 lint `unknown-connector`. |

The `$` prefix is information-bearing: it marks **state-affecting ops** (mutation OR external dispatch). Function-call shape marks **language-intrinsic ops the runtime knows directly**.

Full op catalog and per-op semantics in Ops Reference.

## Substrate portability

The language doesn't privilege any backend. `$ llm`, `$ data_read`, `$ ticketing_search` are not language built-ins — they're connector names resolved at runtime through the registered MCP connector instances. The same skill source runs against any conforming substrate.

The runtime ships bundled bridges for two common patterns:

- `$ llm` routes through whichever LocalModel is wired (via `substrate.local_model` in `connectors.json`)
- `$ data_read` / `$ data_write` route through whichever DataStore is wired (via `substrate.data_store`)

Adopters wire OpenAI instead of Ollama, Pinecone instead of SQLite, etc. Configuration lives outside the skill body; the language remains agnostic.

| Connector slot | Adopter A wires | Adopter B wires |
|---|---|---|
| `llm` | LocalModel: Ollama (default) | LocalModel: OpenAI |
| `data_read` / `data_write` | DataStore: SqliteDataStore (default) | DataStore: Pinecone |
| `ticketing_search` | YouTrack MCP | Jira MCP |

Substrate config syntax + the three-form configuration shape lives in the adopter playbook, not in this reference. Skill authors don't typically need to touch it — they author against the canonical `$ tool` surfaces and adopters wire whatever's underneath.

## Anatomy of a skill

A canonical example exercising trigger → process → deliver against the augmenting channel:

```
# Skill: morning-showstopper-sweep
# Description: Pre-triage open showstoppers before the human arrives; deliver as augmenting context to the on-call agent.
# Triggers: cron:"0 8 * * MON-FRI"
# Output: agent: oncall
# Vars: PROJECT = "INFRA"

sweep:
    # Process: pull showstoppers
    $ ticketing_search query="project:${PROJECT} severity:showstopper state:Open" -> SHOWSTOPPERS

    # Deliver header
    emit(text="Morning showstoppers for ${PROJECT} (count: ${SHOWSTOPPERS.totalCount}):")
    emit(text="")

    # Process + deliver per issue (sub-LLM analysis bracketed by emit lines)
    foreach ISSUE in ${SHOWSTOPPERS.items}:
      $ llm prompt="Two-line summary + top hypothesis for: ${ISSUE.summary}" -> ANALYSIS
      emit(text="## ${ISSUE.id}: ${ISSUE.summary}")
      emit(text="${ANALYSIS}")
      emit(text="")

default: sweep
```

The joined `emit()` stream becomes the augment-kind payload delivered to the on-call agent (per `# Output: agent: oncall` declaration). The agent sees the briefing inline at next-turn dispatch.

**Three layers of declaration:**
1. **Header metadata** (`# Key: value` lines) — name, description, declared variables, triggers, `# Output:` routing, optional `# Autonomous:` flag, error fallbacks
2. **Targets** — named blocks of typed ops, optionally with `needs:` dependencies
3. **`default:`** — names the goal target the runtime walks toward

Other delivery channels for the same shape: swap `# Output: agent: oncall` + the `emit()` calls for `$ data_write content="..." recipients=["oncall"] approved="cron-fired" -> R` (one summary data handoff per fire) or `file_write(path="/var/log/showstoppers-${EVENT.fired_at_unix}.md", content="...", approved="cron-fired")` (one file deliverable per fire).

## Lexical conventions

### Indentation: spaces only

Block structure (`foreach`, `if`/`elif`/`else:`, target bodies, error-handler `else:` blocks) is determined by indentation. **Use spaces. Tabs are a parse error.** Mixed tabs+spaces in a single file is a parse error.

The conventional indent is 4 spaces, but any consistent depth within a block is acceptable. The parser tracks each block's indent level on entry and rejects mid-block changes.

### Reserved keywords

The following identifiers are reserved and cannot be used as variable names, target names, or skill names:

**Mutation statements:** `$set`, `$append`

**Runtime-intrinsic op names:** `emit`, `notify`, `inline`, `execute_skill`, `shell`, `file_read`, `file_write` (the closed function-call list; see Ops Reference)

**Control flow:** `default`, `needs`, `if`, `elif`, `else`, `foreach`, `in`, `not`, `unsafe`

**Future-reserved** (no current semantics, reserved to keep future grammar additions non-breaking): `while`, `for`, `match`, `try`, `catch`, `return`. See the "Not yet implemented, but planned" section at the top for what's coming.

Reserved-name use produces a parse error with a specific diagnostic.

**Case sensitivity.** Reserved words are exact-match case-sensitive. `emit` is reserved; `Emit` is allowed. `If` is allowed as an identifier; `if` is the control-flow keyword.

### Enumerated value normalization

For frontmatter keys with a closed set of accepted values (`# Status:`, `# Output:` kinds, trigger sources, etc.), values are accepted case-insensitively on input and stored as their canonical form. `# Status: draft`, `# Status: Draft`, and `# Status: DRAFT` all parse to the same canonical `Draft`.

This applies to value-space normalization only — keys remain case-sensitive (`# Status:` is the header; `# status:` is a parse error).

## Storage and identity

Skillscripts are stored via a configured `SkillStore` backend. The backend persists each skill as a uniquely-named record; writing a skill with an existing name updates in place. Skill records are infrastructure, not knowledge atoms — backends with garbage-collection or expiry semantics should treat skills as long-lived first-class records, not as candidates for cleanup.

The language is storage-agnostic; the interpreter accepts a skillscript body as text regardless of source. The runtime ships three reference SkillStore implementations:

- **`FilesystemSkillStore`** — skill bodies on disk as `.skill.md` files. Common for filesystem-first authoring workflows (humans editing files in a Git repo).
- **`SqliteSkillStore`** — skill bodies in a SQLite database. Default for runtime hosts (MCP server, web dashboard) when adopters want substrate-native authoring (via dashboard or `skill_write` MCP).
- **Adopter-custom** — adopters write `class MySkillStore implements SkillStore` against the contract; runtime is none the wiser.

Substrate selection lives in `connectors.json` (adopter concern; details in the adopter playbook).

### File-backed convention (FilesystemSkillStore)

Three-file pattern per skill on disk, mirroring the standard source/compiled split (`.ts`→`.js`, `.scss`→`.css`):

- `<skill-name>.skill.md` — **source.** Authored by humans or agents. Dual-extension: `.md` outer makes any markdown-aware tool render headers + code blocks natively; `.skill` inner is the language-tooling discriminator. Committed to version control.
- `<skill-name>.skill` — **compiled artifact.** The prompt text emitted by the compile API. Agent-consumable. Typically gitignored.
- `<skill-name>.skill.provenance.json` — **provenance sidecar.** Records source content_hash, compiled version, timestamps, data-skill staleness markers. Typically gitignored.

Default `.gitignore` for a file-backed skills repo: `*.skill` and `*.skill.provenance.json`.

## Authoring discipline

Three principles for skill authors, learned by accumulated failure across many agent-authored skills.

### Don't encode deterministic implementation details

Skills are orchestration; deterministic operations are tools. When tempted to hardcode a CLI version string, a REST endpoint payload structure, or an authentication handshake, the discipline says: *the work belongs in an MCP tool, not in the skill body*.

- **Drift.** CLI versions change. Endpoints change. The skill that hardcodes them breaks on next update; the MCP tool that abstracts them survives.
- **Substrate-portability.** A skill that knows "the API returns `{ user: {...} }`" is bound to one API shape. A skill that calls `$ user_fetch -> USER` and accesses `${USER.id}` works against any connector that conforms to the user-shape contract.
- **Authority.** Auth handshakes inside skill bodies leak credentials through skill source. Auth lives in the connector's identity-merge layer, not in the call site.

If the work feels deterministic and reproducible — a fixed parse, a fixed API call, a fixed shell pipeline — it's a tool. The skill body should invoke that tool via `$`, not re-implement it.

### Describe when the skill should be invoked, not what it does

The `# Description:` header determines whether agents pick the right skill when multiple are available. A vague description ("Handles error responses") is roughly useless for invocation selection. A specific description ("Read `references/api-errors.md` if a downstream API returns non-200 status") fires the skill at exactly the right moment.

Write descriptions as *trigger conditions*: "if X happens, run this." Not as summaries. Authors who think of the description as the skill's elevator pitch produce skills that never get picked because the trigger condition isn't stated.

This matters at scale. When a skill library grows past ~20 skills, the difference between "agents find the right skill" and "agents waste effort discovering the wrong one" is description-quality discipline.

### Comparison is orchestration; computation goes in tools

The conditional grammar (`==` / `<` / `>` / `in` / `and` / `or` / `not`) lives in the language because conditionals ARE orchestration decisions. Arithmetic, aggregation, transformation — these produce values, which is computation, which belongs in tools.

When you reach for a primitive that isn't in the language (`|max` over an array, modular arithmetic, regex substitution, date math), the stopping rule isn't "feature shelved." It's: *can a tool do this work, and can the skill body invoke that tool via `$` or `shell`?* Almost always yes.

**The universal computation escape is `shell + standard CLI tools.**

```
shell(command="echo ${RAW|shell} | jq -r '[.weather[0].hourly[] | .chanceofrain | tonumber] | max'", unsafe=true) -> MAX_RAIN
if ${MAX_RAIN} > "20":
    emit(text="Rain chance today: ${MAX_RAIN}%")
```

The skill body stays orchestration-shaped — fetch → compute → compare → emit. The aggregation (jq's `| max`) happens inside the shell call, not inside the skill grammar. `${RAW|shell}` neutralizes interpolation safely; `unsafe=true` is required for pipe characters.

Common shells of this pattern:
- Array aggregation → `jq '... | max/min/length/add'`
- Field extraction → `jq -r '.field'` or `awk '{print $N}'`
- String manipulation → `sed`, `cut`, `tr`
- Regex → `grep -E`, `sed 's///'`
- Date math → `date -d` or `python -c 'import datetime; ...'`

When a native primitive eventually ships (e.g., `|max` lands as a language filter), the shell-based version stays correct; the native one is a more skillscript-shaped spelling of the same work. The shell escape is never the wrong answer; it's the always-available answer.

**The stopping rule:** before declaring "feature blocked on missing primitive X," ask: *does shell + a standard tool already do this?* The design philosophy already provides the path; the question is whether a more native spelling would be cleaner.

## Ops reference — three op classes (mutation / runtime-intrinsic / external MCP dispatch)

The op surface is three classes, each with its own grammar and resolution path.

## Three op classes at a glance

| Class | Shape | Resolution |
|---|---|---|
| **Mutation statements** | `$set VAR = value`, `$append VAR <value>` | Reserved keywords (parser dispatches directly). |
| **Runtime-intrinsic function-calls** | `verb(kwarg=value, ...) [-> BINDING]` | Closed built-in list (below). Unknown verb → tier-1 `unknown-runtime-op`. |
| **External MCP dispatch** | `$ <connector>.<tool> kwarg=value, ... [-> BINDING]` (substrate-specific) or `$ <tool> kwarg=value, ... [-> BINDING]` (typed-contract only) | `connectors.json` resolution at compile. Unknown connector → tier-1 `unknown-connector`. See External MCP dispatch subsection below for canonical form rules. |

The `$` prefix is information-bearing: it marks **state-affecting ops** (mutation OR external dispatch). Function-call shape marks **language-intrinsic ops the runtime knows directly**. Parse-time discrimination is unambiguous — three grammars, three resolution paths, zero overlap.

All call-sites are uniform all-kwargs. No positional arguments. No mixed shapes. One call form per class.

---

## Mutation statements

### `$set` — explicit variable binding

Binds a value to a variable. Bind-time interpolation of `${VAR}` substitutions in the RHS.

```
$set RESULT = ""
$set MODE = "production"
$set GREETING = "Hello, ${NAME}!"          # resolves at bind time
$set FOUND = []
```

RHS forms accepted: string literal (with `${VAR}` substitution), number literal, boolean (`true` / `false`), `null`, empty list `[]`, JSON array literal, JSON object literal, or a single variable ref `${OTHER}`.

Missing-ref produces tier-1 runtime error.

### `$append` — accumulator

Mutates the target binding in the outer scope. Type-dispatched on the target binding.

- **List target** → element append.
- **String target** → concatenation.
- **Number/object/null target** → tier-1 `append-to-non-list` lint error.

```
# List-typed accumulator
walk:
    $set SEEN = []
    foreach C in ${CANDIDATES}:
        if ${C.id} not in ${SEEN}:
            $append SEEN ${C.id}
            emit(text="NEW: ${C.id} — ${C.summary}")
    emit(text="Total novel items: ${SEEN|length}")

# String-typed accumulator
build:
    $set DETAIL = ""
    $append DETAIL "Open issues for ${USER.login}:\n\n"
    foreach ISSUE in ${ISSUES.items}:
        $append DETAIL "- ${ISSUE.id}: ${ISSUE.summary}\n"
```

**Initialization required.** `$append VAR <value>` where VAR isn't initialized in the enclosing scope (via `$set X = []`, `$set X = ""`, or `# Vars: X=[]` / `# Vars: X=""`) fires tier-1 `uninitialized-append`.

**Foreach scope rule.** When `$append VAR` is inside a `foreach`, VAR's init must live in an *enclosing* scope. Tier-1 `foreach-local-accumulator-target` catches this.

**Single-value semantics (list mode).** `$append VAR <value>` appends one element. List concatenation is deferred to a future `$extend` op.

**Parallel foreach.** `$append` inside a `parallel foreach` is a tier-1 error.

---

## Runtime-intrinsic function-calls

Closed list of language-intrinsic ops the runtime knows directly. Each is a function-call with kwargs; binding via optional `-> VAR`. The complete set:

| Op | Shape | Binding | Notes |
|---|---|---|---|
| `emit` | `emit(text="...")` | none | Append to the skill's emission stream; consumed by the configured `# Output:` delivery channel. |
| `notify` | `notify(agent="...", message="...", [event_type=...], [correlation_id=...]) -> ACK` | optional | Mid-skill agent alert; synchronous send via configured AgentConnector. |
| `inline` | `inline(skill="<data-skill-name>")` | none | Compile-time inline of an Approved `# Type: data` skill. Resolves at compile, records `content_hash` in provenance. |
| `execute_skill` | `execute_skill(skill_name="...", inputs={...}) -> R` | optional | Composition primitive. Runtime-resolved. See Composition section. |
| `shell` | `shell(command="...") -> R` / `shell(command="...", unsafe=true) -> R` | optional | Sandboxed shell exec (default) or full-shell exec (`unsafe=true`, gated by `runtime.enable_unsafe_shell`). stdout binds. |
| `file_read` | `file_read(path="...") -> R` | required | Read a file at `path`; binds string contents. |
| `file_write` | `file_write(path="...", content="...")` | none | Write `content` to `path`. `mkdir -p` semantics for parent directories. Mutation-classified. |

**Unknown op name** → tier-1 lint `unknown-runtime-op` with remediation pointing at MCP dispatch: "if this is an external tool, use `$ <connector>.<tool> args -> R`."

### `emit` — delivery-channel append

```
emit(text="Triage for ${PROJECT}:")
emit(text="${REPORT}")
```

Substitutions resolved at runtime. Ordering within a block: ops execute sequentially in source order.

**Multi-line strings via triple-quote:**

```
emit(text="""
    Follow these directions exactly, step by step.

    Pull the current state from ${SOURCE}.
    Apply the transformation.
    Verify the output matches ${EXPECTED_SHAPE}.

    Report results to ${RECIPIENT}.
    """)
```

Triple-quote string literals (`"""..."""`) accept multi-line bodies. Whitespace-strip semantics: Python `textwrap.dedent` pattern — strip common leading whitespace across non-blank lines, strip leading + trailing blank lines. Dedent runs before `${VAR}` interpolation, so substituted values arrive verbatim into the dedented template and keep their own whitespace.

Triple-quote is a literal type that any kwarg accepts — not emit-specific. `$ llm prompt="""..."""`, `notify(message="""...""")`, and `$ data_write content="""..."""` all parse. Most natural fit is `emit(text=...)` in template-kind skills delivering prose, but the parser doesn't restrict use to that op.

Per-output-kind consumption semantics: presentation surfaces (`# Output: agent: <name>`, `# Output: template: <name>`) consume the joined emit stream as the delivered payload. Programmatic surfaces (`# Output: text`, `# Output: file:`) follow the per-kind semantics described in Output targets.

### `notify` — mid-skill agent alert

```
notify(agent="oncall", message="Threshold breached at ${COUNT}")
notify(agent="ops", message="ticket TR-1234 is a showstopper", event_type="ticket-911", correlation_id="${INCIDENT_ID}")
```

Synchronous alert to a named agent via wired AgentConnector(s). **Contrast with `emit`:** `emit` accumulates into end-of-skill bulk delivery via the `# Output: agent: <name>` lifecycle hook; `notify` fires mid-execution to interrupt or page an agent before the skill completes.

- `agent` — target agent id (required)
- `message` — alert body (optional; defaults to accumulated emissions so far)
- `event_type` — adopter-defined routing label (optional; flows to `DeliveryMeta.event_type`; overrides `# Event-type:` frontmatter)
- `correlation_id` — reply-correlation id (optional; required for future `exchange()` / `request_response()` paths)
- `connectors` — JSON array restricting which wired AgentConnector(s) receive the dispatch (optional)

Returns ACK `{agent, dispatched: [{connector, ok, error?}]}` — fire-and-forget callers ignore the binding; check-delivery callers inspect ACK.

### `shell` — sandboxed or unsafe shell exec

**Sandboxed default:**

```
shell(command="curl -s 'wttr.in/${LOCATION|url}?format=j1'") -> RAW
shell(command="git status") -> STATUS
```

Structured-spawn sandbox: one binary per call, args parsed structurally, no shell metacharacter interpretation. The structural constraints ARE the security model. stdout binds; non-zero exit → op-error routed through `else:` / `# OnError:`.

**Unsafe mode:**

```
shell(command="for i in $(seq 1 10); do echo $i; done", unsafe=true) -> R
shell(command="curl -s example.com | jq '.field' > /tmp/out", unsafe=true)
```

- Lint flags every `unsafe=true` call as tier-2.
- Runtime refuses with `UnsafeShellDisabledError` unless deployment sets `runtime.enable_unsafe_shell = true` (default `false`). Compile-time `unsafe-shell-disabled` tier-1 catches at authoring.
- Audit-visible at every fire.

Bash's `$(command)` and arithmetic `$((expr))` pass through to bash without escape because skillscript's substitution is braced (`${VAR}`).

### `file_read` / `file_write` — file I/O

```
file_read(path="/tmp/state.json") -> STATE
file_write(path="/tmp/report.md", content="${REPORT}", approved="nightly sweep deliverable")
```

`file_read` is read-only (always allowed). `file_write` is mutation-classified — requires `# Autonomous: true` declaration on the skill OR per-call `approved="..."` kwarg. `mkdir -p` semantics for the parent directory.

`unconfirmed-mutation` lint enforces the mutation-classification rule.

### `inline` — data-skill compile-time inline

```
brief:
    $ llm prompt="${VOICE_RULES} Now write a one-line status:" -> RESULT
    inline(skill="voice-rules")
```

Inlines an Approved `# Type: data` skill into the host skill's compiled artifact at the call site. Resolved at `compile()` time; the data skill's `content_hash` is recorded in the host's provenance. `skillscript audit` detects stale recompiles when a referenced data skill changes.

**Identity semantic.** Inlined helpers run under the **host skill's identity** — compile-time paste makes the inlined ops part of the host body, so there is no runtime identity boundary to cross. Contrast with `execute_skill` where the called skill runs under its own author identity. Bringing code in via `inline` is an act of taking responsibility for it.

See Composition section for the distinction between `inline` (compile-time), `execute_skill` (in-skill runtime call), and dispatched skills.

### `execute_skill` — composition runtime call

```
classify:
    execute_skill(skill_name="classifier", inputs={"text": "${INPUT}"}) -> VERDICT
```

Runtime-resolved against the SkillStore. Recursion-depth-guarded (default 10).

**Identity semantic.** Calls run under the **called skill's author identity** (`SkillMeta.author`), not the caller's — same rule as direct dispatch. When skill A (authored by Alice) invokes skill B (authored by Bob) via `execute_skill`, B runs as Bob. Each skill is its own identity unit; the dispatcher does not loan its identity to the callee. Cross-author delegation (caller-identity threaded as a separate context) is a future-ring design surface.

---

## External MCP dispatch

Calls a tool through a configured connector. Connector name resolves against `connectors.json`. Output binds via optional `-> VAR`. Adopter-side contract details + connector wiring conventions live in the adopter playbook.

### Dispatch form

**Substrate-specific tools use named (dotted) form:**

```
$ <connector>.<tool> kwarg=value, ... [-> R]
```

The text before the dot is the connector name (must match an entry in `connectors.json`); the rest is the tool name + args. Named form is canonical for any tool whose semantics are substrate-specific — adopter MCP servers (`amp_*`, `github_*`, `linear_*`, etc.).

```
$ amp.amp_check_mailbox limit=20 -> MAIL
$ amp.amp_write_memory summary="..." domain_tags=["x"] vault="private" -> ACK
$ github.search_issues query="repo:acme/foo state:open" -> ISSUES
$ linear.find_issues filter="project:INFRA" -> TICKETS
```

The skill body literally names its substrate edges — reading the body tells you which MCP servers it depends on, with no `primary` config indirection.

**Typed-contract tools use bare form:**

```
$ <tool> kwarg=value, ... [-> R]
```

Bare form is reserved for ops with a typed runtime contract — the substrate variance is invisible to the skill body because the runtime dispatches through the contract.

```
$ data_read mode=fts query="${TOPIC}" limit=5 -> RESULTS
$ data_write content="${SUMMARY}" tags=["nightly"] -> ACK
$ skill_read name="hello-world" -> S
$ skill_write name="child" source="..." overwrite=true -> W
$ json_parse ${RAW_JSON} -> PARSED
$ llm prompt="..." -> R
```

Typed-contract ops (`data_*`, `skill_*`, `json_parse`, `llm`) auto-wire from the adopter's `substrate.local_model` / `substrate.data_store` / `substrate.skill_store` config — the skill body doesn't know whether it's running against SQLite or Postgres or Pinecone. That's the point of the typed contract.

**Lint rules:**
- `unknown-connector` (tier-1) — `$ x.y` where `x` isn't wired. Lists wired connector names.
- `bare-mcp-call` (tier-1) — `$ tool_x` where `tool_x` isn't a typed-contract op AND no `primary` connector is wired. Remediation: qualify as `$ <connector>.tool_x`.
- `unverified-qualified-tool` (advisory) — `$ x.y` where connector `x` doesn't declare its tool surface statically. Runtime will resolve at call time.

### Universal op-level kwargs

Four surfaces apply to every `$` dispatch regardless of tool. The runtime intercepts these before forwarding the remaining kwargs to the connector.

**`timeout=N`** — Per-op timeout in **seconds**. Integer literal or `${VAR}` ref. Resolution chain (most-specific wins):

1. Per-op `timeout=N` kwarg
2. Skill-level `# Timeout: N` header
3. Absolute context default (runtime config)
4. Built-in default

```
$ llm prompt="..." timeout=30 -> R
$ amp.amp_olsen_task task_type="scan" timeout=120 -> DISPATCH
```

**`approved="<reason>"`** — Author-intent marker for the mutation-gate lint. Any non-empty string satisfies. Extracted at runtime; **not forwarded to the connector**. The value is required but not parsed semantically — presence is the signal.

```
$ data_write content="${REPORT}" tags=["oncall"] approved="morning roundup" -> ACK
```

**`(fallback: "value")` trailer** — Fires on dispatch throw OR empty bound value (empty string after trim, empty array, null/undefined). Coerce-on-bind: the fallback value binds to the output var transparently, downstream targets need no conditional. Permissive value parsing — bare identifiers, quoted strings, bracketed array literals all accepted.

Note: an envelope object like `{items: []}` is a non-empty object and does NOT trigger the fallback even though its contained array is empty. To handle envelope-empty downstream, test the contained collection (`if ${R.items|length} == "0":`) or apply a filter (`${R.items|fallback:[]}`).

```
$ llm prompt="Classify: ${INPUT}" -> VERDICT (fallback: "unknown")
$ amp.amp_query_memories query="${TOPIC}" -> RESULTS (fallback: [])
$ ticketing.search query="..." -> ISSUES (fallback: "search-unavailable")
```

**`-> R` binding** — Optional output capture. Result string binds to `R` and to `${target}.output`. Omit when the dispatch is fire-and-forget.

**Kwarg validation for typed-contract ops.** Two sibling lints close the kwarg surface — provider-API kwargs (e.g., `temperature=0.7` on `$ llm`) silently dropped by the bridge get caught at parse time:

- `unknown-llm-arg` (tier-2) — `$ llm` carries a kwarg outside the canonical surface (`prompt`/`maxTokens`/`model`/`timeout`/`approved`/`fallback`). `LocalModel.run()` only consumes `{maxTokens, model}`; anything else is silently dropped at the bridge.
- `unknown-data-read-arg` (tier-2) — `$ data_read` carries a kwarg outside the canonical surface (`mode`/`query`/`limit`/`connector`/`fallback`/`domain_tags`/`filters`/`min_confidence`).

For named-form dispatch (`$ <connector>.<tool>`) the connector's `staticTools()` surface + per-tool kwarg validation is the discipline boundary — adopter MCP servers each define their own.

### Typed-contract op surfaces

Canonical kwarg surfaces for each typed-contract bare-form op. These are the ops the runtime auto-wires from `substrate.local_model` / `substrate.data_store` / `substrate.skill_store` config.

#### `$ llm`

Routes through the wired LocalModel.

| Kwarg | Required | Notes |
|---|---|---|
| `prompt="..."` | yes | Non-empty string. Substitution-resolved at runtime. |
| `maxTokens=N` | no | Positive integer (number or numeric string). Forwarded as `runOpts.maxTokens`. |
| `model="X"` | no | Per-call model selection. Resolves against registered LocalModel aliases via `registry.getLocalModel(X)`; falls through to the default LocalModel with `model=X` passed as an upstream hint (e.g., Ollama tag) when X doesn't resolve. See `unknown-llm-model` lint below. |

Plus the universal op-level kwargs (`timeout`, `approved`, `(fallback:)`, `-> R`).

Canonical shape:

```
$ llm prompt="..." [maxTokens=N] [model="<alias-or-tag>"] [timeout=N] [approved="..."] -> R [(fallback: "...")]
```

The wired LocalModel determines which underlying model serves the request. Adopters with multiple registered LocalModels (e.g., `qwen` + `gemma`) can target a specific one via `model="qwen"` from the skill body. The `unknown-llm-model` lint (tier-2) validates the value against both registered alias names AND each LocalModel's `manifest().manifest.models_available` — substrate-aware typo-catch, since manifest data is exposed via `runtime_capabilities`.

#### `$ data_read` / `$ data_write`

Route through the wired DataStore. Surface depends on the connector contract — see the adopter playbook for the canonical DataStore contract reference. Common shape:

```
$ data_read mode=fts query="${TOPIC}" limit=5 -> RESULTS
$ data_write content="${SUMMARY}" tags=["nightly"] approved="..." -> ACK
```

#### `$ skill_read` / `$ skill_write`

Route through the wired SkillStore.

```
$ skill_read name="hello-world" -> S
$ skill_write name="child" source="..." overwrite=true approved="..." -> W
```

#### `$ json_parse`

Runtime-intrinsic parser. Single positional value (the raw JSON string).

```
$ json_parse ${RAW_JSON} -> PARSED
```

### Worked examples

```
$ amp.amp_olsen_task task_type="scan" -> DISPATCH
$ amp.amp_query_memories query="recent activity" limit=5 -> RECENT
$ llm prompt="Classify: ${INPUT}" timeout=30 -> VERDICT
$ llm prompt="Summarize: ${TEXT}" model="qwen" maxTokens=500 -> SUMMARY
$ data_read mode=fts query="${TOPIC}" limit=5 -> RESULTS (fallback: [])
$ data_write content="${SUMMARY}" tags=["oncall"] approved="morning roundup, 2026-05-25" -> ACK
$ ticketing.search query="project:INFRA state:Open" limit=20 -> ISSUES
```

Tool args are unconstrained `key=value` pairs — the connector forwards them to the underlying MCP tool. If a dispatched call returns `isError: true`, the executor throws via `makeOpError`, which routes through `else:` / `# OnError:` machinery. The inner tool's error text is preserved in `result.errors[]`.

**Substrate-neutrality.** Typed-contract bare ops (`$ llm`, `$ data_read`, `$ data_write`, `$ skill_*`, `$ json_parse`) are not reserved built-ins — they're typed-contract bridges the adopter wires through `substrate.local_model` / `substrate.data_store` / `substrate.skill_store` in `skillscript.config.json`. Substrate-specific tools (`$ amp.*`, `$ github.*`, etc.) are whatever the adopter declares in `connectors.json`. For external MCP servers, three bundled wiring paths cover the common cases:

- `HttpMcpConnector` — declarative wiring for any Streamable HTTP MCP server (JSON-RPC over HTTP + SSE). No subprocess. Adopters declare instances by class name in `connectors.json`.
- `RemoteMcpConnector` — stdio bridging for MCPs distributed as spawnable binaries (YouTrack, GitHub, Linear when run locally) or HTTP MCPs adapted via `npx mcp-remote ... --sse`.
- Custom fork (`examples/connectors/McpConnectorTemplate/`) — when the wire shape needs behavior the bundled connectors don't expose.

See the adopter playbook for the substrate config reference + the full Case 2 tradeoff.

**Discovery surface.** `runtime_capabilities` (MCP tool) exposes the registered substrate state. Every entry across all four substrate slots (SkillStore / DataStore / LocalModel / McpConnector) carries its instance `manifest()` payload alongside the static features. Three observable states per entry: working `manifest:{...}`, runtime failure `manifest:null, manifest_error:"..."`, structural absence `manifest:null, manifest_unsupported:true` (AgentConnector only — the contract has no `manifest()` method). The bridge `wraps` convention re-exposes the underlying substrate's full manifest, so adopters reading the discovery surface see the full bound state without traversing multiple entries.

Connector entries also surface `features` declarations (`supports_identity_propagation`, `supports_streaming_responses`, `supports_batch`). Capability flags that span multiple layers — `supports_identity_propagation` requires both the connector's ctx-honoring AND the substrate's per-identity scope honoring — gate via `RuntimeCapabilitiesConformance` auto-coverage: declaring a feature flag true requires the adopter to wire both Level-1 (substrate-independent: ctx reaches transport) and Level-2 (substrate-coupled: distinct identities yield distinct observable scopes) probes via `flagProbes`. Missing probes fail the gate before runtime accepts the flag as true. This is the structural close that prevents the discipline-only-contract pattern (capability claim without honoring impl) from recurring at the capability-flag surface.

**Unquoted-substitution lint** (`unquoted-substitution-in-kwarg-value`, tier-2): fires when `$ x.y key=${VAR}` has unquoted `${VAR}` AND the var's binding origin is "suspect" (`# Vars:` default with whitespace, `$set` with whitespace, op output, foreach iterator). Closes the silent-arg-truncation footgun where the MCP arg parser whitespace-splits substituted values. Remediation: wrap as `key="${VAR}"`.

---

## Per-op gating

Mutation ops require an authorization signal. The signal is per-op, not a mode binary.

**Mutation-classified ops:**
- `file_write(...)` (runtime-intrinsic)
- `$ data_write ...` and any MCP connector entry declared `"mutating": true` in `connectors.json`
- `shell(command=..., unsafe=true)` (always mutation-classified)
- `shell(command=...)` with destructive verb (rm, mv, dd, mkfs, etc. — heuristic list)
- `$ <connector>.<tool>` matching the mutating-verb regex

**Read-only ops (always allowed, no authorization needed):**
- `file_read`, `emit`, `notify`, `inline`, `execute_skill`
- `shell(command=...)` with read-only verb
- `$ <connector>.<tool>` against tools declared `mutating: false` (or unspecified, default false for query-shaped tools)
- `$set`, `$append`

**Authorization signals (either suffices):**
- `# Autonomous: true` in skill frontmatter — author-level: "this skill is authorized to mutate state during its run." Bypasses lint everywhere in the skill.
- `approved="<reason>"` kwarg per-op — call-site-level: "this specific op is authorized." The string is required (forces author intent); value not parsed semantically — presence is what matters.

```
# Authorized via skill-level flag
# Skill: nightly-sweep
# Autonomous: true
# Triggers: cron:"0 8 * * *"

deliver:
    file_write(path="/tmp/sweep.md", content="${REPORT}")        # no approved= needed
    $ data_write content="${REPORT}" tags=["oncall"]             # no approved= needed
```

```
# Authorized per-call (no # Autonomous: true)
# Skill: ad-hoc-snapshot

deliver:
    file_write(path="/tmp/snap.json", content="${DATA}",
               approved="manual snapshot requested 2026-05-25")
```

---

## Op grammar summary

| Class | Op | Shape | Binding |
|---|---|---|---|
| Mutation | `$set` | `$set NAME = value` (with `${VAR}` interpolation at bind) | NAME (no arrow) |
| Mutation | `$append` | `$append VAR <value>` (type-dispatched: list element / string concat) | VAR (no arrow) |
| Runtime-intrinsic | `emit` | `emit(text="...")` or `emit(text="""...""")` for multi-line | none |
| Runtime-intrinsic | `notify` | `notify(agent="...", [message=...], [event_type=...], [correlation_id=...]) -> ACK` | optional |
| Runtime-intrinsic | `inline` | `inline(skill="<name>")` | none (compile-time) |
| Runtime-intrinsic | `execute_skill` | `execute_skill(skill_name="...", inputs={...}) -> R` | optional |
| Runtime-intrinsic | `shell` | `shell(command="...", [unsafe=true], [approved="..."]) -> R` | optional |
| Runtime-intrinsic | `file_read` | `file_read(path="...") -> R` | required |
| Runtime-intrinsic | `file_write` | `file_write(path="...", content="...", [approved="..."])` | none |
| External MCP — substrate-specific | `$ <connector>.<tool>` | `$ <connector>.<tool> kwarg=value, ... [timeout=N] [approved="..."] [-> R] [(fallback: "...")]` | optional |
| External MCP — typed-contract | `$ <tool>` | `$ <tool> kwarg=value, ... [timeout=N] [approved="..."] [-> R] [(fallback: "...")]` (typed-contract ops only: `data_*`, `skill_*`, `json_parse`, `llm`) | optional |

## Variable resolution — ${VAR} canonical, substitution + ambient refs + # Requires: cascade

Skillscript supports four tiers of variables, each with distinct resolution timing and scope. Substitution uses **`${VAR}` as the canonical form**.

## Substitution syntax — `${VAR}` canonical

```
emit(text="Hello, ${USER.login}!")
$ data_read mode=fts query="${TOPIC}" limit=5 -> R
$set REPORT = "Triage for ${PROJECT} (${ISSUES|length} open):\n"
```

Field access: `${VAR.field}`, `${VAR.nested.field}`. Filter chain: `${VAR|filter:"arg"|filter2}`. See Pipe filters section for the filter catalog.

The braced form matches bash double-quoted assignment conventions (trained-corpus alignment) and removes substitution-collision with bash's `$(command)` inside `shell(command=..., unsafe=true)`.

## Tier 1: Ambient

Injected automatically at runtime; never declared by the author.

| Var | Value |
|-----|-------|
| `${NOW}` | ISO-8601 timestamp at op-dispatch time |
| `${USER}` | The configured user identity |
| `${SESSION_CONTEXT}` | Current session-scope context (project/entity/etc., substrate-defined) |
| `${TRIGGER_TYPE}` | What event fired this skill |
| `${TRIGGER_PAYLOAD}` | Event-specific data |
| `${EVENT.*}` | Event-payload fields populated by the trigger source |
| `${ERROR_CONTEXT}` | In `# OnError:` fallback skills: type + target where failure occurred |

Iterator vars from `foreach` and output bindings from runtime-intrinsic / MCP-dispatch ops also pass through ambient at compile time; the runtime substitutes them per iteration / per op completion.

For cron and session triggers, the scheduler injects time-offset ambient fields onto `${EVENT.*}`:
- `${EVENT.fired_at}` — milliseconds since Unix epoch (raw number)
- `${EVENT.fired_at_unix}` — seconds since Unix epoch (raw number)
- `${EVENT.fired_at_plus_1h_unix}` — `fired_at_unix + 3600`
- `${EVENT.fired_at_plus_1d_unix}` — `fired_at_unix + 86400`
- `${EVENT.fired_at_plus_7d_unix}` — `fired_at_unix + 604800`

These let skill bodies compute `expires_at` and similar bounded-lifetime values without arithmetic in op kwargs. For ISO-formatted rendering of any epoch value, see the `|isodate` filter.

Additional ambient refs may be injected based on connector configuration. Connector documentation specifies which ambient refs each connector contributes.

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

**Parser convention:** comma splitting in `# Vars:` respects bracket depth. Commas inside `[]`, `()`, `{}` do not terminate values. `# Vars: TAGS=[a, b], MODE=fast` parses as two declarations (`TAGS=[a, b]` and `MODE=fast`); the inner comma is preserved as a list element separator.

## Tier 4: Local

Bound to a previous target's output mid-execution. Three forms:
- `${target.output}` — the bound output of a target
- `${VAR}` — an explicit `-> VAR` binding from any op
- `${VAR.field}` / `${VAR.nested.field}` — dotted field access into structured output

The exact field set available on a bound variable depends on what the wired connector returns. Field access resolves against the returned object's structure. If a field doesn't resolve, the substitution errors unless `|fallback:"default"` is supplied (see Pipe filters for full `|fallback:` semantics):

```
emit(text="Assignee: ${ISSUE.customFields.Assignee|fallback:\"unassigned\"}")
```

## Resolution order

In `compileSkill`, variables resolve in priority order:
1. Caller inputs (passed in at compile time)
2. `# Requires:` cascade
3. `# Vars:` defaults
4. Ambient passthrough (left as `${NAME}` for runtime substitution)
5. Missing → compile error

## `# Requires:` cascade

Pulls values from the configured data-source backend at compile time. One declaration per line. Both `→` (Unicode) and `->` (ASCII) accepted.

```
# Requires: user-var:location -> LOCATION (fallback: ip-based)
# Requires: system-var:morning-brief-delivered -> DELIVERED (fallback: false)
```

Resolution cascade by namespace:
- `user-var:<key>` — `user-var:<key>` record → `user-profile.<key>` JSON key → declared fallback
- `system-var:<key>` — `system-var:<key>` record → declared fallback (no profile tier)

Lookups query data records in the calling agent's private scope, filtered by tag, respecting expiration. Caller-supplied `# Vars:` inputs short-circuit the cascade for any matching target name. The specific backend lookup semantics (DB query, file read, KV lookup) are defined by the configured data-source connector.

**Vars-namespace conventions** (data records, private scope):
- `user-profile` — single JSON blob per agent, no expiry, static facts
- `user-var:<key>` — dynamic per-key record, typically with expiration
- `system-var:<key>` — agent/process state flags

## `$set` — bind-time interpolation

The `$set` op binds a value to a variable at runtime. Compiler-side outer-quote stripping. `${REF}` substitutions in the RHS string resolve at bind time; the bound value is the resolved string. Mirrors bash double-quoted assignment.

```
$set RESULT = ""
$set MODE = "production"
$set GREETING = "Hello, ${USER.login}!"     # interpolates at bind
$set FOUND = []
```

Missing-ref in the RHS produces a tier-1 runtime error.

## Scoping rules

- `# Vars:` declarations are skill-global (visible to all targets)
- `-> VAR` bindings are skill-global (visible to all targets after the op runs)
- `foreach IDENT in EXPR:` iterator vars are loop-local — `$set` bindings inside the loop don't persist after the loop ends
- Target outputs (`${target.output}`) are accessible after the target completes

## Pipe filters — url, shell, json, trim, fallback, isodate

Pipe filters apply transforms to resolved variables before substitution. Syntax: `${VAR|filter}` or `${VAR|filter:"arg"}` for parameterized filters. Filters operate at compile time for static values; for runtime-bound variables, filters apply at substitution time.

## Shipped filters

| Filter | Effect | Example | Output |
|--------|--------|---------|--------|
| `url` | `encodeURIComponent(value)` | `${location|url}` for `"Asheville, NC"` | `Asheville%2C%20NC` |
| `shell` | POSIX single-quote escape with outer quotes | `${arg|shell}` for `it's safe` | `'it'\''s safe'` |
| `json` | `JSON.stringify(value)` | `${payload|json}` for `{k:"v"}` | `"{\"k\":\"v\"}"` |
| `trim` | Whitespace trim | `${VERDICT|trim}` for `"urgent\n"` | `urgent` |
| `length` | Count of items (array) or characters (string) | `${ITEMS|length}` for `["a","b","c"]` | `3` |
| `contains:"X"` | Boolean: type-aware substring / element membership | `${MSG|contains:"urgent"}` for `"Yes, urgent"` | `true` |
| `fallback:"X"` | Coalesce on missing/undefined ref | `${VAR.missing|fallback:"-"}` | `-` |
| `isodate` | Epoch seconds → ISO-8601 timestamp | `${EPOCH|isodate}` for `1779660000` | `2026-05-24T22:00:00.000Z` |

### `length` semantics

- Arrays → number of elements
- Strings → number of characters
- Non-array/non-string values (number, null, undefined, plain object) → runtime `TypeMismatchError`

Strings that hold JSON arrays get the same tolerance as `in`/`not in` RHS: if the string JSON-parses to an array, the array length is returned.

Pairs naturally with the numeric comparison operators (see Conditionals section):

```
$ data_read mode=fts query="urgent" -> ITEMS
if ${ITEMS|length} > 5:
    emit(text="Mailbox is getting crowded")
```

The output of `|length` is a string-form number ("3", "5", etc.) at substitution time, consistent with how other filters produce strings. Numeric comparison coerces back to number for the comparison; equality (`==`) does byte-for-byte string comparison.

### `contains:"X"` semantics

Type-aware boolean filter for use in conditionals. Resolution branches:

- **LHS resolves to a list** → element membership. `${LIST|contains:"a"}` returns `true` if `"a"` is in the list, `false` otherwise. No substring matching against list elements.
- **LHS resolves to a string that JSON-parses to a list** → use the parsed list (JSON-string tolerance, same pattern as `in`/`not in` RHS). Accommodates LLM-output-as-JSON-array patterns.
- **LHS resolves to a string (non-JSON-array)** → substring match. `${TEXT|contains:"urgent"}` returns `true` if `"urgent"` appears anywhere in `TEXT`.
- **LHS resolves to anything else (object, number, null)** → stringify-then-substring. Last-resort behavior; not the recommended path.

Mirrors the existing `in` / `not in` operator semantics — `${LIST|contains:"a"}` and `if "a" in ${LIST}:` return the same answer for the same inputs. The two ways to ask "does this contain a value" stay symmetric.

```
$ llm prompt="Reply 'urgent' if any items are urgent" -> VERDICT
if ${VERDICT|contains:"urgent"}:
    emit(text="escalate")
```

Replaces the brittle exact-match pattern (`if ${VERDICT|trim} == "urgent":`) that required prompt-engineering the LocalModel to respond with EXACTLY one word.

Return convention: `"true"` on match, `""` (empty string) on miss. Matches the runtime's `isTruthy` so the natural shape `if ${R|contains:"X"}:` evaluates the way the syntax suggests — no explicit `== "true"` needed.

Case-sensitive by default. Case-insensitive variant deferred until empirical signal.

Quoted-string argument required. Bare-identifier accepted for consistency with other filter args but tier-2 lint warns "prefer quoted form."

Empty-string match: `${VAR|contains:""}` returns `true` if VAR is bound. Documented behavior — any string contains the empty string.

`contains` is the first filter to operate on structured types. The design line — filters are predominantly string ops — is intentionally crossed here because filter-as-conditional-primitive is the load-bearing intent. The rest of the filter set (`|trim`, `|json`, `|fallback`, etc.) operates on the resolved string form.

### `fallback:"X"` semantics

Coalesce-on-missing. Emits the literal string `X` when the ref resolves to missing/null/undefined. Strict-by-default semantics preserved everywhere else; `|fallback:` is the explicit opt-out at the call site.

```
emit:
    emit(text="present: ${PRESENT|fallback:\"missing\"}")        # → "hello"  (PRESENT is bound)
    emit(text="missing: ${NOT_DECLARED|fallback:\"-\"}")          # → "-"      (NOT_DECLARED isn't)
    emit(text="nested:  ${ISSUE.customFields.Assignee|fallback:\"unassigned\"}")
```

**Why filter-shape, not ref-level `(fallback:)`.** Op-level `(fallback: ...)` exists on `$` dispatch for **error recovery** (dispatch happened, failed). Ref-level `|fallback:` is **coalesce** (lookup found nothing). They rhyme but are adjacent concepts. The filter-chain attachment keeps composition clean (`${VAR|json_parse|fallback:"-"}` works as a chain step) and the vocabulary alignment with op-level `(fallback:)` lets cold authors learn "fallback" as the universal concept while the syntax disambiguates the attachment site.

**Closes the missing-field strict-error trap**: `${ISSUE.customFields.Assignee}` against an object without that key threw `UnresolvedVariableError` and aborted whole-render. The filter is the per-ref opt-out.

### `isodate` semantics

Converts a Unix epoch-seconds value to an ISO-8601 timestamp string. Pairs with `${NOW}` (ISO-8601 by default) and `${EVENT.fired_at_unix}` (raw epoch seconds, per its name).

```
show:
    emit(text="Now (already ISO):     ${NOW}")                       # → 2026-05-24T23:34:15.859Z
    emit(text="Trigger fire (ISO):    ${EVENT.fired_at_unix|isodate}")  # → 2026-05-24T23:34:15.000Z
    emit(text="Static epoch:          ${SOME_EPOCH|isodate}")           # → 2026-05-24T22:00:00.000Z
```

Input is interpreted as Unix epoch seconds. Non-numeric input produces runtime error. For millisecond inputs, divide first or use a wrapping op.

## Filter chaining

Filters chain left-to-right. The output of each filter becomes input to the next.

```
${VERDICT|trim|json}
```

First trims whitespace, then JSON-stringifies the result.

## Filter use in conditionals

Filters may appear on the LHS of conditional expressions. Useful for whitespace-tolerant equality checks against LocalModel output (which often has trailing newlines), and for the `contains:` predicate-shaped filter:

```
if ${VERDICT|trim} == "urgent":
    ...
if ${VERDICT|contains:"urgent"}:
    ...
if ${VAR.maybe|fallback:"-"} == "-":
    emit(text="nothing there")
```

Filter chains in conditions all work in conditional context.

## Filter use in `in` / `not in` set membership

Filters may appear on the LHS of `in` / `not in` checks (the comparison side). The RHS must resolve to an array at runtime.

```
if ${M.id|trim} in ${SEEN}:
    emit(text="already processed")
```

## Filter use in numeric comparison

Filters may appear on either side of `<`, `>`, `<=`, `>=` comparisons. `|length` is the canonical companion — most numeric-threshold patterns are "more than N items" rather than arithmetic on raw values.

```
if ${ITEMS|length} > 5:
    ...
elif ${BODY|length} > 1000:
    ...
```

## Error handling

Unknown filter on a resolved variable produces a tier-1 `unknown-filter` compile error. Catches both bare (`|unknown`) and colon-positional (`|unknown:"arg"`) shapes. Filter chains that fail at runtime (e.g., `|json` on a non-serializable value, `|length` on a number, `|isodate` on a non-numeric value) produce op errors that route through `else:` / `# OnError:` machinery.

Bare `${NAME}` without a filter is unchanged.

## Pending filters

Several filters are planned but not yet shipped:

| Filter | Effect | Use case |
|--------|--------|----------|
| `head:N` | First N lines | Truncate long output for embedding in prompts |
| `tail:N` | Last N lines | Recent log entries |
| `lines:M-N` | Range of lines | Specific slice |
| `field:N` | Nth whitespace-separated field | Awk-like extraction |
| `summary` | One-line abbreviation | Compress for human-facing emissions |
| `pluck:<field>` | Project array of objects to array of field values | Paired with `in`/`not in` for dedup-by-id workflows |
| `join:"<sep>"` | List → string with separator | Filter-shape alternative to string `$append`; reconsider if filter-chain demand surfaces |
| `isodate_ms` | Epoch ms → ISO-8601 | Companion to `|isodate`; defer until demand |

`pluck` is the highest-priority remaining filter — it closes the structural-dedup gap for skills that iterate retrieval results and want to exclude already-seen items by ID without manual comparison loops.

`join:"<sep>"` is parked: string-typed `$append` + bind-time `$set` interpolation (bash-shaped pair) is the primitive way to compose lists into strings. `|join:` is the filter-shape alternative; reconsider if real filter-chain demand surfaces.

## Composition philosophy

Filters are pure functions (input → output, no side effects). Stay small and orthogonal — each filter does one thing. Composition emerges from chaining, not from elaborate per-filter parameter spaces. The shipped set covers ~90% of real-world string-shaping needs; the pending set extends to slicing and array projection.

`length`, `fallback:`, `isodate`, and `contains:` were all added in response to cold-author harness signal — authored skills demonstrated the gap was load-bearing before each filter shipped. `contains:` is also notable as the first filter to operate on structured types; filter-as-conditional-primitive is the design line that warranted the cross.

## Conditionals & iteration — if/elif/else, foreach, supported operators

Skillscript supports narrow conditionals and bounded iteration. Both are deliberately constrained — composition over expressiveness.

## Conditionals

`if COND:` / `elif COND:` / `else:` chain. Supported condition shapes:

### Truthy

```
if ${VAR}:
    emit(text="VAR was set and non-empty")
```

### Equality

`==` and `!=` against either quoted string literals or another `${...}` ref. Filters and dotted-field access are permitted on either side.

```
if ${VERDICT} == "urgent":
    ...
elif ${VERDICT} != "quiet":
    ...
```

```
if ${FP|trim} == ${LAST_FP|trim}:
    emit(text="no change since last scan")
elif ${M.id} != ${LAST_ID}:
    emit(text="drift detected")
```

The ref-vs-ref form is the canonical change-detection pattern. Both sides resolve to strings at evaluation time; equality is byte-for-byte after filter application. No type coercion — `${N} == "42"` compares the string form of N against the literal `"42"`, even if N is "numeric" elsewhere in the connector layer.

### Set membership

```
if ${M.id|trim} in ${SEEN}:
    emit(text="already processed")
elif ${M.id} not in ${SEEN}:
    $ data_write content="..." approved="dedup" -> R
```

Both sides are explicit refs. RHS must resolve to an array at runtime; clean error otherwise. LHS-undefined evaluates to `false` for both polarities. Optional filter on LHS.

**JSON-string tolerance on RHS**: if the RHS resolves to a *string* that successfully JSON-parses to an array, the parsed array is used. This accommodates the canonical pattern where the array comes from a `$ llm` call that prompted for JSON output:

```
$ llm prompt="List the URGENT item IDs as a JSON array of strings. Items: ${M|json}" -> SEEN

foreach M in ${ITEMS}:
    if ${M.id} in ${SEEN}:
        emit(text="flagged urgent")
```

`${SEEN}` resolves to a string like `["abc", "def"]`; runtime JSON-parses, sees an array, uses it. Strings that don't JSON-parse to an array still error per the strict rule — only valid JSON arrays get the tolerance.

### Numeric comparison

`<`, `>`, `<=`, `>=` in `if`/`elif` conditions. Both operands resolve as strings (same as equality), then attempt numeric coercion. If both coerce, the comparison runs numerically. If either fails to coerce, runtime `TypeMismatchError`.

```
if ${DELTA} > ${THRESHOLD}:
    emit(text="ALERT: dropped past threshold")
elif ${COUNT} <= 0:
    emit(text="No items returned")
```

Filters and dotted-field access work on either side, same as equality. The `|length` filter (see Pipe filters section) is the canonical companion — `${LIST|length} > 5` is the natural "more than five items" pattern:

```
$ data_read mode=fts query="urgent" -> ITEMS
if ${ITEMS|length} > 5:
    emit(text="Mailbox is getting crowded")
```

**Decimal precision.** Coercion uses native number parsing — `5.00` and `5` both coerce to `5`. Skill authors should keep thresholds at the precision they care about; numeric comparison does not preserve trailing-zero string form.

**Why comparison, not arithmetic.** The orchestration carve-out: comparison operators land in the language because *conditionals are orchestration decisions*. Arithmetic operators (`+`, `-`, `*`, `/`) and aggregates (`min`, `max`, `sum`) are deliberately NOT in the grammar — those produce values, which is computation, which belongs in tools. The line is "comparison is orchestration; arithmetic is computation."

If you need to compute a value to compare against, the computation goes in a tool that returns the computed value; the skill compares the returned value. Skills stay orchestration-shaped.

### Logical connectives: `and` / `or` / `not`

Compound conditions via standard boolean connectives.

```
classify:
    $ llm prompt="..." model=qwen -> VERDICT
    if ${VERDICT|trim} == "urgent" and ${SEVERITY|trim} > "5":
        emit(text="escalate")
    elif ${VERDICT|trim} == "urgent" or ${SEVERITY|trim} > "8":
        emit(text="flag")
    else:
        emit(text="noted")
```

**Precedence** (tightest to loosest):
1. Comparison: `==` / `!=` / `<` / `>` / `<=` / `>=` / `in` / `not in`
2. Unary: `not`
3. Binary: `and`
4. Binary: `or`

`a and b or c` parses as `(a and b) or c`. Standard convention. Parentheses available for explicit grouping when default precedence isn't what you want: `(a or b) and c`.

**Short-circuit semantics.** `if ${X} == "ok" and ${MAYBE_UNRESOLVED}` does NOT evaluate the RHS if the LHS already determined the result (false). Matches every other language; required for the "validate-then-access" pattern.

**Falsy check via `not`.** `not ${VAR}` closes the gap where you'd previously have to enumerate `if ${VAR} == "":` / `if ${VAR} == "false":` / `if ${VAR} == "0":` separately.

```
mailbox_check:
    $ data_read mode=fts query="addressed:perry" limit=10 -> MAILBOX
    if not ${MAILBOX}:
        emit(text="empty mailbox today")
    elif ${MAILBOX|length} > 5:
        emit(text="triage backlog")
```

**De Morgan via parens:** `if not (${A} and ${B}):` works as expected.

**`not` with membership:** `not ${X} in ${LIST}` parses as `not (${X} in ${LIST})` — membership-tighter-than-not convention.

**Lint interaction.** Existing `undeclared-var` lint catches references to truly-undeclared vars at compile time. Short-circuit affects only runtime evaluation — "the var is declared, but might not be bound at this evaluation point" is the runtime-only case.

### What's NOT supported

- *No arithmetic ops* — no `+`, `-`, `*`, `/`. Arithmetic produces values; values come from tools. Comparison only (see Numeric comparison above).
- *No aggregate functions* — no `min`, `max`, `sum`, `mean`. Same reasoning.
- *No filter math* — filters apply to substitution, not to condition evaluation arithmetic.
- *No single-`=` assignment-in-condition* — this isn't a feature, it's a parse error.

**Common parse error: single `=` in conditional position.** A single `=` in an `if`/`elif` condition is a parse error with a specific diagnostic:

```
error: '=' is not valid in a condition; use '==' for equality
  if ${VERDICT} = "urgent":
                ^
rewrite as: if ${VERDICT} == "urgent":
```

The grammar doesn't admit single-`=` in condition position at all — the parser catches the construction via a specific error production rather than failing with a generic "syntax error."

### Disambiguation: `else:` after target body vs `else:` after `if:`

Both shapes use the keyword `else:`. Distinguished by parser scope-stack at parse time:
- `else:` after a target's primary body → error handler (runs when any op in the body errors). See Error handling section.
- `else:` after `if:` / `elif:` chain → conditional branch.

Both can coexist in the same target.

## Iteration: `foreach`

`foreach IDENT in EXPR:` block iterates over a list, binding `IDENT` to each item per iteration. Body indented under the header; indent-based dedent returns to outer scope.

```
foreach M in ${RESULTS}:
    emit(text="Processing ${M.id} — ${M.summary}")
    if ${M.id|trim} not in ${SEEN}:
        $ data_write content="${M.summary}" approved="dedup" -> ACK
```

### Iterator vars

`${M}` and `${M.field}` pass through ambient at compile; runtime substitutes per iteration. Dotted field access resolves against whatever structure the connector returned per item — the exact field set depends on the connector. Indexed access (`${LIST.0}`, `${LIST.0.id}`) also works on bound results.

### Loop-local scope (and the accumulator exception)

`$set` bindings inside the loop don't persist after the loop ends. Each iteration starts fresh from the loop binding.

**`$append` is the exception**. Appending to a list-typed variable declared in the *enclosing* scope (target body or `# Vars:`) mutates the outer binding, surviving across iterations:

```
walk:
    $set FOUND = []
    foreach M in ${MESSAGES}:
        if ${M.id} not in ${FOUND}:
            $append FOUND ${M.id}
    emit(text="Collected: ${FOUND|length} novel items")
```

See the Ops reference `$append` section for the full lint rules (`uninitialized-append`, `foreach-local-accumulator-target`, `append-to-non-list`).

### What's NOT supported

- *No `while` loop* — iteration is bounded by the iterable's length. Unbounded loops are not expressible. (See "Not yet implemented, but planned" at top — `while` is planned.)
- *No `break` or `continue`* — every iteration runs to completion. Filter the iterable beforehand if you need exclusion.
- *No nested-loop variable capture* — inner-loop `$set` doesn't escape to outer scope.
- *No `parallel foreach`* — iteration is serial. `$append` inside a future `parallel foreach` is a tier-1 error; semantics deferred to whenever parallel foreach ships.

## Composition philosophy

The grammar is deliberately narrow. The threshold for adding new grammar is "an authored skill demonstrates the gap is load-bearing." Composition through nested blocks + filter chains covers most real cases.

The carve-out is principled: *comparison and logical connectives* land because conditionals ARE orchestration decisions; *arithmetic and aggregates* stay out because they produce values, which belong in tools. Future grammar extensions follow the same discipline: surfaced by real authoring need, not by speculative completeness, and only if they sit on the orchestration side of the line.

Authors writing complex conditional logic should consider:
- *Push the logic into a `$ llm` call* — let the model classify, return a one-word verdict, branch on equality
- *Push the logic into a connector* — wrap the complex check as an MCP tool, dispatch via `$`
- *Decompose into multiple skills* via `execute_skill(skill_name=...)` (see Composition section)

Skills are orchestration, not computation. When the conditional logic feels Turing-complete, the work belongs in a connector.

## Triggers — # Triggers: header, declarative + imperative registration, source types

Triggers declare what events fire a skill autonomously. A skill without triggers must be invoked explicitly (via a compile/execute API call); a skill with triggers fires automatically when matching events occur.

## Declarative registration via `# Triggers:` header

The skill body declares triggers via metadata header. Multiple triggers permitted, comma-separated or one per line.

```
# Triggers: cron: 0 8 * * *, session: start
```

On skill write, the runtime's trigger registry parses the header and auto-registers each trigger. Editing the skill body updates registrations.

## Imperative registration

For dynamic, one-shot, or runtime-decided triggers, use the imperative `registerTrigger` API:

```
registerTrigger({
  skill_name: "my-skill",
  source: "cron",
  name: "55 2 * * *",
  expires_at: 1779107400  // optional auto-cleanup
})
```

Imperative triggers default to a 30-day expiration (cleanup via expiry sweep). Pass `null` for indefinite retention; author must clean up via the corresponding `unregisterTrigger` API.

## Trigger sources

### `cron: <expression>` — time-based

Standard 5-field cron. Sliding-window evaluation by a 30s poll loop. No catch-up replay if the runtime was down at fire time.

```
# Triggers: cron: 0 3 * * *
```

### `session: start | end` — session lifecycle hooks

Fires when an agent session begins (`session: start`) or ends (`session: end`). The load-bearing primitive for prepping context at session boundaries — a session-start skill produces `agent:` output that prepends to the next inference.

```
# Triggers: session: start
# Output: agent: <agent-name>
```

### `event: <event-name>` — runtime-host-emitted events (parse-only)

Header parses cleanly today but the event bus that would emit `event:` triggers isn't wired yet. Cross-reference: see "Not yet implemented, but planned" at top.

Example event categories (deployment-defined):
- `event: thread.replied` — a thread receives a new reply
- `event: mailbox.dangle` — an addressed item expires unprocessed
- `event: classifier.flagged` — a background classifier surfaces an urgent finding
- (extensible via runtime-host event registration)

### `agent-event: <agent>.<event>` — cross-agent event hooks (parse-only)

Subscribes to another agent's events. Same parse-only status as `event:`.

```
# Triggers: agent-event: builder.task.completed
```

### `file-watch: <path>` — filesystem change (parse-only)

Fires when the named path changes. Relies on inotify (Linux) or kqueue (macOS) on the host.

Open spec question: recursive vs directory-only default. Current lean: directory-only by default, opt-in via `file-watch-recursive:` or `file-watch: <path> (recursive)`.

### `sensor: <sensor-name>` — external sensor stream (parse-only)

Extension surface for multimodal inputs — camera, microphone, presence, screen state. Designed as a category distinct from tools: sensors are continuous channels the agent reads but doesn't emit on. Privacy gating is a structural precondition.

```
# Triggers: sensor: presence
```

## Trigger context

When a skill fires from a trigger, the runtime populates ambient refs accessible inside the skill body:

- `${TRIGGER_TYPE}` — the trigger source (`cron`, `session`, etc.)
- `${TRIGGER_PAYLOAD}` — source-specific data
- `${EVENT.*}` — event-payload fields for `event:` / `agent-event:` triggers

## Trigger lifecycle

- **Registration:** declarative via header (auto on skill write) or imperative via the `registerTrigger` API
- **Storage:** registered triggers are records owned by the registering agent, indexed by source + name + agent_id + skill_id; the storage backend is connector-defined
- **Inspection:** `listTriggers({ skill_name?, agent_id?, source? })` returns the live registry
- **Archival:** `unregisterTrigger(trigger_id)` archives the trigger (audit trail preserved); declarative triggers are removed by editing the skill body to drop the declaration

## Multiple triggers

A skill may declare multiple triggers; each fires an independent execution. The compiled output is identical regardless of trigger; the runtime distinguishes via `${TRIGGER_TYPE}`.

Open spec question: dedup on near-simultaneous fires. If `cron: 0 8 * * *` and `event: user.present` both fire within seconds, the runtime currently runs the skill twice (one per trigger). Author dedups via state if needed.

## Output targets — # Output: header, delivery kinds

The `# Output:` header declares where a skill's result is delivered. Default behavior (no header) is `text` — return string to caller.

## Output kinds

### `text` (default, bare-only)

Returns the skill's result as a string to whatever invoked the skill via API or read the compiled prompt artifact. Bare-only — no target accepted; parse error if a target is supplied.

```
# Output: text
```

### `agent: <agent-name>` — augmenting context to a named agent

The Augmenting-kind delivery. Output prepends to the named agent's next-turn prompt context as augment-kind payload.

```
# Output: agent: <agent-name>
```

Used to bring an agent into the next turn pre-shaped — context that would normally require a session-start retrieval is pre-positioned. Wired end-to-end via the runtime host's prompt-prepend surface + a synchronous trigger-fire endpoint with timeout-fallback so the next-turn dispatch isn't blocked on slow skill execution.

### `template: <agent-name>` — playbook delivered to a named agent

The Template-kind delivery. Output renders as a playbook the named agent executes itself — the runtime doesn't dispatch the ops, it hands the agent a recipe to follow.

```
# Output: template: <agent-name>
```

Used for reusable recipes: a skill that, when compiled, produces instructions another agent follows.

### `file: <path>` — write to file

Header parses; file router not yet implemented. See "Not yet implemented, but planned" at top.

### `none` (bare-only)

Side-effects only — the skill's purpose is the writes / shell ops it performs, not the returned value. Bare-only; parse error if a target is supplied.

```
# Output: none
```

## Multiple output targets

A skill may declare multiple output targets, one per line. Each target receives the same content.

```
# Output: agent: ops-channel
# Output: agent: assistant
```

A morning-brief skill, for example, can deliver to a team-channel agent and to an assistant agent's session-start prompt context simultaneously.

## Skill categories — Augmenting / Template / Headless

The output kind declaration determines the skill's category for discovery purposes (see SkillStore `skill_list` discovery surface):

| Category | Determined by | Discovery group |
|---|---|---|
| **Augmenting** | Has `# Output: agent: <name>` declared | `receives` |
| **Template** | Has `# Output: template: <name>` declared OR no agent/template output but agent-invokable (no triggers) | `skills` |
| **Headless** | Output is `text` / `file:` / `none` AND has autonomous triggers | `headless` (filtered out of default agent discovery) |

The derivation: ANY `output.kind === "agent"` → Augmenting; else ANY `output.kind === "template"` → Template; else if no autonomous triggers → Template (agent-invokable inference); else → Headless.

Agent discovery via `skill_list()` defaults to `receives` + `skills` groups. Headless skills are filtered out of the default view (admin views can opt in via `filter: { audience: "all" }`).

## Per-kind output value semantics

Different output kinds consume the skill's execution result differently:

- **Presentation surfaces** (`agent:`, `template:`) consume joined emissions — all `emit()` ops in the skill body concatenated in execution order
- **Programmatic surfaces** (`text`, `file:`) consume the `lastBoundVar` — the most recently bound `-> VAR` value from any op

Single source of truth in the executor's `perKindOutput()` function; routers stay dumb (just consume what the executor hands them per kind).

## Augmenting / Template companion header

Skills with `agent:` or `template:` output kinds can declare a companion header that rides along with the delivery payload. Optional; has no effect on Headless skills.

### `# Event-type: <string>`

Adopter-defined routing vocabulary; flows to `DeliveryMeta.event_type` on lifecycle-hook deliveries as the frontmatter fallback. `notify(event_type=...)` kwarg takes precedence per-emit.

```
# Output: agent: perry
# Event-type: ticket-911
```

The receiving agent reads `event_type` for routing decisions ("this is a 911 — surface immediately" vs "this is a routine check — fold into next brief").

### Lint coverage

A tier-2 lint rule `unused-augmenting-header` fires when `# Event-type:` appears on a Headless skill (no `agent:` or `template:` output declared). Headless skills have no AgentConnector dispatch path, so the header would silently no-op — the lint warns the author to either change the output kind or remove the header.

Legacy `# Delivery-context:` header was renamed to `# Event-type:` for vocab consistency. A tier-2 advisory `legacy-frontmatter-header` fires on the legacy form with a rename suggestion.

## Grammar

- Kinds with no target (`text`, `none`) are bare-only — `# Output: text` is valid, `# Output: text: anything` is a parse error.
- Kinds with a target (`agent`, `template`, `file`) require `<kind>: <target>` — `# Output: agent` without a target is a parse error.
- Authoring friction-fix: parse errors on bare-only kinds suggest the corrected shape inline.

## Output routing failures

If `# Output: agent: <name>` fires and the wired AgentConnector throws, the delivery routes through `else:` / `# OnError:` machinery. The receipt surface (`agent_delivery_receipts[]`) records the failure for the scheduler to log.

## Lifecycle and status — # Status: header, six canonical states, compile + runtime enforcement

Skillscripts carry an explicit lifecycle state via the `# Status:` header. The compiler and runtime enforce status — a Disabled skillscript cannot fire under any path, regardless of who invokes it.

## Header syntax

```
# Skill: support-response-draft
# Status: Approved v1:a1b2c3d4
# Description: ...
```

If `# Status:` is omitted, the default state is **Draft**. This forces authors to explicitly promote a skillscript through its lifecycle rather than relying on "newly written = ready for use."

**Case normalization:** Status values are accepted case-insensitively on input and stored as canonical form. `# Status: draft`, `# Status: Draft`, `# Status: DRAFT` all parse to canonical `Draft`. This principle applies across all enumerated frontmatter value spaces (see Overview section on Lexical conventions).

## The three canonical states

- **Draft** — being authored or under revision; not ready for production use. Compile warns; runtime refuses unless explicitly invoked with `--force-draft` for the author's own testing. Triggers don't fire under default dispatch.
- **Approved** — passed authoring + lint and is ready to fire. The canonical "in use" state. Compile is clean; runtime allows everywhere; declared triggers fire freely. **Requires a hash-token stamp** (see below).
- **Disabled** — explicitly off. Compile rejects; runtime rejects; triggers don't fire. Source and version history preserved, but the skillscript cannot execute under any path.

These three states have crisp, universal operational meaning across every deployment. Every operator understands what each state means; no judgment calls about edge-case distinctions.

## Hash-token approval for Approved

`# Status: Approved` requires a stamped version-hash token: `# Status: Approved v1:<token>` where `<token>` is `f(skill_body)`. Naked `# Status: Approved` (without the stamp) refuses to execute at runtime.

The runtime verifies the stamp on every execution path:
- Trigger-fired dispatch
- MCP `execute_skill` invocation
- In-skill `$ execute_skill` composition
- Compile-time `inline(skill=...)` references

The stamp closes the gate against tampered or Draft-promoted-without-review skill bodies. Three paths produce a stamped Approved skill:

1. **Dashboard approval flow** — human reviewer approves; dashboard stamps the token.
2. **`skill_write` MCP tool auto-stamp** — when an agent writes a skill body declaring `# Status: Approved`, the SkillStore auto-stamps the token on persist (headless-adopter convenience).
3. **Manual stamp** — for unusual cases; details in the adopter playbook.

Tampered bodies (someone edits the source post-stamp) re-derive a different token and refuse to execute. The hash-token check is the structural lock; the dashboard / `skill_write` flows are the discipline layer.

## Compile + runtime behavior table

| State | Compile | Runtime invocation | Test harness | Default trigger fire |
|-------|---------|-------------------|--------------|---------------------|
| Draft | warn | refuse (unless `--force-draft`) | allow (with flag) | refuse |
| Approved (stamped) | OK | allow | allow | allow |
| Approved (unstamped) | warn `approved-without-stamp` | refuse | refuse | refuse |
| Disabled | refuse | refuse | refuse | refuse |

## Trigger registry interaction

The trigger registry respects status. A skillscript in Draft or Disabled state has its declared triggers held in a non-firing state — the trigger is registered (visible via `listTriggers`) but the scheduler skips dispatch. This lets authors register triggers while still in Draft mode without risking accidental production fires.

When a skillscript transitions to Approved (with valid stamp), its triggers activate. When it transitions to Disabled, its triggers deactivate.

## State transitions

Status transitions are freeform — any author with write authority on the skillscript can flip the status by editing the header. Future versions may add transition rules (Draft → Approved with lint-pass requirement; Disabled requiring admin-level permission) once a real authorship-permissions story is in place.

## Audit trail

Status changes are visible via the storage substrate's versioning. For SqliteSkillStore-backed skills, each status transition appends a row to `skill_versions` (see SqliteSkillStore docs). For FilesystemSkillStore-backed skills, status changes show up in git history. The audit trail is part of the substrate, not part of the language.

## States considered but not implemented

Three additional states were considered and deferred. Each is cheap to add later when justified by real operational need:

- **Test** — distinct "passed compile but not production-ready" state. Today's Draft covers this case (same behavior — refuse to fire under default dispatch). If authors find Draft and Test are operationally distinct in practice, Test ships then.
- **Deployed** — distinct "currently shipping" state separate from Approved. Today's Approved + active triggers IS deployed; no operational difference. If a deployment finds Approved-vs-Deployed meaningfully different (e.g., a release-gating workflow that distinguishes "ready" from "live"), Deployed ships then.
- **Deprecated** — soft-warn state for "still works but new authoring should use a successor." Deprecation is currently carried in metadata (`deprecated: true` in frontmatter) + a lint warning at invocation sites. When deprecated skills accumulate enough that the metadata pattern is awkward, Deprecated promotes to a first-class state.

Adding states is additive — existing skills with the three-state model continue to work when new states are added.

## Why this matters

The lifecycle states are the language's answer to operational safety at scale. A traditional "all skillscripts compile and run" model relies on author discipline to keep broken or untested work out of production. Status states enforce the discipline at the language level — a Disabled skill cannot fire even if every author downstream forgets it's broken. The hash-token approval mechanism extends this to: an Approved skill cannot fire if its body was tampered post-approval. The constraint IS the safety story, here as elsewhere.

## Open questions

- **Status + composition.** When a procedural skill references a data skill via `inline(skill=...)`, what happens if the data skill is Disabled? Probable answer: compile-time error if any referenced skill is Disabled.
- **Bulk status operations.** "Disable all skills tagged with project:legacy" is a useful operational primitive. May add a `skillscript bulk-status <pattern> <state>` CLI affordance later.

## Error handling — else: blocks, # OnError: fallback, op-level fallback values

Skillscript provides three layers of error handling, working from local to global.

## Layer 1: Target-level `else:` block

Runs if any op in the target's primary body errors. Local to the failing target. Downstream targets that depend on this one can still proceed using whatever the `else:` branch produced.

```
fetch:
    $ data_read mode=fts query=${TOPIC} limit=5 -> RESULT
else:
    emit(text="retrieval failed, falling back to empty result")
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

Compile-time existence check — fails clean if the referenced fallback doesn't exist. The fallback skill is itself a skill (same compilation, same execution model) and can do real work (file an issue, post an ack, write a degraded result, etc.).

The fallback skill receives:
- The same inputs as the failing skill
- An additional `${ERROR_CONTEXT}` ambient ref containing the error type and the target where it failed

### Constraint

Nested `# OnError:` is *not* supported. If `# OnError: degraded-skill` fires and `degraded-skill` itself errors, the runtime hard-exits with no further fallback. Spec is explicit on this.

## Layer 3: Op-level fallback values

Inline fallback declared on the op line. Used when the call fails or returns empty. Supported on `$` (MCP dispatch) ops with coerce-on-bind semantics.

```
weather:
    $ data_read mode=fts query="weather ${LOCATION}" limit=1 -> CURRENT (fallback: "weather unavailable")
    $ llm prompt="Summarize: ${CURRENT}" -> SUMMARY (fallback: "summary unavailable")
    $ slack.post channel=${CHANNEL} text=${SUMMARY} (fallback: "post failed silently") -> ACK
```

Same pattern as the `# Requires:` cascade's `(fallback: ...)` syntax — consistent across compile-time (`# Requires:`) and runtime (`$` dispatch).

**Fallback value parsing.** Permissive: bare identifiers, quoted strings, and bracketed array literals all accepted. Matches the `# Requires:` cascade convention.

```
$ data_read mode=fts query="..." -> RESULTS (fallback: [])           # array literal
$ llm prompt="..." -> VERDICT (fallback: unknown)                    # bare identifier
$ slack.post text="..." -> ACK (fallback: "post failed")             # quoted string
```

**Coerce-on-bind semantics.** On op throw or empty-result, the fallback value is bound to the outputVar via the same path as a successful result. Downstream targets see the fallback transparently — they don't need conditional checks to detect "did this op fail?" The op-level fallback IS the default-on-failure value.

## Error propagation rules

- Op error → caught by `else:` if present, otherwise propagates to target
- Target error → caught by `# OnError:` if present, otherwise propagates to caller
- Caller can still catch via standard exception handling on compile / runtime invocation APIs
- `else:` blocks are not allowed to declare their own error handlers
- If an `else:` block itself fails, the whole target fails through `# OnError:` (if present)

## Visibility into errors

Open spec question: should `${ERROR}` be ambient inside `else:` blocks (same shape as `${ERROR_CONTEXT}` in `# OnError:` fallbacks)? Current lean: yes. Useful for telemetry skills that need to know what failed before falling back. Not yet specified or shipped.

## The fallback pattern is consistent across scopes

Same idea at every scope:
- Compile-time: `# Requires: ... (fallback: value)`
- Runtime op: `$ dispatch ... (fallback: value)`
- Runtime target: `else:` block
- Whole skill: `# OnError:` header

Authors composing complex skills use these in combination — op-level for transient errors, target-level for cohesive error paths, skill-level for last-resort degradation.

## Connection to runtime observability

Per-op error contract is what makes cascading fallbacks work. When `$` returns `isError: true`, the executor throws via `makeOpError` rather than binding the error text to the output var. The throw routes through `else:` / `# OnError:` machinery and surfaces in `result.errors[]` for the scheduler to log. Without this discipline, op-level failures wouldn't propagate to the fallback layers and silent-fail would be the default.

## Composition — skills calling skills

Skillscript supports skill-to-skill composition via the runtime's public composition primitive. A parent skill invokes a child skill, optionally passes inputs, optionally binds the child's result. The runtime threads variable state, propagates errors, and enforces a recursion-depth guard.

Composition is exposed as a runtime-intrinsic op: `execute_skill(skill_name="...", inputs={...}) -> R`. Symmetric with `compile_skill` and `lint_skill` — same surface, same naming convention, no external-namespace dependency.

## Surface

```
parent:
    execute_skill(skill_name="child") -> RESULT
    emit(text="Child returned: ${RESULT}")
```

The runtime resolves `skill_name` against the configured SkillStore at dispatch time, runs the child to completion against the runtime's wired connectors, and binds the result.

## Tool signature

```
execute_skill({
  skill_name: string,             // required — resolves via SkillStore
  inputs?: Record<string,string>, // optional — Vars override map
  mechanical?: boolean            // optional — dry-run mode (default false)
})
```

**Returns:** `{ final_vars, transcript, outputs, errors, target_order, provenance }`.

## Semantics

**Skill resolution.** Missing skills produce a clean structured error (`MissingSkillReferenceError extends OpError`) — the parent's `(fallback: ...)` discipline applies if specified, otherwise the parent skill's `# OnError:` fallback fires if declared, otherwise the parent fails with the error propagated through.

**Input override.** `inputs` map keys must match the child's `# Vars:` declarations. Undeclared keys are ignored. Required vars without defaults must be supplied or dispatch fails before the child starts.

**Variable threading.** The parent's variable scope is sealed from the child's; the child sees only its declared `# Vars:` plus the inputs override plus ambient refs. The child's emitted result binds to the parent's named variable via `-> RESULT`. The child's transcript surfaces through the parent's transcript with provenance attribution.

**Mechanical mode (the TestFlight property).** When `mechanical: true`, the dispatch graph renders without firing side-effect ops. `$` dispatch ops bind null; runtime-intrinsic side-effect ops bind self-describing placeholder strings. The mechanical flag propagates through recursive `execute_skill` calls — the whole sub-graph previews end-to-end, no real services touched. Authors use this to validate a multi-skill composition chain before committing to any real call.

**Recursion guard.** The runtime enforces a configurable recursion-depth limit (default 10) to prevent infinite-loop composition. Exceeding the limit raises a clean structured error attributable to the offending dispatch site, not a stack overflow.

## Forward-reference resolution

Skill references (`inline(skill=...)`, `execute_skill(skill_name=...)`) are validated at compile time but allow forward references with tier-2 advisories — making it possible to author sibling skills together (chicken-and-egg).

**Lint behavior:**
- `unknown-skill-reference` (tier-2) — covers `inline()` and `execute_skill()` with missing targets
- `deferred-skill-reference` (tier-3 advisory) — teaching message: *"Skill 'X' referenced via `<op>` is not currently in the SkillStore. Will resolve at execute time if the skill exists by then, or throw `SkillNotFoundError` if not. If this is a typo, fix it now; if it's a forward reference, this advisory will clear once you store 'X'."*

**Runtime behavior:** when a deferred reference still can't resolve at execute time, the runtime throws `MissingSkillReferenceError extends OpError` with structured fields (`missingSkillName`, `viaOp` for the op kind, inherited `target` and `opKind`). The error flows through `# OnError:` fallback chain naturally.

**Stronger contracts kept tier-1:**
- `# OnError: <missing>` — error-handler missing-at-runtime is the worst possible UX moment to discover a missing reference; explicit at compile is the right call.
- `disabled-skill-reference` — pointing at a Disabled skill is a stronger contract than "missing yet to be authored"; explicit at compile.

## When to use composition vs other primitives

Three distinct cases that look similar but have different intents:

1. **Get a value back from another skill.** Use `execute_skill(skill_name="...") -> RESULT` and use `${RESULT}` locally. This is the composition primitive case.

2. **Delegate work to an agent as a task.** Use `# Output: template: <agent>` to route a compiled artifact through AgentConnector. The receiving agent acts on the prompt. *This is the Template-skill story* — uses compile-as-delivery, not execute-and-bind.

3. **Augment an agent's context with a result.** Use `# Output: agent: <name>` to route the executed skill's output into the receiving agent's prompt context as augment-kind payload. *This is the Augmenting-skill story.*

The composition primitive (case 1) is for *intra-skill value passing*. Cases 2 and 3 are for *cross-agent delivery*. The runtime handles all three; the right primitive matches the intent.

## Examples

**Simple call + bind:**

```
# Skill: greeting
# Status: Approved
# Vars: NAME=world

greet:
    emit(text="Hello, ${NAME}!")

default: greet
```

```
# Skill: parent
# Status: Approved

call_greeting:
    execute_skill(skill_name="greeting") -> GREETING_RESULT
    emit(text="Greeting skill said: ${GREETING_RESULT}")

default: call_greeting
```

**Composition with input override:**

```
# Skill: parent-with-inputs
# Status: Approved
# Vars: TARGET_NAME=alice

call_with_inputs:
    execute_skill(skill_name="greeting", inputs={"NAME": "${TARGET_NAME}"}) -> RESULT
    emit(text="Customized greeting: ${RESULT}")

default: call_with_inputs
```

**Defensive composition with fallback:**

```
# Skill: defensive-parent
# Status: Approved

call_maybe_missing:
    execute_skill(skill_name="might-not-exist") -> RESULT (fallback: "child unavailable")
    emit(text="Result: ${RESULT}")

default: call_maybe_missing
```

**TestFlight preview (from the runtime caller, not from inside a skill):**

```
execute_skill({
  skill_name: "parent",
  mechanical: true
})
```

Renders the full dispatch chain — parent's targets in topo order, plus the child's targets where `execute_skill` would fire — without any real ops running. Useful for validating composition before commitment.

## Compile-time inline composition: `inline()`

For *data skills* (skills marked `# Type: data`), the compile-time inline primitive `inline(skill="<name>")` resolves the data skill at compile time and bakes its emitted text into the parent's compiled artifact. The data skill's `content_hash` is recorded in the host's provenance; `skillfile audit` detects stale recompiles when a referenced data skill changes.

`inline()` is compile-time; `execute_skill()` is runtime. Different mechanisms, different use cases.

## Authoring discipline

- Treat composition as a real cost. Each `execute_skill()` dispatch incurs the child's full execution time + side effects. Don't compose for trivial cases that could be inlined.
- Pair composition with `(fallback: ...)` when the child skill might fail and the parent has a sensible degraded path.
- Use mechanical mode to TestFlight any multi-skill chain before shipping it as a Headless skill on a cron trigger.
- Forward references work — author sibling skills in any order, validate independently. The tier-2 warning surfaces the deferred-resolution path; runtime catches genuine misses.
- Recursion is legal but bounded. If your design requires deeper recursion than the configured limit, reshape the workflow — almost always a sign of an iteration that should be expressed as `foreach` rather than recursion.

## Static vs Dynamic — skill execution model

Orthogonal to the three skill categories (Headless / Augmenting / Template, which describe the skill's relationship to the frontier agent), every skill has an *execution model* that describes its relationship to the Skillscript runtime.

## Static skill

A static skill compiles to a portable artifact that any agent capable of reading prose can execute. The compiled output is the deliverable — it does not require the Skillscript runtime, wired connectors, or dispatch machinery to run.

A static skill can be:
- **A pure recipe** — procedure steps the executor follows using their own tools and judgment
- **A data + recipe bundle** — data embedded in the skill (via `# Vars:` defaults or `inline(skill=...)` data-skills) plus instructions for what to do with it
- **A reference to known-local tools** — may reference shell binaries (`curl`, `jq`, etc.) that the executor is expected to have; the executor invokes those themselves rather than via Skillscript's `shell()` dispatch

Static skills are useful for:
- **Skill sharing** — a `.skill` artifact can be emailed, posted, or otherwise distributed without runtime ownership transfer
- **Pipelining data with procedure** — "here are 30 customer reviews. Theme them and emit a summary." The data + recipe ship together; the executor runs them.
- **Knowledge artifacts** — durable procedures that survive the runtime they were authored on
- **Cross-platform deliveries** — a static skill compiled on a Skillscript runtime can be executed by Claude, GPT, or any frontier agent

The Template-kind skill is the canonical static shape — its `# Output: template:` declaration explicitly indicates the runtime doesn't dispatch the body; instead, the compiled artifact is routed to the receiving agent for execution.

## Dynamic skill

A dynamic skill requires the Skillscript runtime to execute. The runtime walks the dispatch DAG, fires `$` ops against wired connectors, runs runtime-intrinsic ops (`emit`, `notify`, `shell`, `file_read`, `file_write`, `execute_skill`), and threads outputs through variable bindings.

Dynamic skills are the default for:
- **Autonomous workflows** — cron-fired Headless skills that fetch, reason, and emit
- **Composition orchestrators** — parent skills that invoke child skills via `execute_skill()`
- **Augmenting deliveries** — skills that gather material via dispatches before composing an augment payload

Dynamic skills bind their behavior to the specific runtime they're executed on: connector configuration, model selection, shell-execution mode, persistent trigger registry. They are not portable in the way static skills are.

## Orthogonality to skill category

| | Headless | Augmenting | Template |
|---|---|---|---|
| **Static** | rare (only-`emit()` cron-fired emission skills) | possible (text-only augment with no fetches) | common (the default Template shape) |
| **Dynamic** | common (the default Headless shape) | common (the default Augmenting shape) | possible (Template with `$` setup ops before the prompt body) |

The axes are independent. A skill author can produce any combination.

## Compile-time portability validation (planned)

A `# Portability: static | dynamic` frontmatter header would declare the skill's intended execution model. The compiler would lint-check that the skill's op set is consistent with the declaration:

- `# Portability: static` → no `$` dispatch ops permitted; no side-effect runtime-intrinsics (`shell`, `file_write`, `notify`, `execute_skill`); only the static-safe set (`emit`, `$set`, `$append`, `inline()`, conditionals, iteration)
- `# Portability: dynamic` (or unset, the default) → any op permitted

A new compile mode `compile_skill({source, mode: "static"})` would render only the portable artifact, refusing skills that depend on runtime dispatch.

Pending implementation. See "Not yet implemented, but planned" at top.

## When to choose which

**Choose static when:**
- The skill should be portable beyond this runtime
- The skill's value is the procedure or data + procedure, not the dispatch behavior
- The skill will be shared, distributed, or executed by an external agent
- Pipelining a known data payload through a recipe

**Choose dynamic when:**
- The skill needs to fetch, reason against, or emit through wired connectors
- The skill is autonomous (cron-fired) or augmenting (live context)
- The skill composes other skills via runtime dispatch (`execute_skill()`)
- The skill is bound to this runtime's connector configuration

## Implementation status

Today's skills are all "dynamic" by default; static skills work in practice (any skill whose ops are only `emit()` / `$set` / `$append` / `inline()` / conditionals / iteration is portable), but the language doesn't yet declare or enforce the distinction.

The recipe-with-data pattern is implicit today via `# Vars:` defaults + `inline(skill=...)` data-skill inlines — a static skill can carry payload via these mechanisms without runtime dependence.

## Tests — # Tests: block, given/expect assertions

The `# Tests:` header introduces a block of test cases that travel with the skill body. Each case has `given:` (variable overrides) and `expect:` (assertions on the compiled output or runtime side effects).

## Status

Header parsing and test runner not yet shipped. See "Not yet implemented, but planned" at top. The grammar below is the design but implementation is pending.

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

Run via the compile API with `format: "test"` (and optional `test_case: "<name>"` to run a single case). All cases run when `test_case` is omitted. Returns pass/fail per assertion with diagnostic detail.

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

`# Tests:` cases that exercise runtime behavior (data writes, shell ops, LocalModel calls) need a sandbox so they don't pollute production data. Two approaches:
- Scratch DB / scratch connector overrides for tests
- Skip-and-warn for non-deterministic ops, only assert deterministic compile-time properties

Deferred until the test runner ships.

### Property-based tests

The current design covers example-based tests. Property-based tests (`for all inputs in {...}, output matches pattern X`) would be a useful future addition but require a generator framework.

## Connection to authoring discipline

The authoring loop — *author → lint → revise → store* — depends on tests-as-preflight being cheap to author and cheap to run. The `# Tests:` block makes this possible at skill-source-level; the lint pass enforces structural correctness; together they raise the bar for what enters the library.

Skill discovery via `skill_list()` (see SkillStore docs) closes the related visibility gap — `execute_skill()` references can be validated against the discoverable surface at compile time.

## Future grammar extensions — sensors, time primitives, suppression, persistent state, capability declarations, debounce

Design rationale for planned features. The user-facing list of "what's coming" lives in the "Not yet implemented, but planned" section at top; this section documents the *why* behind each planned addition. When the language extends, the relevant grammar moves into its canonical section (Ops reference, Variables, Triggers, etc.) and the design-rationale entry here is replaced with a cross-reference.

## Sensors as a language category

Currently `# Triggers:` includes `sensor:` as a trigger source. The planned redesign splits sensors into their own category:

```
# Sensors: presence, screen-state, voice-prosody
# Triggers: cron: 0 8 * * *
```

**Distinction:** Sensors are continuous channels the agent reads but doesn't emit on. Triggers are discrete events that fire the skill. Conflating them in one header produces a worse language for both — sensors need different semantics (continuous read, accessible via ambient refs, privacy-gated) than triggers (discrete fire, dispatch semantics).

Pending: ambient refs for sensor values (`${SENSOR.presence}`, `${SENSOR.voice-prosody.affect}`) and the privacy-gating discipline that determines when a sensor is readable.

## Time as first-class primitives

Current ambient time: `${NOW}` (wall-clock ISO timestamp). Planned relative-time primitives:

```
${SECONDS_SINCE_LAST_USER_MESSAGE}
${MINUTES_SINCE_SESSION_START}
${SECONDS_SINCE_LAST_FIRE_OF.<skill-name>}
```

**Rationale:** Most "right time" reasoning is relative, not wall-clock. Authoring relative-time guards requires either runtime-state tracking (which authors then rebuild manually) or first-class primitives. The latter wins.

## Absence as trigger

Different shape from event triggers — "fire if user hasn't messaged in N minutes" is a wait-for-nothing primitive, not a wait-for-event primitive. Proposed grammar:

```
# Triggers: idle: 5m
```

Runtime tracks the relevant idleness counter and fires when the threshold crosses. Separate dispatch mechanism from event triggers.

## Time-windowed aggregation

Filter-like primitives that operate on state across firings:

```
$ llm prompt="..." -> VERDICT
# pseudo-syntax pending: aggregate over a window
${VERDICT|last-5|count-where:value=="frustrated"}
```

**Rationale:** "User has shown frustration in 3 of 5 recent turns" is a canonical sensor-derived condition. Without first-class windowing, every skill rebuilds ring buffers. Pending design: filter syntax vs new op kind.

## Backpressure / debouncing

Sensors produce floods. First-class primitives for rate limiting:

```
# Debounce: 5s
# RateLimit: 1/minute
# Coalesce: latest
```

Headers declare the runtime's queueing policy. Runtime enforces; skill body doesn't reimplement.

## Suppression as valid output

Current behavior: a skill that fires must produce *some* output (even empty string). Pending: explicit "fire-and-suppress" — the skill considered the situation and decided not to emit. Different from `# Output: none` (which signals "I do side effects only").

Proposed: an explicit suppression op or `$set OUTPUT = null` triggers suppression-detection in the runtime. Output routers skip delivery; trigger fire counts increment for telemetry; no consumer surface receives noise.

**Rationale:** Without suppression, signal pipelines become noisy. "Fire everything, hope the right one wins" turns the inbox-to-context into spam. Discipline that makes pub-sub tractable.

## Persistent state with declared scope

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

Backed by a configured data-records connector (the same surface `# Requires:` reads from) with conventionally-namespaced keys (e.g., `state:skill-local:<skill-name>:<key>`).

**Rationale:** Most interesting skills need persistent state across firings — change-detection, windowing, dedup-against-recent. Without lifecycle, every skill rebuilds state tracking via raw `$ data_write` / `$ data_read` calls.

## Cross-skill pub-sub

Procedural `execute_skill()` invocation handles one-to-one composition. Pub-sub handles many-to-many.

```
# Publishes: signal.frustration-detected
# Subscribes: signal.user-confused
```

When a skill publishes a signal, all subscribed skills fire (independent executions, parallel dispatch). Decouples emitters from consumers — the inverse of direct invocation.

**Rationale:** When signal flow is many-to-many, direct invocation couples everything to everything. Pub-sub keeps emitters ignorant of consumers.

## Confidence/threshold gating

Declarative guards on skill firing:

```
# RequiresConfidence: classifier >= 0.8
# RequiresThreshold: change-delta >= 0.3
```

Runtime evaluates the guard before dispatching the skill body. Lets sensitive skills opt out of low-confidence triggers without each skill's body rebuilding the same guard expression.

## Invocation-control axis

Currently a skill is uniformly invocable from any caller (user via explicit command, agent mid-conversation, trigger autonomous fire). Some skills are user-only intents (user types a slash-command to invoke), some are agent-only behaviors (agent picks the skill via description-match while reasoning), some are trigger-only autonomous fires.

Proposed grammar:

```
# Invocable-By: user, agent, trigger
# Invocable-By: trigger            # autonomous only
# Invocable-By: user               # explicit-command only; agent can't pick it via reasoning
```

Header is a permissive list; absent means all three (current default behavior). Lint flags semantically-inconsistent declarations — a skill with `# Triggers: cron:` but `# Invocable-By: user` is a contradiction the rule catches.

**Rationale:** without the axis, sensitive operations (destructive writes, external messages, irreversible state changes) leak across invocation boundaries. An agent reading skill descriptions might invoke a skill that should only fire on explicit user command. Capability declarations enforce more granularly, but the user/agent/trigger triad is the structural distinction that catches most surface-leak bugs cheaply.

## Channel/locality awareness

Ambient refs for current channel state:

```
${CHANNEL_TYPE}       # slack-dm, slack-channel, voice, web, etc.
${CHANNEL_PRIVACY}    # private, public, group
${CHANNEL_NAME}
```

Privacy gating uses these. A sensor-fired skill that reads `voice-prosody` should not emit to a public channel. Runtime enforces; ambient refs let skill bodies make routing decisions.

**This is the structural gate** that makes the sensor direction socially defensible — privacy as precondition, not feature.

## Introspection primitives

Self-state queries:

```
${PROMPT_CONTEXT.size}
${SKILLS_FIRED_RECENTLY.last-1h}
${SELF.confidence-trend}
```

**Rationale:** Skills can't reason about other skills' state today. Introspection closes the gap.

## Capability declarations

Skill declares its required surfaces:

```
# Requires-Capabilities: sensors=[mic, camera], tools=[datastore.write, slack.post]
# Requires-Privacy: private-channel-only
```

Runtime fails-fast on missing capabilities. Trust precondition for sensor work — operators can audit which skills touch which surfaces.

## Build order rationale

Some features depend on others:
- Suppression + persistent state should land before sensors (sensor work would compound problems without them)
- Pub-sub needs sensors producing traffic before it has anything to route
- Introspection is ergonomic, not foundational — useful but skippable
- Capability declarations are the trust gate that makes sensor + privacy work socially defensible

The "Not yet implemented, but planned" section at top tracks the user-facing surface; this section preserves the design-order argument for when implementation work picks up.

## Open spec questions — unresolved language design decisions

Questions surfaced during design that haven't been resolved. Each carries a current lean where applicable. Resolved items have moved to their canonical sections; this section tracks only what's still open.

## 1. Block execution model — write down the rules

Within a target body, op ordering and variable binding conventions aren't fully written down. Specific questions:
- Can `emit()` calls precede `$` ops in the same target? (Yes; `emit()` has no dependency on subsequent ops.)
- What's the default output binding when `-> NAME` is omitted? (`${target.output}` — same as bare `target` referenced from other blocks.)
- How do cross-block references work syntactically? (`${other_target.output}` or `${VAR_BOUND_THERE}`.)

**Write a "Block execution model" subsection** in the Overview or Ops reference section. No semantic change, just documentation gap.

## 2. `else:` block visibility into the error

Should `${ERROR}` be an ambient ref inside `else:` blocks, populated with the error type/message? Lean: yes, same shape as `${ERROR_CONTEXT}` in `# OnError:` fallback skills. Useful for logging/telemetry skills.

## 3. Multiple triggers — concurrency

If `cron: 0 8 * * *` and `event: user.present` both fire within seconds, does the skill run twice (independent) or get deduped? Lean: independent. Author dedups via state if needed. Affects dispatch layer.

## 4. `execute_skill()` invocation vs trigger firing

When skill A invokes skill B via `execute_skill()`, do skill B's `# Triggers:` fire? Almost certainly no — `execute_skill()` is direct invocation, distinct from the trigger event surface. Worth saying explicitly.

## 5. File-watch path semantics

Recursive or directory-only by default? Inotify supports both. Lean: directory-only default; offer recursive via `file-watch-recursive:` or `file-watch: <path> (recursive)`. Affects dispatch layer when the file-watch trigger source actually fires (currently parse-only).

## 6. Output target delivery failures

If a delivery target is unreachable when the skill fires, what happens? Lean: delivery failure is its own retryable error; queue if possible, else error to caller. Worth a separate small spec section. Affects dispatch layer.

## 7. Skill versioning rollback UX

Edits via upsert preserve history through substrate versioning (SqliteSkillStore's `skill_versions` table, FilesystemSkillStore's git history), but no first-class "rollback" affordance. Probably needs a `--version <N>` flag on the compile API or a sister tool.

## 8. Connector capability declarations

Skills can declare required connector capabilities via `# Requires:` for var resolution. Extending this to "needs semantic search" / "needs structured-extraction model with 32K context" capabilities would be useful for the substrate-portable story. Pending design.

## 9. Per-op timeouts

Hung dispatches hang the skill without explicit timeout configuration. Lean: skill-level `# Timeout:` header + per-op `timeoutSeconds=N` kwarg + runtime defaults. Pending implementation; see "Not yet implemented, but planned" at top.

---

*Rendered from `skillscript/skillscript-language-reference` — 2026-06-03 18:08 EDT*  
*Source of truth: AMP (`amp_render_document("skillscript/skillscript-language-reference")`)*