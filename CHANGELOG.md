# Changelog

## 0.2.8 — 2026-05-23

**Discovery + composition.** Two new MCP tools per Perry's v0.2.8
kickoff (thread `45c167bc`). Both close real public-runtime gaps:
cold-author bootstrap (`help`) and skill-to-skill composition that
doesn't depend on AMP (`execute_skill`).

### Added
- **`help` MCP tool** — cold-agent language discovery. `help()` returns
  a ~500-token quickstart covering the six minimum-viable questions a
  cold author needs (skill shape, op symbols, result binding, branching,
  iteration, debugging). `help({topic})` returns deeper sections:
  - `ops` — op symbol legend with grammars
  - `frontmatter` — header keys + values
  - `examples` — three canonical worked skills (minimal / threshold /
    LocalModel branching)
  - `connectors` — short explainer + live wired-set summary from the
    registry (delegates dynamic depth to `runtime_capabilities`)
  - `lint-codes` — tier-1/2/3 rule index
- **`execute_skill` MCP tool** — public composition primitive.
  `execute_skill({skill_name, inputs?, mechanical?})`. Symmetric return
  shape with AMP's `amp_execute_skill`:
  `{skill_name, final_vars, transcript, outputs, errors, target_order}`.
  `mechanical: true` previews dispatch without firing `$`/`~`/`@`/`??`
  ops (TestFlight mode); propagates through recursive composition.
  Recursion-depth guard at 10 (configurable via
  `ExecuteContext.maxRecursionDepth`); structured
  `RecursionDepthExceededError` fires on infinite-loop composition.
  Missing-skill returns a structured error rather than crash.
- **In-skill `$ execute_skill skill_name=child` intercept** — the
  runtime recognizes `execute_skill` as a built-in tool name and
  dispatches to the composition helper without requiring an MCP
  connector to be wired. Closes the gap Perry surfaced: prior to v0.2.8,
  the only way to invoke another skill was via AMP's private
  `amp_execute_skill`; a fresh runtime had `mcpConnectors: []` and no
  way to compose.

### Internal
- New `src/composition.ts` module wraps load + compile + execute behind
  a single `executeSkillByName()` function. Both the MCP tool handler
  and the `$` op intercept delegate here. Keeps the runtime's narrow-
  core LOC under the ERD §1 ceiling.
- New `src/help-content.ts` module hosts the static help payload.
- Tool count: 11 → 13. Existing 5 assertions across `mcp-server`,
  `dashboard-server`, `dogfood-t6b`, `v0.2.1`, and `v0.2.3` tests
  updated.

### Test coverage
- 17 new fixtures in `tests/v0.2.8.test.ts` covering: help topic
  surfaces, execute_skill end-to-end against bootstrapped runtime,
  mechanical-mode preview, missing-skill error shape, in-skill
  `$ execute_skill` composition, recursion-depth guard on infinite-loop
  chains, composition without an MCP connector wired.
- 631/631 tests passing. Narrow-core LOC 4999/13 (1 line under the 5000
  ceiling — tight).

### Validation
Perry's new "zero-primer" harness — fresh sub-agent with the Skillscript
MCP tools wired but ZERO system primer or language reference in context.
Task: "write a working skill that does X." Success = compiles clean.
Tests whether `help()` alone is enough to bootstrap authoring.

### Acknowledgments
Perry — kickoff design + minion-validation cadence. Public composition
was the missing piece for "skillscript without AMP."

## 0.2.7 — 2026-05-22

**Runtime ergonomics.** Items 4 + 5 from Perry's v0.2.5 kickoff
(thread `f75477a4`, carried forward to kickoff `2d3d461c`). Two
orthogonal changes bundled: the long-deferred `serve`/`dashboard`
split + persistent imperative-trigger registry.

### Added
- **`skillfile serve` command.** Headless runtime host: scheduler +
  MCP server only, no browser SPA mounted. For production deployments,
  containers, CI environments. Shares the existing `bootstrap()` helper
  with `skillfile dashboard`; differs only in whether the SPA routes
  are wired.
- **`skillfile dashboard` continues to mount the SPA.** No behavior
  change; the CLI now has the explicit choice rather than an implicit
  bundle.
- **Persistent imperative-trigger registry** at
  `$SKILLSCRIPT_HOME/triggers.json`. Imperative registrations (via the
  MCP `register_trigger` tool) write through to disk synchronously and
  hydrate at bootstrap. Survives process restart — register a one-shot
  trigger before lunch, the trigger fires after the runtime reboots in
  the afternoon. Schema-versioned wire format.
- **Boot-time expiry pruning.** Imperative triggers whose `expires_at`
  has passed at hydrate time are dropped from the in-memory registry
  AND the on-disk file. No accumulation of dead rows.
- **`runtime_capabilities` reports two new fields:** `runtimeMode`
  (`"serve" | "dashboard"`) and `triggersFilePath` (string or null).
  Cold agents discovering the runtime can ask which deployment shape
  they've reached and where the persistent registry lives.

### Unchanged
- **Declarative triggers** (parsed from `# Triggers:` headers in skill
  bodies) continue to live-derive from the SkillStore at every boot.
  They are NOT persisted to `triggers.json` — that's reserved for
  imperative registrations whose source-of-truth is the MCP write path.
- `DashboardServer` defaults `mountSpa: true` so existing embedders
  keep working.

### Internal
- `Scheduler` gains an optional `onTriggersChanged` write-through hook
  in its config. `bootstrap()` wires it when `triggersFilePath` is set.
- `Scheduler.registerTrigger` accepts an optional `seedFromPersistence`
  flag for boot-time hydration that preserves the original trigger id
  and suppresses the write-through hook (prevents re-writing the file
  we just read).
- 614/614 tests passing (600 + 14 new fixtures across persistence
  round-trip, boot-time prune, mode reporting, and SPA-mounting
  toggle). Narrow-core LOC unchanged at 4976/13.

### Acknowledgments
Perry — clean carryover from the v0.2.5 kickoff, validated end-to-end
on every patch since.

## 0.2.6 — 2026-05-22

**Language polish — Items 2 + 3 from the v0.2.5 kickoff** (Perry's thread
`f75477a4`). AgentConnector DeliveryPayload now carries full provenance
+ augmenting-context fields; two new frontmatter headers populate them.
Plus a doc + example response to Perry's Signal 1 (`|length` under-
discoverable).

### Added
- **`source_skill?: string` on the `augment` variant** of
  `DeliveryPayload` (was template-only in T7.1). Receiving agents reading
  an augment now know which skill authored it for correlation /
  auditability.
- **`triggered_by?: TriggerProvenance` on both variants.** Threads
  `{source, name, fired_at_ms}` through every delivery so receivers can
  disambiguate cron / session / manual / event fires. Populated from
  `ExecuteContext.triggerCtx` — scheduler-fired skills carry full
  provenance, ad-hoc `execute()` callers without a trigger ctx omit it.
- **`# Delivery-context: <prose>` header.** Routed to the receiving
  agent alongside the augment payload as `delivery_context` so the agent
  knows *why* it's being notified.
- **`# Templates: <name>, <name>, ...` header.** Comma-separated list of
  Template-skill names the receiving agent may fetch as follow-on
  actions. Routed as `templates: string[]`.
- **Tier-2 lint rule `unused-augmenting-header`.** Fires when
  `# Delivery-context:` or `# Templates:` appears on a Headless skill
  (no `prompt-context:` or `template:` output declaration) — those
  fields would never reach a substrate.
- **`examples/queue-length-monitor.skill.md`** — canonical
  "count items via `|length`, compare to threshold" pattern. Closes
  Perry's Signal 1: cold authors weren't reaching for `|length`
  naturally; examples beat spec for discoverability.

### Fixed
- **Stale `(v2)` markers in the language reference's ambient refs table.**
  `TRIGGER_TYPE`, `TRIGGER_PAYLOAD`, `EVENT.*` are all shipped and
  auto-injected at runtime; the "(v2)" suffix incorrectly implied
  "not yet available." Removed; descriptions sharpened to name the
  concrete values.

### Internal
- Added a `RecordingAgentConnector` test fixture in `tests/v0.2.6.test.ts`
  to verify payload threading end-to-end through the runtime dispatch.
- 600/600 tests passing (588 + 12 new fixtures). Narrow-core LOC
  unchanged at 4880/13.

### Validation
Perry's v0.2.5 Item-1 validation pass returned 6/6 regression + 3/3
fresh-minion compile clean. Surfaced Signal 1 (length discoverability —
addressed by the new example) and Signal 2 (lint gap on `$(NOW)` —
verified non-issue; the misread inspired the ambient-table doc fix).

### Acknowledgments
Perry — kickoff scope and validation cadence remains the same one-hour
loop that surfaced bugs A-F across v0.2.2-v0.2.4.

## 0.2.5 — 2026-05-22

**Language polish — Item 1 of 5 from v0.2.5 kickoff** (Perry's thread
`f75477a4`). The "orchestration carve-out" addition: comparison is
orchestration, arithmetic is tool computation. This patch ships the
comparison + counting affordances; items 2-5 follow after Perry's
validation pass.

### Added
- **Comparison operators `<` / `>` / `<=` / `>=`** in `if` / `elif`
  conditions. Both ref-vs-literal (`$(N) > "10"`) and ref-vs-ref
  (`$(A) <= $(B)`) shapes; filters + dotted field access permitted on
  either side, matching the existing `==`/`!=` surface.
- **Numeric coercion at runtime.** Both operands pass through `Number()`;
  non-finite results throw `TypeMismatchError` with structured operands
  + ref description + canned remediation. Silent lexicographic fallback
  (which would mis-compare `"9" < "10"` as false) is explicitly rejected.
- **`|length` filter.** Returns element count when the value JSON-parses
  as an array; returns character count otherwise. Pairs with the new
  comparisons for skills like `if $(ITEMS|length) > "0":`.
- **`TypeMismatchError` class** extending `OpError`. Surfaced via
  `result.errors[]` with `operator`, `lhs`, `rhs`, `refDesc` fields plus
  remediation suggesting `|trim` / `|length` / model-output preprocessing.

### Scope
**In:** comparison operators, `|length` filter, the type-error class.
**Out:** arithmetic (`+`, `-`, `*`, `/`), aggregates (`min`, `max`,
`sum`, `mean`). Those stay in tools. The line: *comparison is
orchestration; arithmetic is computation.*

### Test coverage
29 new fixtures in `tests/v0.2.5.test.ts` covering: parser grammar
acceptance, ref-vs-literal evaluation, ref-vs-ref evaluation, numeric-
vs-lexicographic regression guard, `TypeMismatchError` shape, `|length`
on arrays + strings + JSON objects, end-to-end compile of the canonical
threshold + queue-watch skill shapes. 588/588 total green.

### Acknowledgments
Perry — for the orchestration carve-out framing and the kickoff scope.

## 0.2.4 — 2026-05-22

**Two more parser bugs from Perry's 6-minion battery via `compile_skill`.**
v0.2.3's authoring tools gave Perry the cleanest possible validation
surface — 30 seconds later, she had two new bugs filed (thread `e609a448`).
Both parser-only, both shipped.

### Fixed
- **Bug D (regression from v0.2.2): apostrophe in plain text swallows targets.**
  The v0.2.2 `foldQuotedContinuations` pre-pass tracked single-quotes
  globally — an apostrophe in `# Description: symbol's intraday drops`
  opened an unclosed-string scope that absorbed all subsequent lines,
  leaving zero targets visible and producing a `[no-targets]` lint error.
  Hit by 2/6 cold authors. Fix: limit fold engagement to kwarg-bearing
  op lines (`~ `, `> `, `& `) — the three op kinds where values
  legitimately span newlines. Frontmatter, `!` literals, `@` shell
  bodies, and target labels are now left untouched.
- **Bug F (pre-existing): `(fallback: ...)` after `-> VAR` broke binding
  on `@` and `&` ops.** `$`/`~`/`>` had explicit fallback support in
  their regexes; `@` (parser.ts:1049) and `&` (`AMPERSAND_OP_REGEX`)
  didn't. The trailing `(fallback: ...)` clause prevented the `-> VAR`
  extractor from matching → outputVar never bound → downstream
  `$(VAR)` fired `undeclared-var` diagnostics on variables that
  authors had clearly declared. Hit by 2/6 cold authors. Fix: extend
  both regexes with `(?:\s+\(fallback\s*:\s*(.+?)\))?` and thread
  the captured fallback into the op record. `@ unsafe` variant also
  fixed for parity.

### Validation
Perry's 6-minion compile matrix:

| State | v0.2.3 | v0.2.4 (projected) |
|---|---|---|
| Pass | 3/6 | 6/6 |

(v0.2.4 projection — three minions previously failed on D and/or F;
sed-removing the apostrophe and rewriting the fallback clause cleared
both per Perry's testing. Test fixtures in `tests/v0.2.4.test.ts`
cover both bug repros and regression guards.)

### Acknowledgments
Perry — for the back-to-back minion-battery runs that surface bugs in
single-hour cadence after each ship.

## 0.2.3 — 2026-05-22

**Over-the-wire authoring lifecycle.** v0.2.0–v0.2.2 gave foreign MCP clients
a way to *observe* and *manage* running skills but not to *author* them
— pushing a new skill required filesystem access to the SkillStore root.
v0.2.3 closes that gap with three new MCP tools per Perry's design
(thread `f48b8ef3`).

### Added
- **`lint_skill({source?|name})` — 9th MCP tool.** Read-only. Returns
  diagnostics across tier 1/2/3, plus `passes_tier_1/2/3` booleans for
  cheap pass/fail checks. Accepts a literal source body (inner-loop
  iteration) or a stored skill name (re-validation).
- **`compile_skill({source?|name, inputs?})` — 10th MCP tool.** Read-only.
  Returns the rendered artifact + `target_order` + `resolved_variables`
  + warnings + errors. Compile failures land in the `errors` array
  rather than throwing, so cold authors get a diagnostic surface to
  iterate against instead of opaque tool failures.
- **`skill_write({name, source, overwrite?})` — 11th MCP tool, write.**
  Tier-1 lint runs at write time (SkillStore contract). Returns version
  + content_hash. Always lands as `Draft` — promote to `Approved` via
  the existing `skill_status` tool to enforce explicit-approval discipline.
  `overwrite` defaults to `false`; existing skills with the same name
  reject the write.

### Workflow
The cold-author flow over MCP becomes:
1. `lint_skill({source})` — fast feedback while drafting
2. `compile_skill({source, inputs})` — confirm the artifact looks right
3. `skill_write({name, source})` — commit to SkillStore as Draft
4. `skill_status({name, new_state: "Approved"})` — explicit deploy
5. `register_trigger({skill_name, source: "cron", name: "...")` — fire
6. `health_metrics({skills: [name]})` — observe fires

Six tools, one round-trip each, no filesystem dependency. The integration
test in `tests/v0.2.3.test.ts` exercises the full lifecycle end-to-end.

### Acknowledgments
Thanks to Perry for the three-tool bundle design (thread `f48b8ef3`),
turned around within an hour of the v0.2.2 ship.

## 0.2.2 — 2026-05-22

**Parser fixes from cold-author minion battery.** Perry ran 3 independent
cold-agent SDK authors against the stock-monitor exercise; they converged
on three parser failure modes. All three fixed in this patch — pure parser
changes, no runtime or dispatcher impact.

### Fixed
- **Bug A: `# Triggers:` comma-split breaks cron expressions with commas.**
  Hit by 3/3 cold authors. Cron syntax naturally has commas
  (`30,45 9 * * 1-5` = run at 9:30 and 9:45 on weekdays). The trigger header
  parser split on bare commas, mistakenly treating the cron-internal comma
  as a multi-trigger delimiter. Now splits at source-keyword boundaries
  (cron/session/event/agent-event/file-watch/sensor) instead — single-cron-
  with-commas parses as one trigger; multiple triggers still split correctly.
- **Bug B: Multi-line `~ prompt="..."` strings break the parser.** Hit by
  2/3 cold authors. The line-iterating parse loop treated interior newlines
  inside quoted kwarg values as block separators. Now a quote-aware pre-pass
  folds unclosed-quote continuations into a single logical line, and the op
  regexes (`~`, `>`, `&`) carry the `s` flag so `.` matches across newlines.
  Multi-paragraph LLM prompts now parse cleanly.

### Documented
- **`needs:` keyword forms.** Bug C audit confirmed the parser already
  supports all three syntactic forms (Make-style `target: dep1 dep2`,
  header form `target: needs: a, b, c`, body-line form `needs: dep`). The
  language reference now has a concrete `### Declaring target dependencies`
  example showing all three. v0.2.2 tests document supported syntax so
  future regressions surface.

### Acknowledgments
Thanks to Perry for the 3-minion cold-author battery (thread `a91db2e2`)
that surfaced these bugs in roughly an hour after v0.2.1 shipped.

## 0.2.1 — 2026-05-22

**Imperative-trigger surface fix.** v0.2.0 shipped with `register_trigger`
(via MCP) storing trigger registrations correctly but the scheduler's tick
loop was never armed inside `skillfile dashboard` — so no cron triggers
actually fired. Declarative `# Triggers:` headers had the same dormant
fate. v0.2.1 is the patch that makes the trigger surface load-bearing.
**Upgrade strongly recommended for anyone exercising the trigger APIs.**

### Fixed
- **Scheduler is now started in the dashboard host.** `cmdDashboard` calls
  `scheduler.start()` after wiring the registry, arming the 30s tick loop
  and the SIGINT/SIGTERM session-end hook.
- **Declarative `# Triggers:` headers register at boot.** The dashboard now
  walks the SkillStore at startup, parses each Approved skill, and registers
  every declared `# Triggers:` entry into the scheduler.

### Added
- **`runtime_capabilities` MCP tool** (8th built-in). Read-only discovery
  surface for cold agents — returns the wired connectors per kind
  (`skillStores`, `memoryStores`, `localModels`, `mcpConnectors`,
  `agentConnectors`), plus `shellExecution.mode` (structural-spawn vs
  bash-via-unsafe) and the runtime version. Optional per-category `include`
  filter.
- **`bootstrap()` + `defaultRegistry()` helpers** (`src/bootstrap.ts`).
  Extract the long-lived runtime host wiring — connector registry, scheduler,
  McpServer — into a single shared function so the v0.3 `serve`/`dashboard`
  split becomes a trivial new entry point rather than a refactor.
- **`Registry.list*()` enumeration methods.** `listSkillStores`,
  `listMemoryStores`, `listLocalModels`, `listMcpConnectors`,
  `listAgentConnectors` each return `Array<{ name, instance, ctor }>` for
  `runtime_capabilities` and future introspection use.

### Removed
- **`skillfile register-trigger` / `unregister-trigger` / `list-triggers`
  CLI commands.** These one-shot invocations each constructed a fresh
  in-memory Scheduler that died on process exit, making them no-ops in
  practice. The MCP tools (`register_trigger` / `unregister_trigger` /
  `list_triggers` against a live `skillfile dashboard`) are the canonical
  registration surface.

### Internal
- **CLI command surface tightened from 16 → 13 commands.** Help, dogfood
  fixture, and README updated.
- **`cmdRun`'s `buildRegistry()` collapsed to `defaultRegistry()`** —
  eliminates the duplicate registration logic between the one-shot run
  path and the long-lived dashboard host.
- **Dashboard now records traces by default** (`trace: { mode: "on" }`)
  so `fires` / `health_metrics` reflect the new tick-driven fires.

### Acknowledgments
Thanks to Perry for the cold-client MCP probe that surfaced the
imperative-trigger bug (thread `52f3d3d9-9212-49a9-b180-ae28fd1a7666`),
the structural-coupling diagnosis, and the `runtime_capabilities` design.

## 0.2.0 — 2026-05-21

Initial public release. T7 distribution polish + T7.1 AgentConnector
contract. See README and `docs/language-reference.md` for the v1 surface.

- Five connector contracts: SkillStore, MemoryStore, LocalModel,
  McpConnector, AgentConnector (NoOp default).
- Sixteen CLI commands; seven-tool MCP server; browser dashboard SPA.
- Narrow-core LOC 4738/13 under 5000/20 ceiling (ERD §1).
- Published to GitHub + GHCR (`ghcr.io/sshwarts/skillscript-runtime`).
