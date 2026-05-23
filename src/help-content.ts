// Static help content for the `help` MCP tool (v0.2.8). Cold-agent
// language discovery — answers the minimum-viable questions a new
// author needs to write a working skill, without needing to load the
// full language reference.
//
// Content layout:
//   quickstart  — ~500-token introduction; 6 questions + 1 worked example
//   ops         — op symbol legend with one-line shapes per op
//   frontmatter — header keys + values
//   examples    — three canonical worked skills (minimal / threshold / branching)
//   connectors  — short explainer; delegates dynamic data to runtime_capabilities
//   lint-codes  — list of lint rules organized by tier
//
// Token estimates per topic are approximate; help() output is intended
// for an agent's working context, not for human reading.

import type { Registry } from "./connectors/registry.js";

const QUICKSTART = `# Skillscript — quickstart

Skillscript is a declarative language for authoring agent workflows. A
skill is a small program with named targets composed of typed ops. The
runtime walks dependencies backward from the goal target (declared via
\`default:\`) and dispatches each op in topological order.

## 1. Shape of a skill file

\`\`\`
# Skill: my-skill                      ← required: skill name
# Description: What this skill does    ← optional but recommended
# Status: Approved                     ← required: Draft | Approved | Disabled
# Vars: NAME=default-value, OTHER      ← optional: declared variables
# Triggers: cron: 0 9 * * *            ← optional: autonomous-dispatch sources

target_a:                              ← a named block of ops
    @ curl -s https://example.com -> RAW
    ~ prompt="Summarize: $(RAW)" -> SUMMARY

target_b: target_a                     ← Make-style: target_b depends on target_a
    ! $(SUMMARY)

default: target_b                      ← goal target the runtime walks toward
\`\`\`

## 2. Op symbol legend

| Op | Meaning |
|---|---|
| \`$ tool args -> VAR\` | MCP tool invocation; binds result to VAR |
| \`~ prompt="..." -> VAR\` | LocalModel call; binds output |
| \`> mode=... query=... limit=N -> VAR\` | Memory retrieval |
| \`@ command args -> VAR\` | Shell exec (structural sandbox; \`@ unsafe\` for full bash) |
| \`! text\` | Emit text to the user / output channel |
| \`?? prompt -> VAR\` | Ask user (interactive mode only) |
| \`$set NAME=value\` | Explicit variable binding |
| \`$append VAR <value>\` | Accumulate a value into a list-typed VAR (v0.3.0) |
| \`& skill-name args -> VAR\` | Inline a data-skill |

## 3. Result binding

Most ops accept \`-> VAR\` to bind their output. Reference later via \`$(VAR)\`.
Optional \`(fallback: "default")\` after \`-> VAR\` binds the fallback on dispatch
error instead of propagating.

## 4. Branching

\`\`\`
if $(VERDICT) == "urgent":
    ! sound the alarm
elif $(COUNT) > "10":
    ! threshold breached: $(COUNT) items
else:
    ! all clear
\`\`\`

Numeric comparison (\`<\` / \`>\` / \`<=\` / \`>=\`) coerces both sides via Number();
non-numeric operands raise TypeMismatchError.

## 5. Iteration

\`\`\`
foreach M in $(MEMORIES):
    ! Processing $(M.id): $(M.summary)
\`\`\`

## 6. How to see what's broken

- \`lint_skill({source})\` — diagnostics across tier-1 (errors), tier-2 (warnings), tier-3 (advisories)
- \`compile_skill({source, inputs?})\` — render the compiled artifact + surface compile errors
- \`runtime_capabilities()\` — discover wired connectors, models, shell-exec mode

## Worked end-to-end example

\`\`\`
# Skill: morning-temperature-alert
# Description: Cron-fired check; alerts when overnight temp drops below threshold
# Status: Approved
# Vars: LOCATION=Asheville,NC, THRESHOLD=40
# Triggers: cron: 0 7 * * *

fetch:
    @ curl -s "wttr.in/$(LOCATION|url)?format=j1" -> RAW (fallback: "")

evaluate: fetch
    ~ prompt="Extract overnight low temperature in F from this JSON. Reply with only the number: $(RAW)" model=qwen -> TEMP

alert: evaluate
    if $(TEMP|trim) < $(THRESHOLD):
        ! Cold morning: overnight low $(TEMP|trim)°F (threshold $(THRESHOLD)°F)
    else:
        ! Temp ok: $(TEMP|trim)°F

default: alert
\`\`\`

Use \`help({topic: "ops"})\`, \`help({topic: "frontmatter"})\`, \`help({topic: "examples"})\`,
\`help({topic: "connectors"})\`, or \`help({topic: "lint-codes"})\` for deeper sections.
`;

const OPS = `# Op symbols — full reference

## Dispatch ops (bind a result)

### \`$\` — MCP tool invocation

\`\`\`
$ tool_name arg1=value1 arg2=value2 -> VAR [(fallback: "default")]
$ connector.tool_name args -> VAR
\`\`\`

Calls an MCP tool. Without an explicit connector prefix, routes to the
\`primary\` MCP connector. Fallback binds when dispatch errors.

**Built-in (v0.2.8):** \`$ execute_skill skill_name=child -> RESULT\` invokes
another stored skill end-to-end without requiring an MCP connector — pass
input vars as additional kwargs.

### \`~\` — LocalModel call

\`\`\`
~ prompt="..." model=qwen maxTokens=400 -> VAR [(fallback: "...")]
\`\`\`

LLM call against a configured LocalModel. \`model\` selects the named model;
default is \`default\`. Multi-line prompts via \`"..."\` are supported (parser
folds quoted-string continuations).

### \`>\` — Memory retrieval

\`\`\`
> mode=fts query="..." limit=20 -> VAR [(fallback: "...")]
\`\`\`

Queries the configured MemoryStore. \`mode\` is substrate-specific
(\`fts\` / \`semantic\` / \`rerank\` are common). \`limit\` is required.

### \`@\` — Shell exec

\`\`\`
@ command arg1 arg2 -> VAR [(fallback: "...")]
@ unsafe full-shell-command -> VAR
\`\`\`

Default mode: structural spawn — one binary, no shell metacharacters,
no pipes/redirects. \`@ unsafe\` opts into full bash; lint-flags tier-2.

## Emission + control ops

### \`!\` — Emit text

\`\`\`
! Hello, $(NAME)!
\`\`\`

One-line literal emission. Variables substitute. No result binding.

### \`??\` — Ask user

\`\`\`
?? Are you sure? -> CONFIRM
\`\`\`

Interactive only. Autonomous-mode dispatch fails with a clean error.

### \`$set\` — Explicit binding

\`\`\`
$set NAME=value
$set NAME=$(OTHER_VAR|trim)
\`\`\`

### \`$append\` — Accumulator (v0.3.0)

\`\`\`
$append VAR <value>
\`\`\`

Single-value append to a list-typed VAR. The target must be initialized in an enclosing scope before the append fires:

\`\`\`
walk:
    $set FOUND = []
    foreach M in $(MESSAGES):
        if $(M.id) not in $(FOUND):
            $append FOUND $(M.id)
            ! NEW: $(M.id)
\`\`\`

The append mutates the outer-scope binding (unlike \`$set\`, which is loop-local inside \`foreach\`). Lint catches: missing init (\`uninitialized-append\`), init inside the same foreach as the append (\`foreach-local-accumulator-target\` — would silently lose data each iteration), init pointing at a non-list value (\`append-to-non-list\`). List-only in v0.3.0 — string concat and map-shaped accumulation deferred.

### \`&\` — Inline data-skill

\`\`\`
& source-skill-name arg=value -> VAR
\`\`\`

References a \`# Type: data\` skill; the compiler inlines its emitted text
at compile time so the compiled artifact is a single resolved document.

## Pipe filters

Apply on \`$(VAR|filter)\` references; chain left-to-right.

| Filter | Effect |
|---|---|
| \`url\` | encodeURIComponent |
| \`shell\` | POSIX single-quote escape |
| \`json\` | JSON.stringify |
| \`trim\` | Whitespace trim |
| \`length\` | Array element count or string char count (v0.2.5) |

## Conditional grammar

\`\`\`
if $(VAR):                            ← truthy check
if $(VAR) == "literal":               ← equality vs literal
if $(VAR) == $(OTHER):                ← equality vs ref
if $(VAR) != "literal":               ← inequality
if $(N) < "10":                       ← numeric comparison (v0.2.5)
if $(N) >= $(THRESHOLD):              ← numeric vs ref
if $(M.id) in $(SEEN):                ← set membership
if $(M.id) not in $(SEEN):
\`\`\`

Branches via \`if:\` / \`elif COND:\` / \`else:\`. The \`else:\` after a target
body is a separate error-handler block (distinguished by indentation scope).
`;

const FRONTMATTER = `# Frontmatter headers — full reference

Skill files open with \`# Key: value\` headers. Order isn't significant.

## Required

- \`# Skill: <name>\` — identity. Reserved keywords (\`default\`, \`needs\`, etc.) rejected.
- \`# Status: Draft | Approved | Disabled\` — lifecycle state. Only Approved skills fire via triggers.

## Common

- \`# Description: <prose>\` — human-readable explanation; surfaces in dashboards.
- \`# Type: procedural | data\` — \`procedural\` (default) for runtime-fired skills; \`data\` for compile-time-inlined fragments referenced by \`&\` ops.
- \`# Vars: NAME=default, OTHER\` — declared variables. \`NAME=default\` provides a default; bare \`NAME\` is required at invocation.
- \`# Triggers: cron: 0 9 * * *, session: start\` — autonomous-dispatch sources. Comma-separated entries split by source-keyword boundary; cron expressions with commas (\`30,45 9 * * 1-5\`) parse correctly.
- \`# Output: text | slack: chan | prompt-context: agent | template: agent | file: path | card: id | none\` — output routing.
- \`# OnError: <fallback-skill-name>\` — error-handler skill invoked when an op fails and no target-level \`else:\` catches.

## Augmenting / Template only

- \`# Delivery-context: <prose>\` — routed to the receiving agent alongside the augment payload. v0.2.6.
- \`# Templates: <skill_name>, <skill_name>\` — comma-separated Template-skill names the receiving agent may fetch as follow-on actions. v0.2.6.

(Both fire \`unused-augmenting-header\` lint warning if set on a Headless skill — one with no \`prompt-context:\` or \`template:\` output declaration.)

## Capabilities + retrieval

- \`# Requires: <namespace>:<key> -> VAR (fallback: "value")\` — declares external input requirements. \`user-var:\` or \`system-var:\` namespaces. Cascades resolve at compile.
- \`# Requires: connector_type.feature_flag\` — capability-style requires (e.g., \`local_model.streaming\`); validated against \`runtime_capabilities\`.

## Performance

- \`# Timeout: <seconds>\` — skill-wide timeout. Falls back to per-op or runtime defaults.

## Trigger declaration forms

\`\`\`
# Triggers: cron: 30,45 9 * * 1-5
# Triggers: session: start, session: end
# Triggers: cron: 0 7 * * *, agent-event: drift-detected
\`\`\`

Trigger sources today: \`cron\` (poll-based), \`session\` (\`start\` / \`end\` phases). Parse-only in v0.2: \`event\`, \`agent-event\`, \`file-watch\`, \`sensor\` (firing lands in v1.0).

## Ambient variables (auto-populated by the runtime)

The runtime injects these refs — don't declare them in \`# Vars:\` / \`# Requires:\`.

| Ref | Source | Notes |
|---|---|---|
| \`$(NOW)\` | runtime clock | ISO-8601 timestamp at op-dispatch time |
| \`$(USER)\` | invocation context | Identity passed via \`agentId\` / CLI user |
| \`$(SESSION_CONTEXT)\` | runtime session | Free-form session snapshot for cross-skill carry |
| \`$(TRIGGER_TYPE)\` | scheduler | \`cron\` / \`session\` / \`manual\` / \`agent-event\` |
| \`$(TRIGGER_PAYLOAD)\` | scheduler | JSON-serializable payload attached to the firing trigger |
| \`$(ERROR_CONTEXT)\` | runtime error handler | Inside \`else:\` and \`# OnError:\` only; \`.kind\` / \`.message\` / \`.target\` accessible |

\`EVENT.*\` auto-populates on cron-fired skills (v0.2.7 scheduler):

| Ref | Value |
|---|---|
| \`$(EVENT.fired_at)\` | epoch milliseconds |
| \`$(EVENT.fired_at_unix)\` | epoch seconds |
| \`$(EVENT.fired_at_plus_1h_unix)\` | \`fired_at_unix + 3600\` |
| \`$(EVENT.fired_at_plus_1d_unix)\` | \`fired_at_unix + 86_400\` |
| \`$(EVENT.fired_at_plus_7d_unix)\` | \`fired_at_unix + 604_800\` |

(v0.2.12 Bug 24 — \`EVENT.*\` was undocumented before this release.)

## Variable reference forms

\`\`\`
$(VAR)              bare ref (any declared/output-bound/ambient name)
$(VAR.field)        dotted field access on JSON-bound vars + ambient family
$(LIST.0)           indexed access (v0.2.12 Bug 25 — was undocumented)
$(LIST.0.id)        mixed indexed + field-access (chains arbitrarily deep)
$(VAR|filter)       filter pipe (see \`help({topic: "ops"})\` for filter list)
$(VAR.field|filter) field-access then filter
\`\`\`

Unresolved refs: tier-1 \`undeclared-var\` at compile, \`UnresolvedVariableError\` at runtime.
`;

const EXAMPLES = `# Three canonical worked skills

## 1. Minimal (single target, no dependencies)

\`\`\`
# Skill: hello
# Description: The canonical first-run example.
# Status: Approved
# Vars: WHO=world

greet:
    ! Hello, $(WHO)!
    ! Welcome to Skillscript.

default: greet
\`\`\`

Demonstrates: required headers, variable defaults, \`!\` emission with substitution.

## 2. Cron-fired numeric threshold + count

\`\`\`
# Skill: queue-length-monitor
# Description: Count pending items in a queue and alert when the count exceeds threshold
# Status: Approved
# Vars: QUEUE_PATH=/var/queue/pending.json, THRESHOLD=10
# Triggers: cron: */5 * * * *

fetch:
    @ cat $(QUEUE_PATH) -> ITEMS (fallback: "[]")

evaluate:
    needs: fetch
    if $(ITEMS|length) > $(THRESHOLD):
        ! Queue backlog: $(ITEMS|length) items pending (threshold $(THRESHOLD)). Action required.
    else:
        ! Queue healthy: $(ITEMS|length) items pending (under $(THRESHOLD)).

default: evaluate
\`\`\`

Demonstrates: \`# Triggers:\` cron, shell \`@\` op with fallback, \`needs:\` body-line dep, numeric comparison, \`|length\` filter, \`if\` / \`else\`.

## 3. LocalModel branching with agent delivery

\`\`\`
# Skill: classify-support-ticket
# Description: Classify an incoming ticket by urgency and route to oncall when severe
# Status: Approved
# Vars: TICKET_BODY
# Delivery-context: Urgent ticket triage — please assess + assign owner.
# Templates: ticket-assignment-procedure
# Output: prompt-context: oncall

classify:
    ~ prompt="Classify this support ticket as one of: 'critical', 'normal', 'low'. Reply with only the label. Ticket: $(TICKET_BODY)" model=qwen -> VERDICT

route: classify
    if $(VERDICT|trim) == "critical":
        ! CRITICAL ticket needs immediate attention:
        ! $(TICKET_BODY)
    elif $(VERDICT|trim) == "normal":
        ! Normal-priority ticket queued.
    else:
        ! Low-priority ticket logged.

default: route
\`\`\`

Demonstrates: \`~\` LocalModel op, named model selection, \`|trim\` filter on LLM output, ref-vs-literal comparison, agent delivery via \`prompt-context:\`, augmenting headers (\`# Delivery-context:\` + \`# Templates:\`).

## 4. Composition — orchestrator invoking child skills

\`\`\`
# Skill: morning-brief-orchestrator
# Description: Fan out to three child skills, gather their outputs into one brief.
# Status: Approved
# Vars: USER_NAME=Scott

gather:
    $ execute_skill skill_name=calendar-today USER=$(USER_NAME) -> CAL (fallback: "(no calendar data)")
    $ execute_skill skill_name=mailbox-triage USER=$(USER_NAME) -> MAIL (fallback: "(mailbox empty)")
    $ execute_skill skill_name=weather-summary -> WX (fallback: "(weather unavailable)")

render: gather
    ! Good morning, $(USER_NAME). Today:
    ! • Calendar: $(CAL)
    ! • Mailbox: $(MAIL)
    ! • Weather: $(WX)

default: render
\`\`\`

Demonstrates: in-skill \`$ execute_skill\` composition (each child runs through the runtime under a depth-counted chain), per-call \`(fallback: ...)\` for resilience, kwarg forwarding (\`USER=$(USER_NAME)\`), \`->\` binding child output for downstream reference.

## 5. Dedup-by-id with the accumulator (v0.3.0)

\`\`\`
# Skill: dedup-walk
# Description: Walk a result list, skip items whose id was already seen.
# Status: Approved

walk:
    > mode=topical query="$(TOPIC)" limit=50 -> CANDIDATES
    $set SEEN = []
    foreach C in $(CANDIDATES):
        if $(C.id) not in $(SEEN):
            $append SEEN $(C.id)
            ! NEW: $(C.id) — $(C.summary)
        else:
            ! dup: $(C.id)
    ! Total novel items: $(SEEN|length)

default: walk
\`\`\`

Demonstrates: \`$append\` accumulator pattern, \`$set SEEN = []\` init at the target body (before the foreach) so mutations persist across iterations, \`not in\` membership check against the accumulating list, \`|length\` filter on the final collected list. Pre-v0.3.0 this pattern was structurally unimplementable — \`$set\` inside foreach is loop-local, so the SEEN list reset every iteration.
`;

const COMPOSITION = `# Composition

Skillscript has three composition primitives — all let one skill draw on another's output, with different semantics around when, where, and how the child runs.

## 1. \`& <skill-name>\` — data-skill inline (compile-time)

Inlines an *Approved data skill* into the host skill's compiled artifact at the call site. The data skill's body becomes part of the rendered prompt. Use for *static* knowledge or templated content (style guides, voice rules, runbooks).

\`\`\`
brief:
    ~ prompt="$(VOICE_RULES) Now write a one-line status:" model=qwen -> RESULT
    & voice-rules
\`\`\`

- Resolved at \`compile()\` time — the data skill's \`content_hash\` is recorded in the host's provenance block.
- Provenance lets \`skillfile audit\` detect stale recompiles when a referenced data skill changes.
- The data skill must be marked \`# Skill-kind: data\` (or live in a path the SkillStore recognizes as data); otherwise it's treated as procedural and won't inline.

## 2. \`& invoke <skill-name>\` — runtime call (per-fire)

Calls a procedural skill at runtime. Each call goes through the runtime under a depth-counted chain (default limit 5) — same recursion guard as Style 3 below.

\`\`\`
escalate:
    & invoke notify-oncall
\`\`\`

- Child skill's outputs flow into the parent's variable scope.
- Failures propagate as \`OpError\`s.

## 3. \`$ execute_skill skill_name="<child>" ...kwargs -> VAR\` — in-skill execute (per-fire)

The most general form: the host \`$\`-dispatches the literal tool name \`execute_skill\` (intercepted by the runtime, not sent to any MCP server). Same depth-counted chain as Style 2, plus full kwarg forwarding and \`-> VAR\` binding for downstream use.

\`\`\`
gather:
    $ execute_skill skill_name="calendar-today" USER=$(USER_NAME) -> CAL (fallback: "(no calendar data)")
    $ execute_skill skill_name="mailbox-triage" inputs={"USER": "$(USER_NAME)"} -> MAIL
\`\`\`

Two kwarg styles, both supported (v0.2.9 fix):
- **Bare kwargs** — \`USER=$(USER_NAME)\` natural skill grammar
- **\`inputs={...}\` JSON** — MCP-call parity, useful when forwarding many fields verbatim

The bound \`-> VAR\` carries the child's final emit through to the host's scope.

## Limits & lint signals

- **Recursion**: depth-5 chain by default (\`ExecuteSkillRecursionError\` if exceeded). Both \`& invoke\` and \`$ execute_skill\` share the counter.
- **Lint** (\`unknown-skill-reference\`, tier-2 as of v0.3.1): \`& <name>\`, \`& invoke <name>\`, and \`$ execute_skill skill_name=<name>\` all validate the child skill exists in the SkillStore at compile time. Forward references are allowed: missing skills lint as a warning (not error), and the runtime throws \`MissingSkillReferenceError\` if still unresolved at execute time. Tier-3 \`deferred-skill-reference\` advisory confirms when the deferred-resolution path is engaged.
- **Lint** (\`disabled-skill-reference\`, tier-1): any composition primitive pointing at a \`# Status: Disabled\` skill blocks compile.

## When to use which

| Use case | Primitive |
|---|---|
| Static knowledge in a prompt | \`& <data-skill>\` |
| Fire-and-forget child call | \`& invoke <skill>\` |
| Child output bound into parent scope | \`$ execute_skill ... -> VAR\` |
| Parallel orchestrators (v0.3.0 candidate — not yet shipped) | parked |

See \`help({topic: "examples"})\` example 4 for a worked orchestrator skill.
`;

const CONNECTORS_PROLOGUE = `# Connectors

The runtime resolves \`$\` / \`~\` / \`>\` / \`# Output:\` dispatches through a
typed registry of five contracts:

| Contract | Purpose | Op |
|---|---|---|
| SkillStore | Skill source persistence + status lifecycle | (implicit) |
| MemoryStore | Knowledge retrieval | \`>\` |
| LocalModel | LLM inference | \`~\` |
| McpConnector | MCP tool dispatch | \`$\` |
| AgentConnector | Deliver augment/template payloads | \`# Output: prompt-context:\` / \`template:\` |

Skills don't import packages — they invoke connectors. The set wired into
this runtime, plus their feature flags, is discoverable via:

  \`runtime_capabilities()\`

Call that tool for the live picture of which connectors are registered,
which feature flags they advertise, and which named instances exist
(e.g., \`default\` / \`qwen\` LocalModels).

For shell execution (\`@\` op), \`runtime_capabilities\` also reports
\`shellExecution.mode\` (\`"structural-spawn"\`) and
\`shellExecution.unsafe_enabled\` (whether \`@ unsafe\` is permitted in
this deployment).
`;

const LINT_CODES = `# Lint rule index

Three tiers per ERD §3:

- **Tier-1 (error)** — blocks compile. Must fix before the skill enters the SkillStore.
- **Tier-2 (warning)** — non-blocking but flagged. Common smell; review.
- **Tier-3 (info)** — advisory. Often style or organizational hints.

## Tier-1 (error)

- \`parse-error\` — frontmatter or grammar fault surfaced by parse()
- \`no-targets\` — skill defines no targets
- \`no-entry-target\` — no \`default:\` declaration
- \`orphan-target\` — target unreachable from entry via dep graph
- \`unknown-capability\` — \`# Requires: connector.feature\` references a flag no registered connector advertises
- \`undeclared-var\` — \`$(VAR)\` reference not in \`# Vars:\` / \`# Requires:\` / output-bound / foreach iterator / tier-1 ambient (NOW/USER/SESSION_CONTEXT/TRIGGER_TYPE/TRIGGER_PAYLOAD/ERROR_CONTEXT)
- \`unknown-filter\` — \`|filter\` references an unregistered filter name
- \`malformed-op-grammar\` — op body doesn't match its grammar
- \`invalid-conditional-syntax\` — \`if\` condition doesn't match supported forms
- \`single-equals\` — \`if $(VAR) = "..."\` instead of \`==\` (specific diagnostic)
- \`indentation\` — tabs in indentation; mixed tabs/spaces
- \`reserved-keyword\` — variable/target/skill name collides with a reserved word
- \`disabled-skill-reference\` — \`&\` or \`$ execute_skill\` references a Disabled skill
- \`credential-in-args\` — op arg looks like a secret literal
- \`status-disabled\` — skill marked \`# Status: Disabled\`
- \`circular-dependency\` — dep cycle between targets
- \`missing-dependency\` — \`needs:\` references a target not declared
- \`missing-skillstore-for-data-ref\` — \`&\` op fires without a SkillStore wired
- \`unsafe-shell-disabled\` — \`@ unsafe\` declared but \`enableUnsafeShell: false\` (v0.2.11 Bug 5; fires only when caller passes the flag explicitly false)
- \`uninitialized-append\` — \`$append VAR ...\` where VAR has no \`$set\` or \`# Vars:\` init in any enclosing scope (v0.3.0)
- \`foreach-local-accumulator-target\` — \`$append VAR ...\` where the matching \`$set VAR = []\` is in the same scope as the append (typically same foreach body — would silently lose data each iter) (v0.3.0)
- \`append-to-non-list\` — \`$append VAR ...\` where VAR's static init is a non-list value (v0.3.0; list-only)

## Tier-2 (warning)

- \`deprecated-question\` — bare \`?\` op (deprecated v1; compile-error in v1.x)
- \`unsafe-shell-ambiguous-subst\` — \`$(NAME)\` inside \`@ unsafe\` body that isn't a declared variable; collides with bash command-sub syntax
- \`unsafe-shell-op\` — \`@ unsafe\` op present; requires human review every time
- \`unknown-retrieval-arg\` — \`>\` op carries kwargs outside mode/query/limit/connector/fallback (v0.2.12 Bug 26)
- \`unknown-skill-reference\` — \`&\` or \`$ execute_skill\` references a skill not in the store (demoted from tier-1 in v0.3.1; runtime throws \`MissingSkillReferenceError\` if still unresolved at execute)
- \`unknown-template-reference\` — \`# Templates: <name>\` references a skill not in the store (demoted from tier-1 in v0.3.1)
- \`unconfirmed-mutation\` — \`$\` op invokes a tool whose name suggests mutation (write/update/delete) without a preceding \`??\` confirmation
- \`model-contention\` — async + sync ops on the same model serialize on a single runtime worker
- \`draft-with-trigger\` — \`# Status: Draft\` skill has \`# Triggers:\` declared; triggers won't fire until Approved
- \`reference-to-disabled-skill\` — \`&\` op references a Disabled skill (also tier-1 in some contexts)
- \`unused-augmenting-header\` — \`# Delivery-context:\` or \`# Templates:\` set on a skill with no agent-bound output (v0.2.6)

## Tier-3 (info)

- \`no-default-target\` — no \`default:\` declaration (relevant for data skills only; procedural skills hit tier-1)
- \`duplicate-skill-name\` — name collides with an existing stored skill
- \`plugin-collision\` — placeholder for v1.x plugin-loader name conflicts
- \`deferred-skill-reference\` — composition ref (\`&\` / \`$ execute_skill\` / \`# Templates:\`) targets a skill not currently in the SkillStore; resolution deferred to execute time (v0.3.1+). Confirms the forward-reference path is engaged; clears once the target is stored.

\`compile_skill({source})\` runs the full lint preflight and reports
findings in the \`errors\` + \`warnings\` arrays. \`lint_skill({source})\`
returns the same diagnostics without compiling.
`;

export function helpResponse(
  topic: string | null,
  runtimeVersion: string,
  registry?: Registry,
): Record<string, unknown> {
  if (topic === null) {
    return {
      topic: null,
      version: runtimeVersion,
      content: QUICKSTART,
      available_topics: ["ops", "frontmatter", "examples", "composition", "connectors", "lint-codes"],
    };
  }
  let content: string;
  switch (topic) {
    case "ops":         content = OPS; break;
    case "frontmatter": content = FRONTMATTER; break;
    case "examples":    content = EXAMPLES; break;
    case "composition": content = COMPOSITION; break;
    case "connectors":  content = renderConnectorsTopic(registry); break;
    case "lint-codes":  content = LINT_CODES; break;
    default:
      content = `# Unknown topic '${topic}'\n\nValid topics: ops, frontmatter, examples, composition, connectors, lint-codes`;
  }
  return { topic, version: runtimeVersion, content };
}

function renderConnectorsTopic(registry?: Registry): string {
  if (registry === undefined) return CONNECTORS_PROLOGUE;
  const summary: string[] = [
    `\n## Wired in this runtime`,
    ``,
    `*Call \`runtime_capabilities()\` for the full discovery payload.*`,
    ``,
  ];
  const ss = registry.listSkillStores();
  const ms = registry.listMemoryStores();
  const lm = registry.listLocalModels();
  const mc = registry.listMcpConnectors();
  const ac = registry.listAgentConnectors();
  summary.push(`- SkillStores: ${ss.length === 0 ? "(none)" : ss.map((e) => `${e.name} (${e.ctor.name})`).join(", ")}`);
  summary.push(`- MemoryStores: ${ms.length === 0 ? "(none)" : ms.map((e) => `${e.name} (${e.ctor.name})`).join(", ")}`);
  summary.push(`- LocalModels: ${lm.length === 0 ? "(none)" : lm.map((e) => e.name).join(", ")}`);
  summary.push(`- McpConnectors: ${mc.length === 0 ? "(none)" : mc.map((e) => `${e.name} (${e.ctor.name})`).join(", ")}`);
  summary.push(`- AgentConnectors: ${ac.length === 0 ? "(none — defaults to NoOp)" : ac.map((e) => `${e.name} (${e.ctor.name})`).join(", ")}`);
  return CONNECTORS_PROLOGUE + summary.join("\n");
}
