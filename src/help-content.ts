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

const QUICKSTART = `# Skillscript — quickstart (v0.7.0+ canonical surface)

Skillscript is a declarative language for authoring agent workflows. A
skill is a small program with named targets composed of typed ops. The
runtime walks dependencies backward from the goal target (declared via
\`default:\`) and dispatches each op in topological order.

## 1. The skill model — trigger → process → deliver

Every skill follows the same shape:

1. **Trigger fires** — cron, command, event, session-start, or programmatic invocation
2. **Process** — pull data (MCP / memory / file), classify / compose via sub-LLM + iteration, build the deliverable
3. **Deliver** — via one or more of three channels

The three delivery channels are all first-class:

| Channel | Op | When you'd use it |
|---|---|---|
| **Embedded prompt** | \`emit(text="...")\` | Skill output is delivered to the receiving agent via the \`# Output: agent: <name>\` lifecycle hook |
| **File handoff** | \`file_write(path="...", content="...")\` | Skill writes a file at a known location for the agent to read |
| **Memory handoff** | \`$ memory_write content="..." recipients=["agent"] -> R\` | Skill writes a memory the target agent picks up via mailbox. Routes through the wired \`memory_write\` connector (default: \`MemoryStoreMcpConnector\` bundled in v0.8.0+). |

## 2. The three op classes

| Class | Shape | Examples |
|---|---|---|
| **Mutation statements** | \`$verb VAR = value\` / \`$verb VAR <value>\` | \`$set NAME = "Scott"\`, \`$append LIST <item>\` |
| **Runtime-intrinsic function-calls** | \`verb(kwarg=value, ...) [-> BINDING]\` | \`emit(text="...")\`, \`ask(prompt="...") -> R\`, \`inline(skill="...")\`, \`execute_skill(skill_name="...") -> R\`, \`shell(command="...") -> R\`, \`file_read(path="...") -> R\`, \`file_write(path="...", content="...")\` |
| **External MCP dispatch** | \`$ <connector> kwarg=value, ... [-> BINDING]\` | \`$ youtrack_search query="..." -> R\`, \`$ llm prompt="..." -> R\`, \`$ memory mode=fts query="..." -> R\` |

The \`$\` prefix marks **state-affecting ops** (mutation OR external dispatch). Function-call shape marks **language-intrinsic ops the runtime knows directly**.

**Bare vs. dotted form.** \`$ <name> kwargs\` (bare) routes via name-match to the connector named \`<name>\` — the most common shape. \`$ <connector>.<tool> kwargs\` (dotted) routes explicitly when multiple connectors expose the same tool, or to pick a specific instance. Example: \`$ slack_eng.post channel="general" text="..."\` vs \`$ slack_marketing.post channel="general" text="..."\` — the dotted form is the disambiguator.

## 3. Shape of a skill file

\`\`\`
# Skill: my-skill                      ← required: skill name
# Description: What this skill does    ← optional but recommended
# Status: Approved                     ← required: Draft | Approved | Disabled
# Vars: NAME=default-value, OTHER      ← optional: declared variables
# Triggers: cron: 0 9 * * *            ← optional: autonomous-dispatch sources

target_a:                              ← a named block of ops
    $ ticketing_search query="state:open" -> ISSUES
    $ llm prompt="Summarize: \${ISSUES}" -> SUMMARY

target_b: target_a                     ← Make-style: target_b depends on target_a
    emit(text="\${SUMMARY}")

default: target_b                      ← goal target the runtime walks toward
\`\`\`

## 4. Variable substitution

Use \`\${VAR}\` (canonical) inside any kwarg value or emit body. Field access works: \`\${ISSUE.title}\`. Filter chains: \`\${VAR|trim|length}\`. Missing-value fallback: \`\${VAR|fallback:"-"}\`.

The legacy \`$(VAR)\` form still compiles during the v0.7.x grace period (tier-2 \`deprecated-substitution-shape\` warning); tier-1 promotion in v0.8/v0.9.

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

## 8. How to see what's broken

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

**Note on legacy syntax.** Legacy symbol-form ops (\`~\`, \`>\`, \`@\`, \`!\`, \`??\`, \`&\`) and \`$(VAR)\` substitution continue to compile during the v0.7.x grace period with tier-2 deprecation warnings. CHANGELOG.md \`## 0.7.0 — Migration\` documents the rewrite rules.
`;

const OPS = `# Ops reference — v0.7.0 canonical surface

Three op classes, two grammars:

| Class | Shape | When you reach for it |
|---|---|---|
| **Mutation statements** | \`$verb VAR = value\` / \`$verb VAR <value>\` | Bind / mutate a named variable in scope |
| **Runtime-intrinsic function-calls** | \`verb(kwarg=value, ...) [-> BINDING]\` | Language-intrinsic side-effects: emit, ask, file I/O, shell, composition |
| **External MCP dispatch** | \`$ <connector> kwarg=value, ... [-> BINDING]\` | Any tool resolved through \`connectors.json\` (LLM calls, memory queries, business tools) |

The \`$\` prefix marks **state-affecting** ops (mutation OR external dispatch). Function-call shape marks **language-intrinsic** ops the runtime knows directly. Legacy symbol forms (\`~\` / \`>\` / \`@\` / \`!\` / \`??\` / \`&\`) compile during the v0.7.x grace period with tier-2 \`deprecated-symbol-op\` warnings.

## Class 1: Mutation statements

### \`$set VAR = value\`

Bind a variable; runtime resolves \`\${REF}\` substitutions in the RHS at bind time (v0.5.0). Value can be a literal, a \`\${REF}\` interpolation, or a JSON literal (object / array / bool / null).

\`\`\`
$set GREETING = "Hello, \${USER}!"
$set ITEMS = []
$set CONFIG = {"timeout": 30, "retries": 3}
\`\`\`

### \`$append VAR <value>\`

Append to a binding. v0.5.0 type-dispatches on the existing target:
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

Closed set: \`emit\`, \`notify\`, \`ask\`, \`inline\`, \`execute_skill\`, \`shell\`, \`file_read\`, \`file_write\`. Unknown function-call names fire \`unknown-runtime-op\` tier-1 with remediation "if this is an MCP tool, use \`$ tool args -> R\` shape instead."

### \`emit(text="...")\` — output to skill consumer

One-line emission. \`\${VAR}\` substitutes. No result binding by default.

\`\`\`
emit(text="Hello, \${NAME}!")
emit(text="\${ISSUES.totalCount} open showstoppers in \${PROJECT}")
\`\`\`

### \`notify(agent="...", message?, connectors?) -> ACK\` — mid-skill agent alert

Synchronous alert to a named agent via wired AgentConnector(s). v0.8.0 op.
**Contrast with \`emit\`:** \`emit\` accumulates into end-of-skill bulk delivery
via the \`# Output: agent: <name>\` lifecycle hook; \`notify\` fires
mid-execution to interrupt or page an agent before the skill completes.

- \`agent\` — target agent id (required)
- \`message\` — alert body (optional; defaults to accumulated emissions so far)
- \`connectors\` — JSON array restricting which wired AgentConnector(s) receive
  the dispatch (optional; defaults to all that claim the target agent)

Returns ACK \`{agent, dispatched: [{connector, ok, error?}]}\` — fire-and-forget
callers ignore the binding; check-delivery callers inspect ACK.

\`\`\`
notify(agent="oncall", message="threshold breached at \${COUNT}")
notify(agent="reviewer", connectors=["slack"]) -> A
\`\`\`

### \`ask(prompt="...") -> R\` — prompt the user

Interactive only. Autonomous-mode dispatch fails with a clean error (use \`# Autonomous: true\` skill flag to disable the gate).

\`\`\`
ask(prompt="Proceed with auto-assignment for P0/P1?") -> APPROVAL
\`\`\`

### \`shell(command="...", unsafe=true) [-> R]\` — local subprocess

Default mode: structural spawn — one binary, no shell metacharacters, no pipes/redirects. \`unsafe=true\` opts into full bash; tier-2 lint warns.

\`\`\`
shell(command="git status --porcelain") -> STATUS
shell(command="echo hi && date +%Y", unsafe=true) -> OUT
\`\`\`

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

### \`execute_skill(skill_name="...", ...kwargs) -> R\` — runtime skill composition

Invokes another stored skill end-to-end against the runtime's connectors. Returns the full execution record (final vars, transcript, outputs). Access via \`\${R.final_vars.FIELD}\`, \`\${R.transcript}\`, etc.

\`\`\`
execute_skill(skill_name="extract-json-number", JSON_BLOB="\${RAW}", FIELD_PATH="total_count") -> RESULT
emit(text="Extracted: \${RESULT.final_vars.VALUE|trim}")
\`\`\`

## Class 3: External MCP dispatch

\`\`\`
$ tool_name arg1=value1 arg2=value2 -> VAR [(fallback: "default")]
$ connector.tool_name args -> VAR
\`\`\`

Resolves the tool name against the adopter's \`connectors.json\`. Flat form (\`$ youtrack_search ...\`) uses the connector that owns the tool; dotted form (\`$ youtrack.search ...\`) routes explicitly. Fallback binds when dispatch errors. The substrate-specific shapes — LLM calls (\`$ llm\`), memory queries (\`$ memory\`), memory writes (\`$ memory_write\`), business tools — all use this dispatch.

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

**v0.5.0 lint warning** \`unquoted-substitution-in-kwarg-value\` fires when an unquoted \`\${VAR}\` sits in kwarg-value position and VAR's binding origin suggests whitespace. Wrap as \`key="\${VAR}"\` to prevent silent arg truncation if the resolved value contains spaces.

**\`$ json_parse \${VAR} -> P\`** (v0.3.3) parses input as JSON and binds the structured value to \`P\`. Dotted descent via \`\${P.field}\` works in conditions and emit. Throws on malformed JSON (caught by \`else:\` / \`# OnError:\`).

\`\`\`
# Vars: PAYLOAD={"status":"ok","count":3}

read:
    $ json_parse \${PAYLOAD} -> P
    if \${P.status} == "ok" and \${P.count} > "0":
        emit(text="processing \${P.count} items")
\`\`\`

## Substrate-portable LLM + memory dispatch

The canonical paths for LLM calls and memory queries are MCP dispatch through adopter-wired connectors. Connector names are convention — \`llm\` / \`memory\` / \`memory_write\` are descriptive, but adopters wire whatever names match their substrate.

\`\`\`
$ llm prompt="Classify priority: \${ISSUE.summary}" -> VERDICT
$ memory mode=fts query="recent incidents" limit=10 -> CONTEXT
$ memory_write content="\${REPORT}" addressed_to="oncall" tags="morning-sweep" approved="cron deliverable" -> R
\`\`\`

**Today's reality (v0.9.x).** Default deployments auto-wire \`llm\` + \`memory\` + \`memory_write\` MCP connectors via bundled bridges (\`LocalModelMcpConnector\` over \`LocalModel\`; \`MemoryStoreMcpConnector\` over \`MemoryStore\` — the same bridge instance registered under both \`memory\` and \`memory_write\` names so query + write share substrate). All three work zero-config against the bundled Ollama + SQLite contracts; adopters override by re-registering the same connector names against their own substrate. The legacy \`~ prompt=...\` and \`> mode=... query=...\` ops continue to dispatch through the bundled typed contracts with tier-2 \`deprecated-symbol-op\` warnings; \`$ memory_write content="..." recipients=[...] -> R\` is the canonical durable-handoff path shipped in v0.8.0.

**One canonical call surface per concern.** \`$ memory\` is **the** memory-retrieval call surface — one contract (\`mode=... query=... limit=N -> R\` returning \`{items: [...]}\` envelope), one connector name. Both bare-form (\`$ memory ...\`) and dotted-form (\`$ memory.query ...\`) dispatch through the same registered connector. Same shape for \`$ llm\` (one \`prompt=... [maxTokens=N] [model="..."] -> R\` contract returning the response string). Author against the canonical \`$ llm\` / \`$ memory\` surfaces today; legacy \`~\` / \`>\` removal lands in v0.8/v0.9.

## Pipe filters

Apply on \`\${VAR|filter}\` references; chain left-to-right.

| Filter | Effect |
|---|---|
| \`url\` | encodeURIComponent |
| \`shell\` | POSIX single-quote escape |
| \`json\` | JSON.stringify |
| \`trim\` | Whitespace trim |
| \`length\` | Array element count or string char count (v0.2.5) |
| \`fallback:"X"\` | (v0.5.0) Coalesce-on-missing: when the upstream ref is unresolved, substitute literal \`X\` and continue the chain. Positional — \`\${VAR|fallback:"-"|upper}\` defaults-then-uppercases. |
| \`isodate\` | (v0.5.0) Format an epoch timestamp (ms or sec, auto-detected by magnitude) as ISO-8601. Passes already-ISO strings through unchanged. \`\${EVENT.fired_at_unix|isodate}\`. |

**\`\${NOW}\` ambient ref** substitutes as an ISO-8601 string per v0.5.0 spec. Numeric epoch values remain available as \`\${EVENT.fired_at}\` (ms) and \`\${EVENT.fired_at_unix}\` (sec).

## Conditional grammar

\`\`\`
if \${VAR}:                            ← truthy check
if not \${VAR}:                        ← falsy check (v0.3.2)
if \${VAR} == "literal":               ← equality vs literal
if \${VAR} == \${OTHER}:                ← equality vs ref
if \${VAR} != "literal":               ← inequality
if \${N} < "10":                       ← numeric comparison (v0.2.5)
if \${N} >= \${THRESHOLD}:              ← numeric vs ref
if \${M.id} in \${SEEN}:                ← set membership
if \${M.id} not in \${SEEN}:
if \${A} == "ok" and \${B} == "ok":     ← logical AND (v0.3.2)
if \${A} == "urgent" or \${B} > "5":    ← logical OR (v0.3.2)
if not \${A} and (\${B} or \${C}):      ← compound with parens + not (v0.3.2)
\`\`\`

Branches via \`if:\` / \`elif COND:\` / \`else:\`. The \`else:\` after a target body is a separate error-handler block (distinguished by indentation scope).

### Compound conditions (v0.3.2)

\`and\` / \`or\` / \`not\` connect simple conditions into compound expressions:

- **Precedence** (tight → loose): comparison ops (\`==\`/\`<\`/etc.) > \`not\` > \`and\` > \`or\`
- **Parentheses** override precedence: \`(a or b) and c\`
- **Short-circuit evaluation**: AND skips RHS if LHS is false; OR skips RHS if LHS is true. Useful for the validate-then-access pattern — \`if \${X} == "ok" and \${X.field} ...\` won't error on the field access when \`\${X} == "ok"\` is false.

## Legacy syntax (grace period — tier-2 deprecated)

| Legacy | Canonical |
|---|---|
| \`! text\` | \`emit(text="text")\` |
| \`?? "prompt" -> R\` | \`ask(prompt="prompt") -> R\` |
| \`@ cmd args [-> R]\` | \`shell(command="cmd args") [-> R]\` |
| \`@ unsafe cmd\` | \`shell(command="cmd", unsafe=true)\` |
| \`& skill-name\` | \`inline(skill="skill-name")\` |
| \`~ prompt="..." -> R\` | \`$ llm prompt="..." -> R\` (auto-wired via \`LocalModelMcpConnector\` bridge in default deployments) |
| \`> mode=... query=... -> R\` | \`$ memory mode=... query=... -> R\` (auto-wired via \`MemoryStoreMcpConnector\` bridge in default deployments) |
| \`$(VAR)\` | \`\${VAR}\` |
| \`(approved: "reason")\` trailer | \`approved="reason"\` kwarg |

All legacy forms compile during v0.7.x with tier-2 \`deprecated-symbol-op\` / \`deprecated-substitution-shape\` warnings. Tier-1 promotion (refuse-to-compile) lands in v0.8/v0.9.
`;

const FRONTMATTER = `# Frontmatter headers — full reference

Skill files open with \`# Key: value\` headers. Order isn't significant.

## Required

- \`# Skill: <name>\` — identity. Reserved keywords (\`default\`, \`needs\`, etc.) rejected.
- \`# Status: Draft | Approved v1:<token> | Disabled\` — lifecycle state. **v0.9.0**: Approved status requires a stamped \`vN:<token>\` (e.g. \`Approved v1:a1b2c3d4\`); the dashboard's approval flow stamps it. Naked \`Approved\` (no token) refuses to execute. Only Approved+verified skills fire via triggers, MCP \`execute_skill\`, in-skill \`$ execute_skill\`, or compile-time \`&\` inline.

## Common

- \`# Description: <prose>\` — human-readable explanation; surfaces in dashboards.
- \`# Type: procedural | data\` — \`procedural\` (default) for runtime-fired skills; \`data\` for compile-time-inlined fragments referenced by \`inline(skill="...")\` (canonical) or legacy \`& <skill-name>\` ops.
- \`# Vars: NAME=default, OTHER\` — declared variables. \`NAME=default\` provides a default; bare \`NAME\` is required at invocation.
- \`# Triggers: cron: 0 9 * * *, session: start\` — autonomous-dispatch sources. Comma-separated entries split by source-keyword boundary; cron expressions with commas (\`30,45 9 * * 1-5\`) parse correctly.
- \`# Output: text | agent: <name> | template: <name> | file: path | none\` — output routing. Five kinds, all substrate-neutral. **Two substrate-neutral lifecycle hooks** (v0.8.0): \`agent: <name>\` (renamed from \`prompt-context:\`) routes via AgentConnector as augment-kind delivery; \`template: <name>\` routes as template-kind delivery (receiving agent executes the rendered playbook). Both default to **joined emissions string** (the \`emit(text=...)\` lines concatenated with newlines). \`text\` / \`file:\` default to the **last-bound variable value** (structured), falling back to the emissions array when no var was bound. If your skill emits multiple lines and a downstream consumer only sees the final tool output via \`outputs.text\`, that's the structured-default behavior — use \`# Output: agent: <name>\` (or another text-coerced kind) to publish the joined emissions instead. **For substrate-specific delivery destinations** (Slack, WhatsApp, Discord, pagerduty, custom dashboards, etc.) — that's contract-between-the-skill-and-the-substrate territory, downstream of the language. Two paths: (1) \`$ <connector>.<tool> ...\` inside the skill body to dispatch through an adopter-wired MCP connector, or (2) deliver via \`agent: <name>\` to an agent whose AgentConnector decides how to surface the result.
- \`# OnError: <fallback-skill-name>\` — error-handler skill invoked when an op fails and no target-level \`else:\` catches.
- \`# Autonomous: true | false\` — declarative authorship intent for unattended-execution skills (cron-fired, agent-fired, etc.). v0.4.2. Today silences \`unconfirmed-mutation\` lint warnings for the whole skill (since the user-confirmation pattern doesn't apply to autonomous skills); reserved as the canonical autonomous-skill category marker for future rules + scheduling defaults + discovery surfaces. Omitted = interactive (default).

## Augmenting / Template only

- \`# Delivery-context: <prose>\` — routed to the receiving agent alongside the augment payload. v0.2.6.
- \`# Templates: <skill_name>, <skill_name>\` — comma-separated Template-skill names the receiving agent may fetch as follow-on actions. v0.2.6.

(Both fire \`unused-augmenting-header\` lint warning if set on a Headless skill — one with no \`agent:\` or \`template:\` output declaration.)

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

const EXAMPLES = `# Five canonical worked skills (v0.7.0+ canonical surface)

## 1. Minimal (single target, no dependencies)

\`\`\`
# Skill: hello
# Description: The canonical first-run example.
# Status: Approved
# Vars: WHO=world

greet:
    emit(text="Hello, \${WHO}!")
    emit(text="Welcome to Skillscript.")

default: greet
\`\`\`

Demonstrates: required headers, variable defaults, \`emit(text="...")\` with \`\${VAR}\` substitution.

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
# Delivery-context: Urgent ticket triage — please assess + assign owner.
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

Demonstrates: \`$ llm\` MCP dispatch (substrate-portable — adopter wires their LLM substrate under the \`llm\` connector name), \`|trim\` filter on LLM output, ref-vs-literal comparison, agent delivery via \`agent:\` lifecycle hook, augmenting headers (\`# Delivery-context:\` + \`# Templates:\`).

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

## 5. Dedup-by-id with the accumulator (v0.3.0+)

\`\`\`
# Skill: dedup-walk
# Description: Walk a result list, skip items whose id was already seen.
# Status: Approved
# Vars: TOPIC=infrastructure

walk:
    $ memory mode=topical query="\${TOPIC}" limit=50 -> CANDIDATES
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

Demonstrates: \`$ memory\` MCP dispatch (substrate-portable memory query), \`$append\` accumulator pattern, \`$set SEEN = []\` init at the target body (before the foreach) so mutations persist across iterations, \`not in\` membership check against the accumulating list, \`|length\` filter on the final collected list. **Note** — most MCP memory tools wrap the array in an envelope object (e.g., \`{items: [...], hasNextPage}\`); the example assumes \`.items\` is the array field. Check your tool's response shape; tier-3 \`object-iteration-advisory\` lint helps when you forget the field accessor.

## Triggered cron deliverable — memory handoff

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

## 6. Memory durable-handoff (substrate-portable write)

\`\`\`
# Skill: research-and-handoff
# Description: Run a query through the LLM, persist the result as a memory for the receiver to pick up
# Status: Approved
# Vars: QUERY=incident triage best practices

go:
    $ llm prompt="\${QUERY}" -> ANSWER
    $ memory_write content="\${ANSWER}" recipients=[researcher] domain_tags=[incident, handoff] -> ACK
    emit(text="memory written; receipt \${ACK.id}")

default: go
\`\`\`

Demonstrates: \`$ memory_write\` substrate-portable durable handoff (returns \`{id, created_at}\` envelope). \`recipients=[...]\` is the bracket-array literal form — the receiving agent's mailbox surfaces this on their next session check.

## 7. File output with confirmed write (v0.9.2+)

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

Demonstrates: \`$append\` accumulator over a string + \`file_write\` side effect. The v0.9.2 runtime emits a \`[file_write] wrote N bytes to <path>\` transcript line on success so the caller can confirm the write landed.

## Per-substrate return-shape note

Different connectors return different envelope shapes. Cold authors authoring against multiple substrates should expect:

- **Ticketing-style** (\`$ ticketing_search\`): returns \`{items: [...], totalCount, hasNextPage, ...}\` — \`.items\` is the array; \`.totalCount\` is the count.
- **Memory query** (\`$ memory\`): returns \`{items: [...]}\` envelope — \`.items\` is the array of memories.
- **Memory write** (\`$ memory_write\`): returns \`{id, created_at}\` — \`.id\` is the new memory's UUID.
- **LLM** (\`$ llm\`): returns the response string directly (no envelope).
- **File read** (\`file_read(path=...) -> R\`): binds the file content string to R.

Don't assume \`.totalCount\` exists on every envelope — it's a ticketing convention, not a universal one. Use the runtime's \`runtime_capabilities()\` + introspection to confirm shapes when in doubt.
`;

const COMPOSITION = `# Composition — composing skills from other skills

Skillscript has two composition primitives in v0.7.0+ canonical form. Both let one skill draw on another's output, with different semantics around when the child runs.

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

## 2. \`execute_skill(skill_name="<child>", ...kwargs) -> R\` — runtime invocation

The general composition form: the host calls another skill at runtime, capturing its full execution record. Same depth-counted chain (default 5) as the recursion guard.

\`\`\`
gather:
    execute_skill(skill_name="calendar-today", USER="\${USER_NAME}") -> CAL (fallback: "(no calendar data)")
    execute_skill(skill_name="mailbox-triage", inputs={"USER": "\${USER_NAME}"}) -> MAIL
\`\`\`

Two kwarg-forwarding styles, both supported (v0.2.9):
- **Bare kwargs** — \`USER="\${USER_NAME}"\` natural skill grammar
- **\`inputs={...}\` JSON** — useful when forwarding many fields verbatim

The bound \`-> R\` carries the child's full execution record (final_vars, transcript, outputs) into the host's scope. Access via \`\${R.final_vars.FIELD}\`, \`\${R.transcript}\`, \`\${R.outputs.text}\`, etc.

## Limits & lint signals

- **Recursion**: depth-5 chain by default (\`ExecuteSkillRecursionError\` if exceeded).
- **Lint** (\`unknown-skill-reference\`, tier-2 as of v0.3.1): both \`inline(skill="<name>")\` and \`execute_skill(skill_name="<name>", ...)\` validate the child exists in the SkillStore at compile time. Forward references are allowed: missing skills lint as warning (not error), runtime throws \`MissingSkillReferenceError\` if still unresolved at execute. Tier-3 \`deferred-skill-reference\` advisory confirms when the deferred-resolution path is engaged.
- **Lint** (\`disabled-skill-reference\`, tier-1): any composition primitive pointing at a \`# Status: Disabled\` skill blocks compile.

## When to use which

| Use case | Primitive |
|---|---|
| Static knowledge in a prompt | \`inline(skill="<data-skill>")\` |
| Child output bound into parent scope | \`execute_skill(skill_name="<skill>", ...) -> R\` |

## Legacy forms (grace period)

- \`& <skill-name>\` → \`inline(skill="<skill-name>")\` (compile-time inline)
- \`& invoke <skill-name>\` (removed concept) → \`execute_skill(skill_name="<skill-name>")\`
- \`$ execute_skill skill_name="<child>" ... -> R\` → \`execute_skill(skill_name="<child>", ...) -> R\` (legacy MCP-dispatch shape still compiles during grace; canonical is the function-call shape)

See \`help({topic: "examples"})\` example 4 for a worked orchestrator skill.
`;

const CONNECTORS_PROLOGUE = `# Connectors

Skillscript skills don't import packages — they invoke connectors. The runtime resolves dispatches through a typed registry of five contracts:

| Contract | Purpose | Op surface |
|---|---|---|
| \`SkillStore\` | Skill source persistence + status lifecycle | implicit (\`inline\` / \`execute_skill\` reference) |
| \`LocalModel\` | LLM inference (Ollama by default) | \`$ llm\` MCP dispatch via auto-wired \`LocalModelMcpConnector\` bridge (v0.7.2); legacy \`~\` op during grace period |
| \`MemoryStore\` | Knowledge retrieval (SQLite-FTS by default) | \`$ memory\` MCP dispatch via auto-wired \`MemoryStoreMcpConnector\` bridge (v0.7.2); legacy \`>\` op during grace period |
| \`McpConnector\` | MCP tool dispatch — all external tools | \`$ <connector_name> args\` |
| \`AgentConnector\` | Deliver augment/template payloads | \`# Output: agent:\` / \`template:\` |

**v0.7.3 substrate framing.** Canonical syntax routes substrate-specific dispatch through MCP (\`$ llm\` / \`$ memory\` rather than legacy \`~\` / \`>\`). Default deployments auto-wire the \`llm\` and \`memory\` connector names via bundled bridges (\`LocalModelMcpConnector\` over \`LocalModel\`; \`MemoryStoreMcpConnector\` over \`MemoryStore\`), so \`$ llm\` and \`$ memory\` work zero-config. Adopters override by re-registering those same connector names against their own substrate (e.g., a hosted-model MCP server in place of the local Ollama bridge); the canonical call sites don't change.

**Adopter-extensible class registration (v0.7.3).** Custom \`McpConnector\` classes that are JSON-instantiable register via \`registerConnectorClass(name, entry)\` from adopter bootstrap before \`loadConnectorsConfig\` runs. Replaces the pre-v0.7.3 pattern of editing the bundled \`KNOWN_CONNECTOR_CLASSES\` Map directly (merge-conflict bait). See \`examples/custom-bootstrap.example.ts\`.

**Canonical runtime config (v0.7.3).** \`skillscript.config.json\` externalizes runtime knobs (skillsDir, traceDir, dashboard port, etc.) so the two-instance posture (dev + adopter on same machine) works as copy-and-tweak. CLI flags override file values; file values override defaults. See \`skillscript.config.json.example\`.

**One canonical call surface per concern.** \`$ memory\` is **the** memory-retrieval call surface — one contract (\`mode=... query=... limit=N -> R\` returning \`{items: [...]}\` envelope), one connector name. Both bare-form (\`$ memory ...\`) and dotted-form (\`$ memory.query ...\`) dispatch through the same registered connector. Same shape for \`$ llm\` (one \`prompt=... [maxTokens=N] [model="..."] -> R\` contract returning the response string). The legacy \`~\` / \`>\` removal lands in v0.8/v0.9 — author against the canonical \`$ llm\` / \`$ memory\` surfaces today.

## Discovery

\`runtime_capabilities()\` reports the live picture: which connectors are registered, which feature flags they advertise, and which named instances exist (e.g., \`default\` / \`qwen\` LocalModels, \`youtrack\` McpConnector).

For shell execution (\`shell(...)\` op), \`runtime_capabilities\` also reports \`shellExecution.mode\` (\`"structural-spawn"\`) and \`shellExecution.unsafe_enabled\` (whether \`shell(command=..., unsafe=true)\` / legacy \`@ unsafe\` is permitted in this deployment).

## Container filesystem isolation

When the runtime is sandboxed (Docker container, deployed VM, etc.), the runtime's filesystem is namespace-isolated from the author's host. \`file_read("/tmp/x")\` and \`file_write(path="/tmp/x", ...)\` operate on the *runtime's* \`/tmp\`, not the host's. For cross-namespace work, use a known shared volume path or expose the file via a mount point both sides see. \`runtime_capabilities()\` (planned v0.8+) will report writable base paths to make this discoverable from cold-author position.
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
- \`deprecated-symbol-op\` (v0.7.1) — legacy symbol-form op (\`~\`, \`>\`, \`@\`, \`!\`, \`??\`, \`&\`) compiles but warns with canonical replacement. Tier-1 promotion (refuse-to-compile) lands in v0.8/v0.9.
- \`deprecated-substitution-shape\` (v0.7.1) — \`$(VAR)\` substitution form compiles but warns; rewrite to \`\${VAR}\`. Tier-1 promotion in v0.8/v0.9.
- \`unsafe-shell-ambiguous-subst\` — \`$(NAME)\` inside \`@ unsafe\` body that isn't a declared variable; collides with bash command-sub syntax
- \`unsafe-shell-op\` — \`@ unsafe\` op present; requires human review every time
- \`unknown-retrieval-arg\` — \`>\` op carries kwargs outside mode/query/limit/connector/fallback (v0.2.12 Bug 26)
- \`unknown-skill-reference\` — \`&\` or \`$ execute_skill\` references a skill not in the store (demoted from tier-1 in v0.3.1; runtime throws \`MissingSkillReferenceError\` if still unresolved at execute)
- \`unknown-template-reference\` — \`# Templates: <name>\` references a skill not in the store (demoted from tier-1 in v0.3.1)
- \`unconfirmed-mutation\` — mutation-class op (\`$\` tool with mutating-name shape, \`$ memory_write\`, \`file_write(...)\`) runs without authorization. v0.7.0+ accepts the captured \`approved="reason"\` per-op kwarg as authorization (any non-empty string; presence is what matters). Silent when the skill declares \`# Autonomous: true\` (v0.4.2 — the autonomous-skill category exempts the rule since the user-confirmation pattern doesn't apply to unattended-execution skills) or when a preceding \`??\` / \`ask(...)\` op gates the mutation in the same target.
- \`model-contention\` — async + sync ops on the same model serialize on a single runtime worker
- \`draft-with-trigger\` — \`# Status: Draft\` skill has \`# Triggers:\` declared; triggers won't fire until Approved
- \`reference-to-disabled-skill\` — \`&\` op references a Disabled skill (also tier-1 in some contexts)
- \`unused-augmenting-header\` — \`# Delivery-context:\` or \`# Templates:\` set on a skill with no agent-bound output (v0.2.6)

## Tier-3 (info)

- \`no-default-target\` — no \`default:\` declaration (relevant for data skills only; procedural skills hit tier-1)
- \`duplicate-skill-name\` — name collides with an existing stored skill
- \`plugin-collision\` — placeholder for v1.x plugin-loader name conflicts
- \`deferred-skill-reference\` — composition ref (\`&\` / \`$ execute_skill\` / \`# Templates:\`) targets a skill not currently in the SkillStore; resolution deferred to execute time (v0.3.1+). Confirms the forward-reference path is engaged; clears once the target is stored.
- \`unparsed-json-field-access\` — op text contains \`$(VAR|json_parse).field\`; the \`|json_parse\` filter was removed in v0.3.3. Replace with \`$ json_parse $(VAR) -> P\` then \`$(P.field)\`.
- \`object-iteration-advisory\` (v0.7.2) — \`foreach IT in \${VAR}\` iterates a bound variable whose origin is a \`$\` MCP tool output, without a \`.field\` accessor. MCP tools commonly wrap arrays in an envelope object (\`.items\`, \`.results\`, \`.issuesPage\`, \`.data\`, \`.records\`). Check the tool's response shape; rewrite as \`foreach IT in \${VAR.items}\` (or the correct field). Placeholder for v0.8 tool-schema introspection that catches this precisely.
- \`disallowed-tool\` (tier-1, v0.4.1) — \`$ name.tool\` references a tool not in the connector's \`allowed_tools\` allowlist. Either rewrite the skill to use a permitted tool or update \`connectors.json\` to grant access. Runtime defense-in-depth refuses disallowed dispatch even if lint is bypassed.

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
