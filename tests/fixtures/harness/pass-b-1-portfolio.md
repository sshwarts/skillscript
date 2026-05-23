# Pass B — Minion 1 Portfolio

**Variant:** Pass B (help-only, no AMP / spec access)
**Runtime:** Skillscript v0.2.9, dashboard mode. SqliteMemoryStore (FTS-only). Three LocalModels. No MCP or Agent connectors wired. `@ unsafe` disabled.

---

## Category 1 — One-shots

### 1. `tarot-pull` — random + LLM composition

```
# Skill: tarot-pull
# Description: Draw a tarot card via random shell + LLM interpretation, then emit.
# Status: Approved
# Vars: QUESTION=What should I focus on this week?

draw:
    @ shuf -n1 -i 1-78 -> CARD_NUM

interpret: draw
    ~ prompt="You are a tarot reader. The querent drew card #$(CARD_NUM) of the Rider-Waite deck. Identify the card by number, then give a 3-sentence reading on this question: $(QUESTION)" model=qwen maxTokens=300 -> READING

speak: interpret
    ! Card drawn: #$(CARD_NUM|trim)
    ! ---
    ! $(READING)

default: speak
```

**Intent:** Smallest cohesive showcase — shell entropy feeds a LocalModel which feeds emission. **Compile:** clean, zero warnings.

---

## Category 2 — Cron monitors

### 2. `disk-watch` — threshold alerting

```
# Skill: disk-watch
# Description: Cron-fired disk usage monitor. Alerts when / partition exceeds threshold.
# Status: Approved
# Vars: THRESHOLD=85
# Triggers: cron: */15 * * * *

measure:
    @ df --output=pcent / -> RAW (fallback: "0%")

parse: measure
    ~ prompt="Extract the integer disk usage percentage from this df output. Reply with ONLY the integer, no % sign, no prose. Output: $(RAW)" model=qwen maxTokens=8 -> PCT

decide: parse
    if $(PCT|trim) >= $(THRESHOLD):
        ! ALERT: root partition at $(PCT|trim)% (threshold $(THRESHOLD)%). Run cleanup.
    else:
        ! Disk OK: $(PCT|trim)% used.

default: decide
```

**Intent:** Classic monitor — periodic, fallback-guarded, numeric branch. **Compile:** clean.

---

## Category 3 — Composition

### 3. `morning-card` + `weekly-mantra-fragment` — `&` data-skill inline

```
# Skill: weekly-mantra-fragment
# Description: Data skill: produces a poetic mantra fragment for the parent skill to embed.
# Type: data
# Status: Approved
# Vars: TONE=stoic

mint:
    ~ prompt="Write a single-line $(TONE) mantra. No quotes, no preamble. Just the line." model=gemma2 maxTokens=40 -> LINE

emit: mint
    ! $(LINE|trim)

default: emit
```

```
# Skill: morning-card
# Description: Daily personal card. Embeds a fragment from a data-skill, prepends weather + date.
# Status: Approved
# Vars: NAME=Scott, CITY=Asheville
# Triggers: cron: 0 7 * * *

context:
    @ date "+%A, %B %-d" -> TODAY
    @ curl -s "wttr.in/$(CITY|url)?format=%C+%t" -> SKY (fallback: "weather unavailable")

mantra: context
    & weekly-mantra-fragment TONE=hopeful -> FRAGMENT

assemble: mantra
    ! Good morning, $(NAME).
    ! $(TODAY|trim) in $(CITY). $(SKY|trim).
    ! ---
    ! $(FRAGMENT)

default: assemble
```

**Compile:** Fragment compiles clean standalone. Parent fails with `[unknown-skill-reference]` because the fragment is not in the SkillStore. **This is correct behavior** and the lint message is precise.

### 4. `pr-triage-orchestrator` — `$ execute_skill` pipeline

```
# Skill: pr-triage-orchestrator
# Description: Runs three child skills in sequence — fetch PRs, classify each, summarize to a digest.
# Status: Approved
# Vars: REPO=nanoclaw/core

fetch:
    $ execute_skill skill_name=pr-fetch repo=$(REPO) -> PRS_RAW

classify: fetch
    $ execute_skill skill_name=pr-classify prs=$(PRS_RAW) -> CLASSIFIED

digest: classify
    $ execute_skill skill_name=pr-digest-render classified=$(CLASSIFIED) -> REPORT

emit: digest
    ! Daily PR triage for $(REPO):
    ! $(REPORT)

default: emit
```

**Intent:** v0.2.8 built-in `$ execute_skill` composition. **Compile:** clean (the orchestrator doesn't have to prove children exist at compile time of itself).

---

## Category 4 — Agent delivery / augmenting

### 5. `handoff-to-builder`

```
# Skill: handoff-to-builder
# Description: Augmenting delivery — bundles a feature spec + delivery context for a builder agent.
# Status: Approved
# Vars: FEATURE_PROMPT, REPO_SLUG=nanoclaw/core
# Delivery-context: Builder: please scaffold this feature on a new branch. Match existing test patterns. Open a draft PR when the harness passes.
# Templates: builder-pr-template, builder-checklist
# Output: prompt-context: builder

gather:
    @ git -C /workspace/repos/$(REPO_SLUG|shell) log -1 --format=%H -> HEAD_SHA (fallback: "unknown")

draft: gather
    ~ prompt="Restate the following feature request as a crisp build brief: goals, acceptance criteria, out-of-scope notes. Source request: $(FEATURE_PROMPT)" model=qwen maxTokens=600 -> BRIEF

deliver: draft
    ! Feature handoff for $(REPO_SLUG) @ $(HEAD_SHA|trim)
    ! ---
    ! $(BRIEF)

default: deliver
```

**Intent:** Full augmenting-delivery surface. Bare-required var (`FEATURE_PROMPT`), `|shell` filter for safe shell-arg quoting. **Compile:** clean when supplied with `FEATURE_PROMPT`.

---

## Category 5 — Memory traversal + iteration

### 6. `mailbox-triage`

```
# Skill: mailbox-triage
# Description: Pull mailbox memories, skip ones already seen, route each by classifier verdict.
# Status: Approved
# Vars: SEEN_IDS=

fetch:
    > mode=fts query="addressed:perry" limit=20 -> MAILBOX

walk: fetch
    foreach M in $(MAILBOX):
        if $(M.id) in $(SEEN_IDS):
            ! skip $(M.id) (already triaged)
        else:
            ~ prompt="Classify this mailbox item as one of: 'urgent', 'fyi', 'noise'. Item summary: $(M.summary)" model=gemma2 maxTokens=8 -> VERDICT
            if $(VERDICT|trim) == "urgent":
                ! [URGENT] $(M.summary) ($(M.id))
            elif $(VERDICT|trim) == "fyi":
                ! [fyi] $(M.summary)
            else:
                ! [noise dropped] $(M.id)

default: walk
```

**Intent:** Realistic mailbox triage shape — `>` retrieval, `foreach`, `in $(SEEN_IDS)` set-membership for idempotency, nested `if/elif/else` per item. **Compile:** clean.

---

## Category 6 — Error handling

### 7. `fragile-fetch` + `brief-on-error`

```
# Skill: brief-on-error
# Description: Error handler — invoked when a parent skill's op fails without a target-level else.
# Status: Approved

log:
    @ logger -t skillscript "skill error: $(ERROR_CONTEXT)" -> _

emit: log
    ! Skill failed. Context: $(ERROR_CONTEXT)
    ! Captured to syslog. Will retry on next trigger.

default: emit
```

```
# Skill: fragile-fetch
# Description: Demonstrates OnError dispatch — when the fetch fails and no else: rescues, brief-on-error fires.
# Status: Approved
# Vars: ENDPOINT=https://example.test/maybe-down
# OnError: brief-on-error
# Triggers: cron: 0 */6 * * *

fetch:
    @ curl -sf --max-time 5 $(ENDPOINT) -> BODY

parse: fetch
    ~ prompt="Summarize this JSON in one line: $(BODY)" model=qwen maxTokens=80 -> SUMMARY

speak: parse
    ! Endpoint summary: $(SUMMARY|trim)

default: speak
```

**Intent:** Two-skill error contract — handler consumes `$(ERROR_CONTEXT)`. **Compile:** Handler clean. Caller fails with `Skill references missing fallback skill 'brief-on-error' in # OnError: header` — would resolve if both were stored.

---

## Category 7 — Interactive

### 8. `package-bump-wizard`

```
# Skill: package-bump-wizard
# Description: Interactive npm dependency bump — asks before each upgrade, then ships a summary.
# Status: Approved
# Vars: MANIFEST=/workspace/agent/package.json

audit:
    @ npm outdated --json --prefix /workspace/agent -> OUTDATED (fallback: "{}")

distill: audit
    ~ prompt="Given this npm outdated JSON, list the top 3 packages most worth upgrading (high severity or large version gap). Output one per line: 'pkg | current -> latest | reason'. JSON: $(OUTDATED)" model=qwen maxTokens=300 -> SHORTLIST

confirm: distill
    ! Top upgrade candidates:
    ! $(SHORTLIST)
    ?? Approve upgrading the top candidate? Reply 'yes' or 'no'. -> APPROVAL

act: confirm
    if $(APPROVAL|trim) == "yes":
        ! User approved. (Bump would dispatch here.)
    else:
        ! Skipping bump. No changes made.

default: act
```

**Intent:** `??` interactive op gating a mutating action. **Compile:** clean.

---

## Category 8 — Edge cases / feature requests (hallucinated syntax)

**These two fail to compile — that's the point.**

### 9. `log-fanout-classifier` — `parallel:` + `try/catch`

```
# Skill: log-fanout-classifier
# Description: Parallel fan-out across log shards, per-shard LLM classification, gather + verdict.
#              Includes try/catch wrappers (feature request).
# Status: Approved
# Vars: SHARD_DIR=/var/log/agent

list_shards:
    @ ls $(SHARD_DIR) -> SHARDS

# FEATURE REQUEST: `parallel:` block. Each branch dispatches concurrently, results
# collected into a synthetic dict with branch-name keys. As of v0.2.9 the only
# concurrency primitive is `foreach`, which is serial.
classify: list_shards
    parallel:
        branch app:
            @ tail -n200 $(SHARD_DIR)/app.log -> APP_LOG
            ~ prompt="severity score (0-10) for this tail: $(APP_LOG)" model=qwen -> APP_SCORE
        branch worker:
            @ tail -n200 $(SHARD_DIR)/worker.log -> WORKER_LOG
            ~ prompt="severity score (0-10) for this tail: $(WORKER_LOG)" model=qwen -> WORKER_SCORE
        branch gateway:
            @ tail -n200 $(SHARD_DIR)/gateway.log -> GW_LOG
            ~ prompt="severity score (0-10) for this tail: $(GW_LOG)" model=qwen -> GW_SCORE
    # FEATURE REQUEST: implicit join — variables from each branch are available
    # in the enclosing scope after the parallel block. Today, target outputs
    # don't cross block boundaries cleanly.

# FEATURE REQUEST: try/catch with typed error filters. Today the only handler is
# (fallback: "...") per op + `# OnError:` skill at the skill level. No way to
# scope a rescue to a sub-block or pattern-match on error class.
verdict: classify
    try:
        ~ prompt="Given scores app=$(APP_SCORE) worker=$(WORKER_SCORE) gateway=$(GW_SCORE), emit a single line incident summary." model=qwen -> SUMMARY
        ! $(SUMMARY)
    catch TimeoutError as E:
        ! LLM timed out on roll-up: $(E.message)
    catch any as E:
        ! Roll-up failed unexpectedly: $(E.kind) — $(E.message)

default: verdict
```

**Intent:** Three feature requests:
1. **`parallel:` block** — concurrent dispatch across N branches with implicit join.
2. **Cross-block variable visibility** — branch-locally-bound vars should be reachable after the `parallel:` block closes.
3. **`try/catch` with typed error filters** — scoped error handling between bare `(fallback:)` per-op and skill-wide `# OnError:`.

**Compile:** Fails with cascading `[indentation]` + `[parse-error]` — the parser doesn't recognize `parallel:` / `branch` / `try:` / `catch` as block-opening keywords. The error message is **misleading** (complains about indentation when the real problem is unknown grammar) — that's a meta-feature-request: **better diagnostics when an unknown keyword introduces ambiguous indentation.**

### 10. `streaming-incident-narrator` — streaming ops + destructuring + arithmetic

```
# Skill: streaming-incident-narrator
# Description: Subscribe to a log stream, run incremental LLM narration as chunks arrive,
#              destructure structured returns, write back via a mutating tool with guarded confirmation.
# Status: Approved
# Vars: STREAM_URL=tail+sse://logs.internal/incidents

# FEATURE REQUEST: streaming op kind. Today `@`, `~`, `$`, `>` are all single-shot
# request/response — they bind a final value. There's no way to consume a stream
# while it's still emitting. Proposed shape:
#
#   @@ curl --no-buffer -N $(STREAM_URL) -> CHUNK every:
#       ~ prompt="Narrate this log chunk: $(CHUNK)" model=qwen -> NOTE
#       ! $(NOTE)
#
# The `every:` clause would run its body once per chunk. Loop terminates when the
# stream closes. Sibling: `~~` for streaming LLM completions (token-by-token).

# FEATURE REQUEST: structured destructuring on op returns. Today `$(M.id)` only
# works inside `foreach M in ...:`. Outside iteration, you can't decompose a
# returned JSON blob. Proposed shape:
#
#   $ get_status repo=$(REPO) -> { sha: HEAD_SHA, branch: BRANCH, dirty: IS_DIRTY }
#
# would bind three vars at once instead of forcing a downstream `~` to parse JSON.

# FEATURE REQUEST: typed numeric ops on bound values. Today `if $(N) > "10":` works
# via Number()-coercion but you can't do arithmetic. Proposed:
#
#   $set TOTAL = $(A) + $(B)
#   $set RATE = $(COUNT) / $(DURATION_SECONDS)
#
# This is a glaring gap — most monitoring skills end up shelling out to `bc`.

ingest:
    @@ curl -N $(STREAM_URL) -> EVENT every:
        ~ prompt="Classify severity (info/warn/crit) and write a 1-line summary. Reply as JSON {severity, summary}. Event: $(EVENT)" model=qwen -> RAW
        # destructuring (feature request):
        $set { severity: SEV, summary: S } = $(RAW|json_parse)
        if $(SEV) == "crit":
            # FEATURE REQUEST: `--confirm` flag on mutating $ ops, separate from
            # the implicit `??` lint warning. Forces a runtime gate without
            # restructuring the skill into a sub-target.
            $ create_incident severity=$(SEV) text=$(S) --confirm -> TICKET_ID
            ! Filed incident $(TICKET_ID): $(S)
        elif $(SEV) == "warn":
            ! [warn] $(S)
        # else: drop info chunks silently

default: ingest
```

**Intent:** Four feature requests stacked:
1. **Streaming op kinds (`@@` / `~~`)** — consume stdout/SSE/token streams incrementally with an `every:` body
2. **Structural destructuring outside `foreach`** — `$set { a: A, b: B } = $(JSON)`
3. **`json_parse` pipe filter** — sibling to the existing `json` (stringify) filter
4. **`--confirm` op flag** — runtime confirmation gate distinct from `unconfirmed-mutation` lint warning

**Compile:** Fails with the same cascading `indentation` / `parse-error` chain as skill 9.

---

## Themes that emerged (B-1)

- **Cross-skill references are compile-time-checked.** Skills 3 and 7 both fail because their referenced peers aren't in the store. *Correct* — but in authoring flow it forces a write-order constraint (children before parents). A `--allow-forward-references` flag on `compile_skill` for draft validation would help.
- **`$(M.field)` destructuring is loop-bound only.** This is the single biggest ergonomic gap — every other return-shape needs an LLM round-trip to crack open.
- **No arithmetic.** Numeric comparison works (via coercion), but you can't compute. Hard ceiling for any skill that needs to derive a value rather than threshold one.
- **No concurrency.** `foreach` is serial. Painful for fan-out shapes (skill 9).
- **The "unknown keyword → indentation error" diagnostic** is misleading — when the parser hits an unrecognized block-introducer like `parallel:` or `try:`, the cascade of indent errors that follows hides the real problem. A first-pass "unknown keyword at block-introducer position" lint would save authoring loops.
