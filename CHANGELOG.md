# Changelog

## 0.9.9 — 2026-05-28 — categorization rule fix (v0.9.8.1 thematic patch)

**Per Perry's `ec74e5fd` test-pass.** v0.9.8 shipped a derivation rule with a
gap: skills with text/file/none output AND no autonomous triggers were
landing in `headless` instead of `skills`. Cold agents calling `skill_list()`
at session start couldn't see this common skill class — `hello`,
`cut-release-tag`, agent-callable analyzers, etc.

### Fixed

Derivation rule grew an "agent-invokable inference" branch:

```
ANY output[i].kind === "agent"        → "augmenting"
else ANY output[i].kind === "template" → "template"
else IF no autonomous triggers        → "template" (agent-invokable inference)
else                                  → "headless"
```

The trigger-presence check disambiguates:
- text/file/none output + NO triggers = "I expect to be invoked" → `skills`
- text/file/none output + cron/session/event triggers = "I fire myself" → `headless`

Verification table:
- `cut-release-tag` (output=text, no triggers) → Template ✓ (was Headless)
- `hello` (output=[], no triggers) → Template ✓
- `analyzer` (output=[], no triggers) → Template ✓
- `queue-length-monitor` (output=[], cron trigger) → Headless ✓ (unchanged)
- `service-health-watch` (output=none, cron trigger) → Headless ✓ (unchanged)
- `morning-brief` (output=agent, cron trigger) → Augmenting ✓ (unchanged)
- `classify-support-ticket` (output=agent, no triggers) → Augmenting ✓ (unchanged)

### Process note pinned

Perry's `ec74e5fd` flagged that v0.9.8 pushed without her pre-push test pass
— deviation from the v0.9.6/v0.9.7 "share in shared → test pass → push"
pattern. The probe-pass-finds-bug here would have caught this pre-push.
The pattern is load-bearing even when discipline is high; v0.9.9 onward,
hold the push until Perry's signal.

### Lesson banked

When tightening a derivation rule to handle a new dimension (multi-output),
re-walk the original cases to verify they still resolve correctly. Same
shape as `1bc9d7a2` (multi-layer-check-inconsistency) at the derivation-rule
layer: lose a branch silently, faithful downstream impl misses it, only
catches at wire-surface probe.

## 0.9.8 — 2026-05-28 — skill_list evolution → SkillCatalog (agent-facing discovery)

**Per Perry's audit thread `f0b8b832` + addendum `73c79a28` + lock `011feaf0`.**
`skill_list` returns a pre-grouped `SkillCatalog` so cold agents reading at
session start see immediately "what pushes to me" vs "what I can invoke."

### Wire shape changes (BREAKING — pre-adoption rule)

`skill_list` response shape changed from `SkillMeta[]` (flat array) to
`SkillCatalog` (pre-grouped object):

```typescript
interface SkillCatalog {
  receives?: SkillEntry[];   // augmenting (# Output: agent:)
  skills?: SkillEntry[];     // template (# Output: template:) + agent-invokable
  headless?: SkillEntry[];   // no agent/template output; present when audience filter allows
}

interface SkillEntry {
  name: string;
  category: "augmenting" | "template" | "headless";
  description: string;
  status: SkillStatus;
  vars: Array<{ name: string; required: boolean; default: string | null }>;
  output: Array<{ kind: "agent" | "template" | "text" | "file" | "none"; target?: string }>;
  triggers: Array<
    | { kind: "cron"; expression: string }
    | { kind: "session"; phase: "start" | "end" }
    | { kind: "webhook"; path?: string }
    | { kind: "event"; event_type: string }
  >;
}
```

### Category derivation

From existing `# Output:` semantics — no new frontmatter syntax. Multi-output rule:

```
ANY output[i].kind === "agent"    → "augmenting" (surfaces in `receives`)
else ANY output[i].kind === "template" → "template" (surfaces in `skills`)
else                              → "headless"   (surfaces only when audience filter allows)
```

### Filter mechanism (AND-composed)

```typescript
interface SkillListFilter {
  audience?: "agent" | "all" | "headless";  // default "agent"
  status?: SkillStatus;                      // default "Approved"
  trigger_kind?: "cron" | "session" | "webhook" | "event";
  domain_tags?: string[];                    // AND-match
  name_prefix?: string;                      // adopter-side scoping
}
```

### Vars rendering (per addendum `73c79a28`)

| `# Vars:` frontmatter | Rendered entry |
|---|---|
| `NAME` (bare) | `{ name: "NAME", required: true, default: null }` |
| `NAME=value` | `{ name: "NAME", required: false, default: "value" }` |
| `NAME=` (equals, empty value) | `{ name: "NAME", required: false, default: "" }` |

### Footnote pinned in SkillEntry doc-comment

*"Invocation is independent of discovery grouping. `execute_skill(skill_name="X")`
works regardless of whether X surfaced in `receives` or `skills`. Discovery
grouping is signal, not gating."*

### Added

- `src/skill-catalog.ts` — `buildSkillCatalog()` + category derivation +
  vars/outputs/triggers rendering helpers (~160 LOC; auxiliary surface, not narrow-core)
- `src/connectors/types.ts` — `SkillCatalog`, `SkillEntry`, `SkillListFilter` interfaces
- `tests/v0.9.8-skill-catalog.test.ts` — locked-shape coverage (category derivation,
  vars rendering, triggers union, filter composition, audience grouping, Q2 footnote)

### Migration

- `mcp__skillscript__skill_list` callers consuming the flat-array shape break.
  Pre-adoption rule applies; no shipped adopters.
- Bundled dashboard updated to flatten the grouped response for its existing
  table view.

### LOC ceiling

Bumped narrow-core 8550 → 8650 for the new contract types in `connectors/types.ts`.
Fourth bump in v0.9.x; consolidate-first signal stands but new contract surface
isn't consolidatable.

## 0.9.7 — 2026-05-27 — HttpWebhookAgentConnector example impl

**Q5 deliverable from the v0.9.6 audit** (`df34313e`). Bundled example
AgentConnector for HTTP-webhook substrates — the canonical worked example
adopter agents read + fork when wiring their own substrate. Lives in
`examples/connectors/` (outside narrow-core LOC budget per audit decision).

### Added

- **`examples/connectors/HttpWebhookAgentConnector/`** — full directory:
  - `HttpWebhookAgentConnector.ts` — the connector class with strict input
    validation in `fromEnv()` (NaN-guard on timeout, agents-shape validation,
    required-url enforcement). Validation pattern is intentionally educational
    for adopter forks.
  - `README.md` — canonical reference for adopter agents. Documents Models
    A/B/C deployment shapes (URL-routed / body-routed / variable-substituted),
    wire format, auth (bearer + HMAC combinable), forking discipline.
  - `.env.example` — nested JSON config + bearer + HMAC stubs.
  - `receiver-example/express.js` + `flask.py` — reference receiver snippets
    with HMAC raw-body validation pattern (validate BEFORE parse).
  - `tests/HttpWebhookAgentConnector.test.ts` — 32 tests, mock HTTP server
    (Node built-in `http.createServer`, zero external deps).

### Design choices documented

- **Wire body includes `agent_id` at top-level** alongside the canonical
  `DeliveryPayload` shape — extension to the wire format the
  HttpWebhookAgentConnector defines (not the contract itself). Enables Model
  B router-receivers to dispatch without URL inspection. Optional for
  Model-A-only deployments.
- **Receipt synthesis is permissive** — tolerantly parses substrate-specific
  response shapes (NanoClaw `{status, id}`, Discord message JSON, Slack
  `{ts, channel}`, empty body) into canonical `DeliveryReceipt`. Adopters
  with strict shape replace `synthesizeReceipt()`.
- **Three deployment models** without code branching:
  - Model A: one URL per agent_id (URL-routed)
  - Model B: single URL, router receiver, agent_id in body
  - Model C: variable-driven channel selection in the skill
    (`notify(agent="agent-${CHANNEL}", ...)`)

### Out of scope (fork to add)

Retries, multi-region failover, OAuth/mTLS/SAML auth, streaming deliveries,
async-callback `request_response()` reply pattern (v0.10 design choice).

### Per Perry's `3f04b413` code review

Two adopter-footgun catches landed before push (fromEnv `timeout_ms` NaN guard,
agents JSON shape validation); five optional polish items (option naming
consistency `auth_header`→`authorization`, README softening on Model-A vs
Model-B forking, Bearer+HMAC combinability note, malformed receiver JSON test,
`client_validation` cause_kind enum) absorbed in the same patch.

## 0.9.6 — 2026-05-27 — AgentConnector audit + contract lock for v1.0

**First connector contract audit + lock for v1.0** per Perry's thread `b722bbf4`.
Closes Q1-Q12 across three pressure-test rounds (sender/substrate lens →
agent-as-receiver lens → full code-audit reconciliation). Opens the
"connector house in order" gate-3 sequence; remaining contracts (McpConnector,
SkillStore, MemoryStore, LocalModel) audit + lock in subsequent v0.9.x slots.

### Contract changes (`src/connectors/agent.ts`)

- **Added `DeliveryMeta` envelope** on both `DeliveryPayload` variants (Q8).
  Runtime auto-fills `dispatch_id` (UUID per emit), `sent_at` (emit-clock),
  `origin.skill_name` / `origin.trigger_kind` (required); optional
  `origin.entry_skill_name`, `origin.caller_agent_id`, `event_type`,
  `correlation_id` populate when context provides them.
- **Added `health_check()` required method** (Q6). Bootstrap-throws on `false`
  via `registerAgentConnector()` — wiring failures surface at boot, not at
  first skill-fire.
- **Added `request_response()` required method** (Q1) with locked `Response`
  shape `{ correlation_id, content, sent_at, agent_id }`. Impl deferred to
  v0.10 when `exchange()` op ships; adopters throw `NotImplementedError`
  until then.
- **Added `delivery_skipped?: boolean`** to `DeliveryReceipt` (Q7). Contract-
  level signal for "accepted but not pushed" (offline agent, rate-limit drop,
  etc.); runtime honors connector-set value, preserves NoOp fallback inference.
- **Dropped `manifest()`** (Q2). No production callers; folded into
  conformance test surface.
- **Dropped `TriggerProvenance`** interface (Q12) and its envelope fields
  (`source_skill`, `triggered_by`, `delivery_context`, `templates`, `format`).
  Each folded into `meta` per Q8-Q11 or dropped to trace-only surface.

### Syntax changes

- **`# Delivery-context:` → `# Event-type:` frontmatter rename** (Q9). Vocab
  consistency between skill-author and receiver-agent surfaces; the field
  flows to `meta.event_type` as the frontmatter fallback (`notify(event_type=...)`
  kwarg takes precedence per-emit).
- **`notify()` op gains `event_type=` and `correlation_id=` kwargs**. Per-emit
  override of frontmatter; `correlation_id` is the reply-correlation primitive
  for the v0.10 `exchange()` shape.

### Behavior changes

- `Registry.registerAgentConnector()` is now `async` — invokes `health_check()`.
- `triggerCtx.source` enum migrated from `{cron, session, event, agent-event, file-watch, sensor, manual}` to Q8's `{cron, session, webhook, agent, cli, dashboard, inline}`. The pre-v0.9.6 "extra" values were parse-only (no production firing path emitted them). `manual` → `inline` is the only meaningful migration.
- `# Templates:` frontmatter still parsed for `unknown-template-reference` lint
  but no longer flows through `DeliveryPayload` (Q10 — vestigial removal).

### Deliverables

- New `docs/connector-contract-reference.md` — canonical reference for adopters
  (audience: adopter agents). Includes the four footnotes Perry pinned during
  the audit (broadcast dispatch_id semantics, deeper-than-2-level chain elision,
  caller_agent_id general rule, sent_at vs delivered_at distinction).
- Updated `docs/adopter-playbook.md` AgentConnector method list.
- Updated `docs/language-reference.md` AgentConnector + DeliveryPayload sections.
- New `tests/v0.9.6-agent-connector-audit.test.ts` (15 tests covering Q1-Q12);
  includes Perry's plumbing-risk SHAPE test for `entry_skill_name` propagation
  (cites lesson `1bc9d7a2`).

### Pre-adoption migration

Pre-adoption rule applies (no external users); breaking changes are cheap.
Adopters who experimented against pre-v0.9.6 code:

- Drop `manifest()` from AgentConnector impls.
- Add `health_check()` + `request_response()` (throw NotImplementedError until v0.10).
- Replace `source_skill` / `triggered_by` / `delivery_context` / `templates` /
  `format` payload field reads with `meta.origin.*` / `meta.event_type` reads.
- Rename `# Delivery-context:` → `# Event-type:` in skill source.

### Methodology lesson (per Perry, worth banking)

*"Contract audits compound. Each pressure-test pass before lock has near-zero
cost; each pass after adoption has near-infinite cost. Spend pre-lock budget
liberally."* Three pressure-test rounds (Q1-Q7 → Q8 → Q9-Q12 audit-reconciliation)
each caught real gaps the previous round missed. The pre-adoption rule made
the discipline cheap; the audit-as-methodology made the pass-count load-bearing.

### LOC ceiling

Bumped narrow-core from 8300 → 8500. Third bump in the v0.9.x series — per §18
note, the "consolidate first" threshold. Most of the ~150 net LOC growth is
doc-comments on `agent.ts`; per the `adopter-agent-as-author` memory,
reference impls are the dominant signal source for adopter agents, so
docstring richness is load-bearing.

## 0.9.5 — 2026-05-27 — lint polish (v0.9.4.1 thematic patch)

**Two mechanical lint fixes from Perry's R-series next-ring (`77ed6c65`).**
Standalone patch ahead of the AgentConnector audit work — keeps
contract-design surface separate from cold-author polish per the
thematic-discipline pattern that worked through v0.9.x. No contract
surface touched; v1.0 cold-author signoff (mean UX 4.0/5 against
v0.9.4) still stands as the gate-1 baseline.

### Fixed — fallback-trailer lint-layering

Cold authors expected `(fallback: ...)` on a bare `$ TOOL` op to
suppress the tier-1 `unwired-primary-connector` error (the intuition:
"if I provide a fallback, the runtime is guarded"). It didn't — lint
runs at authoring-time and fallback resolves at dispatch-time, so the
error fired regardless of fallback presence. The layering wasn't
obvious from the diagnostic.

Fix: when every call site for a `(target, tool)` pair carries an
op-level `(fallback: ...)` trailer, demote the finding from `error`
to `info`. The advisory message explains the layering ("Lint runs at
authoring-time and the fallback resolves at dispatch-time; the
runtime branch is reached only if dispatch fails in production"). If
any call site lacks a fallback, the error stays. Per R8 cold-author
finding in `77ed6c65`.

### Fixed — forward-reference noise dedup

Pre-v0.9.5 lint emitted up to 4 diagnostics for 2 missing skills:
`unknown-skill-reference` keyed by `via:name` (so the same missing
skill referenced via both `&` and `$ execute_skill` produced 2
findings) AND the paired `deferred-skill-reference` advisory doubled
the count. Per Perry's "4 diagnostics for 2 missing skills" cold-author
finding — noisy without adding signal.

Fix:
- `unknown-skill-reference` now dedups by skill name (not `via:name`);
  the message lists all vias encountered.
- `deferred-skill-reference` advisory removed entirely — the warning's
  remediation field already explains the forward-ref path. One warning
  per missing skill carries the same signal.

Net: 2 missing skills × dual-ref produces 2 findings (down from 8).
Cold author noise floor reduced; pre-adoption rule applies (no
external migration needed).

## 0.9.4 — 2026-05-27

**Cold-author cleanup cluster — N1–N8.** Closes the next ring of findings
surfaced by Perry's R8 + qwen re-validation against v0.9.3
(memory `9086b3f8`). Mean UX delta from 3.86/5 → projected 4+/5,
clearing the v1.0 cold-author signoff threshold.

### Fixed — N1 `approved=` kwarg suppresses unconfirmed-mutation lint

Docs explicitly list `approved="reason"` as one of three valid
authorization paths for the `unconfirmed-mutation` lint, but the
parser only populated `op.approved` for function-call ops — `$` op
kwargs were captured in `op.body` as a string and the lint rule
checked `op.approved` (which was undefined). So `$ memory_write ...
approved="..."` failed the docs-promised suppression silently.

Fix: parser extracts `approved="..."` (and `approved='...'`) from `$`
op bodies via `extractApprovedKwarg()` and populates `op.approved`
explicitly. Per R8 minion #4 finding.

### Fixed — N2 `$append STRING_VAR <"line">` strips operator chars

The angle-bracket-arrow `<value>` is the canonical APPEND operator,
but the parser captured the brackets as part of `setValue` for the
string-target concat case. Authors writing
`$set REPORT = ""` then `$append REPORT <"line 1">` got
`<"line 1">` embedded literally in the report — silent wrong output.

Fix: parser strips outer `<...>` from `$append` value capture before
calling `processSetValue`. List-append back-compat preserved. Per R8
minion #3 finding.

### Added — N3 `transcript-footgun` tier-2 lint

`${R.transcript}` against a composition-result var reads as
"human-readable text" but is actually the child skill's emissions
array — interpolation produces JSON-ish array stringification.

Tier-2 warning when `${VAR.transcript}` appears in any substitution
position. Remediation: bind explicitly via `final_vars.NAMED_VAR`,
use `outputs.text` (joined string), or iterate `foreach LINE in
${R.transcript}:` to consume per-line. Per R8 minion #6 finding.

### Added — N5 `set-json-literal-advisory` tier-3 lint

`$set VAR = [{...}]` binds the literal string form, not a parsed
JSON structure. Skillscript's `$set` is literal-only — JS-class
object/array literals don't auto-parse. Cold authors hit this when
mocking structured data inline.

Tier-3 advisory. Suggests `$ json_parse '[{...}]' -> VAR` for
structured-array intent.

### Added — N8 `skill-name-collision` tier-3 lint

When `lint_skill` is called with a `skillStore` and the parsed
skill's name already exists in the store, surface a tier-3 advisory
so cold authors don't round-trip to discover the conflict at
`skill_write` time.

### Changed — N4 docs: shell() argv quoting + N6 FS isolation

`help({topic:"ops"})` shell() section now documents the structural-
spawn quote-stripping behavior (workaround: `unsafe=true` for
quoted-arg-aware bash, or write-then-read via file_write). Plus
explicit container FS isolation note matching file_read/file_write.

### Changed — N7 docs: `${ARRAY|length}` not `${ARRAY.length}`

`help({topic:"examples"})` per-substrate return-shape note now
explicitly says: use the `|length` filter for collection counts; JS
convention `.length` doesn't work (dotted-ref resolver does string-
keyed property descent). Closes the qwen Test B substitute-
hallucination (`.totalCount` → `.length`).

### Notes

- 11 new tests (`v0.9.4-cleanup.test.ts`).
- Suite at 1116/1127 passing, 10 skipped, 1 baseline YouTrack env-gated.
- Narrow-core LOC ceiling bumped 8200 → 8300 to accommodate the parser
  + lint additions. Per `feedback-loc-vs-clarity`: ceiling is a
  signal, not a budget.
- v1.0 cold-author signoff is the next milestone — R8 + qwen re-run
  against v0.9.4 validates the empirical bar.

## 0.9.3 — 2026-05-27

**Deferred design calls — P1.2 + P1.3.** Closes the last two items in
Perry's locked v0.9.x sequencing (`c9c667d2`). Two tier-2 lint
additions, no parser or runtime surface changes — design calls landing
as guardrails rather than language extensions.

### Added — `numeric-subscript` lint (P1.2)

Cold authors hit `${LATEST.items.0}` expecting indexed array access;
the substitution resolver's dotted descent does string-keyed property
access which works on JS arrays for direct single-step subscript but
fails silently on multi-segment refs. Per R8 minion #5 finding in
`dec3ca8a`.

- **Tier-2 warning `numeric-subscript`** fires when a `${VAR.N...}`
  ref has any numeric segment after the var name.
- **Remediation**: use `foreach IT in ${VAR}:` for iteration, or
  `${VAR|first}` for first-only, or bind via `$ json_parse` against
  parsed JSON for true indexed access.
- **Design call**: numeric subscripts NOT promoted to first-class
  syntax. Would conflict with dotted-field-access semantics when JSON
  keys are numeric strings; foreach is the canonical shape.

### Added — `deprecated-addressed-to` lint (P1.3)

`$ memory_write` docs mixed `recipients=["agent"]` (array, plural) and
`addressed_to="agent"` (string, singular) across the quickstart vs
connectors topic. The bundled `MemoryStoreMcpConnector` only ever read
`recipients=[...]` — `addressed_to=` parsed but silently dropped.
Per R8 minion #4 finding in `dec3ca8a`.

- **Tier-2 warning `deprecated-addressed-to`** fires on
  `$ memory_write ... addressed_to=...` with the canonical-fix
  recommendation.
- **Docs fix**: `help({topic:"connectors"})` example updated to
  `recipients=[oncall]` (bracket-array form) — the actual contract.
- **Design call**: `recipients=[...]` is canonical (array, plural,
  matches AMP broker model). Adopters with custom MemoryStoreMcpConnector
  impls that genuinely accept `addressed_to` can wire it — the lint
  is a nudge toward the bundled-default contract, not tier-1.

### Notes

- 7 new tests (`v0.9.3-design-calls.test.ts`).
- Suite at 1105/1116 passing, 10 skipped, 1 baseline YouTrack env-gated.
- Concludes the v0.9.x patch series per Perry's locked sequencing.
  Remaining work (R8/qwen re-validation as periodic harness; v1.0 cold-
  author signoff) is bandwidth-driven from here.

## 0.9.2 — 2026-05-27

**Compiler permissiveness + runtime observability.** Closes P0.5–P0.9
(silent-drop lint additions) + P1.1 (delivery_skipped) + P1.4
(fallback_fired) + P1.6 (worked examples) + P2.5 (file_write transcript)
from Perry's R8 + qwen findings in `dec3ca8a`. Three commits per the
locked sequencing in `c9c667d2`.

### Added — compiler permissiveness lint cluster (P0.5–P0.9)

Smaller LLM authors (qwen-class) confabulate where the prose is abstract;
the pre-v0.9.2 compiler silently dropped malformed syntax. Five lint
additions surface those silent-drops as vocal errors:

- **P0.5 `no-space dispatch`** (parser tier-1) — `$<word>` without a
  space (e.g. `$ticketing_search query="x"`) was silently dropped from
  the topo-sort. Parser now emits a clear `missing the space between
  $ and the tool/connector name` error with the canonical fix.
- **P0.6 `colon-kwarg-syntax`** (lint tier-1) — `key:value` colon-style
  kwargs (e.g. `limit:20`) parsed as part of an adjacent token; lint
  now catches and recommends `key=value`. Skips quoted strings, array
  literals, brace literals, and `(fallback:...)` trailers.
- **P0.7 emit binding refused** (parser tier-1) — `emit(text="hi") -> R`
  was silently accepted; the binding was ignored at runtime. Parser
  now refuses with the canonical fix.
- **P0.8 `$append VAR = ...` refused** (parser tier-1) — the regex
  silently accepted the `=` shape with the `=` becoming part of the
  literal value. Parser now detects and suggests `$set` (replace)
  vs `$append VAR <value>` (append).
- **P0.9 `missing-default-target`** (lint tier-1, promoted from tier-3
  info) — skills without an explicit `default:` line now error. New
  `ParsedSkill.entryTargetExplicit: boolean` distinguishes
  explicit-vs-fallback resolution.

### Added — runtime observability signals (P1.1 + P1.4 + P2.5)

Cold authors couldn't tell whether their skill actually delivered or
just silently no-op'd, and `(fallback:)` substitutions were
indistinguishable from real success in the caller's view.

- **P1.1 `delivery_skipped` flag** — `agentDeliveryReceipts[].delivery_skipped: true`
  set when `# Output: agent:` declared but no real AgentConnector is wired
  (only the NoOp fallback). Includes a `reason` string with the canonical
  fix (`registerAgentConnector('primary', ...)`).
- **P1.4 `fallbacks[]` on ExecuteResult** — new `FallbackRecord[]`
  field. Populated when an op's `(fallback: ...)` trailer caught a
  dispatch failure. Inspect `length > 0` to detect partial-success
  runs. Two firing sites covered today: `file_read` and `$` op.
  Empty array `[]` when no fallbacks fired (clean run).
- **P2.5 `[file_write] wrote N bytes to <path>` transcript line** —
  emitted on successful file_write so cold authors can confirm side
  effects landed without reading the file back.

### Changed — worked examples expanded per substrate (P1.6)

`help({topic:"examples"})` adds two new worked examples — memory
durable-handoff (`$ memory_write`) and file-output (file_write +
`$append` accumulator) — plus a "per-substrate return-shape note"
documenting the canonical envelope shapes (ticketing → `{items, totalCount}`,
memory → `{items}`, LLM → string, etc.). Closes the qwen pattern-matching
issue where Test B inherited `.totalCount` from a ticketing example
onto a memory query result that didn't have it.

### Notes

- 21 new tests (`v0.9.2-permissiveness.test.ts` + `v0.9.2-runtime-signals.test.ts`).
- Suite at 1098/1109 passing, 10 skipped, 1 baseline YouTrack env-gated.
- Qwen re-validation queued — re-run the single-shot harness against
  v0.9.2 to confirm P0.5–P0.9 silent-drops now surface as vocal errors.
- v0.9.3 queued: P1.2 numeric subscript decision, P1.3 kwarg-name
  canonicalization. Bandwidth-driven.

## 0.9.1 — 2026-05-27

**Surface completion + structural dispatch validation.** Closes the v0.9.0
cold-author findings from Perry's R8 + qwen test batteries (thread
`dec3ca8a`, sequencing locked in `c9c667d2`). Three coherent commits.

### Added — `validateQualifiedDispatch` structural fix (P0.1 + P1.5)

Closes the multi-layer-promise pattern's third recurrence
(v0.7.2 → v0.7.3 → v0.9.0). Lint and runtime now call the SAME validator
for qualified `$ <connector>.<tool>` dispatch shapes — they can't drift
apart again.

- **New module `src/dispatch-validate.ts`** exports
  `validateQualifiedDispatch({toolName, qualifiedConnector, registry})`
  returning diagnostics. Lint rules consume them; runtime calls the same
  validator at the `$` op dispatcher as defense-in-depth.
- **New static surface on `McpConnectorClass`**: optional
  `staticTools(): string[] | null`. Bundled bridges declare their
  canonical surface — `LocalModelMcpConnector → ["prompt"]`,
  `MemoryStoreMcpConnector → ["query", "memory_write"]`. Connectors
  without a static surface (RemoteMcpConnector, adopter classes) return
  null and get tier-3 advisory treatment.
- **New tier-1 lint rule `unknown-tool-on-connector`** fires when a
  qualified op references a tool not declared on the connector's
  static surface. Catches `$ llm.tweet_post` etc. at compile time.
- **New tier-3 lint rule `unverified-qualified-tool`** fires when the
  connector class doesn't declare a static surface — advisory only;
  runtime will fail with a connector-specific error if the tool is
  missing.
- **`Registry.getMcpConnectorCtor(name)`** exposes the wired connector's
  class constructor so external validators can read `staticTools()`.
- **PR-template discipline addition** in `docs/adopter-playbook.md` —
  every new dispatch shape lands with lint + runtime + e2e tests as the
  forcing function. Prevents recurrence #4.

### Added — `skill_write` auto-stamp (P0.4)

Headless adopter unblock per thread `dec3ca8a` R8 minion #6. MCP-only
adopters (no dashboard) no longer need a `skill_status` Draft→Approved
round-trip to get a runnable Approved state.

- **`SkillStore.store()` auto-stamps** when the body declares
  `# Status: Approved` (with or without an existing token). Stamping is
  idempotent — pre-stamped bodies get a fresh recomputed token; Draft
  and Disabled bodies pass through verbatim.
- **`tests/setup.ts` simplified** — production code now handles the
  Approved-body case; the test hook only covers the legacy
  no-`# Status:`-header case for fixture convenience.

### Changed — docs sweep (P0.2 + P0.3 + P2.1 + P2.8)

- **`notify()` added to `help({topic:"ops"})`** (P0.2). The op was
  shipped in v0.8.0 but the closed-set list in the ops topic still said
  "emit, ask, inline, execute_skill, shell, file_read, file_write" —
  cold authors by-the-book couldn't find notify. Now documented with a
  full section + contrast against emit ("end-of-skill bulk via
  `# Output: agent:` lifecycle hook" vs "mid-skill synchronous alert").
- **Quickstart's "$ memory_write deferred" lie removed** (P0.3). Both
  the three-channels table and the dispatch surface paragraph now
  correctly state memory_write is live and routes through the bundled
  `memory_write` connector.
- **Dotted-form added to quickstart** (P2.1). One-paragraph addition
  explaining bare (`$ <name>`) vs dotted (`$ <connector>.<tool>`)
  routing, with a multi-connector slack disambiguation example.
- **`unwired-primary-connector` remediation triaged by audience** (P2.8).
  Author-side fix (qualify the op or pick a tool-matching name) is now
  separated from operator-side fix (wire a connector or add `primary` to
  connectors.json). Cold authors no longer have to triage which
  remediation applies to them.

### Notes

- 16 new tests (`v0.9.1-validate-dispatch.test.ts`,
  `v0.9.1-skill-write-autostamp.test.ts`). Suite at 1077/1088 passing,
  10 skipped, 1 baseline YouTrack env-gated.
- v0.9.2 queued: compiler permissiveness lint additions (P0.5–P0.9) +
  qwen re-validation harness as release-gate criteria. Per locked
  sequencing in thread `c9c667d2`.

## 0.9.0 — 2026-05-26

**Hash-token approval gate + trigger enable/disable.** Closes the v0.9.x
auth-model design settled in thread `29b6208e` (Scott + Perry + CC,
2026-05-26). Replaces the deferred `1866302d` lockdown's 6 moving parts
with one substrate-neutral mechanism. 5-10× lighter implementation.

### Added — ad-hoc inline-source execution (carve-out)

Per thread `10746795` (Slack 4:31-4:46 PM). The strict "Approved required to
execute" interpretation creates a corner for ad-hoc scripting: write a quick
skill → can't run it → store it → human reviews → stamps → finally executes,
with the script now persisting forever as detritus. Bad UX for one-off work.

- **`execute_skill({source: "..."})`** runs the supplied source body in
  memory and discards it. **Never crosses the SkillStore boundary** so the
  hash-token gate (which lives at that boundary) doesn't engage.
- **`execute_skill({skill_name: "..."})`** unchanged — stored execution,
  gate fires, Draft/tampered bodies refused.
- **Exactly one** of `skill_name` / `source` must be provided.
- **Child references stay gated.** An inline parent that does
  `$ execute_skill skill_name="child"` or `& data-ref` STILL routes those
  children through the SkillStore + gate. Only the top-level inline body
  is ungated.
- **Threat model rationale**: the gate protects against silent-swap of
  stored autonomous skills. Inline-source has no silent-swap attack — the
  caller wrote/saw the source they're handing in. Invocation IS the
  review. Same intuition as `bash -c "..."`.
- **New export**: `executeSkillFromSource` from `src/composition.ts`.

### Added — hash-token approval gate

- **Two states matter: Draft + Approved.** Draft skills can be authored,
  compiled, linted, viewed — but cannot execute anywhere. Approved skills
  with a valid stamped token execute via every dispatch path (manual MCP,
  in-skill compose, scheduler dispatch, compile-time data-skill inline).
- **`# Status: Approved v1:<token>`** — the dashboard's "Transition to
  Approved" flow now computes `f(body − Status line)` and stamps the
  token into the skill body. Runtime re-computes on every execution;
  mismatch blocks with a clear "re-approve via dashboard" error.
- **Version-prefix enumeration**: `v0:` reserved, `v1:` = CRC32 (bundled),
  `v2:` reserved for HMAC-SHA256, `v3:` reserved for Ed25519. Adopters
  substitute stronger functions via `registerApprovalFn(version, fn)`
  without language changes.
- **Content-change-resets is automatic** via the math — body edits
  invalidate the prior hash, so the next execution fails the gate.
- **Tamper-evident, not tamper-proof** out of the box. CRC32 is a
  discipline barrier; adopters with adversarial threat models substitute
  HMAC/Ed25519. Same protocol shape, stronger function.
- **NEW exports**: `src/approval.ts` →
  `computeApprovalToken`, `verifyApprovalToken`, `evaluateApprovalGate`,
  `stampApprovalToken`, `registerApprovalFn`, `parseApprovalToken`,
  `extractStatusFromBody`, `stripStatusLineForHashing`.
- **NEW error**: `ApprovalRejectedError` (`src/errors.ts`) — flows
  through `# OnError:` chains like other `ConnectorError` subclasses.

### Added — trigger enable/disable

- **`enabled: boolean` field on TriggerRegistration** (default `true`).
  Disabled triggers stay registered but the scheduler skips firing them
  — vacation / maintenance windows without losing the registration.
- **`scheduler.setTriggerEnabled(id, enabled)`** — toggle API. Fires the
  `onTriggersChanged` hook for imperative triggers (persists to
  `triggers.json`); declarative triggers toggle in-memory only (they
  rederive from skill bodies at bootstrap).
- **NEW MCP tool** `set_trigger_enabled({trigger_id, enabled})` — 14th
  bundled tool (was 13).
- **`triggers.json` schema bumped 1 → 2.** v1 files load with
  `enabled: true` (back-compat hydration); fresh writes use schema v2
  with the `enabled` field.

### Added — dashboard surface

- **Approval-state badge on skill detail view.** Approved skills show
  `verified` or `re-approval needed` based on runtime hash check. Stale
  Approved (body edited after approval) surfaces a banner + a
  "Re-approve (refresh token)" button alongside the standard transitions.
- **Trigger enable/disable buttons in the Triggers view.** Each row now
  shows `enabled` / `disabled` state with a one-click toggle alongside
  the unregister button.
- **`skill_metadata` MCP response includes `approval` field**:
  `{gate_ok: true}` when the body verifies cleanly, or
  `{gate_ok: false, reason: "..."}` with the human-readable refusal text.

### Migration

- **Existing skills with `# Status: Approved` (no token) refuse to
  execute** until re-approved via the dashboard. Pre-adoption rule:
  no installed base, no migration tooling needed beyond the one-time
  dashboard click.
- **`examples/*.skill.md` and `scaffold/examples/hello.skill.md`** stamped
  with valid `v1` tokens via `scripts/stamp-examples.mjs` (re-run after
  any body edit).
- **Test fixtures** are auto-stamped at `SkillStore.store()` boundary via
  `tests/setup.ts` — production code paths unaffected.

### Notes

- **R7 cold-author harness still queued.** v0.9.0 ships the auth gate;
  R7 lands separately post-stabilization.
- **`unconfirmed-mutation` lint** stays bundled in v0.9.0 — drop is a
  separate concern; the hash-token gate is the real enforcement, but the
  lint surfaces author-intent gaps at compile time, which is independent
  value.

## 0.8.0 — 2026-05-26

**Delivery model lockdown.** Closes the v0.8.x delivery-model design (Perry/CC
threads `42a0cc41` → `6995d006` → `ef5219a9` → `bb34de4e` → `a39345f9`,
May 26). Three substrate-portable output paths replace the v0.7.x
`# Output:` enum's implicit-substrate behavior:

1. **Substrate writes** — `$ memory_write` (NEW) + `file_write` (existing)
2. **Programmatic return** — result binding `-> VAR` (existing)
3. **Direct agent alerting** — `notify()` op (NEW) + `# Output: agent:` /
   `template:` lifecycle hooks (substrate-neutral, end-of-skill)

**Auth model deferred for rethinking.** The skill-author tracking + promotion
gate work settled in `43178c86` / `1866302d` is kicked down the road per
Scott's call ("needs to be better thought out and perhaps made simpler").
`$ memory_write` ships with the current `approved=` lint gate (same as
`file_write`); `# Status: Draft → Approved` stays self-promotable.

### Changed — OutputKind shape (breaking change; pre-adoption rule applies)

- **`prompt-context:` renamed to `agent:`.** The pre-v0.8.0 name leaned on
  substrate-specific "prompt-context" terminology that doesn't apply to
  Obsidian-vault-backed or mailbox-style agent substrates. `agent:` is
  substrate-neutral — "deliver to whoever's wired for X via their
  AgentConnector."
- `# Output: agent: <name>` → `AgentConnector.deliver({kind: "augment",
  content: <joined-emissions>})`
- `# Output: template: <name>` (unchanged) → `AgentConnector.deliver({kind:
  "template", prompt: <joined-emissions>})`
- Internal v0.7.x value `prompt-context` removed from the OutputKind union;
  internal `output_kind` discriminator in `AgentDeliveryReceiptRecord`
  similarly updated.
- Sweep across `examples/*.skill.md`, test fixtures, scaffold docs.

### Added — `notify()` runtime-intrinsic op

- **`notify(agent, message?, connectors?) -> ACK`** dispatches mid-skill
  synchronous alerts via wired AgentConnector(s). Specialization vs the
  `# Output: agent:` end-of-skill lifecycle hook (per Perry's
  refactor-resistance argument: ordering puzzles dissolve when the
  end-of-skill hook owns emission accumulation and `notify()` owns
  mid-skill fires).
- **Default behavior** when `message` is absent: dispatches the accumulated
  emissions-so-far. Authors can write `notify(agent="X")` between emits to
  fire a checkpoint without manually constructing the message.
- **Fan-out**: dispatches to ALL wired AgentConnectors whose `list_agents()`
  includes the target agent. `connectors=["webhook","tmux"]` restricts.
- **Failure semantics**: best-effort by default. Per-connector errors are
  captured in the ACK's `dispatched[]` array but don't propagate. `strict=true`
  opt-in deferred to dogfooding signal (per Q3 lockdown).
- **Return shape (signature lock)**: `{agent: string, dispatched:
  Array<{connector: string, ok: boolean, error?: string}>}`. Fire-and-forget
  callers ignore the binding; check-delivery callers inspect ACK.
- **Substrate-neutrality**: nothing bundled. Adopters wire AgentConnector
  impls (webhook, tmux, Slack, Discord, etc.). Substrate-specific delivery
  destinations live in adopter-wired AgentConnectors, NOT in the language.
- Closed-set RUNTIME_INTRINSIC_FN_NAMES expanded with `"notify"`.

### Added — tier-2 `# Output:` lint contract warns

- **`output-agent-target-no-emit`** — `# Output: agent: X` / `template: X`
  declared but skill has no `emit()` ops in body; delivery would fire with
  empty content. Warns to surface contract drift.
- **`output-agent-target-no-connector`** — `# Output: agent: X` / `template: X`
  declared but no AgentConnector wired; delivery would silently no-op via
  the NoOp default. Warns when lint context provides registry info.
- Per Q4 lockdown: tier-3 advisories for "header + notify(agent=X) both fire"
  deferred to dogfooding signal (Perry's call — wait for real footgun
  evidence before adding the lint).

### Added — `$ memory_write` op + `MemoryStore.write()` contract

- **`MemoryStore.write({content, tags?, recipients?, expires_at?, metadata?})
  -> {id, created_at}`** — new method on the typed MemoryStore contract.
  Bundled `SqliteMemoryStore` implements via the existing upsert schema with
  generated UUIDs. Companion: onboarding-scaffold `FileMemoryStore.write()`
  implements via JSON file append.
- **`$ memory_write content="..." [recipients=[...]] [tags=[...]]
  [expires_at=N] [metadata={...}] -> R`** — bare-form MCP dispatch through
  the `MemoryStoreMcpConnector` bridge. Bridge dispatches on toolName:
  `memory` routes to `query()`; `memory_write` routes to `write()`. Bootstrap
  auto-registers the same bridge instance under both names.
- Returns `{id, created_at}` envelope (per Q6 ack-shape lockdown).
- `recipients[]` is a substrate-advisory hint — memory systems with alerting
  (AMP) act on it; systems without (Obsidian-vault) ignore. Skillscript
  doesn't enforce or implement alerting at the language layer.
- **Memory handoff delivery channel** (the third "first-class" path
  documented in QUICKSTART since v0.7.0) is now real, no longer paper.

### Deferred to future v0.8.x or later

- **Skill-author tracking + promotion gate.** Per Scott (2026-05-26):
  "needs to be better thought out and perhaps made simpler." The
  `43178c86` / `1866302d` design is reopened for re-thinking. Possible
  simplification: promotion gate as operator-policy at the SkillStore layer
  rather than language-level identity tracking. Until then,
  `# Status: Draft → Approved` stays self-promotable as today.
- **Drop `unconfirmed-mutation` lint + reframe `# Autonomous: true` as
  documentation.** Pairs with the auth model rethink — under the current
  approach the lint is still load-bearing. Defer with auth.
- **R7 cold-author harness for NFR-6** — queued post-v0.8.0; tests
  ops/filters/lint-rules extension surfaces against the new file layout.
- **Portability stress-test scaffold** — v1.0 gate prep; vector-DB memory +
  hosted-API LLM + webhook AgentConnector substrate combination.

### Notes for cold authors

- `# Output: prompt-context: X` from v0.7.x skills is a parse error in
  v0.8.0. Rename to `# Output: agent: X` — pre-adoption rule applies (no
  external installed base; sweep your own test fixtures).
- `notify()` is for mid-skill alerts; `# Output: agent: X` is for end-of-skill
  bulk delivery. See `docs/adopter-playbook.md` for the lifecycle distinction.
- `$ memory_write content="..."` works against any MemoryStore impl that
  implements the typed `write()` contract. Bundled `SqliteMemoryStore` and
  the onboarding-scaffold `FileMemoryStore` both ship it.

## 0.7.3 — 2026-05-26

**Agent-as-author hardening.** Closes structural gaps surfaced by the v0.7.3
roadmap review (`076bdeac`, Perry/CC thread, May 26). The language *shape*
locked at v0.7.2; v0.7.3 hardens the adopter surface so agents (and the
humans wiring them up) have a substrate-neutral, merge-friendly, honestly-
documented surface to build against. `$ memory_write` is deferred to v0.8.x
bundled with the passthrough auth model — see the auth design thread
`43178c86` for the settled framing.

### Added — adopter-extensible connector class registry

- **`registerConnectorClass(name, entry)` public API.** Adopters with custom
  `McpConnector` classes call this from their bootstrap before
  `loadConnectorsConfig` runs. Closes the merge-conflict bait of editing
  the bundled `KNOWN_CONNECTOR_CLASSES` Map directly. Adopter overrides
  take precedence over bundled set on name collision (lets adopters swap
  bundled classes with hardened variants). Companion: `unregisterConnectorClass`,
  `getConnectorClass`. See `examples/custom-bootstrap.example.ts`.

### Added — canonical runtime config

- **`skillscript.config.json`.** Externalizes runtime knobs (skillsDir,
  traceDir, memoryDbPath, dashboard port + host, pollIntervalSeconds,
  enableUnsafeShell, mode, ollamaBaseUrl, triggersFilePath,
  connectorsConfigPath) into one declarative file. `${VAR}` substitution
  matches `connectors.json`. Loader is graceful on missing file. CLI's
  `dashboard` / `serve` commands accept `--config <path>`; CLI flags
  override file values; file values override defaults.
- **Driver:** two-instance posture. Running dev-skillscript + adopter-wiring
  instance on the same machine requires independent ports/paths. The
  config file makes this a copy-and-tweak operation rather than threading
  CLI flags.
- **`skillscript.config.json.example`** ships at repo root as the template.

### Added — onboarding scaffold (`examples/onboarding-scaffold/`)

- Complete adopter deployment with file-backed memory + OpenAI LLM +
  tmux-shell agent delivery. ~200 LOC across three adapter files plus
  bootstrap. Case-1 typed-contract wiring end-to-end — skills authored
  against this scaffold use canonical `$ llm` / `$ memory` and run
  unchanged against any other Case-1 substrate.
- `file-memory-store.ts` — `MemoryStore` impl over a JSON file with
  simple substring FTS
- `openai-local-model.ts` — `LocalModel` impl over OpenAI Chat
  Completions API
- `tmux-shell-agent-connector.ts` — `AgentConnector` impl via `tmux
  send-keys` (mirrors what nanoclaw-style harnesses do internally)
- `bootstrap.ts` — wiring example tying all three together with the
  v0.7.2 bridges
- `README.md` walking through quick-start, two-instance posture, and
  what to modify for production

### Added — adopter playbook (`docs/adopter-playbook.md`)

- Case-1 typed-contract vs Case-2 MCP-tools wiring tradeoff (the
  load-bearing decision)
- Joe-Programmer setup walkthrough
- Conventions for upstream-merge-friendly modifications (dedicated
  adopter files, `// ADOPTER:org —` sentinels, public registration APIs)
- Substrate ship-status table with honest v0.7.x gap callouts
- Skill discovery + cross-agent composition patterns under Case-1 memory

### Changed — OutputKind cleanup (substrate-neutrality)

- **Dropped `slack` and `card` from `OutputKind`.** Substrate-specific
  delivery names in what's supposed to be a substrate-neutral language.
  Same anti-pattern v0.7.0 removed for `LocalModel` and `MemoryStore`
  dispatch shapes. `OutputKind` now: `text` / `prompt-context: <agent>` /
  `template: <agent>` / `file: <path>` / `none`. Adopters wanting
  Slack / WhatsApp / Discord / etc. use either `$ slack.post ...` MCP
  dispatch inside the skill body OR `# Output: prompt-context: <agent>`
  letting the receiving agent decide. The bundled `EmissionConnector`
  v1.x backlog item is also dropped — MCP-dispatch handles the use case.
- **Substrate-neutrality sweep** of the language surface (parser
  enums, lint code names, ambient refs, frontmatter values, help
  content). Clean post-cleanup; no other substrate-specific leaks
  found in the language contract. Internal AST field `ampParams`
  flagged for renaming in a future pass (not user-facing, no
  contract impact).

### Changed — reference bootstrap framing

- `src/bootstrap.ts` reframed as **reference wiring, not canonical**.
  File header + `bootstrap()` docstring explicitly direct adopters with
  custom substrates to write their own bootstrap importing the public
  APIs. `bootstrap()` remains part of the v0.7.x+ stable public surface
  for default deployments. See `examples/custom-bootstrap.example.ts`
  + `examples/onboarding-scaffold/bootstrap.ts`.

### Changed — public exports

- **New top-level exports** from `skillscript-runtime`:
  `loadSkillscriptConfig`, `bootstrap`, `defaultRegistry`,
  `wireDeclarativeTriggers`, `registerConnectorClass`,
  `unregisterConnectorClass`, `getConnectorClass`,
  `listKnownConnectorClasses`, `loadConnectorsConfig`.
- **New `skillscript-runtime/connectors` exports**:
  `LocalModelMcpConnector`, `MemoryStoreMcpConnector` (so adopter
  bootstraps can wire bridges over their own typed-contract impls
  without reaching into bundled `bootstrap()`).

### Deferred to v0.8.x

- **`$ memory_write`** with the `MemoryStore.write({content, tags?,
  recipients?, expires_at?, metadata?})` contract extension. Ships
  bundled with the passthrough auth model so the credibility-crack of
  documented-but-unshipped delivery closes alongside the auth design.
- **Authorization model.** Mixed: passthrough for op-level mutations
  (substrate enforces; runtime threads credentials); runtime-enforced
  for skill-promotion (`# Status: Draft → Approved` requires non-author
  signer). `# Autonomous: true` becomes documentation; `unconfirmed-mutation`
  lint drops (substrate enforcement makes it theater). New-version-of-
  same-name returns to Draft on content change. See thread `43178c86`
  for the settled design.

### Deferred (post-v0.7.3 ship)

- **R7 cold-author harness.** Tests NFR-6 agent-modifiability empirically:
  cold agent adds a new filter, a new lint rule, and a new runtime-
  intrinsic op against the v0.7.3 file layout. If they succeed, NFR-6 is
  satisfied empirically; if they fail, the failure mode targets which
  extension point to refactor first. Evidence-driven, no major-version
  refactor slot.

### Notes for cold authors

- Run `help({topic: "frontmatter"})` for the updated 5-kind OutputKind set.
- Adopters integrating new substrates: see `docs/adopter-playbook.md`
  for the Case-1 vs Case-2 framing — this is the most important
  decision in your wiring.
- `${VAR}` interpolation, the canonical `$ llm` / `$ memory` surfaces,
  bare-form bridge dispatch, the v0.7.2 typed contracts — all unchanged
  in v0.7.3. Existing skills run as-is unless they used `# Output: slack:`
  or `# Output: card:` (rewrite to `prompt-context:` or use MCP dispatch).

## 0.7.2 — 2026-05-25

**R4-driven punchlist + bridge classes.** Closes the cold-author findings
from the R4 harness round (Perry's report `d284763f`, Scott's decisions
`d89905f3`, bridge-class scope-lock `831c2661`, Perry's GO `5f471b0a`).
The hypothesis test passed in R4 — minions reached for canonical
`emit()`, `file_write()`, `${VAR}` naturally; friction moved deeper into
substantive language semantics. v0.7.2 closes the substantive friction
and lands the substrate-portability story end-to-end.

### Added — language semantics

- **String escape interpretation in double-quoted strings.** `\n`, `\t`,
  `\\`, `\"` interpret to their actual chars inside `"..."`. Bash /
  Python / JS / Go / C all do this; skillscript joins the prior. R4
  minion 4 was reaching for `@ printf %b "${VAR}"` as a workaround;
  now `$set X = "line1\nline2"` produces real newlines. Single-quoted
  strings stay literal pass-through (reserved for v0.8+ literal
  semantics). **Breaking change** — pre-adoption rule applies (no
  external users to disrupt); any skill relying on literal `\n` bytes
  needs a one-time rewrite.

- **Triple-quote multi-line string literals.** `"""..."""` for prose-
  shaped content. Spans line breaks naturally; embedded single `"`
  doesn't terminate (three consecutive `"` chars don't accidentally
  appear in natural English). Escape interpretation applies same as
  single double-quote. Use cases: long-form `emit(text="""...""")`,
  `file_write(content="""...""")`, multi-line `$set X = """..."""`
  reports.

- **`${VAR}` substitution in `# Output:` target slot.** Compile-time
  inputs resolution (caller-passed `inputs` to `compile_skill`,
  `# Vars:` defaults, `# Requires:` cascade values). Runtime-bound
  refs (from `$` op outputs) explicitly deferred — needs two-phase
  frontmatter resolution architectural call. Closes R4 finding #6
  (minion 5 wrote `# Output: prompt-context: ${TARGET_AGENT}` expecting
  parameterized routing; now works).

### Added — lints

- **Tier-3 `object-iteration-advisory` lint.** R4's strongest signal
  (4 of 5 minions hit it). Fires on `foreach IT in ${VAR}` where VAR's
  binding origin is a `$` MCP tool output without `.field` accessor.
  Hints at common envelope-field names (`.items`, `.results`,
  `.issuesPage`, `.data`, `.records`). Placeholder for v0.8 tool-schema
  introspection that catches this precisely.

- **`unconfirmed-mutation` broadened to legacy `@` ops.** Closes R4
  minion 4 sub-finding: `@ printf %b ${REPORT}` silently word-split
  when `REPORT` contained whitespace. Lint now flags any suspect
  `${VAR}` substitution in `@` op bodies (same origin-detection logic
  as the existing `$` op coverage). Pattern also widened to recognize
  both `$(VAR)` and `${VAR}` forms.

### Added — bridge classes (substrate-portability lands)

- **`LocalModelMcpConnector`.** Bridge class that exposes a registered
  `LocalModel` instance as an `McpConnector`. Wraps `LocalModel.run`
  per the canonical contract:
  `$ <connector> prompt="..." [maxTokens=N] [model="..."] -> R` where
  R is the model's response string.

- **`MemoryStoreMcpConnector`.** Bridge class that exposes a registered
  `MemoryStore` instance as an `McpConnector`. Wraps `MemoryStore.query`:
  `$ <connector> mode="fts|semantic|rerank" query="..." limit=N
  [...extras] -> R` where R = `{items: PortableMemory[]}` envelope
  (consistent with the object-iteration-advisory's hint pattern).

- **Bootstrap auto-wire.** Bridges wire automatically at bootstrap as
  connector instances `llm` (default LocalModel) + `memory` (default
  MemoryStore, when SQLite db exists). Zero-config — `$ llm prompt="..."`
  and `$ memory mode=fts query="..." limit=10` work in default
  deployments without adopter wiring. Adopters override by re-registering
  the names or wiring entries in `connectors.json`.

### Architectural framing — canonical MCP-dispatch contract

v0.7.2 doesn't just ship bridge code — it **defines what `$ llm` and
`$ memory` MEAN in skillscript** by shipping with explicit kwarg surfaces.

**Two layers of substrate portability:**

1. **`LocalModel` + `MemoryStore` interface contracts** (typed contracts
   within the runtime). Adopters implement these to plug in their
   substrate without writing MCP servers. Bundled `OllamaLocalModel` +
   `SqliteMemoryStore` are reference impls.
2. **MCP dispatch via `$ <name>`** — bridge classes expose Layer 1 as
   MCP; adopters can also bypass bridges and wire any MCP server under
   any name (`$ pinecone_vector`, `$ amp.amp_query_memories`, etc.).

**Bundled memory surface is ONE canonical call** (per Perry's scope-lock
`5f471b0a`):
```
$ memory mode="fts|semantic|rerank" query="..." limit=N [...extras] -> R
```
Read-only, FTS-flavored. Substrate-portable across any `MemoryStore`-
interface impl. Explicitly **not** bundled (adopter wires via dotted-form
escape hatch `$ <connector>.<tool>`):
- `$ memory_write`, `$ memory_get` (no MemoryStore interface methods)
- Thread operations (`$ thread_get`, `$ thread_close`,
  `$ thread_check_mailbox`, etc.) — substrate-specific
- Introspection / traversal / promote / reinforce — substrate-specific
- Mutations beyond write — substrate-specific

For Tradita-style deployments, AMP wires as `$ amp.<tool>` with the
full ~15-tool surface available; `$ memory` covers the canonical query
path, `$ amp.<tool>` covers AMP-specific operations.

### Changed

- **`deprecated-symbol-op` lint** — remediation messages now confidently
  suggest `$ llm` / `$ memory` (the bridge auto-wire makes these
  load-bearing in default deployments). No more "(or your wired LLM
  connector name)" caveat.

- **`help()` content** — all six topics (quickstart, ops, frontmatter,
  examples, composition, connectors, lint-codes) refreshed to canonical
  v0.7.0+ surface. Container FS isolation note added. `object-iteration-
  advisory` indexed. Tradita-internal naming scrubbed from connectors
  topic.

- **Quickstart hero example** — broken `$append REPORT <line>...</line>`
  accumulator pattern replaced with `emit(text="...")` per-line +
  `# Output: prompt-context:` delivery channel. Matches Perry's
  corrected §1 doc atom.

- **AST**: `op.sourceForm?: "function-call"` field already added in v0.7.1
  to distinguish canonical from legacy at lint time. Continues to do
  load-bearing work for the deprecated-symbol-op lint.

### LOC ceiling

Narrow-core ceiling 7250 → 7550. Bridges add ~80 LOC each (auxiliary
surface). String-escape interpreter + triple-quote tokenizer state +
${VAR}-in-Output substitution + object-iteration advisory + @-op
unquoted-subst extension add ~200 LOC narrow-core total.

### Tests

53 new tests across 5 v0.7.2-specific test files:
- `v0.7.2-object-iteration-advisory.test.ts` — 6 tests
- `v0.7.2-string-escapes.test.ts` — 12 tests
- `v0.7.2-triple-quote-literals.test.ts` — 14 tests
- `v0.7.2-output-substitution.test.ts` — 9 tests
- `v0.7.2-unquoted-subst-at-op.test.ts` — 7 tests
- `v0.7.2-bridge-classes.test.ts` — 16 tests (unit + closed-set registry)

Plus updated fixtures across test files where bootstrap auto-wire
shifted expected behavior. Suite: 974 passing, 10 skipped, 1 env-gated
YouTrack.

### Deferred to v0.8 (per locked roadmap)

- **Tool-schema introspection** that adapts the object-iteration-advisory
  + deprecation lints based on actual connector availability
- **Richer memory contract** covering vector / embedding / hybrid
  substrates beyond FTS-flavored query
- **`MemoryStore.write()`** interface addition to enable a bundled
  `$ memory_write` bridge (currently adopter-wired)
- **Pagination / `while` loop** primitive (v0.9)
- **Phase 2 trigger sources** (event + agent-event) — v0.11
- **Output routers** (slack + card) — v0.12

## 0.7.1 — 2026-05-25

**R4-enabling polish.** Help-content refresh (was the R4 cold-author harness
blocker), tier-2 deprecation visibility lints, broadened `unconfirmed-mutation`
enforcement using the captured `approved="..."` kwarg from v0.7.0, scaffold
hygiene. Per Perry's v0.7.1 kickoff `7f31c7a4`. Bridge classes
(`LocalModelMcpConnector` + `MemoryStoreMcpConnector`) deferred to v0.7.2
as a dedicated AMP-substrate dogfooding release.

### Added

- **Tier-2 `deprecated-symbol-op` lint.** Fires on legacy symbol-form ops
  (`~`, `>`, `@`, `!`, `??`, `&`) with the canonical replacement in the
  remediation message (`emit(text="...")`, `shell(command="...")`, etc.).
  Tier-2 (warning, not error) during the v0.7.x grace period; tier-1
  promotion (refuse-to-compile) lands in v0.8/v0.9. Dedupes per-kind-per-
  target — one nudge per legacy op type per target. Uses a new
  `op.sourceForm` AST marker to distinguish canonical function-call ops
  (silent) from legacy symbol-form ops (warned), since both parse to the
  same AST kind in v0.7.0.

- **Tier-2 `deprecated-substitution-shape` lint.** Fires on legacy
  `$(VAR)` substitution form, advises rewrite to `${VAR}` canonical. Skips
  the `$$(VAR)` escape (used in `@ unsafe` for bash literal pass-through).
  Dedupes per-var-per-target. Tier-1 promotion in v0.8/v0.9.

- **`unconfirmed-mutation` broadening.** Closes the captured-but-not-
  enforced gap from v0.7.0. The lint now covers:
  - `$` MCP dispatch with mutating-shape tool name (unchanged)
  - `$ memory_write` MCP dispatch (new — matches the canonical memory-
    delivery channel name)
  - `file_write(...)` runtime-intrinsic op (new — v0.7.0 ship)

  Three authorization paths recognized:
  1. `# Autonomous: true` skill flag (existing, v0.4.2)
  2. Preceding `??` / `ask(prompt="...")` confirmation op in same target
  3. **New (v0.7.0+):** `approved="reason"` per-op kwarg — any non-empty
     string. Value not parsed semantically; presence is what matters.
     Replaces the v0.4.2-era `(approved: "...")` trailer for function-
     call ops.

- **`help()` content refresh (R4 blocker).** Quickstart (default `help()`
  call) rewritten to lead with the v0.7.0 framework — trigger → process →
  deliver model, three op classes, three delivery channels, canonical
  `${VAR}` substitution and function-call op shape throughout. Worked
  end-to-end example uses canonical syntax (morning-showstopper-sweep
  pattern with memory-handoff delivery). Legacy syntax footnoted with
  grace-period note. `LINT_CODES` topic updated with the two new
  deprecation rules + broadened `unconfirmed-mutation` semantics.

- **Scaffold hygiene** (`scaffold/connectors.json` +
  `connectors.json.example`). Updated to v0.4.0+ class-registry format,
  explicit v0.7.0 substrate-framing comments, planned `LocalModelMcpConnector`
  + `MemoryStoreMcpConnector` v0.7.2 entries as future-reference templates.
  All internal naming (Tradita, AmpMcpConnector, amp_query_memories)
  scrubbed — scaffold is adopter-neutral.

### Changed

- **AST:** new optional field `op.sourceForm?: "function-call"` set by the
  parser's function-call dispatch path. Distinguishes canonical from
  legacy at lint time without changing runtime/render dispatch (both
  paths still produce identical AST kinds).

### Roadmap update

- **v0.10 `foreach parallel` cut from roadmap.** Cron windowing covers
  the use case; parallel `$append` opens thread-safety + ordering
  complexity in a constrained language; adopters can implement parallel
  inside an MCP tool. Speculative gap, not load-bearing for the
  broker-replacement north star.

### LOC ceiling

Narrow-core ceiling nudged 7150 → 7250. ~105 LOC across lint.ts (two new
tier-2 rules + `unconfirmed-mutation` broadening) + ~5 LOC in parser.ts
(sourceForm marker setters). Help-content refresh is content swap, no
net LOC.

### Tests

14 new tests in `tests/v0.7.1-deprecation-lints.test.ts` covering the
two deprecation rules + `unconfirmed-mutation` broadening (file_write +
`$ memory_write` + `approved=` kwarg + `# Autonomous: true` + preceding
`ask()` gate). Suite: 910 passing, 10 skipped, 1 env-gated YouTrack.

## 0.7.0 — 2026-05-25

**Syntax revamp + pre-adoption clean break.** Two grammar additions
(canonical `${VAR}` substitution + function-call op shape), two new
runtime-intrinsic ops (file_read, file_write), one throwaway script
that mechanically rewrites every prior-version skill to the new
surface. Legacy forms (`$(VAR)`, `~`, `>`, `@`, `!`, `??`, `&`) continue
to compile + run during the grace period; tier-1 lint promotion lands
in v0.8/v0.9. Per Perry's kickoff `50a83a88` + final consolidated framework
`c48fca7e` + approval `783a10a4`.

### Added (canonical surface)

- **`${VAR}` substitution canonical form.** Replaces `$(VAR)` (legacy,
  still works during grace period). Field access `${VAR.field}` +
  filter chain `${VAR|filter:"arg"|filter2}` work identically. Closes
  the bash-command-substitution collision (`$(date)` runs `date` in
  bash; `${VAR}` is bash variable-interpolation — same intuition path,
  no semantic ambiguity). The `$$(VAR)` shell-escape gains a parallel
  `$${VAR}` form.

- **Function-call op grammar.** `verb(kwarg=value, ...) [-> BINDING]`.
  Closed runtime-intrinsic set: `emit`, `ask`, `inline`, `execute_skill`,
  `shell`, `file_read`, `file_write`. Paren-balanced parsing (nested
  parens in kwarg values handled), comma-separated kwargs, quote-aware.
  Unknown function-call names produce a parse error with remediation:
  "if this is an MCP tool, use `$ tool args -> R` shape instead."

- **`file_read(path=) -> CONTENT` runtime op.** Reads file contents
  via Node `fs.readFile`. Substitutes `${VAR}` in the path. Optional
  `(fallback: "...")` trailer for missing-file handling. New
  runtime-intrinsic op for skills that pull data from local files for
  prompt-context injection or processing.

- **`file_write(path=, content=, approved="...")` runtime op.** Writes
  contents via Node `fs.writeFile`. Auto-creates parent directories
  (`mkdir -p` semantics). Substitutes `${VAR}` in both path and content.
  The `approved=` kwarg is the v0.7.0 author-intent marker for mutation
  ops outside `# Autonomous: true` skills; lint enforcement broadens
  in v0.7.1.

- **`approved="reason"` inline kwarg shape.** Captured on every
  function-call AST node; uniform with the all-kwargs discipline.
  Required string value forces author intent (presence matters; value
  not parsed semantically). Replaces the `(approved: "...")` trailer
  syntax for function-call ops (legacy trailer still works on symbol-
  form ops).

### Changed (substrate framing)

- **`local_model` and `memory_query` removed as language keywords.**
  Pre-v0.7.0: `~` and `>` ops dispatched to amp's `amp_invoke_local_model`
  and `amp_query_memories` MCP tools via hardcoded paths — amp-specific
  privilege baked into the language. v0.7.0: they become regular
  `$ <connector>` MCP dispatch resolved against `connectors.json`.
  Tradita wires `llm` + `memory` as connector names pointing at amp;
  external adopters wire whatever substrate they use. Language stops
  assuming amp is the substrate.

### Architectural framework

Per the design conversation captured in thread `50a83a88 → c48fca7e`:

- **Skillscript is a compose-time prompt-construction language.** Its
  job is to build the prompt-context the agent receives, with optional
  pre-dispatch optimizations baked in. Not a general execution
  environment.
- **Two layers:** compose (skillscript) + execute (agent at higher
  level with native Read/Write/Bash/MCP tools).
- **Three delivery channels** — embedded prompt (`emit`), memory
  handoff (`$ memory_write`), file handoff (`file_write`). All
  first-class.
- **Three op classes** — mutation statements (`$set`/`$append`),
  runtime-intrinsic function-calls, external MCP dispatch.

### Migration + harness cleanup

One-shot Node script (`scripts/migrate-v07.mjs`, removed after use)
rewrote `examples/` from legacy to canonical (9 files, 138 rewrites:
92 substitution-shape + 25 emit + 8 tilde + 7 shell + 5 memory + 1
ask). Markdown-aware, idempotent. No permanent CLI surface.

**Pre-adoption harness cleanup.** The wild-and-crazy harness corpus
(R1/R2/R3 cold-author fixtures from v0.2.9 production) — `tests/skills/`,
`tests/fixtures/harness/`, `tests/harness-corpus.test.ts`,
`tests/skills-battery.test.ts` — removed in this release. Pre-adoption
means no external users depend on backwards-compat regression coverage;
R4 will rebuild fresh fixtures against canonical v0.7.0 syntax. Test
count drops ~187 (harness-corpus 66 + skills-battery 121) but the
remaining 896 tests cover the parser/runtime/lint paths comprehensively,
and v0.7.0-brace-substitution + v0.7.0-function-call ship 30 new tests
specific to the canonical surface. Git history preserves the discarded
fixtures if any are ever wanted as legacy snapshots.

### Deprecation grace period

Legacy syntax (`$(VAR)`, `~`, `>`, `@`, `!`, `??`, `&`) continues to
compile + execute in v0.7.x — both forms work identically during the
grace window. Tier-2 `deprecated-symbol-op` lint (visibility nudge)
ships in a v0.7.x point release; tier-1 promotion (refuse-to-compile)
lands in v0.8 or v0.9 once adopter ecosystem confirms migration.

### LOC ceiling

Narrow-core ceiling nudged 6800 → 7150 (current: 7078). ~280 LOC
across parser.ts (function-call grammar + REF_PATTERN const + paren-
balanced helpers) + runtime.ts (file_read/file_write + loose-bracket
condition regexes + `$${` escape) + compile.ts (alternation substitute
+ new op renderers) + lint.ts (4-capture extractVarRefs). Per the
v0.5.0 lesson `loc-vs-clarity`: ceiling is a signal, not a budget.

### Tests

30 new tests across 2 files (`v0.7.0-brace-substitution.test.ts`,
`v0.7.0-function-call.test.ts`). All 7 runtime-intrinsic function-call
ops covered + ${VAR} substitution in all positions (substitution body,
conditions, $set RHS, kwarg values) + file_read/file_write round-trip
+ mkdir-p + fallback + mixed legacy-and-new in same skill. Net suite
(after harness cleanup): 896 passing, 10 skipped, 1 env-gated
(YouTrack token).

## 0.5.0 — 2026-05-24

**R3 harness-driven cold-author UX wins.** Eight items closing the
load-bearing footguns the R3 cold-author harness surfaced (Perry kickoff
`15a50e29`). Bash-shaped string composition lands as a pair (items 2+3);
the `|fallback:"X"` filter closes ref-level coalesce; silent stubs on
unwired connectors become hard errors with a tier-1 lint; the
unquoted-substitution kwarg footgun gets a tier-2 lint with binding-
origin awareness; `$(NOW)` aligns with its documented ISO-8601 shape;
docs catch up on outputs.text + kwarg grammar.

### Added (load-bearing)

- **String-typed `$append` (item 2).** `$append VAR "more"` now type-
  dispatches on the target binding: list → push (existing behavior,
  regression-protected); string → concatenate (new). Lifts the
  `append-to-non-list` lint restriction for string-typed inits. Mirrors
  bash `+=`. Smallest behavior change to existing op that closes the
  R3 minion 4 string-composition gap.

- **`$set` bind-time interpolation (item 3).** `$set X = "...$(REF)..."`
  now resolves `$(REF)` at bind time (was: literal binding, refs
  unresolved at use-time). Mirrors bash double-quoted assignment. Per
  the design philosophy memory `8cccf5e5`: cold authors approach
  skillscript with bash intuition; items 2+3 together close the
  bash-shaped composition category without adding new operator surface.
  Behavior change called out per `dc824ee4` lesson option 1 — the
  literals-only spec was the cold-author footgun, not a deliberate
  call. R3 minion 4 + T6 dogfood independently confirmed in 3 days.

- **`|fallback:"X"` filter (item 4).** `$(VAR.field|fallback:"-")` —
  coalesce-on-missing-ref. When the upstream ref is unresolved, the
  filter substitutes the literal arg and the chain continues. Positional
  within the chain. Named `fallback` (not `default`) to align with
  op-level `(fallback: ...)` vocabulary — different syntactic site,
  same universal word for "what to do when a value-producer doesn't
  produce." Renaming decision: design thread `15a50e29` / `9f59ef63`.
  The pipe chain IS a primitive (filter-composition algebra); breaking
  the chain to align with op-level syntax would lose real expressiveness.

- **Silent-stub-on-unwired-connector → hard error + tier-1 lint
  (item 5).** Pre-v0.5.0: bare `$ TOOL` ops with no `primary` connector
  and no embedder toolDispatch emitted "Would call tool X (no
  dispatcher wired)" and bound `null` to the output var. Autonomous
  skills thought they succeeded. v0.5.0: runtime throws
  `ConnectorNotFoundError` (caught by op-level `(fallback:)` if
  declared); new tier-1 `unwired-primary-connector` lint surfaces the
  same at compile time when the registry is queryable. R3 minion 4
  motivation.

- **`unquoted-substitution-in-kwarg-value` tier-2 lint (item 1).** Fires
  when `$ tool key=$(VAR)` has unquoted `$(VAR)` AND VAR's binding
  origin suggests whitespace (`# Vars:` default with whitespace, `$set`
  literal with whitespace, `~`/`$`/`>` op output, or foreach iterator).
  Closes the R3 silent-arg-truncation footgun — pre-v0.5.0 the rendered
  string `key=value with spaces` re-tokenized at the MCP arg boundary
  and only the first chunk bound to `key`. Folklore (always quote
  dynamic kwarg values) becomes lint discipline. Walker tracks binding
  origin via `# Vars:` / `$set` / op-output / foreach-iter and only
  fires on suspect origins — no noise on safe literals.

### Added (polish)

- **`$(NOW)` ISO-8601 alignment (item 6).** `$(NOW)` now substitutes as
  ISO-8601 per the documented spec (was: raw epoch ms — docs/runtime
  drift identified by R3 minion 2). Numeric epoch ms/sec remain
  available as `$(EVENT.fired_at)` / `$(EVENT.fired_at_unix)`. New
  `|isodate` filter formats epoch ms/sec (auto-detected by magnitude)
  or ISO strings to ISO-8601 — `$(EVENT.fired_at_unix|isodate)`.

- **Docs: outputs.text shape clarification (item 7).** Investigated:
  the runtime intentionally distinguishes "programmatic surfaces"
  (`text`, `file:` — default to lastBoundVar, structured) from
  "human-readable surfaces" (`prompt-context:` / `template:` /
  `slack:` / `card:` — default to joined emissions). Cold-author
  surprise (R3 minion 3) was a docs gap, not a runtime bug. Help
  content now explains both shapes inline with the `# Output:` syntax.
  Emit-as-binding primitive (`! "text" -> VAR`) deferred to v0.5.1 as
  its own design item.

- **Docs improvements (item 8).** `# Output:` value-shape per kind
  documented inline. `$` op kwarg grammar table added (bare string,
  quoted string, integer, boolean, null, JSON array, JSON object,
  substitution, quoted substitution) with the v0.5.0 unquoted-kwarg
  lint warning surfaced inline. `|fallback:"X"` + `|isodate` filter
  entries added to the pipe-filters table. `$(NOW)` ISO-8601 note in
  the filters section.

### Changed

- **`|default:"X"` filter renamed to `|fallback:"X"`** (never shipped
  under the old name — vocabulary alignment landed pre-release, see
  item 4 above).

- **Runtime `$(NOW)` now substitutes as ISO-8601 string** (was: number
  with epoch ms). Skills consuming `$(NOW)` as a string get the
  documented shape; skills doing math on `$(NOW)` must migrate to
  `$(EVENT.fired_at)` (epoch ms) or `$(EVENT.fired_at_unix)` (sec).
  No shipped skills are known to math on `$(NOW)` — the surface read
  as a "current timestamp string" everywhere.

### Implementation notes

- **51 new tests across 5 v0.5.0 test files**: `v0.5.0-bash-pair`,
  `v0.5.0-fallback-filter`, `v0.5.0-unwired-connector`,
  `v0.5.0-unquoted-kwarg`, `v0.5.0-now-isodate`, `v0.5.0-outputs-shape`.
  Suite is 1052/1064 passing (2 failures are the YouTrack proving env
  gate and the pre-bump LOC ceiling — both expected).
- **LOC ceiling nudged 6600 → 6800** to accommodate the binding-origin
  walker + condition-context filter applier + chain parser.
- **Design discipline**: items 4 and 7 each ran a design-pushback loop
  (CC pushed back on Perry's primitive-unification framing for item 4;
  Perry conceded with "adjacent concepts that rhyme aren't the same
  primitive" sharpening; CC investigated item 7 first per Perry's gate
  framing, found it was a docs change, deferred emit-as-binding to
  v0.5.1). Both directions of the pushback pattern, healthy.

## 0.4.4 — 2026-05-24

**Dashboard SPA Connectors view shows the wired registry.** Closes the
"dashboard MCP view" gap (per `08a08316`): pre-v0.4.4 the SPA's
`#connectors` tab showed only post-hoc activity metrics from
`health_metrics`, so a user could wire YouTrack through `connectors.json`
and see an empty page until a skill actually exercised it.

### Fixed

- **`renderConnectors()` polls `runtime_capabilities`** and renders the
  full wired registry (MCP, Local model, Memory store, Skill store,
  Agent) above the existing activity-metrics table. Each entry shows
  class, contract version, and (for MCP) the effective `allowed_tools`
  allowlist from v0.4.1. Available MCP classes for `connectors.json`
  surface as a footer note (closed-set registry from v0.4.0).

- **`state.capabilities` field** populates on every poll (30s cadence).
  Refresh path is `runtime_capabilities` alongside the existing
  `skill_list` / `list_triggers` / `health_metrics` calls.

### Implementation notes

- **SPA-only change.** No runtime / parser / lint impact. The
  `runtime_capabilities` MCP tool already surfaced the full registry
  shape (v0.4.0 + v0.4.1); this release wires the SPA to consume it.
- **Tests:** 5 new in `tests/v0.4.4.test.ts` covering source-level
  wiring (polling, render, allowlist, classes) + dist/ build
  verification (so deployed dashboards get the fix).
- **LOC unchanged.** SPA changes don't count against narrow core; no
  ceiling impact.

## 0.4.3 — 2026-05-24

**CLI auto-discovers `connectors.json` from `$SKILLSCRIPT_HOME`.** Closes
the v0.4.x arc's last-mile gap: pre-v0.4.3, the loader + lint + runtime
+ allowlist all worked, but `skillfile dashboard` and `skillfile serve`
(both via `cmdRuntimeHost`) called `bootstrap()` without
`connectorsConfigPath`. The scaffold's `connectors.json` was dead-on-
arrival via the canonical CLI path.

### Fixed

- **`cmdRuntimeHost` now passes `connectorsConfigPath: $SKILLSCRIPT_HOME/connectors.json`** to `bootstrap()`. The loader is graceful on missing files (returns empty result), so the default is safe for users without a connectors.json. Bug since v0.4.0.

### Added

- **`--connectors PATH` flag** on `skillfile dashboard` and `skillfile serve` — overrides the default for non-standard layouts. Useful for testing connectors-as-config without modifying `$SKILLSCRIPT_HOME/connectors.json`.

### Implementation notes

- **One-line behavior change.** No architecture impact; just wires the existing config-path through the existing bootstrap API.
- **Tests:** 5 new in `tests/v0.4.3.test.ts` covering `--help` flag presence, bootstrap path resolution, graceful-missing handling, and a source-level regression-lock to guard against silent regression of the wire-up.
- **LOC unchanged at 6593/6600.** Ergonomic patch; no language surface changes.

## 0.4.2 — 2026-05-24

**Markdown support + strict-target detection + `# Autonomous: true`
header.** Closes the cold-author footgun where `.skill.md` files with
markdown prose around the skill code triggered misleading
`missing-dependency` cascade errors (`fbf10206`). Adds the canonical
declarative marker for autonomous-execution skills.

Spec: Perry approval `08a08316` + amendment `f352413d` + final
greenlight `efad035f`.

### Added

- **Markdown extraction at parser layer** — `parse()` scans the
  source for the first ` ```skillscript ` or ` ```skill ` fenced block
  and parses its contents. Cold-author LLMs writing markdown prose
  around their skill code get extraction automatically. Lives in the
  parser, not the skill store — clean layering per Scott's read
  ("storage shouldn't be the format-dispatch layer").

  **Lenient by design**: if no fenced block is found, the whole source
  parses as raw (existing behavior). Backward-compatible with every
  existing `.skill.md` file — no migration, no breakage. The fenced-
  block convention is the *recommended* shape for files with prose;
  pure-code files keep working as-is.

  ```
  # Welcome
  Use this skill for the morning sweep.
  
  ```skillscript
  # Skill: morning-sweep
  # Status: Approved
  run:
      ! morning
  default: run
  \`\`\`
  ```

- **Strict-target-detection** — target declaration lines now require
  `<ident>:` shape (matching `[A-Za-z_][\w-]*`). Prose lines like
  `## Use this:` or `Note (important):` are silently treated as
  comments instead of misread as malformed target declarations. Pairs
  with markdown extraction: even without a fenced block, prose lines
  no longer cascade into misleading missing-dep errors.

- **`# Autonomous: true | false` header** — declarative authorship
  intent marker for unattended-execution skills (cron-fired, agent-
  fired, etc.). Today silences `unconfirmed-mutation` lint warnings
  for the whole skill (since the user-confirmation pattern doesn't
  apply to autonomous skills). Implemented as a category marker on
  `ParsedSkill.autonomous` so future rules + scheduling defaults +
  discovery surfaces can hook into the same field without breaking-
  change — per Perry's framing in `efad035f`.

### Fixed

- **`unconfirmed-mutation` lint conditional on `# Autonomous`** —
  pre-existing rule from v0.2.11 (`Bug 6`) now properly distinguishes
  interactive skills from autonomous ones. Cold-author skills that
  legitimately invoke mutating tools without `??` confirmation
  (cron-fired log-monitoring → YouTrack issue creation, etc.) declare
  intent via the header instead of seeing false-positive warnings.

### Implementation notes

- **Parser-layer extraction** matters because file-extension dispatch
  (the rejected alternative path) would have coupled the skill store
  to markdown semantics. Storage stays format-agnostic; parser handles
  the markdown wrapper concern locally. No skill store changes in this
  release.

- **Tests:** 23 new across `tests/v0.4.2-autonomous.test.ts` (10 —
  header recognition + lint conditional + help-content) and
  `tests/v0.4.2-markdown.test.ts` (13 — extractor + parse integration +
  strict-target-detection + end-to-end cold-author footgun closure).
  Total 965 passing in the suite (3 long-skip browser dogfood).

- **No LOC ceiling nudge.** 6593/6600 — under by 7. The ergonomic
  fixes are small enough to fit in the v0.4.1 ceiling without
  expansion.

## 0.4.1 — 2026-05-24

**`RemoteMcpConnector` + per-connector tool allowlist + YouTrack proving
end-to-end.** First "external-MCP-in-Skillscript" release. v0.4.0
shipped the config-plumbing mechanism (loader, validation, lint,
discovery, discipline); v0.4.1 ships the first JSON-instantiable
connector class and proves it works against real YouTrack through the
`mcp-remote` bridge.

Spec: Perry kickoff `c65e77af` + amendments `8a7356dc` (allowlist) +
`89e2752d` (Scott's framing/scope answers).

### Added

- **`RemoteMcpConnector` class** (`src/connectors/mcp-remote.ts`). Child-
  process spawn + JSON-RPC stdio bridge. Lifecycle: initialize
  handshake, `tools/call` dispatch, clean shutdown via `shutdown` request
  → SIGTERM → SIGKILL fallback. No auto-restart in v0.4.1 — child crash
  puts the connector into an error state; subsequent dispatch throws
  `RemoteMcpDispatchError`. Library-level `connector.call()` returns the
  raw MCP `{content, isError}` envelope; runtime's `unwrapToolResult`
  does the convention-aware unwrap (text → `JSON.parse`).

- **Closed-set class registry adds `RemoteMcpConnector`** with
  `fromConfig` factory. Existing v0.4.0 `connectors.json` shapes pointing
  at this class now instantiate cleanly.

- **`framing` config option** — `"lsp"` (default) or `"newline"`. The
  YouTrack proving case exposed that `mcp-remote` speaks newline-
  delimited JSON-RPC, NOT LSP `Content-Length` headers. The
  config-driven option (item 5 of the kickoff) is exactly the escape
  hatch needed. Lint rejects unknown framing values.

- **Per-connector `allowed_tools` allowlist**. Optional config field on
  connectors.json entries. Semantics: `undefined` = allow-all
  (backward-compat with v0.4.0); `[]` = allow-none (staging disable
  pattern); listed = exactly these tools, nothing else.
  - New tier-1 lint rule `disallowed-tool` fires at compile time on
    `$ name.tool` where `tool` isn't in the allowlist
  - Runtime defense-in-depth: dispatcher refuses disallowed calls even
    if lint is bypassed (the "fail closed even when lint missed it"
    backstop per `8a7356dc`)
  - `runtime_capabilities` surfaces effective allowlist per connector
    (or `null` for allow-all)

- **Env-block-as-scope `${VAR}` substitution.** v0.4.0 only resolved
  `${VAR}` from `process.env`. v0.4.1 resolves the connector's `env`
  block first, then merges into the substitution scope for the rest of
  the config. Composable shape from Claude Desktop's `mcp.json`:

  ```json
  "args": [..., "--header", "Authorization:${AUTH_HEADER}"],
  "env":  { "AUTH_HEADER": "Bearer ${YOUTRACK_TOKEN}" }
  ```

  `YOUTRACK_TOKEN` resolves from process env; `AUTH_HEADER` derives once
  in the env block; args reference the derived value.

- **Loader-time gitignore-detection warning** (folded v0.4.0 deferral).
  At startup, if `connectors.json` is detected in a `.git`-tracked
  directory without a `.gitignore` entry covering it, emit a one-time
  stderr warning. Informational; doesn't block startup.

- **`unknown-connector` lint auto-wires from runtime registry** (folded
  v0.4.0 deferral, closes Perry's signoff observation `a4ae08a6`). MCP
  `lint_skill` + `compile_skill` handlers auto-pass the running
  runtime's `registry` to lint, so `unknown-connector` + `disallowed-
  tool` fire by default without callers having to remember explicit
  options. Cold-author callers targeting a different runtime can
  override via explicit `mcpConnectorNames` / `mcpConnectorAllowedTools`.

- **`foreach` over parsed-JSON arrays** (folded v0.4.0 deferral). v0.2.5
  extended `in`-RHS to tolerate JSON-string values that parse to arrays;
  v0.4.1 mirrors that tolerance into `foreach`. Lets
  `foreach I in $(RAW):` work when `RAW` is a string that JSON-parses
  to an array (e.g., from a `~` op response). `$ json_parse`-bound
  arrays already worked since the parsed structure is in the vars map
  directly.

- **Kwarg type coercion in `$` op calls.** Pre-v0.4.1, `limit=5` in
  `$ youtrack.search_issues query="for: me" limit=5` was sent as the
  string `"5"`. YouTrack (and other typed MCPs) rejected with "expected
  integer, got String." v0.4.1 adds `coerceKwargValue` in
  `parseToolArgs`: unquoted `^-?\d+$` → integer, `^-?\d+\.\d+$` →
  number, `true`/`false` → boolean, `null` → null,
  `[...]`/`{...}` shapes → JSON-parsed if valid. Quoted strings force
  the string type (`count="5"` stays "5").

- **YouTrack proving end-to-end** (`tests/v0.4.1-youtrack-proving.test.ts`).
  8 tests covering direct connector dispatch (initialize, tools/list,
  `get_current_user`, `search_issues` with integer kwarg), full skill
  chain (`examples/youtrack-morning-sweep.skill.md` compile + execute),
  kwarg type coercion regression-lock, allowlist enforcement (positive +
  negative against real YouTrack). Always-fail-if-`YOUTRACK_TEST_TOKEN`-
  missing per Scott's call (`89e2752d`). CI workflow updated.

### Example skill

`examples/youtrack-morning-sweep.skill.md` checked in — the canonical
"external remote MCP in Skillscript" proving case. Compiles + executes
against real YouTrack given a configured `youtrack` connector.

### Implementation notes

- **Narrow-core LOC ceiling 6000 → 6600.** ~330 LOC for the
  `mcp-remote.ts` connector class (spawn + framing + lifecycle), ~60
  LOC across Registry + config + lint + runtime for allowlist
  plumbing, ~40 LOC for env-block-as-scope substitution refactor, ~50
  LOC for kwarg coercion + foreach JSON tolerance + lint auto-wire
  threading. ~50 LOC for the gitignore-detection helper. New file
  takes us to 15 narrow-core files; ceiling stays under 20.

- **Tests:** 50 new across `tests/v0.4.1-mcp-remote.test.ts` (21 —
  bridge core via mock child processes), `tests/v0.4.1-allowlist.test.ts`
  (17 — allowed_tools loader + lint + runtime + discovery),
  `tests/v0.4.1-folded.test.ts` (12 — gitignore detection, lint auto-
  wire, foreach over parsed-JSON), plus 8 in
  `tests/v0.4.1-youtrack-proving.test.ts` (live YouTrack chain). Total
  58 new; 955 passing in the suite (3 long-skip browser dogfood).

- **CI requires `YOUTRACK_TEST_TOKEN` secret.** Set in repo settings.
  Token should be allowlist-scoped (read-only YouTrack tools), not a
  personal admin token. Failure-mode is loud: missing token → CI fails
  at the test step → no publish (avoids silent regression).

## 0.4.0 — 2026-05-24

**`connectors.json` loader + credential discipline (config plumbing).**
First MCP-scripting-era release. Wires the per-host connector
configuration the ERD §3+§4 spec has called for since T2. Loads
`connectors.json` at runtime startup, parses + validates, resolves
`${VAR}` substitutions, and registers each declared instance into the
Registry. Closed-set class registry + two new tier-1 lint rules. Spec
at `b3f6c5ed` (Perry kickoff) + `58a9d3d3` (credential amendment) +
`8f723b6a` (final approval).

**Split note:** `RemoteMcpConnector` (the stdio-bridge class for remote
MCPs via `mcp-remote` etc.) deferred to v0.4.1. v0.4.0 ships the
mechanism — loader, validation, lint, discovery, credential discipline
— but the only class in the v0.4.0 closed set (`CallbackMcpConnector`)
isn't JSON-instantiable (it requires a dispatch function). v0.4.1
adds `RemoteMcpConnector` as the first real configurable class, plus
the YouTrack end-to-end proving test.

### Added

- **`connectors.json` loader.** Reads from `BootstrapOpts.connectorsConfigPath`
  (caller-supplied path; bootstrap stays explicit, doesn't auto-discover).
  Missing file → graceful empty result. Malformed JSON / structural
  errors / unknown class / unset `${VAR}` → clear startup errors via
  `BootstrapResult.connectorConfigErrors`. Permissive on unknown
  fields so v0.4.1 schema additions (`allowed_tools`, etc.) plug in
  without breaking compat.

- **Credential resolution: two shapes.** Matches Claude Desktop's
  `mcp.json` convention:
  - Literal: `"AUTH_HEADER": "Bearer plnt-..."` (in-file)
  - Env-var substitution: `"AUTH_HEADER": "Bearer ${YOUTRACK_TOKEN}"`
    (resolved from `process.env` at load time)

  Missing `${VAR}` → clear error (not silent empty-string substitution).
  Both shapes work; deployments should prefer `${VAR}` per the
  credential-discipline section.

- **Closed-set class registry.** v0.4.0 set: `{CallbackMcpConnector}`.
  Plugin-style runtime-arbitrary class loading deliberately out of
  scope (security surface, discoverability, API maturity). Unknown
  class in `connectors.json` → clear startup error listing the known
  set. The set grows via CHANGELOG-tracked runtime releases.

- **`unknown-connector` tier-1 lint.** Fires on `$ name.tool` ops
  where `name` isn't a wired connector. Includes the list of wired
  names in the diagnostic so cold authors can correct typos quickly.
  Silent when the caller doesn't know what's wired (no false positives).

- **`unknown-connector-class` tier-1 lint** (Perry's sibling addition,
  `8f723b6a`). Re-surfaces the loader's "unknown connector class"
  errors via the lint API for tooling that consumes lint as the
  primary diagnostic surface (compile_skill / lint_skill MCP).

- **`runtime_capabilities` discovery extension.** New `include`
  option: `mcpConnectorClasses` returns the closed-set class names.
  Cold authors introspect "what classes can I configure?" before
  writing `class: "..."` fields.

- **Credential discipline (hard requirement).** Perry's amendment
  promoted from footnote to ship requirement:
  - `connectors.json` added to repo root `.gitignore` (root-anchored
    so the scaffold's bundled placeholder stays tracked)
  - `connectors.json.example` shipped at repo root as the version-
    controlled template
  - README "Connector model" section documents both credential
    shapes + the gitignore default + the discipline rationale
  - Loader-time gitignore-detection warning deferred to v0.4.1

### New module

- **`src/connectors/config.ts`** — loader + env substitution + closed-set
  class registry. ~190 LOC including docstrings. Public surface:
  `loadConnectorsConfig({path, env?})`, `listKnownConnectorClasses()`,
  `resolveEnvSubstitution(value, env)`, `KNOWN_CONNECTOR_CLASSES`.

### Implementation notes

- **Narrow-core LOC ceiling 5750 → 6000.** Net ~190 LOC from the new
  `connectors/config.ts` module plus ~50 for the two lint rules and
  the `mcpConnectorNames` LintContext field. Consistent with v0.3.0's
  200-LOC nudge for `$append`. History entry in `loc-ceiling.mjs`.

- **`BootstrapOpts.connectorsConfigPath`** is explicit (no auto-
  discovery from CWD). Embedders pass the path; the CLI's
  `skillfile dashboard` / `skillfile serve` / `skillfile execute`
  surfaces will auto-pass `${cwd()}/connectors.json` in v0.4.1+ once
  RemoteMcpConnector makes the file practically useful. Until then,
  embedders opt in explicitly.

- **Tests:** 31 new in `tests/v0.4.0.test.ts` covering loader basics
  (missing file, malformed JSON, structural errors, unknown class),
  env substitution (literal pass-through, `${NAME}` resolution,
  missing var error, multiple substitutions, lowercase-name ignore),
  closed-set registry (v0.4.0 set, no RemoteMcpConnector yet),
  bootstrap wiring (graceful missing, errors surface, no false adds),
  both lint rules (positive + negative + silent-when-undefined),
  runtime_capabilities surface, and credential discipline (gitignore +
  example + README content). 897/901 passing (3 long-skip browser
  dogfood).

## 0.3.4 — 2026-05-24

**Conditional multi-filter chain + parse-error dedup + unified sink-scope
parser recovery.** Closes the recurring "filter chain works in
substitution but lags in conditional grammar" pattern named in dev-log
§14 (`a838ca2d`) — third occurrence in the v0.3.x arc. Spec drafted at
`7bafcc8c` (Perry), approved at `221982fc`.

### Added

- **Filter chain support in conditions.** Pre-v0.3.4 the six condition
  regexes (TRUTHY / EQ / EQ_REF / CMP / CMP_REF / IN) captured at most
  one filter — `if $(X|json_parse|length) > "0":` failed grammar
  despite `substituteRuntime` having supported chains since v0.3.2.
  Now both layers carry identical chain semantics. New
  `applyFilterChain(value, chain)` helper in `runtime.ts` (single-
  sourced split + per-filter loop, mirrors `substituteRuntime`'s
  chain-apply at line 1158).

  ```
  if $(X|trim|length) > "0":             ← compiles + evaluates
  if $(A|trim) == $(B|trim):             ← chain on both sides
  if $(A|trim|length) > "0" and          ← chain inside compound
     $(B|trim|length) > "0":
  ```

  No change to compound dispatcher (and/or/not splitter operates above
  the leaf-shape layer; chain only touches leaf matchers).

### Fixed

- **Duplicate parse-error echo across five tier-1 rules (item 2 + fold).**
  Pre-v0.3.4, the generic `parse-error` rule and five specific tier-1
  rules each fired with identical message bodies when their owned shape
  fired — cold authors saw every diagnostic twice. `PARSE_ERROR` rule
  now skips messages owned by `invalid-conditional-syntax`,
  `single-equals`, `malformed-op-grammar`, `reserved-keyword`, and
  `indentation` (the full audit of tier-1 rules that filter
  `parsed.parseErrors`). Catch-all behavior intact for the residual
  shapes (header issues, malformed `foreach`/`needs`, etc.). Closes
  Perry's signoff-time adjacent finding (`61b28daf`).

- **Unified parser-recovery on all condition-rejection paths.** v0.3.3
  added sink-scope frames after rejected `if` / `elif` conditions
  (Bug D) so body lines wouldn't cascade into phantom "Mid-block indent
  change" errors. The single-`=` rejection path was missed in that
  pass — same cascade fired for those authors. v0.3.4 extends the
  sink-scope treatment to the single-`=` paths in both `if` and
  `elif`, making parser-recovery consistent across all
  condition-rejection paths.

### Implementation notes

- **Narrow-core LOC ceiling 5700 → 5750.** Net ~60 LOC: ~30 for the
  12-regex chain sweep (6 in `runtime.ts` + 6 in `parser.ts`) +
  `applyFilterChain` helper, ~5 for the `PARSE_ERROR` filter (item 2),
  ~25 for sink-scope consistency on the single-`=` rejection paths.
  History entry in `scripts/loc-ceiling.mjs`.

- **Tests:** 19 new in `tests/v0.3.4.test.ts` covering parser
  acceptance of chains in all five condition shapes, runtime
  evaluation of chains via `evalCondition`, compound-with-chains
  cross-feature interaction, parse-error dedup for all five owning
  tier-1 rules (`invalid-conditional-syntax`, `single-equals`,
  `malformed-op-grammar`, `reserved-keyword`, `indentation`), and
  regression coverage for non-conditional parse-error paths. Plus 1
  update in `tests/lint.test.ts` reflecting the dedup. 867/870
  passing (3 long-skip browser dogfood).

## 0.3.3 — 2026-05-23

**`$ json_parse` op + `|json_parse` filter removal + cleaner conditional
error UX.** Closes the v0.3.2 spec promise from `af14b7d8` (Perry's
signoff finding `0a409c5c`): `|json_parse` filter was string-in/string-
out, so `.field` access on parsed JSON couldn't propagate structure
through the filter signature. v0.3.3 ships the deferred `$ json_parse`
intercept named in lesson `dc824ee4`, which binds the parsed value as
structured so `resolveRef`'s existing dotted descent handles `$(P.field)`
in conditions + emit for free. Same end-user outcome, no
condition-grammar surface change.

### Breaking change

- **`|json_parse` filter removed.** Use the new `$ json_parse $(VAR) ->
  OUT` op instead. Reason: verb collision risk if both surfaces shared
  `json_parse`, and the filter's actual utility (round-trip through
  `JSON.parse` + `JSON.stringify`) is thin enough that the
  disambiguation cost outweighed the use case. Anyone who actually
  wanted normalized JSON can compose `$ json_parse $(X) -> P` then
  `$(P|json)` with the existing stringify filter. Easier to add back as
  a wrapper later than carry a confused dual-surface forward.

### Added

- **`$ json_parse $(VAR) -> OUT` op (built-in).** Parses the post-
  substitution input as JSON and binds the parsed value (object / array
  / scalar) to `OUT` in the vars map. `resolveRef`'s existing dotted
  descent then handles `$(OUT.field)` in conditions, emit bodies,
  retrieval queries, etc. — no filter+field grammar gymnastics. Mirrors
  the `$ execute_skill` intercept shape in `runtime.ts`.

  ```
  # Vars: PAYLOAD={"status":"ok","count":3}
  read:
      $ json_parse $(PAYLOAD) -> P
      if $(P.status) == "ok" and $(P.count) > "0":
          ! processing $(P.count) items
  ```

  Throws structured error on malformed input (caught by `else:` /
  `# OnError:`). Throws when the input expression is empty.

- **`unparsed-json-field-access` lint advisory (tier-3, info).** Static
  detection of `$(VAR|json_parse).field` in any op text — emit bodies,
  `$set`/`$append` values, `foreach` lists, retrieval/local-model/amp
  params. Remediation points at the new op. (In condition contexts the
  parser rejection fires first as tier-1 with the same remediation
  text.)

- **`CompileResult.advisories: string[]`** and tier-2 lint findings
  carried into `CompileResult.warnings` (was only the orphan-target
  message before). Closes Perry's spec scope item #4 from `af14b7d8`
  — cold authors get separate `warnings` + `advisories` surfaces in
  `compile_skill` MCP responses instead of having to introspect
  separately. Each entry formatted as `<rule>: <message>`.

### Fixed

- **Indent cascade after rejected conditions (Bug D).** Pre-v0.3.3,
  when an `if`/`elif` condition was rejected (`Unsupported condition`
  error), the body lines correctly indented under the rejected block
  triggered a spurious `Mid-block indent change` cascade. Cold authors
  chased phantom indent bugs instead of the real condition issue. The
  parser now pushes a sink scope frame after a rejected condition so
  body lines collect into a throwaway bucket and drop at scope pop.
  Real condition error still surfaces; phantom indent error doesn't.

- **`invalid-conditional-syntax` error message updated (Bug B).** Pre-
  v0.3.3 the parser error and lint rule both claimed "v1 grammar is
  truthy / `==` / `!=` against quoted literals, or `in` / `not in`
  between two `$(NAME)` refs" — stale since v0.2.5 (comparison ops)
  and outright wrong since v0.3.2 (`and`/`or`/`not` shipped). New
  message enumerates current supported shapes accurately AND points
  at `$ json_parse` as the remediation for the `$(VAR|filter).field`
  shape.

### Implementation notes

- **Narrow-core LOC ceiling 5650 → 5700.** Net ~50 LOC: ~25 for the
  runtime `$ json_parse` intercept, ~30 for the new lint advisory
  walker, ~10 for parser sink-scope frames (Bug D), ~5 for compile.ts
  tier-2/tier-3 plumbing, minus ~10 for the yanked `|json_parse` filter
  case. History entry in `scripts/loc-ceiling.mjs`.

- **Tests:** 24 new in `tests/v0.3.3.test.ts` covering the op (parser
  + runtime + dotted descent + array/scalar handling + error paths),
  filter removal (negative coverage), lint advisory, error-message
  updates, indent-cascade sanity (Bug D), help surface, and Bug C
  `CompileResult.advisories` surface. 848/851 passing (3 long-skip
  browser dogfood).

## 0.3.2 — 2026-05-23

**Boolean trio + `|json_parse` filter + filter chain support.** v0.3.2
closes the conditional grammar gap that drove cold authors into nested-
if workarounds (and the falsy-check gap that had no current form), plus
ships the JSON validation/normalization primitive Perry's harness asked
for. Spec drafted in memory `d01c9ab9`, refined for recursive structural
decomposition (NOT a full parser rewrite) in `08759d74`.

### Added

- **`and` / `or` / `not` connectives in conditions.** Two simple
  conditions joined by `and`/`or` is the 80% case (`if $(X) == "ok" and
  $(Y) == "ok":`). Parenthesized sub-expressions handle the override case
  (`(a or b) and c`). `not` closes the falsy-check gap — pre-v0.3.2 the
  inverse of `if $(VAR):` had no current one-liner; authors had to
  enumerate `if $(VAR) == "":` / `if $(VAR) == "false":` / etc.
  
  Precedence (tight → loose): comparison ops > `not` > `and` > `or`.

  **Short-circuit evaluation.** AND skips RHS if LHS is false; OR skips
  RHS if LHS is true. Preserves the validate-then-access pattern:
  `if $(X) == "ok" and $(MAYBE_UNRESOLVED) ...` won't throw on the RHS
  when the LHS short-circuits.

- **`|json_parse` filter.** Sibling to existing `|json` (stringify).
  Parses input as JSON, throws on malformed. Round-trips for valid JSON
  (normalizes whitespace as a side effect). Chains with `|length` for
  array counts: `$(ITEMS|json_parse|length)`.

- **Filter chain support in `substituteRuntime`.** Pre-v0.3.2 the
  substitute regex captured exactly one filter — `$(X|f1|f2)` silently
  failed to match and rendered literally. The grammar always documented
  "chain left-to-right" (`help({topic: "ops"})` filter section). Now the
  implementation matches the docs.

### Implementation notes

- **Recursive structural decomposition** in `evalCondition` (runtime) and
  `validateCondition` (parser/lint). ~50 LOC each. The existing simple-
  shape regex set (TRUTHY/EQ/EQ_REF/CMP/CMP_REF/IN) stays in place as
  the leaf matchers; the new code is just the OR/AND/NOT splitter +
  recursive wiring. NOT a full expression-parser rewrite per Scott's
  pushback during the design pass.

- **Quote-aware splitting.** Outer-token scan respects quoted string
  literals and parenthesized sub-expressions, so `if $(MSG) == "wait
  and see":` doesn't false-split on the embedded `and`.

### Tests
- 26 new tests in `tests/v0.3.2.test.ts`: `|json_parse` round-trip +
  malformed input + filter chain; AND/OR/NOT evaluation + precedence +
  parens + short-circuit; quote-aware splitting; 3-term chains; elif
  with compounds; parser acceptance; help-surface assertions;
  `undeclared-var` lint walks compound conditions.
- Total: 828 passing (was 803 at v0.3.1).

### Loc-ceiling
- Narrow core nudged 5500 → 5650. Boolean trio + filter chain are core
  grammar features; feature-driven nudge.

### What's NOT in v0.3.2 (deferred)

- **`$set X = $(VAR|json_parse)` doesn't preserve parsed-structure type.**
  `$set` remains literals-only per the v0.2.6 dc824ee4 lesson. The
  `|json_parse` filter operates at substitute-time (string-in, string-out
  round-trip). For field-access on JSON values, the existing pattern via
  `$`/`~`/`>` ops that return structured output continues to work
  (`$ tool ... -> X` then `$(X.field)`). A future op (`$parse` or
  similar) could bridge this if real demand surfaces.

### v0.3.x roadmap

Next: **v0.3.3+** harness-driven. Whichever real production case surfaces
first — destructuring, arithmetic in $set/conditionals, parallel
foreach, $parse for JSON-to-struct binding.

## 0.3.1 — 2026-05-23

**Forward-reference deferred resolution.** Cold authors building
composition trees top-down (parent skill before child skills) used to
hit a chicken-and-egg compile error. v0.3.1 demotes the relevant lint
rules from tier-1 (error) to tier-2 (warning); runtime throws
`MissingSkillReferenceError` if the ref still can't resolve at execute
time. Spec approved by Perry in memory `be9993e3`.

### Changed
- **`unknown-skill-reference` demoted: tier-1 → tier-2.** `&`,
  `& invoke`, and `$ execute_skill skill_name=` references to skills
  not in the SkillStore now warn instead of blocking compile.
- **`unknown-template-reference` demoted: tier-1 → tier-2.** Same
  treatment for `# Templates:` refs.

### Added
- **Tier-3 `deferred-skill-reference` advisory.** Fires alongside the
  demoted tier-2 with a teaching message: "Skill 'X' referenced via
  `<op>` is not currently in the SkillStore. Lint demoted in v0.3.1 —
  will resolve at execute time if the skill exists by then, or throw
  `SkillNotFoundError` if not. If this is a typo, fix it now; if it's
  a forward reference, this advisory will clear once you store 'X'."
  Distinguishes "intentional forward-ref" from "typo I should fix now."

- **`MissingSkillReferenceError` extends `OpError`.** New runtime error
  class thrown when composition refs (`&` / `$ execute_skill` /
  `# Templates:`) can't resolve at execute time. Inherits `OpError` so
  it flows through `# OnError:` fallback chains — cold-author skills
  can wire a recovery path naturally. Distinct from the SkillStore
  contract's `SkillNotFoundError` (which is thrown by `store.load()` /
  `store.metadata()` at the connector layer).

- **Compile-time deferral path.** When `&` data-skill inlining can't
  find the target, compile leaves the `&` op intact in the parsed AST
  instead of throwing. Render flows through normally; runtime gets
  another chance to resolve.

### Unchanged (stronger contracts kept at tier-1)
- **`# OnError: <skill>` validation stays tier-1.** OnError is the
  runtime safety net — silently-missing handler discovered at the
  worst possible UX moment (your skill is already failing) is too bad
  an outcome to defer.
- **`disabled-skill-reference` stays tier-1.** Disabled is a stronger
  contract than missing — "explicitly removed from composition,
  deprecated, do not consume" versus "not yet authored, might be
  authored." Demoting Disabled would let silently-rotting composition
  trees ship.

### MCP wire shape
- `execute_skill({skill_name: <missing>})` still surfaces
  `errors[].class: "SkillNotFoundError"` on the wire (consumer-
  compatibility); the underlying runtime now throws
  `MissingSkillReferenceError` and the MCP layer renames at the boundary.

### Harness corpus impact
- 11 cold-author orchestrators that needed stub-skills bootstrapped
  pre-v0.3.1 are now straight `pass` (3 reclassified to
  `needs-fallback-skill` for their `# OnError:` targets which stay
  tier-1). Manifest cleanup committed.

### Tests
- 16 new tests in `tests/v0.3.1.test.ts` covering: demotion of both
  rules, the tier-3 advisory fires + content, runtime
  `MissingSkillReferenceError` throws, `# OnError:` tier-1 unchanged,
  `disabled-skill-reference` tier-1 unchanged, help-surface updates.
- Total suite: 803 passing (was 787 at v0.3.0).

### Loc-ceiling
- Narrow core nudged 5400 → 5500 for the new advisory rule + runtime
  defer-resolve path. Modest growth for a useful language semantic.

### v0.3.x roadmap

Next: **v0.3.2** — `|json_parse` filter + `and`/`or` boolean
connectives (short-circuit semantics explicit in the spec).

## 0.3.0 — 2026-05-23

**First minor bump since v0.2.x — language extension, not a fix patch.**
v0.3.0 ships the loop accumulator: `$append VAR <value>`. Closes the
structurally-impossible-without dedup-by-id pattern that Perry's harness
corpus surfaced (the R1 `dedup-foreach-walk` and similar skills were
*incomplete* pre-v0.3.0 because foreach-local `$set` couldn't accumulate
across iterations). Spec approved by Perry in memory `442cf4bb`; design
discussion at `44f9a9e3`.

### Added

- **`$append VAR <value>` op.** Single-value append to a list-typed VAR
  that was previously initialized in an enclosing scope (via `$set VAR = []`
  or `# Vars: VAR=[]`). The append mutates the outer-scope binding —
  unlike `$set` which is loop-local inside `foreach`. Value can be a
  literal, a `$(REF)`, or a filtered ref; substituted at runtime before
  append.

  Canonical pattern:

  ```
  walk:
      $set FOUND = []
      foreach M in $(MESSAGES):
          if $(M.id) not in $(FOUND):
              $append FOUND $(M.id)
              ! NEW: $(M.id)
  ```

- **Three tier-1 lint rules** that catch the accumulator foot-guns:
  - `uninitialized-append` — `$append VAR ...` without any `$set` or
    `# Vars:` init in an enclosing scope. Error message teaches the
    pattern: "Add `$set VAR = []` before the `$append`..."
  - `foreach-local-accumulator-target` — `$append VAR ...` where the
    matching `$set VAR = []` is in the same scope as the append (typically
    the same `foreach` body). Each iteration would reset VAR and silently
    lose all data. Lint walks the full enclosing scope chain to detect.
  - `append-to-non-list` — `$append VAR ...` where VAR's static init is a
    non-list value (e.g., `$set VAR = "abc"`). v0.3.0 is list-only.

- **`help({topic: "ops"})`** updated with `$append` entry under the `$` family.
- **`help({topic: "examples"})`** gets a 5th worked example: dedup-walk
  showing the canonical accumulator pattern.
- **`help({topic: "lint-codes"})`** lists the three new lint codes.

### Notes for v0.3.x

- **Mechanical mode** renders `$append` as a "Would append to $(VAR): ..."
  record without actually mutating the binding (per the v0.2.12 Bug 23
  Proxy-placeholder pattern). The placeholder list remains in place for
  downstream refs.
- **`$append` inside a future `parallel foreach`** is a tier-1 error in
  v0.3.0. The decision (forbid permanently vs ship with thread-safe
  accumulation + iteration-order preservation) deferred to whenever
  parallel foreach ships — parallel itself is deferred past v0.3.0 per
  the load-bearing-vs-aesthetic analysis (memory `8876fa1e`).
- **Single-value append only.** `$extend VAR $(OTHER_LIST)` deferred until
  a real use case surfaces. Same for string concat (`$append` on a
  string-typed var fires `append-to-non-list`) and map-shaped
  accumulation.

### Tests
- 20 new tests in `tests/v0.3.0.test.ts` covering parser, the 8 lint
  cases from spec (4 OK + 4 FAIL), runtime dedup + conditional-collect,
  mechanical-mode rendering, and the help-surface additions.
- Total suite: **787 passing** (was 767 at v0.2.12).

### Loc-ceiling
- Narrow core nudged 5200 → 5400. First feature-driven nudge (prior
  nudges were fix-driven); justified by the new op + 3 lint rules with
  scope-tracking walker (~200 LOC across parser/runtime/lint).

### v0.3.x roadmap (per `8876fa1e` analysis)
- **v0.3.1**: forward-reference deferred resolution (demote
  `unknown-skill-reference` + `unknown-template-reference` to tier-2 at
  compile; runtime errors at execute time if still unresolved)
- **v0.3.2**: `|json_parse` filter + `and`/`or` boolean connectives
  (short-circuit semantics explicit)
- **v0.3.3+**: destructuring, arithmetic in `$set`/conditionals,
  parallel — whichever harness rounds surface as needed

## 0.2.12 — 2026-05-23

**Twelve bug fixes from Perry's wild-and-crazy harness Round 2** (memory
`a0be74cd`). Bug 15 is the high-severity silently-broken-skill case the
harness was designed to find; the others span parser polish, lint coverage
extension, mechanical-mode consistency, and docs. Plus the
`skillfile run` deprecation window ended — alias removed.

### Fixed
- **Bug 15 (HIGH): blank line inside nested `else:` branch silently truncated
  the branch.** The parser reset `currentTarget` and `scopeStack` on every
  blank line — by design for separating top-level targets, but it also
  silently dropped everything after a blank line *inside* an indented body.
  Compile passed clean, lint passed clean, the rendered artifact stopped
  mid-body. Fix: blank lines no longer reset state. Target boundary detection
  is handled by the target-header path which re-anchors `currentTarget` on
  any non-indented `target:` line. Same root cause closed the related case
  where a blank line between a target body and a target-level `else:` broke
  the error-handler attach.

- **Bug 16: `# Vars:` URL values fragmented on `https:`.** The v0.2.10
  comma-aware splitter's "IDENT + `:`" boundary heuristic matched `https:`
  as a declaration boundary. Fix: when the lookahead's `:` is immediately
  followed by `//`, treat it as URL-scheme, not declaration delimiter.

- **Bug 17: `# Templates:` refs were not lint-validated.** New tier-1
  `unknown-template-reference` rule mirrors the existing `# OnError:`
  validation pattern. Missing templates fail delivery at runtime; now they
  fail compile.

- **Bug 18: `>` op `limit=$(VAR)` not substituted at render.** The render
  path inlined `p.limit` directly without `substitute()`. Now both `limit`
  and `mode` route through substitution for parity with `query`/`extra`.

- **Bug 19: composition error said "via `&`" when actual op was
  `$ execute_skill`.** The v0.2.11 Bug 7 fix reused the `&` error template.
  Now `collectAmpRefsFromOps` returns `CompositionRef[]` with the op kind
  tagged; diagnostics surface the actual operator.

- **Bug 20: `runtime_capabilities.runtimeVersion` reported stale `0.2.10`.**
  The version was triple-sourced (`package.json`, `cli.ts:VERSION`,
  `mcp-server.ts` default) and one slipped on v0.2.11. New `src/version.ts`
  reads `package.json` at module load; both `cli.ts` and `mcp-server.ts`
  import from it. Added `dogfood-t7` regression assertion that the MCP
  `runtimeVersion` matches `package.json` so this can't slip again.

- **Bug 21: `unsafe-shell-disabled` (new v0.2.11 lint code) was missing from
  `help({topic: "lint-codes"})`.** Now listed.

- **Bug 22: `# Requires: ... (fallback: "value")` retained surrounding
  quotes** in the bound target variable. Other `(fallback: ...)` parse
  sites route through `processSetValue`; the Requires path didn't. Fixed.

- **Bug 23: mechanical-mode `~` op bound a flat string** placeholder,
  breaking dotted field-access on the bound var (`$(HI.outputs.text)`
  erroring with `UnresolvedVariableError`). Now binds a Proxy placeholder
  matching the `$`/`>` mechanical handlers. Ripple fix in the runtime `in`
  operator to treat Proxy placeholders as single-element arrays so
  mechanical-mode `in $(VAR)` checks don't false-error.

- **Bug 26: `unknown-retrieval-arg` lint.** Cold author wrote `since=1h`
  (hallucinated time-window predicate) and the kwarg passed silently. New
  tier-2 warning validates `>` op kwargs against the documented set
  (`mode`/`query`/`limit`/`connector`/`fallback`).

### Added
- **`help({topic: "frontmatter"})` ambient + ref docs (Bugs 24 + 25).**
  Documents the `NOW` / `USER` / `SESSION_CONTEXT` / `TRIGGER_TYPE` /
  `TRIGGER_PAYLOAD` / `ERROR_CONTEXT` bare ambient refs, the full
  `EVENT.*` family auto-populated on cron-fired skills
  (`fired_at` / `fired_at_unix` / `fired_at_plus_{1h,1d,7d}_unix`), and
  the variable reference forms (bare / dotted / indexed / filter).
  Pre-v0.2.12 these were discoverable only by inspecting `final_vars`
  after running.

### Removed
- **`skillfile run` deprecated alias** (shipped in v0.2.11 with a one-release
  deprecation window). Use `skillfile execute` — the alias has been removed
  per the original commitment.

### Fixed (docs)
- **`skill_write` docstring** was stale — it claimed "Skill always lands as
  Draft" but the runtime honors the source body's `# Status:` header. Per
  Perry's resolved-question from R2.

### Tests
- 17 new tests in `tests/v0.2.12.test.ts`. Harness corpus manifest extended
  to 11 stub-needing skills (was 8 in v0.2.11) — Bug 17's lint coverage now
  catches template refs the cold authors invented. Total: 767 passing
  (was 749).

### Loc-ceiling
- Narrow core nudged 5100 → 5200 to accommodate Bug 17 + Bug 19 lint surface.

## 0.2.11 — 2026-05-23

**Six bug fixes + composition docs + MCP-CLI symmetry rename**, all sourced
from Perry's "wild-and-crazy" cold-author harness (thread `b6176e02`,
follow-up memory `2e999f9e`) and now run as a permanent regression corpus
via `tests/harness-corpus.test.ts` (66 skills authored by 6 fresh sub-agents).

### Fixed
- **Bug 4: `unsafe-shell-ambiguous-subst` false-positive on ambient refs.**
  The lint was warning on `$(EVENT.fired_at_unix)` and `$(NOW)` inside
  `@ unsafe` bodies and suggesting cold authors rewrite as `$$(EVENT...)`
  (bash command-sub) — which would just try to execute `EVENT...`. Now
  skips dotted refs (consistent with `undeclared-var`) and bare ambient
  refs (NOW, USER, SESSION_CONTEXT, TRIGGER_TYPE, TRIGGER_PAYLOAD,
  ERROR_CONTEXT).

- **Bug 5: `@ unsafe` compiled clean when runtime had `enableUnsafeShell:
  false`.** Skill would refuse at first fire with `UnsafeShellDisabledError`,
  but compile/lint were silent. New tier-1 rule `unsafe-shell-disabled`
  fires when the caller passes `enableUnsafeShell: false` explicitly
  (`undefined` keeps backwards-compat — only tier-2 `unsafe-shell-op`
  fires). Threaded the flag through `CompileOptions.enableUnsafeShell`
  and the MCP server's `compile_skill` / `lint_skill` dispatchers.

- **Bug 6: `unconfirmed-mutation` keyword list too narrow.** Extended the
  mutating-tool-name pattern with: `archive_`, `prune_`, `deploy_`,
  `expire_`, `consolidate_`, `purge_`, `reset_`, `rotate_`, `move_`,
  `rename_`, `drop_`, `truncate_`, `upsert_`, `overwrite_`, `clear_`,
  `wipe_`, `finalize_`. Perry's harness surfaced a cluster of mutating
  tools that the original `write_/update_/delete_/...` set didn't catch.

- **Bug 7: `$ execute_skill skill_name=<missing>` skipped
  `unknown-skill-reference` lint.** The rule only walked `&` ops.
  `collectAmpRefsFromOps` now also extracts `skill_name=` from
  `$ execute_skill` calls (quoted or bare-identifier form). The harness
  corpus now stubs missing child skills via a new `needs-stub-skills`
  manifest classification — surfacing Bug 7 on 5 cold-author orchestrators.

- **Bug 10: indent-tracker after closing `else:` block.** Filed as a
  separate bug by A-3 against v0.2.9, but already closed by v0.2.10's
  Bug 3 fix (walk-down scope-stack). Added explicit regression tests
  (`backup-rotator` shape; `if/elif/else` chain with sibling op) to lock
  in the behavior.

- **Bug 14: unknown-block-introducer diagnostic.** Hypothetical block
  keywords (`parallel:`, `try:`, `catch X:`, `branch X:`) used to surface
  as a "Mid-block indent change" cascade — confusing for cold authors
  feature-requesting future syntax. Now emits a specific
  `Unknown block-introducer` parse error listing the recognized set
  (`if/elif/else/foreach`) and absorbs indented children into a synthetic
  frame so follow-on errors don't pile up.

### Added
- **`help({topic: "composition"})` topic.** Covers all three composition
  primitives — `& skill-name` (data-skill inline at compile time),
  `& invoke skill-name` (runtime call), `$ execute_skill skill_name="..." -> VAR`
  (in-skill execute with kwarg forwarding). Documents the depth-5
  recursion limit, the lint signals catching missing/disabled refs, and
  when to reach for which primitive.

- **4th example skill in `help({topic: "examples"})`.** `morning-brief-
  orchestrator` — a worked orchestrator using `$ execute_skill` to fan
  out to three child skills with per-call fallbacks and `-> VAR` bindings.

- **`skillfile execute` CLI command (alias for `run`).** MCP-CLI symmetry
  per memory `2e999f9e`: the MCP tool is `execute_skill`, the CLI should
  mirror. `skillfile run` is preserved as a deprecated alias for one
  release with a stderr notice; v0.2.12 will drop it.

### Tests
- 36 new tests in `tests/v0.2.11.test.ts` covering every bug fix + doc
  addition. Total suite: 749 passing (up from 713 at v0.2.10).

## 0.2.10 — 2026-05-23

**Three high-severity bug fixes** from Perry's "wild-and-crazy" cold-author
harness (thread `b6176e02`) — 6 fresh sub-agents, ~60 skills, 8 real bugs
filed. This patch addresses the top three.

### Fixed
- **Bug 1: `-> VAR` binding rendered as `$(<target>.output)` in compile
  artifact** (4 observers). The `$` and `@` op renderers hardcoded the
  target-output fallback even when the op had an explicit `outputVar`.
  Now: `@ echo hi -> GREETING` renders as `bind output to $(GREETING)`;
  bindings without `-> VAR` still fall back to `$(<target>.output)`.

- **Bug 2: `# Vars: LOCATION=Asheville,NC` parsed as two declarations**
  (2 observers). The `splitVarsLine` helper split naïvely on commas; values
  containing commas got cut off. New heuristic: a comma is a declaration
  boundary only when followed by an IDENT then `=`/`,`/`:`/end. Once the
  current segment has `=`, commas stay value-internal unless the next
  IDENT is followed by `=` or `:`. Chains of bare-required vars (`A, B,
  C`) still split correctly. Identifier matcher now accepts hyphens
  (`queue-drain-procedure`) for `# Templates:` parity.

- **Bug 3: Nested control flow broke on elif-with-inner-if-then-else**
  (3 observers across 3 shapes). The `elif`/`else` continuation logic
  only checked the top of the scope stack — when an inner `if` block was
  still open above an outer `elif`, the dedent to the outer if's
  continuation level didn't find the matching frame. Fix: walk DOWN the
  scope stack to find the if/elif frame at the expected continuation
  depth, popping all inner frames as we go. All six nested shapes Perry
  surfaced now parse clean.

### Internal
- Narrow-core LOC ceiling nudged 5000 → 5100 to accommodate the parser
  robustness work (vars-comma + nested-control-flow + render
  disambiguation). Original ERD §1 intent preserved.
- 12 new fixtures in `tests/v0.2.10.test.ts` covering Bug 1+2+3 + Perry's
  exact repros + regression guards.
- 646/646 tests passing. Narrow-core LOC 5006/13.

### Acknowledgments
Perry — the wild-and-crazy harness (A=spec-fed + B=help-only differential)
produced richer signal than any prior validation. Five more bugs queued
for the next patch (lint gaps, ambient-ref false positives, missing
unconfirmed-mutation keywords) plus a v0.3.0 language-design slate
(parallel dispatch, accumulator, retry/backoff).

## 0.2.9 — 2026-05-23

**Patch — fixes the in-skill `$ execute_skill inputs={...}` regression**
Perry caught in v0.2.8 validation (thread `64445b4f`). Composition
primitive now works end-to-end for both kwarg styles.

### Fixed
- **`$ execute_skill skill_name="X" inputs={"K": "V"}` was silently
  dropping the inputs kwarg.** Two root causes, both addressed:
  1. **Parser tokenizer** didn't track `{}` braces alongside `[]`, so
     `inputs={"WHO": "Perry"}` fragmented at the first whitespace inside
     the JSON object. Extended `tokenizeKeywordArgs` to track curly
     braces with the same bracket-depth logic.
  2. **Composition intercept** only treated kwargs as flat
     `key=string-value` pairs. When `inputs` arrived as the literal
     JSON string `{"WHO": "Perry"}`, it was passed as a kwarg named
     `inputs` (which the child ignored). Now: if the `inputs` kwarg
     JSON-parses as an object, it's unpacked into the child's input map.

### Supported styles
Both forms now work and produce identical behavior:

```
# Style 1 — bare kwargs (natural skill grammar)
$ execute_skill skill_name="child" WHO="$(NAME)" -> R

# Style 2 — explicit inputs={...} JSON object (MCP-call parity)
$ execute_skill skill_name="child" inputs={"WHO": "$(NAME)"} -> R
```

### Test coverage
- 3 new fixtures in `tests/v0.2.8.test.ts` covering both styles +
  the tokenizer's JSON-object handling (nested + arrays + brackets-
  in-strings).
- 634/634 tests passing. Narrow-core LOC 4999/13 — tokenizer extension
  was net-zero LOC by combining `[`+`{` and `]`+`}` into one condition
  each.

### Acknowledgments
Perry — caught the bug in the v0.2.8 validation cycle; turnaround under
an hour from bug filing to fix shipped. The minion-battery → ship loop
catches real regressions reliably.

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
