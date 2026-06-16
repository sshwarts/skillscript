// Static help content for the `help` MCP tool. Cold-agent
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

## 1. The skill model — trigger → process → deliver

Every skill follows the same shape:

1. **Trigger fires** — cron, command, event, session-start, or programmatic invocation
2. **Process** — pull data (MCP / memory / file), classify / compose via sub-LLM + iteration, build the deliverable
3. **Deliver** — via one or more of four channels

The four delivery channels are all first-class:

| Channel | Op | When you'd use it |
|---|---|---|
| **Body-text-as-output template** | prose between frontmatter + first target | Declarative output — skill body IS the output, rendered with var substitution. The clean shape for fixed-form output. |
| **Embedded prompt** | \`emit(text="...")\` | Imperative output for variable-cardinality cases (\`foreach\` per-item emit), conditionally-different output shapes, or transcript / reasoning trace |
| **File handoff** | \`file_write(path="...", content="...")\` | Skill writes a file at a known location for the agent to read |
| **Data handoff** | \`$ data_write content="..." recipients=["agent"] -> R\` | Skill writes a record the target agent picks up via mailbox. Routes through the wired \`data_write\` connector (default: \`DataStoreMcpConnector\` bundled). |

## 2. The three op classes

| Class | Shape | Examples |
|---|---|---|
| **Mutation statements** | \`$verb VAR = value\` / \`$verb VAR <value>\` | \`$set NAME = "Scott"\`, \`$append LIST <item>\` |
| **Runtime-intrinsic function-calls** | \`verb(kwarg=value, ...) [-> BINDING]\` | \`emit(text="...")\`, \`inline(skill="...")\`, \`execute_skill(name="...") -> R\`, \`shell(command="...") -> R\` / \`shell(argv=[...]) -> R\`, \`file_read(path="...") -> R\`, \`file_write(path="...", content="...")\`, \`notify(agent="...")\` |
| **External MCP dispatch** | \`$ <connector> kwarg=value, ... [-> BINDING]\` | \`$ youtrack_search query="..." -> R\`, \`$ llm prompt="..." -> R\`, \`$ data_read mode=fts query="..." -> R\` |

The \`$\` prefix marks **state-affecting ops** (mutation OR external dispatch). Function-call shape marks **language-intrinsic ops the runtime knows directly**.

**Bare vs. dotted form.** \`$ <name> kwargs\` (bare) routes via name-match to the connector named \`<name>\` — the most common shape. \`$ <connector>.<tool> kwargs\` (dotted) routes explicitly when multiple connectors expose the same tool, or to pick a specific instance. Example: \`$ slack_eng.post channel="general" text="..."\` vs \`$ slack_marketing.post channel="general" text="..."\` — the dotted form is the disambiguator.

## 3. Shape of a skill file

\`\`\`
# Skill: my-skill                      ← required: skill name
# Description: What this skill does    ← optional but recommended
# Status: Approved                     ← required: Draft | Approved | Disabled
# Vars: NAME=default-value, OTHER      ← optional: declared variables
# Triggers: cron: 0 9 * * *            ← optional: autonomous-dispatch sources

\${SUMMARY}                             ← body-text-as-output template (optional)

target_a:                              ← a named block of ops
    $ ticketing_search query="state:open" -> ISSUES
    $ llm prompt="Summarize: \${ISSUES}" -> SUMMARY

target_b: needs: target_a              ← target_b depends on target_a
    $set _ = "noop"

default: target_b                      ← goal target the runtime walks toward
\`\`\`

Text between the frontmatter and the first target is a **declarative output template**. The runtime interpolates \`\${VAR}\` refs against final vars and publishes the rendered string as the skill's canonical output. No \`emit()\` ceremony for fixed-shape output. See section "Body template" below.

## 4. Variable substitution

Use \`\${VAR}\` (canonical) inside any kwarg value or emit body. Field access works: \`\${ISSUE.title}\`. Filter chains: \`\${VAR|trim|length}\`. Missing-value fallback: \`\${VAR|fallback:"-"}\`.

The legacy \`$(VAR)\` form still compiles with a tier-2 \`deprecated-substitution-shape\` warning; rewrite to canonical \`\${VAR}\`.

## 5. Result binding + fallback

Most dispatch ops accept \`-> VAR\` to bind their output. Reference later via \`\${VAR}\`. Optional \`(fallback: "default")\` after \`-> VAR\` binds the fallback on dispatch error instead of propagating.

## 6. Branching

\`\`\`
if \${VERDICT} == "urgent":
    emit(text="sound the alarm")
elif \${COUNT} > "10":
    emit(text="threshold breached: \${COUNT} items")
else:
    emit(text="all clear")
\`\`\`

Numeric comparison (\`<\` / \`>\` / \`<=\` / \`>=\`) coerces both sides via Number(); non-numeric operands raise TypeMismatchError.

## 7. Iteration

\`\`\`
foreach M in \${MEMORIES}:
    emit(text="Processing \${M.id}: \${M.summary}")
\`\`\`

## 8. Body template — when emit is overkill

For fixed-shape output, write the rendered sentence directly as the skill body. The compute block fills in the holes:

\`\`\`
# Skill: get-weather
# Vars: AREA="Brooklyn"

\${AREA}: \${TEMP}°\${UNIT} and \${DESC}.

fetch:
    shell(command="curl -s https://wttr.in/\${AREA|url}?format=j1") -> RAW
    $ json_parse \${RAW} -> W
    $set TEMP = "\${W.current_condition.0.temp_F}"
    $set UNIT = "F"
    $set DESC = "\${W.current_condition.0.weatherDesc.0.value|trim}"

default: fetch
\`\`\`

**Template vs. emit — complementary channels.** Template owns canonical output (\`outputs.text\` / agent or template delivery payload / file content). \`emit()\` populates the transcript (trace records, dashboard \`/fires\` view, debugging). Skills with both: template = output, emit = transcript. The \`emit-with-template\` advisory lint confirms intent.

Keep \`emit()\` when:
- Variable-cardinality output: \`foreach M in \${MEMORIES}: emit(text="\${M.id}")\` — N lines determined at runtime
- Conditional output **shapes**: different branches produce different structural outputs (not just different values)
- Transcript / reasoning trace: emit feeds \`/fires\` even when template feeds output

Pin 4 disambiguation — a target is \`<name>:\` alone with an indented op-block following. Content after the colon (\`Summary: hot today\`) or a bare \`<word>:\` with no following op-block reads as template text. Lint \`template-looks-like-target\` flags the genuinely ambiguous shape.

## 9. How to see what's broken

- \`lint_skill({source})\` — diagnostics across tier-1 (errors), tier-2 (warnings), tier-3 (advisories)
- \`compile_skill({source, inputs?})\` — render the compiled artifact + surface compile errors
- \`runtime_capabilities()\` — discover wired connectors, models, shell-exec mode

## Worked end-to-end example

\`\`\`
# Skill: morning-showstopper-sweep
# Description: Cron-fired pre-triage; delivers triaged showstoppers to oncall agent via the agent: lifecycle hook
# Status: Approved
# Autonomous: true
# Vars: PROJECT=INFRA
# Triggers: cron: 0 8 * * MON-FRI
# Output: agent: oncall

run:
    $ ticketing_search query="project:\${PROJECT} severity:showstopper state:Open" limit=20 -> ISSUES

    emit(text="Morning showstoppers for \${PROJECT} — \${ISSUES.totalCount} open:")
    emit(text="")
    foreach ISSUE in \${ISSUES.items}:
        $ llm prompt="Two-line triage hypothesis for: \${ISSUE.summary}" -> ANALYSIS
        emit(text="## \${ISSUE.id}: \${ISSUE.summary}")
        emit(text="\${ANALYSIS}")
        emit(text="")

default: run
\`\`\`

What this example demonstrates:
- **Trigger** — cron at 8am weekdays
- **Process** — \`$ ticketing_search\` MCP dispatch (substrate-portable: adopters wire whatever ticketing connector they have), \`foreach\` iteration with per-item \`$ llm\` sub-classification
- **Deliver** — \`emit(text=...)\` per line accumulates as agent-bound delivery, routed to the on-call agent via the \`# Output: agent: oncall\` lifecycle hook declaration
- **Authorization** — \`# Autonomous: true\` declares this skill cron-fired and unattended; mutation ops within are silenced from the user-confirmation lint

**Pattern note:** prefer \`emit(text="...")\` per line over building a multi-line accumulator string with \`$append\`. The runtime threads emissions into the agent-bound delivery naturally, and the per-line shape is what cold authors reach for. Multi-line string accumulators are a real pattern for file-writing scenarios; emit is the natural choice for agent-targeted delivery via \`# Output: agent:\`.

Use \`help({topic: "ops"})\`, \`help({topic: "frontmatter"})\`, \`help({topic: "examples"})\`,
\`help({topic: "connectors"})\`, or \`help({topic: "lint-codes"})\` for deeper sections.

**Note on substitution form.** Use \`\${VAR}\` for variable substitution. The bare-paren \`$(VAR)\` form still compiles with a tier-2 \`deprecated-substitution-shape\` warning.
`;

const OPS = `# Ops reference

Three op classes, two grammars:

| Class | Shape | When you reach for it |
|---|---|---|
| **Mutation statements** | \`$verb VAR = value\` / \`$verb VAR <value>\` | Bind / mutate a named variable in scope |
| **Runtime-intrinsic function-calls** | \`verb(kwarg=value, ...) [-> BINDING]\` | Language-intrinsic side-effects: emit, notify, file I/O, shell, composition |
| **External MCP dispatch** | \`$ <connector> kwarg=value, ... [-> BINDING]\` | Any tool resolved through \`connectors.json\` (LLM calls, data queries, business tools) |

The \`$\` prefix marks **state-affecting** ops (mutation OR external dispatch). Function-call shape marks **language-intrinsic** ops the runtime knows directly.

## Class 1: Mutation statements

### \`$set VAR = value\`

Bind a variable; runtime resolves \`\${REF}\` substitutions in the RHS at bind time. Value can be a literal, a \`\${REF}\` interpolation, or a JSON literal (object / array / bool / null).

\`\`\`
$set GREETING = "Hello, \${USER}!"
$set ITEMS = []
$set CONFIG = {"timeout": 30, "retries": 3}
\`\`\`

### \`$append VAR <value>\`

Append to a binding. Type-dispatches on the existing target:
- **List-typed target** → push (\`$set FOUND = []\` then \`$append FOUND \${ID}\`)
- **String-typed target** → concatenate (\`$set REPORT = ""\` then \`$append REPORT "more text"\`)

Lint guards: \`uninitialized-append\` (no \`$set\` / \`# Vars:\` init); \`foreach-local-accumulator-target\` (init inside the same foreach as the append — silently loses data each iteration); \`append-to-non-list\` (numeric/boolean/null init).

\`\`\`
walk:
    $set SEEN = []
    $set REPORT = ""
    foreach M in \${MESSAGES}:
        if \${M.id} not in \${SEEN}:
            $append SEEN \${M.id}
            $append REPORT "\\n - \${M.id}: \${M.summary}"
\`\`\`

The append mutates the outer-scope binding (unlike \`$set\`, which is loop-local inside \`foreach\`).

## Class 2: Runtime-intrinsic function-calls

Closed set: \`emit\`, \`notify\`, \`inline\`, \`execute_skill\`, \`shell\`, \`file_read\`, \`file_write\`. Unknown function-call names fire \`unknown-runtime-op\` tier-1 with remediation "if this is an MCP tool, use \`$ tool args -> R\` shape instead."

### \`emit(text="...")\` — output to skill consumer

One-line emission. \`\${VAR}\` substitutes. No result binding by default.

\`\`\`
emit(text="Hello, \${NAME}!")
emit(text="\${ISSUES.totalCount} open showstoppers in \${PROJECT}")
\`\`\`

### \`notify(agent="...", message?, connectors?) -> ACK\` — mid-skill agent alert

Synchronous alert to a named agent via wired AgentConnector(s).
**Contrast with \`emit\`:** \`emit\` accumulates into end-of-skill bulk delivery
via the \`# Output: agent: <name>\` lifecycle hook; \`notify\` fires
mid-execution to interrupt or page an agent before the skill completes.

- \`agent\` — target agent id (required)
- \`message\` — alert body (optional; defaults to accumulated emissions so far)
- \`connectors\` — JSON array restricting which wired AgentConnector(s) receive
  the dispatch (optional; defaults to all that claim the target agent)
- \`event_type\` — adopter-defined routing label (optional; flows to \`DeliveryMeta.event_type\`; overrides \`# Event-type:\` frontmatter)
- \`correlation_id\` — reply-correlation id (optional; flows to \`DeliveryMeta.correlation_id\`; required for future \`exchange()\` / \`request_response()\` paths)

Returns ACK \`{agent, dispatched: [{connector, ok, error?}]}\` — fire-and-forget
callers ignore the binding; check-delivery callers inspect ACK.

\`\`\`
notify(agent="oncall", message="threshold breached at \${COUNT}")
notify(agent="reviewer", connectors=["slack"]) -> A
notify(agent="ops", message="911", event_type="ticket-911", correlation_id="\${INCIDENT_ID}")
\`\`\`

### \`shell(command="...", unsafe=true) [-> R]\` / \`shell(argv=[...]) [-> R]\` — local subprocess

Three forms:

1. **\`shell(command="...")\`** — structural spawn. The command string is whitespace-tokenized and quote-stripped, then one binary is spawned with the resulting tokens. No shell metacharacters, no pipes, no redirects. Quotes around each token ARE respected during tokenization (so \\\`"hello world"\\\` stays one token), but **quotes around a \\\`\${VAR}\\\` substitution do NOT reliably protect spaces in the substituted value** — they're fragile when the value contains quote characters or other tokenizer-special content. Use the argv form below when an arg may contain whitespace.

2. **\`shell(argv=["bin", "arg1", "\${VAR}", ...])\`** — explicit argv form. Each list element is exactly one argv token; no tokenization, no quote-stripping, no shell. \\\`\${VAR}\\\` substitutes per element and the result does NOT get re-split, so an arg with spaces stays one arg. Strictly safer than \`unsafe=true\` (no shell process; no metacharacter interpretation; injection-surface zero). **The right tool when an arg may contain whitespace, JSON payloads, or any dynamic content.**

3. **\`shell(command="...", unsafe=true)\`** — full bash interpretation. Tier-2 lint warns. Required for pipes, redirects, shell built-ins. Refused unless \`enable_unsafe_shell = true\` in runtime config.

\`\`\`
shell(command="git status --porcelain") -> STATUS                              # structural; safe for simple args
shell(argv=["say", "-v", "\${VOICE}", "-f", "\${PATH}"]) -> OUT                # argv; safe for args-with-spaces
shell(command="echo hi && date +%Y", unsafe=true) -> OUT                       # unsafe; for real shell features
\`\`\`

**Quote trap:** the structural \`command=\` tokenizer respects quotes during the *original* whitespace split — so \\\`'hello world'\\\` IS one token. But after \\\`\${VAR}\\\` substitution, if VAR contained quote characters (\\\`Jamie's\\\`) the quote-matching can drift. Pattern \\\`'\${VAR}'\\\` looks safe and works for simple values, but tier-2 lint \`shell-quoted-var-in-command\` flags it because the safer answer is \`argv=[...]\`. The mutex rule: \`argv=\` does not compose with \`command=\` or \`unsafe=true\` (it's an execv-class spawn — no shell to opt into).

**Container FS isolation:** shell() runs inside the runtime's container/sandbox. Writes to \`/tmp/x\` from \`shell(command="touch /tmp/x")\` land in the RUNTIME's \`/tmp/x\`, not on the author's host. Same isolation as \`file_read\` / \`file_write\` — cross-namespace work needs a known shared volume.

**Fallback trailer:** all three forms (\`command=\`, \`argv=\`, \`unsafe=true\`) accept \`(fallback: "value")\` after the \`-> R\` binding. The fallback fires when (a) the shell op throws (binary not on allowlist, spawn failure, timeout), or (b) the binary runs cleanly but produces empty stdout after trim. Matches the \`$\`-dispatch op-trailer semantics. Example: \`shell(argv=["gh","pr","list"]) -> PRS (fallback: "No current PRs.")\` — when the repo has no open PRs and \`gh\` writes nothing to stdout, PRS binds to the fallback cleanly instead of leaving downstream \`\${PRS}\` references as UnresolvedVariableError. The \`|fallback:\` template filter has the same empty-aware semantic — both fire on empty-string-after-trim / empty-array / null/undefined.

### \`file_read(path="...") -> R\` — read file contents

Reads via Node \`fs.readFile\`. Substitutes \`\${VAR}\` in the path. Optional \`(fallback: "...")\` trailer binds when read fails. **Container note:** when the runtime is sandboxed (Docker, container deployment), the runtime's filesystem is namespace-isolated from the author's host — \`/tmp/x\` in the skill maps to the runtime's \`/tmp/x\`, not the host's. Use absolute paths under a known shared volume for cross-namespace work.

\`\`\`
file_read(path="/var/reports/today.md") -> REPORT (fallback: "no report")
\`\`\`

### \`file_write(path="...", content="...", approved="...")\` — write file contents

Writes via Node \`fs.writeFile\`. Auto-creates parent directories. Substitutes \`\${VAR}\` in path + content. The \`approved="reason"\` kwarg authorizes the mutation per-op (any non-empty string; presence is what matters); skip when \`# Autonomous: true\` skill flag is declared. Same container FS-isolation caveat as \`file_read\` — the runtime's filesystem ≠ the author's.

\`\`\`
file_write(path="/var/reports/sweep-\${DATE}.md", content="\${REPORT}", approved="nightly cron deliverable")
\`\`\`

### \`inline(skill="...")\` — compile-time skill composition

References a \`# Type: data\` skill; the compiler inlines its emitted text at compile time so the compiled artifact is a single resolved document.

\`\`\`
inline(skill="common-prelude")
\`\`\`

### \`execute_skill(name="...", ...kwargs) -> R\` — runtime skill composition

Invokes another stored skill end-to-end against the runtime's connectors. Returns the child's execution record — \`outputs\` + \`transcript\` + \`errors\` + \`target_order\` + (filtered) \`final_vars\`. Access via \`\${R.outputs.text}\`, \`\${R.transcript}\`, \`\${R.final_vars.FIELD}\`, etc.

\`\`\`
execute_skill(name="extract-json-number", JSON_BLOB="\${RAW}", FIELD_PATH="total_count") -> RESULT
emit(text="Extracted: \${RESULT.outputs.text}")
\`\`\`

**Returns filter.** \`R.final_vars\` is filtered to the called skill's \`# Returns: X, Y, Z\` declaration. Skills without \`# Returns:\` declared export nothing from \`final_vars\` — the caller sees \`outputs\` + \`transcript\` + execution metadata, but no internal vars. Internal scratch (large JSON, intermediate computations, debug values) stays local to the child and never serializes into the caller's \`R\`. To expose a value for caller consumption, declare it in the called skill's \`# Returns:\` header.

\`name\` is the canonical kwarg, aligning with \`skill_read({name})\` / \`skill_write({name})\` / \`skill_status({name})\`. \`skill_name\` is accepted as a silent back-compat alias.

## Class 3: External MCP dispatch

\`\`\`
$ tool_name arg1=value1 arg2=value2 -> VAR [(fallback: "default")]
$ connector.tool_name args -> VAR
\`\`\`

Resolves the tool name against the adopter's \`connectors.json\`. Flat form (\`$ youtrack_search ...\`) uses the connector that owns the tool; dotted form (\`$ youtrack.search ...\`) routes explicitly. Fallback binds when dispatch errors. The substrate-specific shapes — LLM calls (\`$ llm\`), data queries (\`$ data_read\`), data writes (\`$ data_write\`), business tools — all use this dispatch.

**Kwarg value grammar.** Each \`key=value\` token follows a small literal grammar:

| Form | Example | Type |
|------|---------|------|
| Bare string | \`status=open\` | string \`"open"\` |
| Quoted string | \`query="hello world"\` | string \`"hello world"\` (use when value contains whitespace) |
| Integer | \`limit=10\` | number \`10\` |
| Boolean | \`urgent=true\` | boolean \`true\` |
| Null | \`assignee=null\` | null |
| JSON array | \`tags=["a","b"]\` | array \`["a","b"]\` |
| JSON object | \`payload={"k":"v"}\` | object \`{"k":"v"}\` |
| Substitution | \`id=\${BUG_ID}\` | resolved at dispatch time |
| Quoted substitution | \`query="\${QUERY}"\` | quoted resolution (recommended when value may contain whitespace) |
| Triple-quote multi-line | \`text="""prose body across\\nmultiple lines"""\` | string; spans newlines, embedded \`"\` allowed, common leading indent stripped (\`textwrap.dedent\` pattern), \`\${VAR}\` interpolation works the same as single-line |

**Lint warning** \`unquoted-substitution-in-kwarg-value\` fires when an unquoted \`\${VAR}\` sits in kwarg-value position and VAR's binding origin suggests whitespace. Wrap as \`key="\${VAR}"\` to prevent silent arg truncation if the resolved value contains spaces.

**Triple-quote dedent.** Authors writing multi-line bodies indented inside the call site (e.g., inside an \`emit(text=...)\` block) get the common leading whitespace stripped automatically. Leading and trailing whitespace-only lines are stripped too. Interior blank lines stay. The template looks like the output:

\`\`\`
deliver:
    emit(text="""
    Follow these directions exactly,
    step by step,
    without skipping any steps.
    """)
\`\`\`

renders as:

\`\`\`
Follow these directions exactly,
step by step,
without skipping any steps.
\`\`\`

**\`$ json_parse \${VAR} -> P\`** parses input as JSON and binds the structured value to \`P\`. Dotted descent via \`\${P.field}\` works in conditions and emit. Throws on malformed JSON (caught by \`else:\` / \`# OnError:\`).

\`\`\`
# Vars: PAYLOAD={"status":"ok","count":3}

read:
    $ json_parse \${PAYLOAD} -> P
    if \${P.status} == "ok" and \${P.count} > "0":
        emit(text="processing \${P.count} items")
\`\`\`

## Substrate-portable LLM + data dispatch

The canonical paths for LLM calls and data queries are MCP dispatch through adopter-wired connectors. Connector names are convention — \`llm\` / \`data_read\` / \`data_write\` are descriptive, but adopters wire whatever names match their substrate.

\`\`\`
$ llm prompt="Classify priority: \${ISSUE.summary}" -> VERDICT
$ data_read mode=fts query="recent incidents" limit=10 -> CONTEXT
$ data_write content="\${REPORT}" recipients=[oncall] tags=[morning-sweep] approved="cron deliverable" -> R
\`\`\`

**Bundled bridges + substrate config.** Default deployments auto-wire \`llm\` + \`data_read\` + \`data_write\` MCP connectors via bundled bridges — but **only when the underlying substrate is configured**. Base config: \`SqliteDataStore\` is wired conditionally (\`substrate.data_store: "sqlite"\`); \`LocalModel\` is \`null\` by default. To enable \`$ llm\`, set \`substrate.local_model: "ollama"\` in \`~/.skillscript/connectors.json\` (then restart the runtime host). To enable \`$ data_read\` / \`$ data_write\`, set \`substrate.data_store: "sqlite"\` (default value in the scaffold). The bridges: \`LocalModelMcpConnector\` over \`LocalModel\`; \`DataStoreMcpConnector\` over \`DataStore\` — same instance under both \`data_read\` + \`data_write\` names so query + write share substrate. Adopters with their own substrate impl wire it programmatically. See [\`docs/configuration.md\`](docs/configuration.md) for the substrate config reference.

**One canonical call surface per concern.** \`$ data_read\` is **the** data-retrieval call surface — one contract (\`mode=... query=... limit=N -> R\` returning \`{items: [...]}\` envelope), one connector name. Both bare-form (\`$ data_read ...\`) and dotted-form (\`$ data_read.query ...\`) dispatch through the same registered connector. Same shape for \`$ llm\` (\`prompt=... [maxTokens=N] [model="..."] -> R\` returns the response string; optional op-level \`timeout=N\` kwarg overrides skill-level \`# Timeout:\`; optional trailing \`(fallback: "...")\` fires on throw or empty bound value). \`$ llm\` and \`$ data_read\` are the canonical surfaces for LLM dispatch and data retrieval.

**Note on \`(fallback:)\` + envelope shapes.** The fallback fires on dispatch throw OR empty bound value — empty string (after trim), empty array, null/undefined. An envelope object like \`{items: []}\` is a **non-empty object** even when the contained array is empty, so the fallback does NOT fire. To handle envelope-empty downstream, either test the contained collection (\`if \${R.items|length} == "0":\`) or apply a filter (\`\${R.items|fallback:[]}\`). The \`object-iteration-advisory\` lint catches a related shape — \`foreach IT in \${R}\` against an envelope-shaped origin.

## Pipe filters

Apply on \`\${VAR|filter}\` references; chain left-to-right.

| Filter | Effect |
|---|---|
| \`url\` | encodeURIComponent |
| \`shell\` | POSIX single-quote escape |
| \`json\` | JSON.stringify |
| \`trim\` | Whitespace trim |
| \`length\` | Array element count or string char count |
| \`fallback:"X"\` | Coalesce-on-missing: when the upstream ref is unresolved, substitute literal \`X\` and continue the chain. Positional — \`\${VAR|fallback:"-"|upper}\` defaults-then-uppercases. |
| \`isodate\` | Format an epoch timestamp (ms or sec, auto-detected by magnitude) as ISO-8601. Passes already-ISO strings through unchanged. \`\${EVENT.fired_at_unix|isodate}\`. |
| \`contains:"X"\` | Boolean substring/membership check. Returns \`"true"\` on match, \`""\` on miss — use in conditionals: \`if \${R|contains:"urgent"}:\`. Type-aware: list LHS (or JSON-string-of-list) does element membership; string LHS does substring match. Mirrors \`if "X" in \${R}:\` semantics from the conditional grammar. |

**\`\${NOW}\` ambient ref** substitutes as an ISO-8601 string. Numeric epoch values remain available as \`\${EVENT.fired_at}\` (ms) and \`\${EVENT.fired_at_unix}\` (sec).

## Conditional grammar

\`\`\`
if \${VAR}:                            ← truthy check
if not \${VAR}:                        ← falsy check
if \${VAR} == "literal":               ← equality vs literal
if \${VAR} == \${OTHER}:                ← equality vs ref
if \${VAR} != "literal":               ← inequality
if \${N} < "10":                       ← numeric comparison
if \${N} >= \${THRESHOLD}:              ← numeric vs ref
if \${M.id} in \${SEEN}:                ← set membership
if \${M.id} not in \${SEEN}:
if \${A} == "ok" and \${B} == "ok":     ← logical AND
if \${A} == "urgent" or \${B} > "5":    ← logical OR
if not \${A} and (\${B} or \${C}):      ← compound with parens + not
\`\`\`

Branches via \`if:\` / \`elif COND:\` / \`else:\`. The \`else:\` after a target body is a separate error-handler block (distinguished by indentation scope).

### Compound conditions

\`and\` / \`or\` / \`not\` connect simple conditions into compound expressions:

- **Precedence** (tight → loose): comparison ops (\`==\`/\`<\`/etc.) > \`not\` > \`and\` > \`or\`
- **Parentheses** override precedence: \`(a or b) and c\`
- **Short-circuit evaluation**: AND skips RHS if LHS is false; OR skips RHS if LHS is true. Useful for the validate-then-access pattern — \`if \${X} == "ok" and \${X.field} ...\` won't error on the field access when \`\${X} == "ok"\` is false.

## Substitution form

Use \`\${VAR}\` for variable substitution. The bare-paren \`$(VAR)\` form still compiles with a tier-2 \`deprecated-substitution-shape\` warning; rewrite to \`\${VAR}\`.
`;

const FRONTMATTER = `# Frontmatter headers — full reference

Skill files open with \`# Key: value\` headers. Order isn't significant.

## Required

- \`# Skill: <name>\` — identity. Reserved keywords (\`default\`, \`needs\`, etc.) rejected.
- \`# Status: Draft | Approved v1:<token> | Disabled\` — lifecycle state. Approved status requires a stamped \`vN:<token>\` (e.g. \`Approved v1:a1b2c3d4\`); the dashboard's approval flow stamps it. Naked \`Approved\` (no token) refuses to execute. Only Approved+verified skills fire via triggers, MCP \`execute_skill\`, in-skill \`$ execute_skill\`, or compile-time \`inline(...)\`.

## Common

- \`# Description: <prose>\` — human-readable explanation; surfaces in dashboards.
- \`# Type: procedural | data\` — \`procedural\` (default) for runtime-fired skills; \`data\` for compile-time-inlined fragments referenced by \`inline(skill="...")\`.
- \`# Vars: NAME=default, OTHER\` — declared variables. \`NAME=default\` provides a default; bare \`NAME\` is required at invocation. Quoted defaults (\`NAME="hello world"\`) strip one matched layer of surrounding quotes at parse time — quoted-spaced values bind correctly; bare values bind unchanged.
- \`# Returns: X, Y, Z\` — declared export surface for \`execute_skill\` composition. Names that propagate from this skill's \`final_vars\` into the caller's bound \`R\`. Internal scratch vars NOT listed here stay local — never serialized into the caller's result. Skills without \`# Returns:\` export nothing from \`final_vars\` (outputs + transcript + metadata still flow). Symmetric with \`# Vars:\` (input surface ↔ output surface).
- \`# Triggers: cron: 0 9 * * *, event: my-event\` — autonomous-dispatch sources. Two primitives: \`cron\` (time-based) and \`event\` (HTTP POST \`/event\` ingress, named registration). Comma-separated entries split by source-keyword boundary; cron expressions with commas (\`30,45 9 * * 1-5\`) parse correctly.
- \`# Output: text | agent: <name> | template: <name> | file: path | none\` — output routing. Five kinds, all substrate-neutral. **Two substrate-neutral lifecycle hooks**: \`agent: <name>\` routes via AgentConnector as augment-kind delivery; \`template: <name>\` routes as template-kind delivery (receiving agent executes the rendered playbook). **Output content source**: if the skill has a body-text-as-output template (prose between frontmatter and first target), the rendered template populates the canonical output payload. Otherwise: agent/template kinds default to joined emissions; text/file kinds default to the last-bound variable value, falling back to the emissions array. Body template + emit() are complementary — template = canonical output, emit() = transcript. **For substrate-specific delivery destinations** (Slack, WhatsApp, Discord, pagerduty, custom dashboards, etc.) — that's contract-between-the-skill-and-the-substrate territory, downstream of the language. Two paths: (1) \`$ <connector>.<tool> ...\` inside the skill body to dispatch through an adopter-wired MCP connector, or (2) deliver via \`agent: <name>\` to an agent whose AgentConnector decides how to surface the result.
- \`# OnError: <fallback-skill-name>\` — error-handler skill invoked when an op fails and no target-level \`else:\` catches.
- \`# Autonomous: true | false\` — declarative authorship intent for unattended-execution skills (cron-fired, agent-fired, etc.). Silences \`unconfirmed-mutation\` lint warnings for the whole skill (since the user-confirmation pattern doesn't apply to autonomous skills); reserved as the canonical autonomous-skill category marker for future rules + scheduling defaults + discovery surfaces. Omitted = interactive (default).

## Augmenting / Template only

- \`# Event-type: <string>\` — adopter-defined routing vocabulary; flows to \`DeliveryMeta.event_type\` on lifecycle-hook deliveries as the frontmatter fallback. \`notify(event_type=...)\` kwarg takes precedence per-emit.
- \`# Templates: <skill_name>, <skill_name>\` — comma-separated Template-skill names referenced by this skill; validated for existence by \`unknown-template-reference\` lint.

(\`# Event-type:\` fires \`unused-augmenting-header\` lint warning if set on a Headless skill — one with no \`agent:\` or \`template:\` output declaration.)

## Output target resolution

For the \`agent:\` and \`template:\` kinds, the runtime resolves the target agent_id via a **2-level chain** (first match wins):

1. **Explicit name** — \`# Output: agent: oncall\` delivers to agent_id \`oncall\`.
2. **\`\${VAR}\` compile-time substitution** — \`# Output: agent: \${RECIPIENT}\` resolves against the resolved inputs map (\`# Vars:\` defaults, \`# Requires:\` cascade, caller-supplied \`inputs\`) at compile time. Only compile-time inputs resolve here — a runtime-bound ref (an op's \`-> VAR\` output, an ambient ref) passes through verbatim and fails at delivery if still unresolved.

There is **no** invocation-context inheritance and **no** runtime \`default_agent_id\` fallback: a skill must name its target explicitly or pass it as an input var.

## Capabilities + retrieval

- \`# Requires: <namespace>:<key> -> VAR (fallback: "value")\` — declares external input requirements. \`user-var:\` or \`system-var:\` namespaces. Cascades resolve at compile.
- \`# Requires: connector_type.feature_flag\` — capability-style requires (e.g., \`local_model.streaming\`); validated against \`runtime_capabilities\`.

## Performance

- \`# Timeout: <seconds>\` — skill-wide timeout. Falls back to per-op or runtime defaults.

## Trigger declaration forms

\`\`\`
# Triggers: cron: 30,45 9 * * 1-5
# Triggers: event: ticket-created
# Triggers: cron: 0 7 * * *, event: drift-detected
\`\`\`

Trigger sources: two primitives — \`cron\` (poll-based) and \`event\` (HTTP \`/event\` ingress with named registration; an external service POSTs to drive the skill). Anything substrate-coupled — session lifecycle, agent events, file-watch, sensors — is adapter responsibility: external code POSTs \`/event\` when relevant.

## Ambient variables (auto-populated by the runtime)

The runtime injects these refs — don't declare them in \`# Vars:\` / \`# Requires:\`.

| Ref | Source | Notes |
|---|---|---|
| \`$(NOW)\` | runtime clock | ISO-8601 timestamp at op-dispatch time |
| \`$(USER)\` | invocation context | Identity passed via \`agentId\` / CLI user |
| \`$(SESSION_CONTEXT)\` | runtime session | Free-form session snapshot for cross-skill carry |
| \`$(TRIGGER_TYPE)\` | scheduler | \`cron\` / \`event\` / \`webhook\` / \`agent\` / \`cli\` / \`dashboard\` / \`inline\` |
| \`$(TRIGGER_PAYLOAD)\` | scheduler | JSON-serializable payload attached to the firing trigger |
| \`$(ERROR_CONTEXT)\` | runtime error handler | Inside \`else:\` and \`# OnError:\` only; \`.kind\` / \`.message\` / \`.target\` accessible |

\`EVENT.*\` auto-populates on cron-fired skills:

| Ref | Value |
|---|---|
| \`$(EVENT.fired_at)\` | epoch milliseconds |
| \`$(EVENT.fired_at_unix)\` | epoch seconds |
| \`$(EVENT.fired_at_plus_1h_unix)\` | \`fired_at_unix + 3600\` |
| \`$(EVENT.fired_at_plus_1d_unix)\` | \`fired_at_unix + 86_400\` |
| \`$(EVENT.fired_at_plus_7d_unix)\` | \`fired_at_unix + 604_800\` |


## Variable reference forms

\`\`\`
$(VAR)              bare ref (any declared/output-bound/ambient name)
$(VAR.field)        dotted field access on JSON-bound vars + ambient family
$(LIST.0)           indexed access
$(LIST.0.id)        mixed indexed + field-access (chains arbitrarily deep)
$(VAR|filter)       filter pipe (see \`help({topic: "ops"})\` for filter list)
$(VAR.field|filter) field-access then filter
\`\`\`

Unresolved refs: tier-1 \`undeclared-var\` at compile, \`UnresolvedVariableError\` at runtime.
`;

const EXAMPLES = `# Five canonical worked skills

## 1. Minimal (single target, no dependencies)

\`\`\`
# Skill: hello
# Description: The canonical first-run example.
# Status: Approved
# Vars: WHO=world

Hello, \${WHO}!
Welcome to Skillscript.

greet:
    $set _ = "noop"

default: greet
\`\`\`

Demonstrates: required headers, variable defaults, body-text-as-output template with \`\${VAR}\` substitution. No \`emit()\` ceremony needed for fixed-shape output — the body prose IS the output. Compare with example #5 below, which uses \`emit()\` per-item for variable-cardinality output (\`foreach\`-based).

## 2. Cron-fired numeric threshold + count

\`\`\`
# Skill: queue-length-monitor
# Description: Count pending items in a queue and alert when the count exceeds threshold
# Status: Approved
# Autonomous: true
# Vars: QUEUE_PATH=/var/queue/pending.json, THRESHOLD=10
# Triggers: cron: */5 * * * *

fetch:
    file_read(path="\${QUEUE_PATH}") -> ITEMS_JSON (fallback: "[]")
    $ json_parse \${ITEMS_JSON} -> ITEMS

evaluate:
    needs: fetch
    if \${ITEMS|length} > \${THRESHOLD}:
        emit(text="Queue backlog: \${ITEMS|length} items pending (threshold \${THRESHOLD}). Action required.")
    else:
        emit(text="Queue healthy: \${ITEMS|length} items pending (under \${THRESHOLD}).")

default: evaluate
\`\`\`

Demonstrates: \`# Triggers:\` cron, \`# Autonomous: true\` for unattended skills, \`file_read\` with fallback, \`$ json_parse\` for structured parsing, \`needs:\` body-line dep, numeric comparison, \`|length\` filter, \`if\` / \`else\`.

## 3. LLM branching with agent delivery

\`\`\`
# Skill: classify-support-ticket
# Description: Classify an incoming ticket by urgency and route to oncall when severe
# Status: Approved
# Vars: TICKET_BODY
# Event-type: ticket-triage-urgent
# Templates: ticket-assignment-procedure
# Output: agent: oncall

classify:
    $ llm prompt="Classify this support ticket as one of: 'critical', 'normal', 'low'. Reply with only the label. Ticket: \${TICKET_BODY}" -> VERDICT

route: classify
    if \${VERDICT|trim} == "critical":
        emit(text="CRITICAL ticket needs immediate attention:")
        emit(text="\${TICKET_BODY}")
    elif \${VERDICT|trim} == "normal":
        emit(text="Normal-priority ticket queued.")
    else:
        emit(text="Low-priority ticket logged.")

default: route
\`\`\`

Demonstrates: \`$ llm\` MCP dispatch (substrate-portable — adopter wires their LLM substrate under the \`llm\` connector name), \`|trim\` filter on LLM output, ref-vs-literal comparison, agent delivery via \`agent:\` lifecycle hook, augmenting headers (\`# Event-type:\` + \`# Templates:\`).

## 4. Composition — orchestrator invoking child skills

\`\`\`
# Skill: morning-brief-orchestrator
# Description: Fan out to three child skills, gather their outputs into one brief.
# Status: Approved
# Vars: USER_NAME=Scott

gather:
    execute_skill(skill_name="calendar-today", USER="\${USER_NAME}") -> CAL (fallback: "(no calendar data)")
    execute_skill(skill_name="mailbox-triage", USER="\${USER_NAME}") -> MAIL (fallback: "(mailbox empty)")
    execute_skill(skill_name="weather-summary") -> WX (fallback: "(weather unavailable)")

render: gather
    emit(text="Good morning, \${USER_NAME}. Today:")
    emit(text="• Calendar: \${CAL}")
    emit(text="• Mailbox: \${MAIL}")
    emit(text="• Weather: \${WX}")

default: render
\`\`\`

Demonstrates: \`execute_skill(...)\` runtime composition (each child runs through the runtime under a depth-counted chain), per-call \`(fallback: ...)\` for resilience, kwarg forwarding, \`->\` binding child output for downstream reference.

## 5. Dedup-by-id with the accumulator

\`\`\`
# Skill: dedup-walk
# Description: Walk a result list, skip items whose id was already seen.
# Status: Approved
# Vars: TOPIC=infrastructure

walk:
    $ data_read mode=topical query="\${TOPIC}" limit=50 -> CANDIDATES
    $set SEEN = []
    foreach C in \${CANDIDATES.items}:
        if \${C.id} not in \${SEEN}:
            $append SEEN \${C.id}
            emit(text="NEW: \${C.id} — \${C.summary}")
        else:
            emit(text="dup: \${C.id}")
    emit(text="Total novel items: \${SEEN|length}")

default: walk
\`\`\`

Demonstrates: \`$ data_read\` MCP dispatch (substrate-portable data query), \`$append\` accumulator pattern, \`$set SEEN = []\` init at the target body (before the foreach) so mutations persist across iterations, \`not in\` membership check against the accumulating list, \`|length\` filter on the final collected list. **Note** — most MCP data-query tools wrap the array in an envelope object (e.g., \`{items: [...], hasNextPage}\`); the example assumes \`.items\` is the array field. Check your tool's response shape; tier-3 \`object-iteration-advisory\` lint helps when you forget the field accessor.

## Triggered cron deliverable — data handoff

\`\`\`
# Skill: morning-showstopper-sweep
# Description: Cron pre-triage; delivers triaged showstoppers to oncall via the agent: lifecycle hook
# Status: Approved
# Autonomous: true
# Vars: PROJECT=INFRA
# Triggers: cron: 0 8 * * MON-FRI
# Output: agent: oncall

run:
    $ ticketing_search query="project:\${PROJECT} severity:showstopper state:Open" limit=20 -> ISSUES

    emit(text="Morning showstoppers for \${PROJECT} — \${ISSUES.totalCount} open:")
    foreach ISSUE in \${ISSUES.items}:
        $ llm prompt="Two-line triage hypothesis for: \${ISSUE.summary}" -> ANALYSIS
        emit(text="")
        emit(text="## \${ISSUE.id}: \${ISSUE.summary}")
        emit(text="\${ANALYSIS}")

default: run
\`\`\`

Demonstrates: end-to-end trigger → process → deliver pattern. Trigger fires cron; process pulls data + sub-classifies each issue with \`$ llm\`; delivers via the \`agent:\` lifecycle hook (each \`emit(text=...)\` becomes a line in the joined-emissions delivery to the named agent).

## 6. Data durable-handoff (substrate-portable write)

\`\`\`
# Skill: research-and-handoff
# Description: Run a query through the LLM, persist the result as a memory for the receiver to pick up
# Status: Approved
# Vars: QUERY=incident triage best practices

go:
    $ llm prompt="\${QUERY}" -> ANSWER
    $ data_write content="\${ANSWER}" recipients=[researcher] domain_tags=[incident, handoff] -> ACK
    emit(text="memory written; receipt \${ACK.id}")

default: go
\`\`\`

Demonstrates: \`$ data_write\` substrate-portable durable handoff (returns \`{id, created_at}\` envelope). \`recipients=[...]\` is the bracket-array literal form — the receiving agent's mailbox surfaces this on their next session check.

## 7. File output with confirmed write

\`\`\`
# Skill: triage-report
# Description: Build a markdown report and write to disk

build:
    $ ticketing_search query="severity:critical" limit=10 -> ISSUES
    $set REPORT = "# Critical issues\\n\\n"
    foreach I in \${ISSUES.items}:
        $append REPORT <"- \${I.id}: \${I.summary}\\n">
    file_write(path="/tmp/triage-\${EVENT.fired_at_unix}.md", content="\${REPORT}")
    emit(text="report built")

default: build
\`\`\`

Demonstrates: \`$append\` accumulator over a string + \`file_write\` side effect. The runtime emits a \`[file_write] wrote N bytes to <path>\` transcript line on success so the caller can confirm the write landed.

## Per-substrate return-shape note

Different connectors return different envelope shapes. Cold authors authoring against multiple substrates should expect:

- **Ticketing-style** (\`$ ticketing_search\`): returns \`{items: [...], totalCount, hasNextPage, ...}\` — \`.items\` is the array; \`.totalCount\` is the count.
- **Data query** (\`$ data_read\`): returns \`{items: [...]}\` envelope — \`.items\` is the array of records.
- **Data write** (\`$ data_write\`): returns \`{id, created_at}\` — \`.id\` is the new record's UUID.
- **LLM** (\`$ llm\`): returns the response string directly (no envelope).
- **File read** (\`file_read(path=...) -> R\`): binds the file content string to R.

Don't assume \`.totalCount\` exists on every envelope — it's a ticketing convention, not a universal one. Use the runtime's \`runtime_capabilities()\` + introspection to confirm shapes when in doubt.

**Array length:** to get the count of an array bound from a substrate query (e.g., \`\${ITEMS.items}\` is the array), use the **\`|length\` filter**: \`\${ITEMS.items|length}\`. The JS convention \`\${ITEMS.items.length}\` does NOT work — skillscript's dotted-ref resolver does string-keyed property descent and \`.length\` on an array returns undefined at substitution time. Filter syntax is canonical for collection-shape operations across all substrates.
`;

const COMPOSITION = `# Composition — composing skills from other skills

Skillscript has two composition primitives. Both let one skill draw on another's output, with different semantics around when the child runs.

## 1. \`inline(skill="<name>")\` — compile-time data-skill inline

Inlines an *Approved data skill* into the host skill's compiled artifact at the call site. The data skill's body becomes part of the rendered prompt. Use for *static* knowledge or templated content (style guides, voice rules, runbooks).

\`\`\`
brief:
    $ llm prompt="\${VOICE_RULES} Now write a one-line status:" -> RESULT
    inline(skill="voice-rules")
\`\`\`

- Resolved at \`compile()\` time — the data skill's \`content_hash\` is recorded in the host's provenance block.
- Provenance lets \`skillfile audit\` detect stale recompiles when a referenced data skill changes.
- The data skill must be marked \`# Type: data\` (or live in a path the SkillStore recognizes as data); otherwise it's treated as procedural and won't inline.

## 2. \`execute_skill(name="<child>", ...kwargs) -> R\` — runtime invocation

The general composition form: the host calls another skill at runtime, capturing its full execution record. Same depth-counted chain (default 5) as the recursion guard.

\`\`\`
gather:
    execute_skill(skill_name="calendar-today", USER="\${USER_NAME}") -> CAL (fallback: "(no calendar data)")
    execute_skill(skill_name="mailbox-triage", inputs={"USER": "\${USER_NAME}"}) -> MAIL
\`\`\`

Two kwarg-forwarding styles, both supported:
- **Bare kwargs** — \`USER="\${USER_NAME}"\` natural skill grammar
- **\`inputs={...}\` JSON** — useful when forwarding many fields verbatim

The bound \`-> R\` carries the child's execution record into the host's scope:
- \`\${R.outputs.text}\` — the joined emission stream (the canonical accessor, what 100% of composers reach for)
- \`\${R.transcript}\` — array of individual emit lines
- \`\${R.final_vars.FIELD}\` — the child's declared exports (see \`# Returns:\` below)
- \`\${R.errors}\`, \`\${R.target_order}\` — execution metadata

**Declaring what gets exported.** The child skill controls what's visible to the caller via its \`# Returns: X, Y, Z\` frontmatter header. Internal scratch (large JSON, intermediate computations) stays local; only declared names propagate into \`R.final_vars\`. Skills without \`# Returns:\` export nothing from \`final_vars\` — outputs + transcript + metadata still flow.

\`\`\`
# Skill: get-weather
# Vars: LOCATION=Valdese
# Returns: SUMMARY, TEMP_F

fetch:
    shell(command="curl -s 'wttr.in/\${LOCATION|url}?format=j1'") -> RAW
    $ json_parse \${RAW} -> PARSED

shape: fetch
    $set TEMP_F = \${PARSED.current_condition.0.temp_F}
    $set SUMMARY = "\${LOCATION}: \${TEMP_F}°F"
    emit(text="\${SUMMARY}")
default: shape
\`\`\`

Caller binding \`-> R\` sees \`R.final_vars = {SUMMARY, TEMP_F}\` — NOT \`RAW\` or \`PARSED\` (internal scratch, filtered out by the Returns surface). Closes the "skills are functions; declare what you return" contract: internal state stays internal.

Lint \`unknown-returns-ref\` (tier-1) catches names declared in \`# Returns:\` that aren't bound anywhere in the skill body.

## Limits & lint signals

- **Recursion**: depth-5 chain by default (\`ExecuteSkillRecursionError\` if exceeded).
- **Lint** (\`unknown-skill-reference\`, tier-2): both \`inline(skill="<name>")\` and \`execute_skill(skill_name="<name>", ...)\` validate the child exists in the SkillStore at compile time. Forward references are allowed: missing skills lint as warning (not error), runtime throws \`MissingSkillReferenceError\` if still unresolved at execute. Tier-3 \`deferred-skill-reference\` advisory confirms when the deferred-resolution path is engaged.
- **Lint** (\`disabled-skill-reference\`, tier-1): any composition primitive pointing at a \`# Status: Disabled\` skill blocks compile.

## When to use which

| Use case | Primitive |
|---|---|
| Static knowledge in a prompt | \`inline(skill="<data-skill>")\` |
| Child output bound into parent scope | \`execute_skill(skill_name="<skill>", ...) -> R\` |

See \`help({topic: "examples"})\` example 4 for a worked orchestrator skill.
`;

const CONNECTORS_PROLOGUE = `# Connectors

Skillscript skills don't import packages — they invoke connectors. The runtime resolves dispatches through a typed registry of five contracts:

| Contract | Purpose | Op surface |
|---|---|---|
| \`SkillStore\` | Skill source persistence + status lifecycle | implicit (\`inline\` / \`execute_skill\` reference) |
| \`LocalModel\` | LLM inference | \`$ llm\` MCP dispatch via \`LocalModelMcpConnector\` bridge — auto-wired when \`substrate.local_model\` is set in \`connectors.json\`. Default: off. |
| \`DataStore\` | Data persistence + query | \`$ data_read\` MCP dispatch via \`DataStoreMcpConnector\` bridge — auto-wired when \`substrate.data_store\` is set (default scaffold: \`"sqlite"\`). |
| \`McpConnector\` | MCP tool dispatch — all external tools | \`$ <connector_name> args\` |
| \`AgentConnector\` | Deliver augment/template payloads | \`# Output: agent:\` / \`template:\` |

**Substrate framing.** Canonical syntax routes substrate-specific dispatch through MCP (\`$ llm\` / \`$ data_read\`). Runtime hosts (MCP server + web dashboard) honor whichever substrate the deployment configures via \`~/.skillscript/connectors.json\`:

\`\`\`json
{
  "substrate": {
    "skill_store": "filesystem",
    "data_store": "sqlite",
    "local_model": "ollama"
  }
}
\`\`\`

Short-form (\`"sqlite"\`, \`"ollama"\`, \`"filesystem"\`, \`null\`) wires bundled defaults. Object form (\`{type, config}\`) overrides config. Adopters with custom substrate impls (AMP, Pinecone, etc.) write a programmatic bootstrap. Authoring CLI commands (\`skillfile compile\` / \`lint\` / \`audit\` / \`list\`) stay filesystem-pinned regardless. See \`docs/configuration.md\`.

**Cold-author footgun.** \`$ llm\` errors with \`No \`llm\` connector wired. Set \`substrate.local_model: 'ollama'\` in connectors.json...\` when the substrate slot is null. Same for \`$ data_read\` / \`$ data_write\` against null \`substrate.data_store\`. The error message points at the right config knob — no need to dig through API docs.

**Adopter-extensible class registration.** Custom \`McpConnector\` classes that are JSON-instantiable register via \`registerConnectorClass(name, entry)\` from adopter bootstrap before \`loadConnectorsConfig\` runs. See \`examples/custom-bootstrap.example.ts\`.

**Canonical runtime config.** \`skillscript.config.json\` externalizes runtime knobs (skillsDir, traceDir, dashboard port, etc.) so the two-instance posture (dev + adopter on same machine) works as copy-and-tweak. CLI flags override file values; file values override defaults. See \`skillscript.config.json.example\`.

**One canonical call surface per concern.** \`$ data_read\` is **the** data-retrieval call surface — one contract (\`mode=... query=... limit=N -> R\` returning \`{items: [...]}\` envelope), one connector name. Both bare-form (\`$ data_read ...\`) and dotted-form (\`$ data_read.query ...\`) dispatch through the same registered connector. Same shape for \`$ llm\` (\`prompt=... [maxTokens=N] [model="..."] -> R\` returns the response string; optional op-level \`timeout=N\` kwarg overrides skill-level \`# Timeout:\`; optional trailing \`(fallback: "...")\` fires on throw or empty bound value). \`$ llm\` and \`$ data_read\` are the canonical surfaces for LLM dispatch and data retrieval.

**Note on \`(fallback:)\` + envelope shapes.** The fallback fires on dispatch throw OR empty bound value — empty string (after trim), empty array, null/undefined. An envelope object like \`{items: []}\` is a **non-empty object** even when the contained array is empty, so the fallback does NOT fire. To handle envelope-empty downstream, either test the contained collection (\`if \${R.items|length} == "0":\`) or apply a filter (\`\${R.items|fallback:[]}\`). The \`object-iteration-advisory\` lint catches a related shape — \`foreach IT in \${R}\` against an envelope-shaped origin.

**Return shapes are tool-native.** External tools return whatever shape they natively return; the language doesn't normalize. Some tools return a **structured envelope** (e.g., \`$ youtrack.search_issues -> R\` → \`R.issuesPage[]\`); some return **pre-formatted text** (e.g., \`$ ddg.search -> R\` → a search-results text blob). Bind and inspect — via \`runtime_capabilities()\` advertised schema, a probe-run trace, or a \`compile_skill\` preview — before writing \`\${R.field}\` or \`foreach IT in \${R.results}\`. Mistaking a text-blob return for a structured envelope is the canonical cold-author trap.

## Discovery

\`runtime_capabilities()\` reports the live picture: which connectors are registered, which feature flags they advertise, and which named instances exist (e.g., \`default\` / \`qwen\` LocalModels, \`youtrack\` McpConnector).

For shell execution (\`shell(...)\` op), \`runtime_capabilities\` also reports \`shellExecution.mode\` (\`"structural-spawn"\`) and \`shellExecution.unsafe_enabled\` (whether \`shell(command=..., unsafe=true)\` is permitted in this deployment).

## Container filesystem isolation

When the runtime is sandboxed (Docker container, deployed VM, etc.), the runtime's filesystem is namespace-isolated from the author's host. \`file_read("/tmp/x")\` and \`file_write(path="/tmp/x", ...)\` operate on the *runtime's* \`/tmp\`, not the host's. For cross-namespace work, use a known shared volume path or expose the file via a mount point both sides see.
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
- \`unsafe-shell-disabled\` — \`shell(command=..., unsafe=true)\` declared but \`enableUnsafeShell: false\` on the runtime (fires only when caller passes the flag explicitly false)
- \`uninitialized-append\` — \`$append VAR ...\` where VAR has no \`$set\` or \`# Vars:\` init in any enclosing scope
- \`foreach-local-accumulator-target\` — \`$append VAR ...\` where the matching \`$set VAR = []\` is in the same scope as the append (typically same foreach body — would silently lose data each iter)
- \`append-to-non-list\` — \`$append VAR ...\` where VAR's static init is a non-list value (list-only)

## Tier-2 (warning)

- \`deprecated-question\` — bare \`?\` op (deprecated; compile-error path)
- \`deprecated-substitution-shape\` — \`$(VAR)\` substitution form compiles but warns; rewrite to \`\${VAR}\`.
- \`unsafe-shell-ambiguous-subst\` — \`$(NAME)\` inside \`shell(command=..., unsafe=true)\` body that isn't a declared variable; collides with bash command-sub syntax
- \`unsafe-shell-op\` — \`shell(command=..., unsafe=true)\` present; requires human review every time
- \`unknown-skill-reference\` — \`inline(skill="...")\` or \`execute_skill(name="...")\` references a skill not in the store (tier-2; runtime throws \`MissingSkillReferenceError\` if still unresolved at execute)
- \`unknown-template-reference\` — \`# Templates: <name>\` references a skill not in the store
- \`unconfirmed-mutation\` — mutation-class op (\`$\` tool with mutating-name shape, \`$ data_write\`, \`file_write(...)\`) runs without authorization. Accepts the captured \`approved="reason"\` per-op kwarg as authorization (any non-empty string; presence is what matters). Silent when the skill declares \`# Autonomous: true\` (the autonomous-skill category exempts the rule since the user-confirmation pattern doesn't apply to unattended-execution skills).
- \`model-contention\` — async + sync ops on the same model serialize on a single runtime worker
- \`draft-with-trigger\` — \`# Status: Draft\` skill has \`# Triggers:\` declared; triggers won't fire until Approved
- \`reference-to-disabled-skill\` — \`&\` op references a Disabled skill (also tier-1 in some contexts)
- \`unused-augmenting-header\` — \`# Event-type:\` set on a skill with no agent-bound output

## Tier-3 (info)

- \`no-default-target\` — no \`default:\` declaration (relevant for data skills only; procedural skills hit tier-1)
- \`duplicate-skill-name\` — name collides with an existing stored skill
- \`plugin-collision\` — placeholder for future plugin-loader name conflicts
- \`deferred-skill-reference\` — composition ref (\`inline\` / \`$ execute_skill\` / \`# Templates:\`) targets a skill not currently in the SkillStore; resolution deferred to execute time. Confirms the forward-reference path is engaged; clears once the target is stored.
- \`unparsed-json-field-access\` — op text contains \`$(VAR|json_parse).field\`; the \`|json_parse\` filter is no longer supported. Use \`$ json_parse $(VAR) -> P\` then \`$(P.field)\`.
- \`object-iteration-advisory\` — \`foreach IT in \${VAR}\` iterates a bound variable whose origin is a \`$\` MCP tool output, without a \`.field\` accessor. MCP tools commonly wrap arrays in an envelope object (\`.items\`, \`.results\`, \`.issuesPage\`, \`.data\`, \`.records\`). Check the tool's response shape; rewrite as \`foreach IT in \${VAR.items}\` (or the correct field).
- \`disallowed-tool\` (tier-1) — \`$ name.tool\` references a tool not in the connector's \`allowed_tools\` allowlist. Either rewrite the skill to use a permitted tool or update \`connectors.json\` to grant access. Runtime defense-in-depth refuses disallowed dispatch even if lint is bypassed.

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
  const ms = registry.listDataStores();
  const lm = registry.listLocalModels();
  const mc = registry.listMcpConnectors();
  const ac = registry.listAgentConnectors();
  summary.push(`- SkillStores: ${ss.length === 0 ? "(none)" : ss.map((e) => `${e.name} (${e.ctor.name})`).join(", ")}`);
  summary.push(`- DataStores: ${ms.length === 0 ? "(none)" : ms.map((e) => `${e.name} (${e.ctor.name})`).join(", ")}`);
  summary.push(`- LocalModels: ${lm.length === 0 ? "(none)" : lm.map((e) => e.name).join(", ")}`);
  summary.push(`- McpConnectors: ${mc.length === 0 ? "(none)" : mc.map((e) => `${e.name} (${e.ctor.name})`).join(", ")}`);
  summary.push(`- AgentConnectors: ${ac.length === 0 ? "(none — defaults to NoOp)" : ac.map((e) => `${e.name} (${e.ctor.name})`).join(", ")}`);
  return CONNECTORS_PROLOGUE + summary.join("\n");
}
