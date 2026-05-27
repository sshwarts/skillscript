# Skillscript Language Reference — syntax, ops, semantics

Canonical language reference for skillscript. Audience: skill authors (human + agent). Specifies what is valid syntax, what behavior to expect at compile + runtime, and what is currently pending implementation.

Implementation state is cross-referenced to commit hashes; pending items mark v2/v3 work.

Companion docs under the Skillscript project anchor:
- `skillscript-prd` — product positioning, value prop, roadmap
- `skillscript-erd` — engineering requirements, system architecture, runtime mechanics

## Overview & language model — trigger → process → deliver, three delivery channels, three op classes (v0.7.0)

**DRAFT — pending v0.7.0 ship.** Replaces `b0a8e612-14bc-401e-80d1-b7979c4493ff` (v0.5.0 §1) on doc anchor swap when v0.7.0 lands. Reflects the locked v0.7.0 framework (`50a83a88` thread, approved `783a10a4`).

---

Skillscript is a constrained domain-specific language for authoring agent workflows. A skillscript is a declarative recipe: a small program with a dependency DAG of named targets, each composed of typed operations. Skillscripts are written once and executed many times.

## Language model — trigger → process → deliver

Every skill follows the same shape:

1. **Trigger** — what fires the skill: cron, command, session-start, agent-event, file-watch, webhook, etc.
2. **Process** — pull data (MCP / memory / file), classify or compose via sub-LLM + iteration, build the deliverable.
3. **Deliver** — emit the result via one or more delivery channels (see below).

Skillscript's job is to express this pipeline declaratively. When there is an agent above the skill, the agent's job is to act on the delivered artifact. When there isn't (autonomous fires), the delivery channel IS the outcome.

**Declarative DAG, not imperative script.** A skillscript declares targets and their dependencies (`needs:` keyword); the interpreter topologically sorts and executes them in dependency order. Write blocks in any order — the runtime walks the graph.

**Goal-directed, not entry-point-directed.** The `default:` declaration names the *goal target* — the terminal node whose result is the skill's output. The runtime walks dependencies backward from the goal through the topo-sort. A skill with a single target obscures this (goal == entry trivially); skills with multi-target DAGs make the shape visible.

## Two execution paths

**Runtime-mediated** — the interpreter walks ops and dispatches them directly through configured connectors. Used for autonomous fires (cron, session-triggered, event-triggered). Safety boundary is the connector config + per-op gating (see §2).

**Agent-mediated** — the compiler renders the skill as a prompt; an agent reads the prompt and executes ops through its own tools. Used when an agent invokes a skill mid-conversation. Safety boundary is the agent's harness tool permissions.

The language is identical in both paths. The execution model is a deployment-time + invocation-time decision.

## Three delivery channels

A skill delivers its work via one or more of three channels. Delivery channel is not a property of skill type — it's just which ops a skill ends with.

| Channel | Op | When you'd use it |
|---|---|---|
| **Embedded prompt** | `emit(text="...")` | Skill output is prompt-context for the agent's next turn; agent reads it inline. Pattern: agent-augmenting skills declared via `# Output: prompt-context:<agent>`. |
| **Memory handoff** | `$ memory_write content="..." addressed_to="<agent>" -> R` | Skill writes a memory the target agent picks up via mailbox at next session. Pattern: async carrier skills, autonomous fires that hand off to a future session. |
| **File handoff** | `file_write(path="...", content="...")` | Skill writes a file at a known location; agent or downstream process reads when working in the area. Pattern: autonomous reports, status snapshots, queue files. |

A single skill can use any combination. An autonomous cron-fired sweep might write a memory addressed to the on-call agent AND emit a file for the dashboard. A command-invoked skill might emit prompt-context AND file one memory as a deliverable. The combinations are unconstrained — the per-op gating model (§2) governs which mutating ops are authorized, not which channels a skill uses.

## Three op classes

The op surface is three classes, each with its own grammar:

| Class | Shape | Resolution |
|---|---|---|
| **Mutation statements** | `$set VAR = value`, `$append VAR <value>` | Reserved keywords. |
| **Runtime-intrinsic function-calls** | `verb(kwarg=value, ...) [-> BINDING]` | Closed built-in list (§2). Unknown verb → tier-1 lint `unknown-runtime-op`. |
| **External MCP dispatch** | `$ <connector> kwarg=value, ... [-> BINDING]` | Resolved against `connectors.json`. Unknown connector → tier-1 lint `unknown-connector`. |

The `$` prefix is information-bearing: it marks **state-affecting ops** (mutation OR external dispatch). Function-call shape marks **language-intrinsic ops the runtime knows directly**.

Full op catalog and per-op semantics in §2.

## Substrate portability

The language doesn't privilege any backend. `$ llm`, `$ memory`, `$ ticketing_search` are not language built-ins — they're connector names declared in `connectors.json` and wired to whichever substrate the adopter chooses. The same skill source runs against any conforming connector set:

| Connector slot | Adopter A wires | Adopter B wires |
|---|---|---|
| `llm` | Local model (Ollama) | OpenAI Chat Completions |
| `memory` | AMP query | Pinecone query |
| `memory_write` | AMP write | Pinecone upsert |
| `ticketing_search` | YouTrack search | Jira search |
| `agent_notify` | Claude Code spawn (webhook) | tmux send-keys |

Skill source doesn't change. Adopter wires their substrate; language is agnostic.

## Anatomy of a skill

```
# Skill: morning-showstopper-sweep
# Description: Pre-triage open showstoppers before the human arrives; deliver via addressed memory.
# Triggers: cron:"0 8 * * MON-FRI"
# Vars: PROJECT = "INFRA"

# Process: pull showstoppers + pre-triage each via sub-LLM
$ ticketing_search query="project:${PROJECT} severity:showstopper state:Open" -> SHOWSTOPPERS

$set REPORT = "Morning showstoppers (${SHOWSTOPPERS.totalCount}):\n\n"
foreach ISSUE in ${SHOWSTOPPERS.items}:
  $ llm prompt="Two-line summary + top hypothesis for: ${ISSUE.summary}\n\n${ISSUE.description}" -> ANALYSIS
  $append REPORT <line>## ${ISSUE.id}: ${ISSUE.summary}</line>
  $append REPORT <line>${ANALYSIS}</line>

# Deliver: memory handoff to the on-call agent
$ memory_write content="${REPORT}" addressed_to="cc" tags="morning-sweep" approved="cron-fired daily sweep" -> SWEEP_ID

default: deliver
```

Three layers of declaration:
1. **Header metadata** (`# Key: value` lines) — name, description, declared variables, triggers, optional `# Output:` routing, `# Autonomous:` flag, error fallbacks
2. **Targets** — named blocks of typed ops, optionally with `needs:` dependencies
3. **`default:`** — names the goal target the runtime walks toward

## Lexical conventions

### Indentation: spaces only

Block structure (`foreach`, `if`/`elif`/`else:`, target bodies, error-handler `else:` blocks) is determined by indentation. **Use spaces. Tabs are a parse error.** Mixed tabs+spaces in a single file is a parse error.

The conventional indent is 4 spaces, but any consistent depth within a block is acceptable. The parser tracks each block's indent level on entry and rejects mid-block changes.

### Reserved keywords

The following identifiers are reserved and cannot be used as variable names, target names, or skill names:

**Mutation statements:** `$set`, `$append`

**Runtime-intrinsic op names:** `emit`, `ask`, `inline`, `execute_skill`, `shell`, `file_read`, `file_write` (the closed function-call list; see §2)

**Control flow:** `default`, `needs`, `if`, `elif`, `else`, `foreach`, `in`, `not`, `unsafe`

**Future-reserved** (no current semantics, reserved to keep v2 grammar additions non-breaking): `while`, `for`, `match`, `try`, `catch`, `return`

Reserved-name use produces a parse error with a specific diagnostic.

**Case sensitivity.** Reserved words are exact-match case-sensitive. `emit` is reserved; `Emit` is allowed. `If` is allowed as an identifier; `if` is the control-flow keyword.

### Enumerated value normalization

For frontmatter keys with a closed set of accepted values (`# Status:`, `# Output:` kinds, trigger sources, etc.), values are accepted case-insensitively on input and stored as their canonical form. `# Status: draft`, `# Status: Draft`, and `# Status: DRAFT` all parse to the same canonical `Draft`.

This applies to value-space normalization only — keys remain case-sensitive (`# Status:` is the header; `# status:` is a parse error).

## Storage and identity

Skillscripts are stored via a configured `SkillStore` backend. The backend persists each skill as a uniquely-named record; writing a skill with an existing name updates in place. Skill records are infrastructure, not knowledge atoms — backends with garbage-collection or expiry semantics should treat skills as long-lived first-class records, not as candidates for cleanup.

The language is storage-agnostic; the interpreter accepts a skillscript body as text regardless of source. Common SkillStore implementations:

- **Memory-backed** — skill bodies live in a knowledge-substrate as records with a distinguished payload type. Versioning and audit trail come from the substrate.
- **File-backed** — skill bodies live on disk (e.g., for version-control workflows or distribution). Versioning and audit trail come from the filesystem and/or VCS.
- **Hybrid** — skills authored in one backend and synced to another for distribution.

The Connectors section (§10) documents the `SkillStore` interface and how to wire a custom backend.

### File-backed convention

Three-file pattern per skill on disk, mirroring the standard source/compiled split (`.ts`→`.js`, `.scss`→`.css`):

- `<skill-name>.skill.md` — **source.** Authored by humans or agents. Dual-extension: `.md` outer makes any markdown-aware tool render headers + code blocks natively; `.skill` inner is the language-tooling discriminator. Committed to version control.
- `<skill-name>.skill` — **compiled artifact.** The prompt text emitted by the compile API. Agent-consumable. Typically gitignored.
- `<skill-name>.skill.provenance.json` — **provenance sidecar.** Records source content_hash, compiled version, timestamps, data-skill staleness markers. Typically gitignored.

Default `.gitignore` for a file-backed skills repo: `*.skill` and `*.skill.provenance.json`.

## Authoring discipline

Two principles for skill authors, learned by accumulated failure across many agent-authored skills.

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

## Ops reference — three op classes (mutation / runtime-intrinsic / external MCP dispatch) (v0.7.0)

**v0.7.0.** Replaces prior `e52bc525-2637-4bc2-94fe-50e730393d6b` (v0.5.0) on doc anchor swap. Reflects shipped commit `7612571` (locked framework `c48fca7e`, approved `783a10a4`; `approved="..."` shape locked `1783828b`; spec answers `f8aff1b7`).

---

The op surface in v0.7.0 is three classes, each with its own grammar and resolution path. The symbol-per-op design (`~`, `>`, `@`, `!`, `??`, `&`) shipped through v0.5.0 is **deprecated** in v0.7.0 in favor of verb-word ops in function-call shape — training-corpus alignment + human-reviewability. Grace-period framing: legacy symbol-ops still compile in v0.7.0 (route to canonical dispatch under the hood); compile-warn ships v0.7.1 (`deprecated-symbol-op` tier-2); full removal slated for v0.8.x or v0.9. See the "Removed ops" section below for the migration map.

## Three op classes at a glance

| Class | Shape | Resolution |
|---|---|---|
| **Mutation statements** | `$set VAR = value`, `$append VAR <value>` | Reserved keywords (parser dispatches directly). |
| **Runtime-intrinsic function-calls** | `verb(kwarg=value, ...) [-> BINDING]` | Closed built-in list (below). Unknown verb → tier-1 `unknown-runtime-op`. |
| **External MCP dispatch** | `$ <connector>[.<tool>] kwarg=value, ... [-> BINDING]` | `connectors.json` resolution at compile. Unknown connector → tier-1 `unknown-connector`. See §10 for flat vs dotted dispatch shape. |

The `$` prefix is information-bearing: it marks **state-affecting ops** (mutation OR external dispatch). Function-call shape marks **language-intrinsic ops the runtime knows directly**. Parse-time discrimination is unambiguous — three grammars, three resolution paths, zero overlap.

All call-sites are uniform all-kwargs. No positional arguments. No mixed shapes. One call form per class.

---

## Mutation statements

### `$set` — explicit variable binding

Binds a value to a variable. Bind-time interpolation of `${VAR}` substitutions in the RHS (shipped v0.5.0).

```
$set RESULT = ""
$set MODE = "production"
$set GREETING = "Hello, ${NAME}!"          # resolves at bind time
$set FOUND = []
```

RHS forms accepted: string literal (with `${VAR}` substitution), number literal, boolean (`true` / `false`), `null`, empty list `[]`, JSON array literal, JSON object literal, or a single variable ref `${OTHER}`.

Missing-ref produces tier-1 runtime error.

### `$append` — accumulator

Mutates the target binding in the outer scope. Type-dispatched on the target binding (shipped v0.5.0).

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
    $append DETAIL "YouTrack issues for ${USER.login}:\n\n"
    foreach ISSUE in ${ISSUES.issuesPage}:
        $append DETAIL "- ${ISSUE.id}: ${ISSUE.summary}\n"
```

**Initialization required.** `$append VAR <value>` where VAR isn't initialized in the enclosing scope (via `$set X = []`, `$set X = ""`, or `# Vars: X=[]` / `# Vars: X=""`) fires tier-1 `uninitialized-append`.

**Foreach scope rule.** When `$append VAR` is inside a `foreach`, VAR's init must live in an *enclosing* scope. Tier-1 `foreach-local-accumulator-target` catches this.

**Single-value semantics (list mode).** `$append VAR <value>` appends one element. List concatenation is deferred to a future `$extend` op.

**Parallel foreach.** `$append` inside a `parallel foreach` is a tier-1 error.

---

## Runtime-intrinsic function-calls

Closed list of language-intrinsic ops the runtime knows directly. Each is a function-call with kwargs; binding via optional `-> VAR`. The complete v0.7.0 set:

| Op | Shape | Binding | Notes |
|---|---|---|---|
| `emit` | `emit(text="...")` | none | Append to the skill's response surface (delivery channel: embedded prompt). |
| `ask` | `ask(prompt="...") -> R` | required | Prompt user for input; binds response. Autonomous-mode fails fast (routes to `else:` / `# OnError:`). |
| `inline` | `inline(skill="<data-skill-name>")` | none | Compile-time inline of an Approved `# Type: data` skill. Resolves at compile, records `content_hash` in provenance. |
| `execute_skill` | `execute_skill(skill_name="...", inputs={...}) -> R` | optional | Composition primitive. Runtime-resolved. See §11. |
| `shell` | `shell(command="...") -> R` / `shell(command="...", unsafe=true) -> R` | optional | Sandboxed shell exec (default) or full-shell exec (`unsafe=true`, gated by `runtime.enable_unsafe_shell`). stdout binds. |
| `file_read` | `file_read(path="...") -> R` | required | Read a file at `path`; binds string contents. |
| `file_write` | `file_write(path="...", content="...")` | none | Write `content` to `path`. `mkdir -p` semantics for parent directories. Mutation-classified (see Per-op gating below). |

**Unknown op name** → tier-1 lint `unknown-runtime-op` with remediation pointing at MCP dispatch: "if this is an external tool, use `$ tool_name args -> R`."

### `emit` — embedded-prompt delivery

```
emit(text="Triage for ${PROJECT}:")
emit(text="${REPORT}")
```

Substitutions resolved at runtime. Ordering within a block: ops execute sequentially in source order.

The presentation-surface output kinds (`# Output: prompt-context:<agent>`, `# Output: slack:`, `# Output: card:`, `# Output: template:`) consume the joined emit stream. Programmatic surfaces (`# Output: text`, `# Output: file:`) follow the per-kind semantics described in §7.

### `ask` — interactive prompt

```
ask(prompt="Approve fix A+B?") -> APPROVED
```

**Autonomous mode** (cron/event-fired): `ask` fails fast — routes to `else:` or `# OnError:` fallback.

**Interactive mode:** response binds to the output variable. **Decline semantics:** when the user response is "no" / "n" / falsey, dependent targets are skipped (treated as soft op-error so `else:` fires).

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

**No substitution collision in v0.7.0.** Bash's `$(command)` and arithmetic `$((expr))` pass through to bash without escape because skillscript's substitution is braced (`${VAR}`). The v0.5.0 `$$(...)` escape syntax and `unsafe-shell-ambiguous-subst` lint are retired.

### `file_read` / `file_write` — file I/O

```
file_read(path="/tmp/state.json") -> STATE
file_write(path="/tmp/report.md", content="${REPORT}", approved="nightly sweep deliverable")
```

`file_read` is read-only (always allowed). `file_write` is mutation-classified — requires `# Autonomous: true` declaration on the skill OR per-call `approved="..."` kwarg. `mkdir -p` semantics for the parent directory.

**v0.7.0 status:** `approved="..."` kwarg is *captured* on the AST but **not yet referenced by lint enforcement** (per-op gating broadens in v0.7.1; see below). Today the existing v0.4.2-era `unconfirmed-mutation` heuristic still governs mutation gating.

### `inline` — data-skill compile-time inline

```
brief:
    $ llm prompt="${VOICE_RULES} Now write a one-line status:" model=qwen -> RESULT
    inline(skill="voice-rules")
```

Inlines an Approved `# Type: data` skill into the host skill's compiled artifact at the call site. Resolved at `compile()` time; the data skill's `content_hash` is recorded in the host's provenance. `skillfile audit` detects stale recompiles when a referenced data skill changes.

See §11 for the distinction between `inline` (compile-time), `execute_skill` (in-skill runtime call with kwarg forwarding), and dispatched skills.

### `execute_skill` — composition runtime call

```
classify:
    execute_skill(skill_name="classifier", inputs={"text": "${INPUT}"}) -> VERDICT
```

Runtime-resolved against the SkillStore. Recursion-depth-guarded (default 10).

---

## External MCP dispatch

Calls a tool through a configured connector. Connector name resolves against `connectors.json`. Output binds via optional `-> VAR`. See §10 for the connector contract and dispatch resolution details (flat-name vs dotted-prefix forms).

```
$ youtrack_search query="project:INFRA state:Open" limit=20 -> ISSUES
$ llm prompt="Classify: ${INPUT}" -> VERDICT
$ memory mode=fts query="${TOPIC}" limit=5 -> RESULTS
$ memory_write content="${SUMMARY}" addressed_to="cc" approved="morning roundup, 2026-05-25" -> ACK
$ youtrack.search query="project:INFRA" -> ISSUES                            # dotted-prefix form (explicit routing)
```

Tool args are unconstrained `key=value` pairs — the connector forwards them to the underlying MCP tool. If a dispatched call returns `isError: true`, the executor throws via `makeOpError`, which routes through `else:` / `# OnError:` machinery. The inner tool's error text is preserved in `result.errors[]`.

**Substrate-neutrality.** Connector names like `$ llm`, `$ memory`, `$ ticketing_search` are NOT reserved or built-in — they're whatever the adopter declares in `connectors.json`. See §10.

**Unknown connector** → tier-1 `unknown-connector` lint with the list of wired connector names.

**Unquoted-substitution lint** (`unquoted-substitution-in-kwarg-value`, tier-2): fires when `$ tool key=${VAR}` has unquoted `${VAR}` AND the var's binding origin is "suspect" (`# Vars:` default with whitespace, `$set` with whitespace, op output, foreach iterator). Closes the silent-arg-truncation footgun where the MCP arg parser whitespace-splits substituted values. Remediation: wrap as `key="${VAR}"`.

---

## Per-op gating

Mutation ops require an authorization signal. The signal is per-op, not a mode binary.

**Mutation-classified ops:**
- `file_write(...)` (runtime-intrinsic)
- `$ memory_write ...` and any MCP connector entry declared `"mutating": true` in `connectors.json` (v0.7.1; today still uses v0.4.2 heuristic list)
- `shell(command=..., unsafe=true)` (always mutation-classified)
- `shell(command=...)` with destructive verb (rm, mv, dd, mkfs, etc. — heuristic list extends today's `unconfirmed-mutation` rule)

**Read-only ops (always allowed, no authorization needed):**
- `file_read`, `emit`, `ask`, `inline`, `execute_skill`
- `shell(command=...)` with read-only verb
- `$ <connector> ...` against tools declared `mutating: false` (or unspecified, default false for query-shaped tools)
- `$set`, `$append`

**Authorization signals (either suffices):**
- `# Autonomous: true` in skill frontmatter — author-level: "this skill is authorized to mutate state during its run."
- `approved="<reason>"` kwarg per-op — call-site-level: "this specific op is authorized." The string is required (forces author intent); value not parsed semantically — presence is what matters.

### v0.7.0 vs v0.7.1 staging

The framework above describes the **v0.7.1 target state**.

**What v0.7.0 ships today:**
- `approved="..."` kwarg is *captured* on the AST for function-call ops (`shell`, `file_write`, `emit`, `ask`, `inline`, `execute_skill`)
- The existing v0.4.2-era `unconfirmed-mutation` lint still governs gating (covers destructive shell verbs, destructive verbs in `$` tool args, ambiguous shell substitutions from op outputs)
- The v0.4.2-era `(approved: "...")` trailer syntax continues to work
- Lint does NOT yet check `approved="..."` kwarg presence on function-call mutation ops, and does NOT yet cover `file_write` / `$ memory_write` specifically

**What v0.7.1 broadens:**
- `unconfirmed-mutation` extends to `file_write(...)` and `$ memory_write ...` (and other connectors declared `"mutating": true`)
- `approved="..."` kwarg becomes the canonical v0.7.0+ per-op authorization marker; any non-empty string presence = author-confirmed (lint quiet)
- v0.4.2 `(approved: "...")` trailer continues to work (back-compat); the kwarg form is canonical

```
# Authorized via skill-level flag
# Skill: nightly-sweep
# Autonomous: true
# Triggers: cron:"0 8 * * *"

deliver:
    file_write(path="/tmp/sweep.md", content="${REPORT}")        # no approved= needed
    $ memory_write content="${REPORT}" addressed_to="cc"          # no approved= needed
```

```
# Authorized per-call (no # Autonomous: true)
# Skill: ad-hoc-snapshot

deliver:
    file_write(path="/tmp/snap.json", content="${DATA}",
               approved="manual snapshot requested by Scott 2026-05-25")
```

---

## Removed ops (migration map)

These symbols are deprecated in v0.7.0. They still compile during the grace period — legacy symbol-form `~`, `>`, `@`, `!`, `??`, `&` parse and route to the canonical dispatch path. Grace-period staging:

- **v0.7.0** (now): legacy ops compile cleanly. Canonical equivalents are the recommended form going forward.
- **v0.7.1**: tier-2 `deprecated-symbol-op` lint + tier-2 `deprecated-substitution-shape` (for `$(VAR)`) ship as visibility nudges. Skills still compile.
- **v0.8.x or v0.9** (TBD): legacy symbols + `$(VAR)` removed; compile-error. Symbol re-use for new semantics opens after removal.

The migration map below describes the canonical equivalents:

| Deprecated | Canonical replacement | Notes |
|---|---|---|
| `~ prompt="..." [model=...] [maxTokens=...]` | `$ llm prompt="..." [model=...] [maxTokens=...]` | `llm` is an adopter-wired connector convention, not a language built-in. See §10. |
| `> query=... mode=... limit=N` | `$ memory query=... mode=... limit=N` | `memory` is an adopter-wired connector. Mutation form: `$ memory_write`. |
| `@ <binary> <args>...` | `shell(command="<binary> <args>...")` | Structural sandbox stays; call shape is now function-call. |
| `@ unsafe <command>` | `shell(command="<command>", unsafe=true)` | `unsafe` is a kwarg, not a magic first-token. |
| `! <text>` | `emit(text="<text>")` | |
| `?? "<prompt>" -> R` | `ask(prompt="<prompt>") -> R` | |
| `& <data-skill-name>` | `inline(skill="<data-skill-name>")` | |
| `$ execute_skill skill_name="..."` | `execute_skill(skill_name="...")` | Now in runtime-intrinsic class; no `$` prefix. |

**Adopter-facing migration:** the v0.7.0 codebase included a one-shot internal migration script (`scripts/migrate-v07.mjs`) that was used to migrate the bundled examples, then deleted post-run. There is no permanent migration CLI. Adopters with existing skills can either:
- Re-derive the rewrites mechanically (the rules are documented in `CHANGELOG.md` under `## 0.7.0 — Migration`), or
- Write new skills against the canonical surface from day one.

Most adopters land in the second category because Skillscript is still pre-adoption.

## Op grammar summary

| Class | Op | Shape | Binding |
|---|---|---|---|
| Mutation | `$set` | `$set NAME = value` (with `${VAR}` interpolation at bind) | NAME (no arrow) |
| Mutation | `$append` | `$append VAR <value>` (type-dispatched: list element / string concat) | VAR (no arrow) |
| Runtime-intrinsic | `emit` | `emit(text="...")` | none |
| Runtime-intrinsic | `ask` | `ask(prompt="...") -> R` | required |
| Runtime-intrinsic | `inline` | `inline(skill="<name>")` | none (compile-time) |
| Runtime-intrinsic | `execute_skill` | `execute_skill(skill_name="...", inputs={...}) -> R` | optional |
| Runtime-intrinsic | `shell` | `shell(command="...", [unsafe=true], [approved="..."]) -> R` | optional |
| Runtime-intrinsic | `file_read` | `file_read(path="...") -> R` | required |
| Runtime-intrinsic | `file_write` | `file_write(path="...", content="...", [approved="..."])` | none |
| External MCP | `$ <connector>` | `$ <name>[.<tool>] kwarg=value, ... [-> R]` | optional |
| Deprecated (grace) | `~`, `>`, `@`, `!`, `??`, `&` | compile + route to canonical; v0.7.1 deprecation lint | per legacy form |

## Variable resolution — ${VAR} canonical, substitution + ambient refs + # Requires: cascade (v0.7.0)

**v0.7.0.** Replaces prior `719fd967-de5a-4857-86bb-ef325bdb7d72` (v0.5.0) on doc anchor swap. Reflects shipped commit `7612571` (locked framework `c48fca7e`, approved `783a10a4`; spec answers `f8aff1b7`).

---

Skillscript supports four tiers of variables, each with distinct resolution timing and scope. Substitution uses **`${VAR}` as the canonical form in v0.7.0**. The `$(VAR)` form (parentheses) from v0.5.0 continues to compile during the grace period, deprecation-tagged for visibility in v0.7.1 and slated for removal in v0.8.x or v0.9 (TBD). Adopters writing new skills should reach for `${VAR}` exclusively; legacy `$(VAR)` skills still work but will fire `deprecated-substitution-shape` (tier-2) once v0.7.1 ships.

## Substitution syntax — `${VAR}` canonical

```
emit(text="Hello, ${USER.login}!")
$ memory mode=fts query="${TOPIC}" limit=5 -> R
$set REPORT = "Triage for ${PROJECT} (${ISSUES|length} open):\n"
```

Field access: `${VAR.field}`, `${VAR.nested.field}`. Filter chain: `${VAR|filter:"arg"|filter2}`. See §4 for the filter catalog.

**Why the change.** v0.5.0 used `$(VAR)` (parens). v0.7.0 ships `${VAR}` (braces) as canonical — bash-trained agents recognize the braced form, and the brace removes the substitution-collision class inside `shell(command=..., unsafe=true)` where bash's `$(command)` would visually collide.

**Grace-period reality for v0.7.0:**
- `${VAR}` is the canonical form
- `$(VAR)` continues to parse and substitute (back-compat)
- v0.7.1 ships `deprecated-substitution-shape` tier-2 lint as visibility nudge
- v0.8.x / v0.9 removes `$(VAR)` form entirely

**Migration.** No permanent CLI migration tool ships with v0.7.0. The codebase included a one-shot internal migration script (`scripts/migrate-v07.mjs`) that was used to migrate the bundled examples, then deleted post-run. Adopters with existing skills can:
- Re-derive the rewrites mechanically — `$(VAR)` → `${VAR}` is a literal substitution; comments and string content are preserved as-is. The rules are documented in `CHANGELOG.md` under `## 0.7.0 — Migration`.
- Use editor find-and-replace with a simple regex.
- Write new skills against `${VAR}` from day one.

Most adopters land in the third category because Skillscript is pre-adoption.

**Inside `shell(command="...", unsafe=true)`** there is no collision with bash command-substitution `$(command)` — skillscript's substitution is braced (`${VAR}`), bash's is unbraced (`$(cmd)`). The `$$(...)` escape syntax and `unsafe-shell-ambiguous-subst` lint from v0.5.0 are retired.

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

These let skill bodies compute `expires_at` and similar bounded-lifetime values without arithmetic in op kwargs. For ISO-formatted rendering of any epoch value, see the `|isodate` filter (§4).

Additional ambient refs may be injected based on connector configuration (e.g., a vault-backed memory connector may expose `${VAULT_ROOT}`). §10 documents which ambient refs each connector contributes.

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

Bound to a previous target's output mid-execution. Two forms:
- `${target.output}` — the bound output of a target
- `${VAR}` — an explicit `-> VAR` binding from any op
- `${target.output.field}` or `${MEMORY.field}` — dotted field access into structured output

**Field access resolution tiers** for `${MEMORY.field}`:
1. Core `PortableMemory` fields (id, summary, detail, score)
2. Curated substrate subset (thread_status, pinned, confidence, domain_tags, payload_type, knowledge_type, recipients, expires_at, created_at, agent_id, vault)
3. `metadata.X` for everything else
4. Ambient passthrough as literal `${MEMORY.field}` if unresolved

**Missing-field opt-out:** `${MEMORY.field|fallback:"-"}` coalesces to the literal when the field doesn't resolve. See §4 for the full `|fallback:` semantics.

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

## `$set` — bind-time interpolation (v0.5.0, retained)

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

Pipe filters apply transforms to resolved variables before substitution. Syntax: `$(VAR|filter)` or `$(VAR|filter:"arg")` for parameterized filters. Filters operate at compile time for static values; for runtime-bound variables, filters apply at substitution time.

## Shipped filters

| Filter | Effect | Example | Output |
|--------|--------|---------|--------|
| `url` | `encodeURIComponent(value)` | `$(location|url)` for "Asheville, NC" | `Asheville%2C%20NC` |
| `shell` | POSIX single-quote escape with outer quotes | `$(arg|shell)` for `it's safe` | `'it'\''s safe'` |
| `json` | `JSON.stringify(value)` | `$(payload|json)` for `{k:"v"}` | `"{\"k\":\"v\"}"` |
| `trim` | Whitespace trim | `$(VERDICT|trim)` for `"urgent\n"` | `urgent` |
| `length` (v0.2.5) | Count of items (array) or characters (string) | `$(ITEMS|length)` for `["a","b","c"]` | `3` |
| `fallback:"X"` (v0.5.0) | Coalesce on missing/undefined ref | `$(VAR.missing|fallback:"-")` | `-` |
| `isodate` (v0.5.0) | Epoch seconds → ISO-8601 timestamp | `$(EPOCH|isodate)` for `1779660000` | `2026-05-24T22:00:00.000Z` |

### `length` semantics

- Arrays → number of elements
- Strings → number of characters
- Non-array/non-string values (number, null, undefined, plain object) → runtime `TypeMismatchError`

Strings that hold JSON arrays get the same tolerance as `in`/`not in` RHS: if the string JSON-parses to an array, the array length is returned. Lets `$(SEEN|length)` work cleanly when `SEEN` came from a `~` op that returned a JSON-array string.

Pairs naturally with the numeric comparison operators (see Conditionals section):

```
$ memorystore.query query="urgent" -> ITEMS
if $(ITEMS|length) > 5:
    ! Mailbox is getting crowded
```

The output of `|length` is a string-form number ("3", "5", etc.) at substitution time, consistent with how other filters produce strings. Numeric comparison coerces back to number for the comparison; equality (`==`) does byte-for-byte string comparison.

### `fallback:"X"` semantics (v0.5.0)

Coalesce-on-missing. Emits the literal string `X` when the ref resolves to missing/null/undefined. Strict-by-default semantics preserved everywhere else; `|fallback:` is the explicit opt-out at the call site.

```
emit:
    ! present: $(PRESENT|fallback:"missing")         → "hello"  (PRESENT is bound)
    ! missing: $(NOT_DECLARED|fallback:"-")          → "-"      (NOT_DECLARED isn't)
    ! nested:  $(ISSUE.customFields.Assignee|fallback:"unassigned")
```

**Why filter-shape, not ref-level `(fallback:)`.** Op-level `(fallback: ...)` exists on `~`/`>`/`$` for **error recovery** (dispatch happened, failed). Ref-level `|fallback:` is **coalesce** (lookup found nothing). They rhyme but are adjacent concepts. The filter-chain attachment keeps composition clean (`$(VAR|json_parse|fallback:"-")` works as a chain step) and the vocabulary alignment with op-level `(fallback:)` lets cold authors learn "fallback" as the universal concept while the syntax disambiguates the attachment site.

**Closes the missing-field strict-error trap** identified in R3 minion 5: `$(ISSUE.customFields.Assignee)` against an object without that key threw `UnresolvedVariableError` and aborted whole-render. Pre-v0.5.0 the only mitigation was wrapping each nullable ref in an `if` block. v0.5.0+: the filter is the per-ref opt-out.

### `isodate` semantics (v0.5.0)

Converts a Unix epoch-seconds value to an ISO-8601 timestamp string. Pairs with `$(NOW)` (now ISO-8601 by default in v0.5.0; pre-v0.5.0 was raw epoch milliseconds — docs/runtime alignment finding from R3 minion 2) and `$(EVENT.fired_at_unix)` (raw epoch seconds, per its name).

```
show:
    ! Now (already ISO):     $(NOW)                       → 2026-05-24T23:34:15.859Z
    ! Trigger fire (ISO):    $(EVENT.fired_at_unix|isodate) → 2026-05-24T23:34:15.000Z
    ! Static epoch:          $(SOME_EPOCH|isodate)         → 2026-05-24T22:00:00.000Z
```

Input is interpreted as Unix epoch seconds. Non-numeric input produces runtime error. For millisecond inputs, divide first or use a wrapping op (no `|isodate_ms` filter in v0.5.0; file if real demand surfaces).

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
if $(VAR.maybe|fallback:"-") == "-":
    ! nothing there
```

Filter chains in conditions (v0.2.5+) and the v0.5.0 `|fallback:` filter all work in conditional context.

## Filter use in `in` / `not in` set membership

Filters may appear on the LHS of `in` / `not in` checks (the comparison side). The RHS must resolve to an array at runtime.

```
if $(M.id|trim) in $(SEEN):
    ! already processed
```

## Filter use in numeric comparison (v0.2.5)

Filters may appear on either side of `<`, `>`, `<=`, `>=` comparisons. `|length` is the canonical companion — most numeric-threshold patterns are "more than N items" rather than arithmetic on raw values.

```
if $(ITEMS|length) > 5:
    ...
elif $(BODY|length) > 1000:
    ...
```

## Error handling

Unknown filter on a resolved variable produces a tier-1 `unknown-filter` compile error. v0.5.0+ catches both bare (`|unknown`) and colon-positional (`|unknown:"arg"`) shapes. Filter chains that fail at runtime (e.g., `|json` on a non-serializable value, `|length` on a number, `|isodate` on a non-numeric value) produce op errors that route through `else:` / `# OnError:` machinery.

Bare `$(NAME)` without a filter is unchanged.

## Removed: `|json_parse` filter (was v0.3.2, yanked v0.3.3)

`|json_parse` shipped briefly in v0.3.2 as a filter, then was yanked in v0.3.3 in favor of the `$ json_parse` op. The reason: filters are string-in/string-out by design; parsed structures couldn't propagate as bindings through the pipe chain. Field access on parsed JSON (`$(VAR|json_parse).field`) was structurally impossible inside the filter signature.

The `$ json_parse $(VAR) -> OUT` op (see Ops reference §2) is the v0.3.3+ canonical way to parse JSON and bind a structured value. `$(OUT.field)` works for descent + `foreach OUT.items in ...` works for iteration.

```
# v0.3.3+ pattern (correct)
$ json_parse $(RAW) -> STATUS
! Title: $(STATUS.title)
if $(STATUS.healthy) == "true":
    ! All systems green
foreach ITEM in $(STATUS.items):
    ! - $(ITEM.id)

# v0.3.2 pattern (NO LONGER SUPPORTED — fires unknown-filter tier-1)
# $(RAW|json_parse).title
```

Authors with v0.3.2 skills migrate by replacing `$(X|json_parse).field` shapes with `$ json_parse $(X) -> P` + `$(P.field)`.

## Pending filters (v2/v3)

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

`join:"<sep>"` is parked: v0.5.0 ships string-typed `$append` + bind-time `$set` interpolation (bash-shaped pair) as the primitive way to compose lists into strings. `|join:` is the filter-shape alternative; reconsider if real filter-chain demand surfaces (e.g., a use case where the list comes from a chain and inline accumulation isn't viable).

## Composition philosophy

Filters are pure functions (input → output, no side effects). Stay small and orthogonal — each filter does one thing. Composition emerges from chaining, not from elaborate per-filter parameter spaces. The shipped set covers ~85% of real-world string-shaping needs; the pending set extends to slicing and array projection.

`length` (v0.2.5), `fallback:` (v0.5.0), and `isodate` (v0.5.0) were all added in response to cold-author harness signal — authored skills demonstrated the gap was load-bearing before each filter shipped. The v0.5.0 additions specifically: `|fallback:` came from R3 minion 5 hitting the missing-field strict-error trap; `|isodate` came from R3 minion 2 hitting the `$(NOW)` raw-epoch-ms surprise (paired with the runtime fix to make `$(NOW)` ISO by default).

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

`==` and `!=` against either quoted string literals or another `$(...)` ref. Filters and dotted-field access are permitted on either side.

```
if $(VERDICT) == "urgent":
    ...
elif $(VERDICT) != "quiet":
    ...
```

```
if $(FP|trim) == $(LAST_FP|trim):
    ! no change since last scan
elif $(M.id) != $(LAST_ID):
    ! drift detected
```

The ref-vs-ref form is the canonical change-detection pattern. Both sides resolve to strings at evaluation time; equality is byte-for-byte after filter application. No type coercion — `$(N) == "42"` compares the string form of N against the literal `"42"`, even if N is "numeric" elsewhere in the connector layer.

### Set membership (v2, shipped 2026-05-13)

```
if $(M.id|trim) in $(SEEN):
    ! already processed
elif $(M.id) not in $(SEEN):
    $ memorystore.write summary="..." detail="..."
```

Both sides are explicit refs. RHS must resolve to an array at runtime; clean error otherwise. LHS-undefined evaluates to `false` for both polarities. Optional filter on LHS.

**JSON-string tolerance on RHS** (added 2026-05-21): if the RHS resolves to a *string* that successfully JSON-parses to an array, the parsed array is used. This accommodates the canonical pattern where the array comes from a `~` op that prompted for JSON output:

```
~ prompt="List the URGENT memory IDs as a JSON array of strings. Items: $(M|json)" -> SEEN

foreach M in $(MEMORIES):
    if $(M.id) in $(SEEN):
        ! flagged urgent
```

`$(SEEN)` resolves to a string like `["abc", "def"]`; runtime JSON-parses, sees an array, uses it. Strings that don't JSON-parse to an array still error per the strict rule — only valid JSON arrays get the tolerance.

### Numeric comparison (v0.2.5)

`<`, `>`, `<=`, `>=` in `if`/`elif` conditions. Both operands resolve as strings (same as equality), then attempt numeric coercion. If both coerce, the comparison runs numerically. If either fails to coerce, runtime `TypeMismatchError`.

```
if $(DELTA) > $(THRESHOLD):
    ! ALERT: dropped past threshold
elif $(COUNT) <= 0:
    ! No items returned
```

Filters and dotted-field access work on either side, same as equality. The `|length` filter (see Pipe filters section) is the canonical companion — `$(LIST|length) > 5` is the natural "more than five items" pattern:

```
$ memorystore.query query="urgent" -> ITEMS
if $(ITEMS|length) > 5:
    ! Mailbox is getting crowded
```

**Decimal precision.** Coercion uses native number parsing — `5.00` and `5` both coerce to `5`. Skill authors should keep thresholds at the precision they care about; numeric comparison does not preserve trailing-zero string form.

**Why comparison, not arithmetic.** The orchestration carve-out: comparison operators land in the language because *conditionals are orchestration decisions*. Arithmetic operators (`+`, `-`, `*`, `/`) and aggregates (`min`, `max`, `sum`) are deliberately NOT in the grammar — those produce values, which is computation, which belongs in tools. The line is "comparison is orchestration; arithmetic is computation."

If you need to compute a value to compare against, the computation goes in a tool that returns the computed value; the skill compares the returned value. Skills stay orchestration-shaped.

### Logical connectives: `and` / `or` / `not` (v0.3.2)

Compound conditions via standard boolean connectives. Replaces the nested-`if` workaround for multi-factor decisions.

```
classify:
    ~ prompt="..." model=qwen -> VERDICT
    if $(VERDICT|trim) == "urgent" and $(SEVERITY|trim) > "5":
        ! escalate
    elif $(VERDICT|trim) == "urgent" or $(SEVERITY|trim) > "8":
        ! flag
    else:
        ! noted
```

**Precedence** (tightest to loosest):
1. Comparison: `==` / `!=` / `<` / `>` / `<=` / `>=` / `in` / `not in`
2. Unary: `not`
3. Binary: `and`
4. Binary: `or`

`a and b or c` parses as `(a and b) or c`. Standard convention; no surprise for cold authors. Parentheses available for explicit grouping when default precedence isn't what you want: `(a or b) and c`.

**Short-circuit semantics.** `if $(X) == "ok" and $(MAYBE_UNRESOLVED)` does NOT evaluate the RHS if the LHS already determined the result (false). Matches every other language; required for the "validate-then-access" pattern. The cross-feature interaction with `|json_parse` is critical here: `if $(VAR|json_parse).status == "ok" and $(VAR|json_parse).other` evaluates LHS once and branches — no double-parse when LHS short-circuits to false.

**Falsy check via `not`.** Pre-v0.3.2, the language had no clean falsy check — author had to enumerate `if $(VAR) == "":` / `if $(VAR) == "false":` / `if $(VAR) == "0":` separately. `not $(VAR)` closes this gap with one keyword.

```
mailbox_check:
    > mode=fts query="addressed:perry" limit=10 -> MAILBOX
    if not $(MAILBOX):
        ! empty mailbox today
    elif $(MAILBOX|length) > "5":
        ! triage backlog
```

**De Morgan via parens:** `if not ($(A) and $(B)):` works as expected.

**`not` with membership:** `not $(X) in $(LIST)` parses as `not ($(X) in $(LIST))` — membership-tighter-than-not convention.

**Lint interaction.** Existing `undeclared-var` lint still catches references to truly-undeclared vars at compile time. Short-circuit affects only runtime evaluation — "the var is declared, but might not be bound at this evaluation point" is the runtime-only case.

**Implementation status:** v0.3.2 ship in flight as of 2026-05-23. Pre-shipping spec — kept in sync with the v0.3.2 design thread `d01c9ab9-4372-44ce-ab67-b7b1a6430b05`. Implementation uses recursive structural decomposition over the existing simple-shape regex matchers (not a full Pratt parser) per CC's revised framing.

### What's NOT supported

- *No arithmetic ops* — no `+`, `-`, `*`, `/`. Arithmetic produces values; values come from tools. Comparison only (see Numeric comparison above).
- *No aggregate functions* — no `min`, `max`, `sum`, `mean`. Same reasoning: aggregates produce values; values come from tools.
- *No filter math* — filters apply to substitution, not to condition evaluation arithmetic.
- *No single-`=` assignment-in-condition* — this isn't a feature, it's a parse error. See below.

**Common parse error: single `=` in conditional position.** A single `=` in an `if`/`elif` condition is a parse error with a specific diagnostic:

```
error: '=' is not valid in a condition; use '==' for equality
  if $(VERDICT) = "urgent":
                ^
rewrite as: if $(VERDICT) == "urgent":
```

The grammar doesn't admit single-`=` in condition position at all — the parser catches the construction via a specific error production rather than failing with a generic "syntax error." Skillscript condition equality is always two-character `==`; single-`=` is the JavaScript-shaped bug pattern this rule blocks at parse time.

### Disambiguation: `else:` after target body vs `else:` after `if:`

Both shapes use the keyword `else:`. Distinguished by parser scope-stack at parse time:
- `else:` after a target's primary body → error handler (runs when any op in the body errors). See Error handling section.
- `else:` after `if:` / `elif:` chain → conditional branch.

Both can coexist in the same target. Conformance suite includes regression tests demonstrating both parse correctly without ambiguity.

## Iteration: `foreach`

`foreach IDENT in EXPR:` block iterates over a list, binding `IDENT` to each item per iteration. Body indented under the header; indent-based dedent returns to outer scope.

```
foreach M in $(RESULTS):
    ! Processing $(M.id) — $(M.summary)
    if $(M.id|trim) not in $(SEEN):
        $ memorystore.update id=$(M.id) pinned=true -> ACK
```

### Iterator vars

`$(M)` and `$(M.field)` pass through ambient at compile; runtime substitutes per iteration. Dotted field access against `PortableMemory` shape applies (core fields → curated subset → metadata). Indexed access (`$(LIST.0)`, `$(LIST.0.id)`) also works on bound results (documented v0.2.12).

### Loop-local scope (and the accumulator exception)

`$set` bindings inside the loop don't persist after the loop ends. Each iteration starts fresh from the loop binding.

**`$append` is the exception** (v0.3.0). Appending to a list-typed variable declared in the *enclosing* scope (target body or `# Vars:`) mutates the outer binding, surviving across iterations:

```
walk:
    $set FOUND = []
    foreach M in $(MESSAGES):
        if $(M.id) not in $(FOUND):
            $append FOUND $(M.id)
    ! Collected: $(FOUND|length) novel items
```

See the Ops reference `$append` section for the full lint rules (`uninitialized-append`, `foreach-local-accumulator-target`, `append-to-non-list`).

### What's NOT supported

- *No `while` loop* — iteration is bounded by the iterable's length. Unbounded loops are not expressible.
- *No `break` or `continue`* — every iteration runs to completion. Filter the iterable beforehand if you need exclusion.
- *No nested-loop variable capture* — inner-loop `$set` doesn't escape to outer scope. (Use `$append` against an outer-scope list-typed var for accumulator patterns — v0.3.0.)
- *No `parallel foreach`* — iteration is serial. `$append` inside a future `parallel foreach` is a tier-1 error in v0.3.0; semantics deferred to whenever parallel foreach ships.

## Composition philosophy

The grammar is deliberately narrow. The threshold for adding new grammar is "an authored skill demonstrates the gap is load-bearing." Composition through nested blocks + filter chains covers most real cases.

Ref-vs-ref equality and JSON-string `in` RHS tolerance were both added in 2026-05-21 because cold-context agents authoring against the spec reached for them as canonical patterns (change-detection for the former, JSON-array-from-LLM for the latter) — exactly the "authored skill demonstrates the gap is load-bearing" trigger. Numeric comparison (v0.2.5) followed the same precedent: the cold-agent stock-monitor minion battery reached for `if delta > threshold:` naturally and was forced into shell-out or LocalModel routing because the operators weren't in the grammar. `and`/`or`/`not` (v0.3.2) followed the same precedent across two wild-and-crazy harness rounds — 6/6 unanimous request for multi-factor conditions, plus the falsy-check gap (no clean `not $(VAR)` form) was structurally unimplementable.

The carve-out is principled: *comparison and logical connectives* land because conditionals ARE orchestration decisions; *arithmetic and aggregates* stay out because they produce values, which belong in tools. Future grammar extensions follow the same discipline: surfaced by real authoring need, not by speculative completeness, and only if they sit on the orchestration side of the line.

Authors writing complex conditional logic should consider:
- *Push the logic into a `~` LocalModel call* — let the model classify, return a one-word verdict, branch on equality
- *Push the logic into a connector* — wrap the complex check as an MCP tool, dispatch via `$`
- *Decompose into multiple skills* via `$ execute_skill` (see Composition section)

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

### `cron: <expression>` — time-based (shipped)

Standard 5-field cron. Sliding-window evaluation by a 30s poll loop. No catch-up replay if the runtime was down at fire time.

```
# Triggers: cron: 0 3 * * *
```

### `session: start | end` — session lifecycle hooks (shipped)

Fires when an agent session begins (`session: start`) or ends (`session: end`). The load-bearing primitive for prepping context at session boundaries — a session-start skill produces `prompt-context:` output that prepends to the next inference.

```
# Triggers: session: start
# Output: prompt-context: <agent-name>
```

### `event: <event-name>` — runtime-host-emitted events (parse-only, dispatch pending)

Header parses, but the event bus that would emit `event:` triggers isn't wired yet. Phase 2 work.

Example event categories (deployment-defined):
- `event: thread.replied` — a thread receives a new reply
- `event: mailbox.dangle` — an addressed item expires unprocessed
- `event: classifier.flagged` — a background classifier surfaces an urgent finding
- (extensible via runtime-host event registration)

### `agent-event: <agent>.<event>` — cross-agent event hooks (parse-only)

Subscribes to another agent's events. Same phase-2 dispatch status as `event:`.

```
# Triggers: agent-event: builder.task.completed
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

When a skill fires from a trigger, the runtime populates ambient refs accessible inside the skill body:

- `$(TRIGGER_TYPE)` — the trigger source (`cron`, `session`, etc.)
- `$(TRIGGER_PAYLOAD)` — source-specific data
- `$(EVENT.*)` — event-payload fields for `event:` / `agent-event:` triggers

## Trigger lifecycle

- **Registration:** declarative via header (auto on skill write) or imperative via the `registerTrigger` API
- **Storage:** registered triggers are records owned by the registering agent, indexed by source + name + agent_id + skill_id; the storage backend is connector-defined
- **Inspection:** `listTriggers({ skill_name?, agent_id?, source? })` returns the live registry
- **Archival:** `unregisterTrigger(trigger_id)` archives the trigger (audit trail preserved); declarative triggers are removed by editing the skill body to drop the declaration

## Multiple triggers

A skill may declare multiple triggers; each fires an independent execution. The compiled output is identical regardless of trigger; the runtime distinguishes via `$(TRIGGER_TYPE)`.

Open spec question: dedup on near-simultaneous fires. If `cron: 0 8 * * *` and `event: user.present` both fire within seconds, the runtime currently runs the skill twice (one per trigger). Author dedups via state if needed. Affects the dispatch layer.

## Output targets — # Output: header, delivery kinds

The `# Output:` header declares where a skill's result is delivered. Default behavior (no header) is `text` — return string to caller.

## Output kinds

### `text` (default, bare-only)

Returns the skill's result as a string to whatever invoked the skill via API or read the compiled prompt artifact. Bare-only — no target accepted; parse error if a target is supplied.

```
# Output: text
```

### `slack: <channel>` — Slack delivery

Posts to a Slack channel. Routes through the runtime's notification dispatch.

```
# Output: slack: <channel-name>
```

Phase-2 — header parses, dispatch routing pending implementation.

### `prompt-context: <agent>` — prepend to next-turn prompt context (shipped)

The load-bearing primitive for "hot-ready" briefings. Output prepends to the named agent's next-turn prompt context as a `<skill_output>` block.

```
# Output: prompt-context: <agent-name>
```

Used to bring an agent into the next turn pre-shaped — context that would normally require a session-start retrieval is pre-positioned in the prompt header. Wired end-to-end via the runtime host's prompt-prepend surface + a synchronous trigger-fire endpoint with timeout-fallback so the next-turn dispatch isn't blocked on slow skill execution.

### `template: <agent>` — deliver a rendered prompt for the agent to execute (shipped)

The Template-kind delivery. Output renders as a prompt the named agent executes itself — the runtime doesn't dispatch the ops, it hands the agent a playbook.

```
# Output: template: <agent-name>
```

Used for reusable recipes: a skill that, when compiled, produces instructions another agent follows. See the skill-kind taxonomy in Section 1 for the full framing.

### `file: <path>` — write to file

Writes output to a filesystem path. Phase-2 — header parses, file router pending.

### `card: <spec>` — structured UI card

Renders output as a structured card to the appropriate UI surface. Phase-2 — pending host UI card-render surface.

### `none` (bare-only)

Side-effects only — the skill's purpose is the writes / shell ops it performs, not the returned value. Bare-only; parse error if a target is supplied.

```
# Output: none
```

## Multiple output targets

A skill may declare multiple output targets, one per line. Each target receives the same content.

```
# Output: slack: ops-channel
# Output: prompt-context: assistant
```

A morning-brief skill, for example, can post to a team Slack channel and prepend to an assistant agent's session-start prompt context simultaneously.

## Per-kind output value semantics (shipped 2026-05-12)

Different output kinds consume the skill's execution result differently:

- **Presentation surfaces** (`slack:`, `prompt-context:`, `template:`, `card:`) consume joined emissions — all `!` ops in the skill body concatenated in execution order
- **Programmatic surfaces** (`text`, `file:`) consume the `lastBoundVar` — the most recently bound `-> VAR` value from any op

Single source of truth in the executor's `perKindOutput()` function; routers stay dumb (just consume what the executor hands them per kind).

## Augmenting / Template companion headers (v0.2.6)

Skills with `prompt-context:` or `template:` output kinds (Augmenting and Template kinds per the Section 1 taxonomy) can declare two companion headers that ride along with the delivery payload. Both are optional, both have no effect on Headless skills.

### `# Event-type: <string>`

Adopter-defined routing vocabulary — opaque to skillscript, meaningful to the receiving agent's handler-routing logic. Threads through to `DeliveryMeta.event_type` at dispatch time as the **frontmatter fallback** (per-emit `notify(event_type=...)` kwarg takes precedence). Renamed from `# Delivery-context:` in v0.9.6 for vocab consistency between skill-author and receiver-agent surfaces.

```
# Output: agent: perry
# Event-type: stock-price-threshold-breached
```

The receiving agent can route on this field without parsing content — e.g., `if event_type === "stock-price-threshold-breached": ... fetch the execute-trade-decision template`. Adopter chooses the vocabulary.

### `# Templates: <skill_name>, <skill_name>, ...`

Comma-separated list of Template-kind skills the receiving agent can fetch as follow-on actions. Threads through to the `DeliveryPayload.templates` field.

```
# Output: prompt-context: perry
# Templates: execute-trade-decision, log-alert, notify-portfolio-manager
```

The receiving agent reads the augment content + sees the available follow-on templates + picks the right one (or none) based on context. Composition primitive — Augmenting routes into Template via this header.

### Lint coverage

A tier-2 lint rule `unused-augmenting-header` fires when either header appears on a Headless skill (no `prompt-context:` or `template:` output declared). Headless skills have no AgentConnector dispatch path, so the headers would silently no-op — the lint warns the author to either change the output kind or remove the header.

## Grammar

- Kinds with no target (`text`, `none`) are bare-only — `# Output: text` is valid, `# Output: text: anything` is a parse error.
- Kinds with a target (`slack`, `prompt-context`, `template`, `file`, `card`) require `<kind>: <target>` — `# Output: slack` without a target is a parse error.
- Authoring friction-fix: parse errors on bare-only kinds suggest the corrected shape inline.

## Output routing failures

If `# Output: slack: <channel>` and Slack is down, the runtime's behavior is currently unspecified. Spec question: queue-and-retry, error-to-caller, or silent best-effort? Pending decision. Affects dispatch layer.

## Lifecycle and status — # Status: header, six canonical states, compile + runtime enforcement

Skillscripts carry an explicit lifecycle state via the `# Status:` header. The compiler and runtime enforce status — a Disabled skillscript cannot fire under any path, regardless of who invokes it.

## Header syntax

```
# Skill: support-response-draft
# Status: Approved
# Description: ...
```

If `# Status:` is omitted, the default state is **Draft**. This forces authors to explicitly promote a skillscript through its lifecycle rather than relying on "newly written = ready for use."

**Case normalization:** Status values are accepted case-insensitively on input and stored as canonical form. `# Status: draft`, `# Status: Draft`, `# Status: DRAFT` all parse to canonical `Draft`. Per the Section 1 lexical convention, this principle applies across all enumerated frontmatter value spaces.

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

The trigger registry respects status. A skillscript in Draft or Disabled state has its declared triggers held in a non-firing state — the trigger is registered (visible via `listTriggers`) but the scheduler skips dispatch. This lets authors register triggers while still in Draft mode without risking accidental production fires.

When a skillscript transitions to Approved, its triggers activate. When it transitions to Disabled, its triggers deactivate.

## State transitions

For v1, status transitions are freeform — any author with write authority on the skillscript can flip the status by editing the header. v2 may add transition rules (Draft → Approved with lint-pass requirement; Disabled requiring admin-level permission) once a real authorship-permissions story is in place.

## Audit trail

Status changes are visible via the storage substrate's versioning. For memory-backed skillscripts, each header change is a new record revision; the version history shows the lifecycle. For file-backed skillscripts, status changes show up in git history. The audit trail is part of the substrate, not part of the language.

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

Skillscript provides three layers of error handling, working from local to global. All three shipped in v1.

## Layer 1: Target-level `else:` block

Runs if any op in the target's primary body errors. Local to the failing target. Downstream targets that depend on this one can still proceed using whatever the `else:` branch produced.

```
fetch:
    > mode=fts query=$(TOPIC) limit=5 -> RESULT
else:
    ! retrieval failed, falling back to empty result
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
- An additional `$(ERROR_CONTEXT)` ambient ref containing the error type and the target where it failed

### Constraint

Nested `# OnError:` is *not* supported. If `# OnError: degraded-skill` fires and `degraded-skill` itself errors, the runtime hard-exits with no further fallback. Spec is explicit on this.

## Layer 3: Op-level fallback values for `$`, `>`, and `~`

Inline fallback declared on the op line. Used when the call fails or returns empty. Supported on all three dispatch ops (`$` MCP tools, `>` retrieval, `~` LocalModel) with identical coerce-on-bind semantics.

```
weather:
    > mode=fts query="weather $(LOCATION)" limit=1 -> CURRENT (fallback: "weather unavailable")
    ~ prompt="Summarize: $(CURRENT)" -> SUMMARY (fallback: "summary unavailable")
    $ slack.post channel=$(CHANNEL) text=$(SUMMARY) (fallback: "post failed silently") -> ACK
```

Same pattern as the `# Requires:` cascade's `(fallback: ...)` syntax — consistent across compile-time (`# Requires:`) and runtime (`$` / `>` / `~`).

**Fallback value parsing.** Permissive: bare identifiers, quoted strings, and bracketed array literals all accepted. Matches the `# Requires:` cascade convention.

```
> ... -> RESULTS (fallback: [])              # array literal
~ ... -> VERDICT (fallback: unknown)         # bare identifier
$ ... -> ACK (fallback: "post failed")       # quoted string
```

**Coerce-on-bind semantics.** On op throw or empty-result, the fallback value is bound to the outputVar via the same path as a successful result. Downstream targets see the fallback transparently — they don't need conditional checks to detect "did this op fail?" The op-level fallback IS the default-on-failure value.

`$` was added to Layer 3 in 2026-05-21 (originally `~`/`>` only). Symmetry with the other dispatch ops; cold-context agents reached for the pattern on `$` ops as the natural extension of the documented behavior. Spec catch-up to authoring reality.

## Error propagation rules

- Op error → caught by `else:` if present, otherwise propagates to target
- Target error → caught by `# OnError:` if present, otherwise propagates to caller
- Caller can still catch via standard exception handling on compile / runtime invocation APIs
- `else:` blocks are not allowed to declare their own error handlers
- If an `else:` block itself fails, the whole target fails through `# OnError:` (if present)

## Visibility into errors

Open spec question: should `$(ERROR)` be ambient inside `else:` blocks (same shape as `$(ERROR_CONTEXT)` in `# OnError:` fallbacks)? Current lean: yes. Useful for telemetry skills that need to know what failed before falling back. Not yet specified or shipped.

## The fallback pattern is consistent across scopes

Same idea at every scope:
- Compile-time: `# Requires: ... (fallback: value)`
- Runtime op: `$`, `>`, `~` all accept `(fallback: value)` with identical semantics
- Runtime target: `else:` block
- Whole skill: `# OnError:` header

Authors composing complex skills use these in combination — op-level for transient errors, target-level for cohesive error paths, skill-level for last-resort degradation.

## Connection to runtime observability

Per-op error contract is what makes cascading fallbacks work. When `$` returns `isError: true`, the executor throws via `makeOpError` rather than binding the error text to the output var. The throw routes through `else:` / `# OnError:` machinery and surfaces in `result.errors[]` for the scheduler to log. Without this discipline, op-level failures wouldn't propagate to the fallback layers and silent-fail would be the default.

## Connectors — McpConnector / AgentConnector / SkillStore; substrate-neutral framing (v0.7.0)

**v0.7.0.** Replaces prior `50332e7e-1fd4-4e68-8817-dfc2663a13a2` (v0.5.0) on doc anchor swap. Reflects shipped commit `7612571` (locked framework `c48fca7e`, approved `783a10a4`; spec answers `f8aff1b7`).

---

The substrate-routing ops route through thin connector interfaces. The language is portable across substrates because skill source doesn't bake substrate identity in.

**v0.7.0 substrate-neutrality.** `MemoryStore` and `LocalModel` are no longer language-level connector contracts. The `~` and `>` symbols are deprecated under the grace-period framing (§2). What was previously "the LocalModel contract" is now an *adopter convention*: declare a connector (e.g., named `llm` if that's a useful name for your wiring) in `connectors.json` that conforms to a prompt-in/text-out shape. Same for memory query and memory write. The language doesn't know or care whether the adopter wires Ollama, OpenAI, Anthropic Claude, Pinecone, AMP, Weaviate, or anything else.

This is the load-bearing v0.7.0 change. Adopters who want a memory + LLM substrate wire whatever they like; the language stops privileging any particular backend.

## Three language-relevant connector contracts

| Contract | Routes | Stays language-relevant because |
|---|---|---|
| **McpConnector** | All `$ <connector>` external dispatch | Universal substrate-bridging surface; the language's main "call out to the world" primitive |
| **AgentConnector** | `# Output: prompt-context:`, `# Output: template:` | Agent-bound delivery channels need a structured contract for `deliver` + `wake` semantics |
| **SkillStore** | Skill source persistence + `inline(skill=...)` + `execute_skill(skill_name=...)` | The language needs to find skills by name |

`file_read` and `file_write` are runtime-intrinsic ops with direct OS-level dispatch — no connector contract for general filesystem I/O. If an adopter needs exotic file backends (S3, virtual FS, encrypted-at-rest, etc.), they wire a custom MCP connector and dispatch via `$ <name>` instead of `file_write`.

### McpConnector

Routes every `$ <connector>` op. Interface: `McpConnector.call(args, ctxOverrides?) → unknown`.

Each entry in `connectors.json` is a connector — flat namespace, name → instance. The name is what skill source references (`$ youtrack_search ...`); the entry declares the wire protocol, underlying tool/endpoint, identity, and per-connector metadata.

```jsonc
{
  "mcpConnectors": {
    "llm":             { "type": "OllamaMcpConnector", "model": "qwen2.5:7b" },
    "memory":          { "type": "RemoteMcpConnector", "tool": "your_memory_tool" },
    "memory_write":    { "type": "RemoteMcpConnector", "tool": "amp_write_memory", "mutating": true },
    "youtrack_search": { "type": "RemoteMcpConnector", "endpoint": "...", "tool": "search_issues" },
    "youtrack":        { "type": "RemoteMcpConnector", "endpoint": "..." },
    "agent_notify":    { "type": "WebhookMcpConnector", "endpoint": "..." }
  }
}
```

#### Two dispatch forms — flat and dotted

Both forms are first-class. Neither is canonical; choose by what makes the call site clearer.

**Flat-name dispatch** is the common case. The tool name resolves against the wired connector (most often the `primary` connector's tool list, or a dedicated entry per tool):

```
$ youtrack_search query="project:INFRA" -> R
$ llm prompt="${INPUT}" -> V
$ memory mode=fts query="..." limit=5 -> M
```

**Dotted-prefix dispatch** is the explicit-routing escape hatch — useful when multiple connectors expose tools with overlapping names, or when an adopter wants the connector identity visible at the call site for audit clarity:

```
$ youtrack.search query="project:INFRA" -> R
$ personal_mcp.write_note title="..." body="${SUMMARY}"
$ amp.query_memories query="..." -> M
```

Parser rule: `^([a-z_][a-z0-9_-]*)\.(?=[A-Za-z_])([\s\S]*)$` matches the dotted prefix. The text before the dot is the connector name (must match an entry in `connectors.json`); the rest is the tool + args.

A typical `connectors.json` mostly uses flat names because our wired tools have unique names. Adopters with overlapping tool names across connectors should prefer the dotted form at those call sites.

**`mutating` classification.** Each connector entry declares `"mutating": true | false` (default `false`). Mutating connectors are subject to the §2 per-op gating rule (v0.7.1+ enforcement).

**`allowed_tools` constraint** (carried from v0.4.1): per-connector entry may declare `"allowed_tools": [...]` to constrain dispatch surface for minion-safe defaults. Dispatch outside the allowlist → tier-1 `disallowed-tool` lint.

**Identity merge** (carried from v0.5.0): a connector entry may declare `identity: { agentId: "...", isAdmin: false }`. Merge order at dispatch (top wins):

1. Registry-configured per-connector identity
2. Per-call `ctxOverrides` from the runtime
3. (no intrinsic identity) — adapter forwards whatever the merge produces

Configured identity is a *partial merge* — unmentioned keys flow through from the per-call ctx. Default connectors should configure no intrinsic identity, so `ctxOverrides` always wins.

**Unknown connector at compile time** → tier-1 `unknown-connector` lint listing every wired connector name.

### AgentConnector

Routes agent-bound `# Output:` kinds — `prompt-context:` and `template:`. Interface unchanged from v0.5.0:

```typescript
interface AgentConnector {
  list_agents(): Promise<AgentDescriptor[]>;
  deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt>;
  wake(agent_id: string, opts?: WakeOpts): Promise<WakeReceipt>;
  health_check(): Promise<boolean>;
  request_response(agent_id: string, payload: DeliveryPayload, opts: RequestResponseOpts): Promise<Response>;
  agent_status?(agent_id: string): Promise<AgentStatus>;
}

// v0.9.6 audit Q8 — DeliveryMeta envelope locked at v1.0
type DeliveryPayload =
  | { kind: "augment"; content: string; meta: DeliveryMeta }
  | { kind: "template"; prompt: string; meta: DeliveryMeta };

interface DeliveryMeta {
  dispatch_id: string;       // UUID per emit; same across broadcast branches
  sent_at: number;           // unix ms — runtime emit-clock
  origin: {
    skill_name: string;
    entry_skill_name?: string;
    trigger_kind: "cron" | "session" | "webhook" | "agent" | "cli" | "dashboard" | "inline";
    caller_agent_id?: string;
  };
  event_type?: string;       // adopter-defined routing label
  correlation_id?: string;   // reply-correlation for exchange()
}

type DeliveryReceipt = { delivered_at: number; delivery_id?: string; delivery_skipped?: boolean };
type Response = { correlation_id: string; content: string; sent_at: number; agent_id: string };
type RequestResponseOpts = { timeout_ms: number };
type WakeOpts = { context?: string; when?: "immediate" | number };
type WakeReceipt = { woken_at: number; session_id?: string };
type AgentDescriptor = { agent_id: string; agent_name?: string; capabilities?: ("deliver" | "wake" | "augment" | "template")[]; };
type AgentStatus = "active" | "idle" | "asleep" | "unknown";
```

Two primary verbs (`deliver` + `wake`), one mandatory discovery method (`list_agents`), one optional status method.

The contract is substrate-neutral; adopters wire any delivery mechanism behind it:

| Substrate | `deliver` impl | `wake` impl |
|---|---|---|
| tmux session | `tmux send-keys` to a pane | `tmux send-keys` with wake prompt |
| webhook | POST to `/augment` or `/template` endpoint | POST to `/wake` endpoint |
| memory store | write a memory record with delivery tag | write addressed memory + push notification |
| file-watch | write to `<path>/augment-<id>.txt` | write to `<path>/wake-<id>.txt` |
| chat thread | post to monitored thread | post + @mention |

Default impl `NoOpAgentConnector` logs warnings and resolves; lets the runtime ship without an agent-delivery substrate wired.

**DeliveryMeta envelope (v0.9.6):** every `deliver()` call carries a `meta: DeliveryMeta` field. Runtime auto-fills `dispatch_id`, `sent_at`, `origin.skill_name`, `origin.trigger_kind`. Optional fields (`event_type`, `correlation_id`, `entry_skill_name`, `caller_agent_id`) populate when context provides them. Adopters consume meta substrate-side (webhook: JSON field; tmux: header line; whatever); they never construct meta themselves.

**`agent_id` resolution chain** (4-level, first match wins):

1. **Explicit name in `# Output:` line** — `# Output: prompt-context: perry`
2. **Invocation context** — agent-event trigger or runtime API `agent_id` context
3. **Input var override** — `# Output: prompt-context: ${TARGET_AGENT}`
4. **Runtime config default** — `default_agent_id`

### SkillStore

Routes skill source persistence + composition lookups (`inline(skill=...)`, `execute_skill(skill_name=...)`). Interface unchanged from v0.5.0:

```typescript
interface SkillStore {
  get(name: string): Promise<SkillRecord | null>;
  write(name: string, body: string): Promise<void>;
  list(): Promise<SkillDescriptor[]>;
  delete(name: string): Promise<void>;
}
```

Bundled `FilesystemSkillStore` reads and writes `.skill.md` source plus `.skill` compiled output and `.skill.provenance.json` sidecar in a configured directory; the standard for file-backed deployments.

Skill records are infrastructure, not knowledge atoms — adopter impls should treat skills as first-class long-lived records, not as candidates for substrate-level garbage collection.

## Connector names are convention, not reservation

Names like `llm`, `memory`, `memory_write`, `agent_notify`, `youtrack_search` are **adopter-chosen identifiers**, not language-reserved keywords. The parser does not special-case any of them; they're just entries in `connectors.json`. The `unknown-connector` tier-1 lint is the safety net — typos against wired connector names fire at compile time with the list of valid names.

Pick the connector names that read well at your call sites. `llm` and `memory` are descriptive for substrates that play those roles. An OpenAI shop might wire `openai_chat` and `openai_embeddings`. A Pinecone-and-Claude shop might wire `pinecone` and `claude`. Skill source written against one adopter's names is portable to another adopter's wiring only insofar as the names match — or via mechanical rewrite at adoption time.

The implication for skill authors: pick descriptive names that match what the connector does, not what backend it currently points at. `llm` is more portable than `ollama_qwen`; `memory` is more portable than `amp_query`. But neither is enforced.

## Removed: MemoryStore and LocalModel as language contracts

Previously the language declared:
- `MemoryStore` interface (`query(filters) → PortableMemory[]`) for `>` dispatch
- `LocalModel` interface (`run(prompt, opts) → string`) for `~` dispatch

Both are removed as language-special in v0.7.0. The `~` and `>` symbols continue to compile during the grace period (§2) and route through the canonical `$ llm` / `$ memory` dispatch path. Adopters who want memory or LLM connectivity wire them as ordinary MCP connectors:

```jsonc
{
  "mcpConnectors": {
    "memory":       { "type": "RemoteMcpConnector", "tool": "your_memory_tool" },
    "memory_write": { "type": "RemoteMcpConnector", "tool": "amp_write_memory", "mutating": true },
    "llm":          { "type": "OllamaMcpConnector", "model": "qwen2.5:7b" }
  }
}
```

Skill source calls `$ memory mode=fts query="${TOPIC}" -> R` and `$ llm prompt="${P}" -> V` — same behavior as `>` and `~` provided in v0.5.0, routed through the universal MCP dispatch surface.

**Why remove them.** Two contracts that bundled wire-protocol + canonical-shape (PortableMemory, prompt-in/text-out) became an amp-substrate privilege in practice: the language assumed memory looked like AMP memories and LLM calls looked like Ollama. Adopters wiring OpenAI or Pinecone had to write awkward shape-translator shims because the language insisted on its own canonical shapes. v0.7.0 lets adopters declare whatever shapes their MCP tools natively return; skills access fields via the same `${VAR.field}` dotted-access semantics as any other tool dispatch.

**Migration.** The v0.7.0 codebase included a one-shot internal migration script (`scripts/migrate-v07.mjs`) used to migrate the bundled examples, then deleted post-run. There is no permanent migration CLI. Adopters with existing skills can:
- Re-derive the rewrites mechanically — the rules are documented in `CHANGELOG.md` under `## 0.7.0 — Migration`. The reference mapping (`~` → `$ llm`, `>` → `$ memory`) is one valid set of names; adopters substitute whatever connector names they wire.
- Use editor find-and-replace.
- Write new skills against the canonical surface from day one.

Most adopters land in the third category because Skillscript is pre-adoption.

## Multi-instance by design

Multiple connector entries for the same underlying substrate are the normal case. The flat-namespace shape encourages this:

```jsonc
{
  "mcpConnectors": {
    "llm_fast":   { "type": "OllamaMcpConnector", "model": "phi3:mini" },
    "llm":        { "type": "OllamaMcpConnector", "model": "qwen2.5:7b" },
    "llm_batch":  { "type": "OllamaMcpConnector", "model": "gemma2:9b" }
  }
}
```

Skill source picks the connector by name: `$ llm_fast prompt="..."` for quick classifiers, `$ llm prompt="..."` for default, `$ llm_batch prompt="..."` for async heavy work.

The convention from v0.5.0 still applies — small batch-class model for asynchronous / background work, larger dispatch-class model for interactive verdicts. Skill authors and operators own model-tier allocation; the runtime makes no concurrency-safety promises.

## Model contention property

Carried unchanged from v0.5.0. Any skill that dispatches to an LLM connector shares the underlying local-model service with every other process on the deployment. Most local-model services serialize per-model dispatch. A skill that fires asynchronous batch work and then immediately dispatches to the same model will race itself — the synchronous call queues behind the batch.

Canonical mitigation: use distinct connectors (and underlying models) for the synchronous and asynchronous paths.

## Per-skill connector selection

Skills declare which connectors they use, by name, when they care:

```
# Connectors: mcp=[llm, memory, youtrack_search]
```

Discipline about declared intent. A skill that depends on a specific connector says so; a substrate-blind skill omits the header.

Runtime fails fast if a named connector is unavailable. (Phase 3 enforcement still pending; declarative for now.)

## Connector resolution chain

Connectors are runtime-resolved — the compiler stays pure read+transform. Compiled artifacts are generic; any runtime can dispatch them through whatever connectors it has configured. Resolution chain (first match wins):

1. **Env var** — `SKILLFILE_CONNECTORS_CONFIG` for multi-store config override. Ad-hoc / test override.
2. **Working-dir / agent-scoped `connectors.json`** — persistent per-agent override.
3. **Server default** — bundled with the compiler. Common-case fallback.

Per-deployment naming lives in config, not the contract. A given deployment registers concrete instances under whatever names make sense locally; skill authors reference those names.

The `connectors.json` loader (shipped v0.4.0+) handles literal + `${ENV_VAR}` credential resolution, file-discovery via `$SKILLSCRIPT_HOME`, and a closed-set class registry. The `allowed_tools` field per-connector entry constrains dispatch surface for minion-safe defaults.

## Capabilities discovery

All connector types expose `capabilities()` for runtime discovery. Three consumers:
1. Static `# Requires:` matching
2. Dynamic queries via `listMcpConnectors()` / `listAgentConnectors()` to pick a connector for the moment
3. Authoring tools that surface the registered set

## Portable shape conventions (adopter-level, not language-level)

For adopters who want their memory connectors to be interchangeable across deployments, the v0.5.0 `PortableMemory` shape is a recommended convention — not a language-enforced contract:

```typescript
interface PortableMemory {
  id: string;
  summary: string;
  detail?: string;
  score?: number;

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

  metadata?: Record<string, unknown>;
}
```

Adopters who follow the convention get cross-substrate skill portability (a skill that accesses `${R.summary}` works against any memory connector that returns this shape). Adopters who don't follow it write skills that access whatever fields their substrate natively exposes — also valid.

The language doesn't validate the shape; it just provides the `${VAR.field}` dotted access. Conformance is a deployment-level discipline.

## Why connector abstraction matters

Hard-coupling skills to specific substrates would make information-flow decisions infrastructural rather than skill-authored, defeating the point of skills as the agent's programming language. The connector layer is what lets the same skill body run against substrate A today and substrate B tomorrow without rewriting.

v0.7.0's substrate-neutrality move (removing MemoryStore + LocalModel as privileged language contracts) is the cleanest expression of this principle: the language describes the *pipeline* (trigger → process → deliver), and adopters describe the *substrate* (which connectors handle which roles). Two concerns, two layers, no leak between them.

## Composition — skills calling skills (v0.2.8)

# Composition — skills calling skills

Skillscript supports skill-to-skill composition via the runtime's public composition primitive. A parent skill invokes a child skill, optionally passes inputs, optionally binds the child's result. The runtime threads variable state, propagates errors, and enforces a recursion-depth guard.

**Shipping shape (v0.2.8):** composition is exposed as an MCP tool `execute_skill`, dispatched from within a skill via the `$` op. Symmetric with `compile_skill` and `lint_skill` — same surface, same naming convention, no external-namespace dependency. This is the public-runtime composition path; no private connector wiring required.

**Future shape (v0.3.x+):** a dedicated language primitive `call: <skill_name>` may compile down to the same MCP dispatch, giving authors a cleaner syntax without re-deriving the orchestration. Deferred pending cold-author evidence on whether the language sugar is worth the surface area.

## Surface

```skillfile
parent:
    $ execute_skill skill_name="child" -> RESULT
    ! Child returned: $(RESULT)
```

The `$` op dispatches `execute_skill` from the runtime's MCP surface. The child skill runs to completion against the runtime's wired connectors, returns its full result, and binds to the named variable.

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

**Skill resolution.** The runtime resolves `skill_name` against the configured SkillStore at dispatch time. Missing skills produce a clean structured error (`MissingSkillReferenceError extends OpError` per v0.3.1) — the parent's `(fallback: ...)` discipline applies if specified, otherwise the parent skill's `# OnError:` fallback fires if declared, otherwise the parent fails with the error propagated through.

**Input override.** Inputs map keys must match the child's `# Vars:` declarations. Undeclared keys are ignored. Required vars without defaults must be supplied or dispatch fails before the child starts.

**Variable threading.** The parent's variable scope is sealed from the child's; the child sees only its declared `# Vars:` plus the inputs override plus ambient refs. The child's emitted result binds to the parent's named variable via `-> RESULT`. The child's transcript surfaces through the parent's transcript with provenance attribution.

**Mechanical mode (the TestFlight property).** When `mechanical: true`, the dispatch graph renders without firing side-effect ops. `$` binds null, `~` binds a self-describing placeholder string, `>` (retrieval ops) bind an empty array. The mechanical flag propagates through recursive `$ execute_skill` calls — the whole sub-graph previews end-to-end, no real services touched. Authors use this to validate a multi-skill composition chain before committing to any real call.

**Recursion guard.** The runtime enforces a configurable recursion-depth limit (default 5-10 per implementation) to prevent infinite-loop composition. Exceeding the limit raises a clean structured error attributable to the offending dispatch site, not a stack overflow.

## Forward-reference resolution (v0.3.1)

Prior to v0.3.1, all skill references (`& <name>`, `$ execute_skill skill_name=X`, `# Templates: ...`) were validated against the live SkillStore at compile time. Missing-target references failed compile with tier-1 errors — making it impossible to author sibling skills together (chicken-and-egg).

**v0.3.1 demoted three lint rules from tier-1 to tier-2:**
- `unknown-skill-reference` (covers `&` and `$ execute_skill skill_name=X`)
- `unknown-template-reference` (covers `# Templates: ...`)

Plus a new tier-3 advisory:
- `deferred-skill-reference` — fires alongside the demoted tier-2 with a teaching message: *"Skill 'X' referenced via `<op>` is not currently in the SkillStore. Lint demoted in v0.3.1 — will resolve at execute time if the skill exists by then, or throw `SkillNotFoundError` if not. If this is a typo, fix it now; if it's a forward reference, this advisory will clear once you store 'X'."*

**Runtime behavior:** when a deferred reference still can't resolve at execute time, the runtime throws `MissingSkillReferenceError extends OpError` with structured fields (`missingSkillName`, `viaOp` for the op kind, inherited `target` and `opKind`). The error flows through `# OnError:` fallback chain naturally.

**Stronger contracts kept tier-1:**
- `# OnError: <missing>` — error-handler missing-at-runtime is the worst possible UX moment to discover a missing reference; explicit at compile is the right call.
- `disabled-skill-reference` — pointing at a Disabled skill is a stronger contract than "missing yet to be authored"; explicit at compile.

## When to use composition vs other primitives

Three distinct cases that look similar but have different intents:

1. **Get a value back from another skill.** Use `$ execute_skill skill_name="..." -> RESULT` and use `$(RESULT)` locally. This is the composition primitive case.

2. **Delegate work to an agent as a task.** Use `output: template:` to route a compiled artifact through AgentConnector. The receiving agent acts on the prompt. *This is the Template-skill story* — uses compile-as-delivery, not execute-and-bind.

3. **Augment an agent's context with a result.** Use `output: agent:` (with optional `# Event-type:` header) to route the executed skill's output into the receiving agent's prompt context. *This is the Augmenting-skill story* shipped in v0.2.6; v0.9.6 renamed `# Delivery-context:` → `# Event-type:` per the contract audit.

The composition primitive (case 1) is for *intra-skill value passing*. Cases 2 and 3 are for *cross-agent delivery*. The runtime handles all three; the right primitive matches the intent.

## Examples

**Simple call + bind:**

```skillfile
# Skill: greeting
# Status: Approved
# Vars: NAME=world

greet:
    ! Hello, $(NAME)!

default: greet
```

```skillfile
# Skill: parent
# Status: Approved

call_greeting:
    $ execute_skill skill_name="greeting" -> GREETING_RESULT
    ! Greeting skill said: $(GREETING_RESULT)

default: call_greeting
```

**Composition with input override:**

```skillfile
# Skill: parent-with-inputs
# Status: Approved
# Vars: TARGET_NAME=alice

call_with_inputs:
    $ execute_skill skill_name="greeting" inputs={"NAME": "$(TARGET_NAME)"} -> RESULT
    ! Customized greeting: $(RESULT)

default: call_with_inputs
```

**Defensive composition with fallback:**

```skillfile
# Skill: defensive-parent
# Status: Approved

call_maybe_missing:
    $ execute_skill skill_name="might-not-exist" -> RESULT (fallback: "child unavailable")
    ! Result: $(RESULT)

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

## Authoring discipline

- Treat composition as a real cost. Each `$ execute_skill` dispatch incurs the child's full execution time + side effects. Don't compose for trivial cases that could be inlined.
- Pair composition with `(fallback: ...)` when the child skill might fail and the parent has a sensible degraded path.
- Use mechanical mode to TestFlight any multi-skill chain before shipping it as a Headless skill on a cron trigger.
- Forward references work as of v0.3.1 — author sibling skills in any order, validate independently. The tier-2 warning surfaces the deferred-resolution path; runtime catches genuine misses.
- Recursion is legal but bounded. If your design requires deeper recursion than the configured limit, reshape the workflow — almost always a sign of an iteration that should be expressed as `foreach` rather than recursion.

## Implementation status

- **`execute_skill` MCP tool + in-skill `$ execute_skill` intercept:** shipped v0.2.8
- **`inputs={...}` kwarg propagation:** shipped v0.2.9 (bug fix)
- **Composition `help({topic: "composition"})` topic:** shipped v0.2.11
- **Forward-reference deferred resolution:** shipped v0.3.1 (lint demotion + tier-3 advisory + `MissingSkillReferenceError`)
- **Language primitive `call:`:** deferred indefinitely (v0.3.x candidate, no real demand yet)

## Static vs Dynamic — skill execution model (v0.3.x)

# Static vs Dynamic — Skill Execution Model

Orthogonal to the three skill *kinds* (Headless / Augmenting / Template, which describe the skill's relationship to the frontier agent), every skill has an *execution model* that describes its relationship to the Skillscript runtime.

## Static skill

A static skill compiles to a portable artifact that any agent capable of reading prose can execute. The compiled output is the deliverable — it does not require the Skillscript runtime, wired connectors, or dispatch machinery to run.

A static skill can be:
- **A pure recipe** — procedure steps the executor follows using their own tools and judgment
- **A data + recipe bundle** — data embedded in the skill (via `# Vars:` defaults or `&` inlines) plus instructions for what to do with it
- **A reference to known-local tools** — may reference shell binaries (`curl`, `jq`, etc.) that the executor is expected to have; the executor invokes those themselves rather than via Skillscript's `@` dispatch

Static skills are useful for:
- **Skill sharing** — a `.skill` artifact can be emailed, posted, or otherwise distributed without runtime ownership transfer
- **Pipelining data with procedure** — "here are 30 customer reviews. Theme them and emit a summary." The data + recipe ship together; the executor runs them.
- **Knowledge artifacts** — durable procedures that survive the runtime they were authored on
- **Cross-platform deliveries** — a static skill compiled on a Skillscript runtime can be executed by Claude, GPT, or any frontier agent

The Template-kind skill is the canonical static shape — its `# Output: template:` declaration explicitly indicates the runtime doesn't dispatch the body; instead, the compiled artifact is routed to the receiving agent for execution.

## Dynamic skill

A dynamic skill requires the Skillscript runtime to execute. The runtime walks the dispatch DAG, fires `$` / `~` / `@` / `>` ops against wired connectors, and threads outputs through variable bindings.

Dynamic skills are the default for:
- **Autonomous workflows** — cron-fired Headless skills that fetch, reason, and emit
- **Composition orchestrators** — parent skills that invoke child skills via `$ execute_skill`
- **Augmenting deliveries** — skills that gather material via dispatches before composing an augment payload

Dynamic skills bind their behavior to the specific runtime they're executed on: connector configuration, model selection, shell-execution mode, persistent trigger registry. They are not portable in the way static skills are.

## Orthogonality to skill kind

| | Headless | Augmenting | Template |
|---|---|---|---|
| **Static** | rare (only-`!` cron-fired emission skills) | possible (text-only augment with no fetches) | common (the default Template shape) |
| **Dynamic** | common (the default Headless shape) | common (the default Augmenting shape) | possible (Template with `$` setup ops before the prompt body) |

The axes are independent. A skill author can produce any combination.

## Compile-time portability validation (proposed v0.3.x)

A `# Portability: static | dynamic` frontmatter header would declare the skill's intended execution model. The compiler would lint-check that the skill's op set is consistent with the declaration:

- `# Portability: static` → no `$` / `~` / `@` / `>` / `??` ops permitted (only `!`, `$set`, `&`, conditionals, iteration, `# Vars:` and `# OnError:`)
- `# Portability: dynamic` (or unset, the default) → any op permitted

A new compile mode `compile_skill({source, mode: "static"})` would render only the portable artifact, refusing skills that depend on runtime dispatch.

## When to choose which

**Choose static when:**
- The skill should be portable beyond this runtime
- The skill's value is the procedure or data + procedure, not the dispatch behavior
- The skill will be shared, distributed, or executed by an external agent
- Pipelining a known data payload through a recipe

**Choose dynamic when:**
- The skill needs to fetch, reason against, or emit through wired connectors
- The skill is autonomous (cron-fired) or augmenting (live context)
- The skill composes other skills via runtime dispatch (`$ execute_skill`)
- The skill is bound to this runtime's connector configuration

## Implementation status

The static/dynamic distinction is a v0.3.x roadmap concept as of 2026-05-23. Today's skills are all "dynamic" by default; static skills work in practice (any skill whose ops are only `!` / `$set` / `&` / conditionals / iteration is portable), but the language doesn't yet declare or enforce the distinction.

The recipe-with-data pattern is implicit today via `# Vars:` defaults + `&` data-skill inlines — a static skill can carry payload via these mechanisms without runtime dependence.</detail>
<parameter name="domain_tags">["skillscript", "language-reference", "execution-model", "project:skillscript"]

## Tests — # Tests: block, given/expect assertions (pending v2)

The `# Tests:` header introduces a block of test cases that travel with the skill body. Each case has `given:` (variable overrides) and `expect:` (assertions on the compiled output or runtime side effects).

## Status: pending v2

Header parsing and test runner not yet shipped. The grammar below is the agreed design but the implementation is queued behind shipping `&` skill-invocation and runtime trigger dispatch.

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

`# Tests:` cases that exercise runtime behavior (memory writes, shell ops, LocalModel calls) need a sandbox so they don't pollute production data. Two approaches:
- Scratch DB / scratch connector overrides for tests
- Skip-and-warn for non-deterministic ops, only assert deterministic compile-time properties

Out of v2 scope; deferred until the test runner ships.

### Discovery and naming collisions

When the skill library grows past ~20 skills, name typos in `&` invocations become a real risk. No "list available skills with their inputs" surface yet. Probably wants a `skill_list` API and/or an IDE plugin.

### Property-based tests

The current design covers example-based tests. Property-based tests (`for all inputs in {...}, output matches pattern X`) would be a useful future addition but require a generator framework. Out of v2 scope.

## Connection to authoring discipline

The PRD's pitch — *authoring loop becomes "author → lint → revise → store"* — depends on tests-as-preflight being cheap to author and cheap to run. The `# Tests:` block makes this possible at skill-source-level; the lint pass enforces structural correctness; together they raise the bar for what enters the library.

## Future grammar extensions — sensors, time primitives, suppression, persistent state, capability declarations, debounce

This section documents language-design additions planned for future phases. These aren't yet shipped, but the design has been thought through enough that authors should know what's coming and what categories of work the language is reaching toward.

## Sensors as a language category (Phase 3)

Currently `# Triggers:` includes `sensor:` as a trigger source. The v3 redesign splits sensors into their own category:

```
# Sensors: presence, screen-state, voice-prosody
# Triggers: cron: 0 8 * * *
```

**Distinction:** Sensors are continuous channels the agent reads but doesn't emit on. Triggers are discrete events that fire the skill. Conflating them in one header produces a worse language for both — sensors need different semantics (continuous read, accessible via ambient refs, privacy-gated) than triggers (discrete fire, dispatch semantics).

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

Backed by a configured data-records connector (the same surface `# Requires:` reads from) with conventionally-namespaced keys (e.g., `state:skill-local:<skill-name>:<key>`).

**Rationale:** Most interesting skills need memory across firings — change-detection, windowing, dedup-against-recent. Without lifecycle, every skill rebuilds state tracking via raw memory-write / memory-query calls.

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
# RequiresConfidence: classifier >= 0.8
# RequiresThreshold: change-delta >= 0.3
```

Runtime evaluates the guard before dispatching the skill body. Lets sensitive skills opt out of low-confidence triggers without each skill's body rebuilding the same guard expression.

## Invocation-control axis (Phase 4)

Currently a skill is uniformly invocable from any caller (user via explicit command, agent mid-conversation, trigger autonomous fire). Some skills are user-only intents (user types a slash-command to invoke), some are agent-only behaviors (agent picks the skill via description-match while reasoning), some are trigger-only autonomous fires.

Proposed grammar:

```
# Invocable-By: user, agent, trigger
# Invocable-By: trigger            # autonomous only
# Invocable-By: user               # explicit-command only; agent can't pick it via reasoning
```

Header is a permissive list; absent means all three (current default behavior). Lint flags semantically-inconsistent declarations — a skill with `# Triggers: cron:` but `# Invocable-By: user` is a contradiction the rule catches.

**Rationale:** without the axis, sensitive operations (destructive writes, external messages, irreversible state changes) leak across invocation boundaries. An agent reading skill descriptions might invoke a skill that should only fire on explicit user command. Phase 5 capability declarations enforce more granularly, but the user/agent/trigger triad is the structural distinction that catches most surface-leak bugs cheaply.

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
# Requires-Capabilities: sensors=[mic, camera], tools=[memorystore.write, slack.post]
# Requires-Privacy: private-channel-only
```

Runtime fails-fast on missing capabilities. Trust precondition for sensor work — operators can audit which skills touch which surfaces.

## Build order rationale

Phases must land in order:
- Phase 0 → 1 → 2 are foundation; without them, sensor work compounds problems
- Phase 3 (sensors) needs Phase 1 (suppression, state) and Phase 2 (core ops, session triggers) solid first
- Phase 4 (routing) has nothing to route until sensors produce traffic
- Phase 5 (introspection) is ergonomic, not foundational — useful but skippable

## When the language extends, this section moves

When any of these primitives ship, the relevant grammar moves into its canonical section (Ops reference, Variables, Triggers, etc.) and this section's entry is replaced with a cross-reference. Future-extensions section stays alive for the next horizon of unshipped work — it's a continuous staging area, not a once-and-done document.

## Open spec questions — unresolved language design decisions

Questions surfaced during design that haven't been resolved. Each carries a current lean where applicable; spec must commit at implementation time. Items marked **[RESOLVED 2026-05-21]** are locked decisions awaiting (or already in) implementation.

## 1. `?` op explicit prompt — confirm v3 requirement — **[RESOLVED 2026-05-21]**

The bare `?` form is the most fragile primitive in the language. Implicit-context-reading drifts subtly across model versions. **Resolution:** `?` deprecated. Compile-warn in v1 (every bare `?` warns with rewrite suggestion `~ prompt="..." -> VAR`); compile-error in v1.x. Hardening before v2 because the population producing the debt is mostly agents, which compounds — an agent will author hundreds of skills referencing `?` during the same wall-clock window a human team would author ten. Diagnostic includes the explicit rewrite shape per Section 2 Ops.

## 2. `??` decline semantics — **[RESOLVED 2026-05-21]**

When the user responds "no"/"n"/falsey to a `??` prompt in interactive mode, what happens to dependent targets? **Resolution:** bind the response to the output variable AND short-circuit downstream targets (treat as soft op-error so `else:` fires). Silent fall-through to subsequent `apply:` is exactly the security bug pattern; bind-AND-short-circuit closes it cleanly. Per Section 2 Ops `??` documentation.

## 3. Block execution model — write down the rules

Within a target body, op ordering and variable binding conventions aren't fully written down. Specific questions:
- Can `!` directives precede `$` ops in the same target? (Yes; `!` has no dependency on subsequent ops.)
- What's the default output binding when `-> NAME` is omitted? (`$(target.output)` — same as bare `target` referenced from other blocks.)
- How do cross-block references work syntactically? (`$(other_target.output)` or `$(VAR_BOUND_THERE)`.)

**Write a "Block execution model" subsection.** No semantic change, just documentation gap.

## 4. `$` op prose suffix — disallow in v3

Example: `$ Edit file_path=... — merge hooks.PreToolUse block from $(plan.output)`. The em-dash + prose only works in agent-mediated execution because the agent interprets prose. Runtime-mediated execution ignores or errors on the trailing prose.

Lean: disallow prose in `$` for standalone v3. Args only, structured. Prose moves to a `~` op (LocalModel) that produces structured instructions; `$` consumes them. Keeps `$` semantics deterministic across both execution paths. **Resolve in language reference revision.**

## 5. `default:` semantics — make goal-directed shape explicit

`default:` names the *goal target*, not the entry point. The runtime walks dependencies backward through topo-sort. Skills with one target obscure this; multi-target skills make it visible. Authors writing imperative-style ("do A, then B") will be surprised by execution order otherwise.

**Status:** Already covered in the Overview section. Surface again in operator-of-skills tutorial material.

## 6. `&` skill-invocation output binding

What does `$(WEATHER)` contain after `& get-weather -> WEATHER`? Probable answer: the called skill's `default:` target output. Should be made explicit when `&` ships. Affects compiler; affects how authors reason about composed output.

## 7. `else:` block visibility into the error

Should `$(ERROR)` be an ambient ref inside `else:` blocks, populated with the error type/message? Lean: yes, same shape as `$(ERROR_CONTEXT)` in `# OnError:`. Useful for logging/telemetry skills. **Not yet shipped.**

## 8. Nested `# OnError:`

If `# OnError: degraded-skill` fires and `degraded-skill` itself errors, what happens? Lean: hard exit, no nested fallbacks. **Spec committed; documented in Error handling section.**

## 9. Multiple triggers — concurrency

If `cron: 0 8 * * *` and `event: user.present` both fire within seconds, does the skill run twice (independent) or get deduped? Lean: independent. Author dedups via state if needed. Affects dispatch layer.

## 10. `&` invocation vs trigger firing

When skill A invokes skill B via `&`, do skill B's `# Triggers:` fire? Almost certainly no — `&` is direct invocation, distinct from the trigger event surface. **Worth saying explicitly when `&` ships.**

## 11. File-watch path semantics

Recursive or directory-only by default? Inotify supports both. Lean: directory-only default; offer recursive via `file-watch-recursive:` or `file-watch: <path> (recursive)`. Affects dispatch layer.

## 12. Output target delivery failures

If `# Output: slack: <channel>` and Slack is down, what happens? Lean: delivery failure is its own retryable error; queue if possible, else error to caller. Worth a separate small spec section. Affects dispatch layer.

## 13. Compile-time vs runtime fallback evaluation timing

`# Requires:` fallbacks are compile-time. Op-level `(fallback: ...)` and `else:` blocks are runtime. Authoring clarification needed. **One-table summary in the spec would close the gap.**

## 14. Skill versioning rollback UX

Edits via upsert preserve history through substrate versioning, but no first-class "rollback" affordance. Probably needs a `--version <N>` flag on the compile API or a sister tool. **Out of v2 scope; track as future work.**

## 15. Skill discoverability

When the library grows past ~20 skills, name typos in `&` invocations become a real risk. No "list available skills with their inputs" surface yet. **Out of v2 scope; track as future work.**

## 16. `?` op explicit prompt — migration path — **[RESOLVED 2026-05-21]**

Pairs with #1. When the language deprecates bare `?`, existing skills in the library need to be migrated. **Resolution:** the v1 compile-warn diagnostic carries the explicit rewrite (`~ prompt="..." -> VAR`); a lint pass surfaces bare-`?` usage with the same rewrite for batch authoring assistance. No automated rewrite tool in v1 — the diagnostic is sufficient given that agents (not humans) are the primary authoring population, and agent reads of the diagnostic trigger the rewrite naturally.

## 17. Connector capability declarations

Skills can declare required connector capabilities via `# Requires:` (Phase 5). Examples: "needs semantic search," "needs structured-extraction model with 32K context." Useful for the substrate-portable story. **Pending design.**

## 18. Per-op timeouts

Hung dispatches hang the skill without explicit timeout configuration. Lean: skill-level `# Timeout:` header + per-op `timeoutSeconds=N` kwarg + runtime defaults. **Pending implementation in T5; ERD §6 specifies the four-level resolution chain.**

## 19. Data-skill primitive — which op fetches a data skill?

If we adopt the procedural-skills vs data-skills distinction (the compiler produces separate artifact types, the procedural skill is unchanged when data updates), an open question remains: which op references a data skill from a procedural one? Four viable shapes:

- **Extend `# Requires:` to data skills.** Keeps data lookup compile-time, baking the data value into the compiled artifact. Loses runtime flexibility but gains determinism + reproducibility.
- **Use `>` retrieval.** Data skills are a tagged record class returned by `>` queries. Composes with existing primitives; data is runtime-fetched.
- **Dedicated data-fetch op** (e.g., `^ skill_name -> VAR`). Explicitly different from procedure-call `&`; signals intent at read time. Adds one more op kind to the grammar.
- **Same `&` op, compiler inlines at compile time.** Uniform syntax with procedure invocation, but compiler treats data-skill references as compile-time includes. Author syntax is the same; semantics diverge based on the referenced artifact's type.

Lean: option 4 (uniform `&` with compile-time inline for data skills). Best of both — uniform call surface for authors, deterministic compile-time semantics for data, runtime-execution semantics for procedural. Compiler tracks "compiled against version N of data skill X" for staleness tracking; data update triggers recompile of dependent procedural skills.

Operational implication differs by choice: compile-time inline means data update → recompile dependent skills → new compiled artifacts published (more rebuild churn but deterministic at runtime). Runtime fetch means data update is invisible to the procedural skill until next invocation (less churn but less predictable).

**Resolve before data-skill payload type ships.** Affects compiler, lint pass, and the `# Requires:` cascade design.

## 20. Syntax footgun audit — **[RESOLVED 2026-05-21]**

A six-item syntax-footgun audit was conducted pre-T5 to lock disambiguation policies before the runtime locked more behavior into stone:

- **Indentation discipline** — spaces-only. Mixed tabs+spaces parse error. Per Section 1 Lexical conventions.
- **Reserved keywords** — `default`, `needs`, `if`, `elif`, `else`, `foreach`, `in`, `not`, `unsafe` (current). `while`, `for`, `match`, `try`, `catch`, `return` (future-reserved for v2 forward compatibility). Reserved-name use is a parse error with helpful diagnostic. Case-sensitive exact match. Per Section 1.
- **`# Status:` and other enumerated value spaces** — case-insensitive on input, stored as canonical form. Per Section 1 + Section 8.
- **`=` vs `==` in conditions** — single-`=` in `if`/`elif` is a parse error with specific diagnostic. Per Section 5.
- **`$(VAR)` vs `$$(bash-command)` inside `@ unsafe`** — `$$` escape signals bash command-substitution; bare `$()` is skillscript variable. Lint rule `unsafe-shell-ambiguous-subst` fires when `$()` in `@ unsafe` doesn't resolve to a declared var; diagnostic offers both rewrites. Per Section 2 Ops `@ unsafe` subsection.
- **Bracket-aware comma splitting** — parser respects bracket depth in `# Vars:` value parsing. Per Section 3.

All six are locked. T5 implements parser + lint + dispatcher per these dispositions.

---

*Rendered from `skillscript/skillscript-language-reference` — 2026-05-25 13:16 EDT*  
*Source of truth: AMP (`amp_render_document("skillscript/skillscript-language-reference")`)*