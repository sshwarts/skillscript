# Pass A — Minion 1 Portfolio

**Variant:** Pass A (full Language Reference loaded via AMP)
**Runtime:** v0.2.9 (dashboard mode). LocalModels: `default`, `gemma2`, `qwen`. MCP connectors: none wired. Built-in `$ execute_skill` works for composition.
**Categories:** One-shot · Cron monitors · Composition · Augmenting/Template · Edge cases

---

## A. One-shot tasks

### 1. `tide-glance`

Single-target chain — curl a NOAA endpoint, hand the JSON to qwen, emit two lines. The canonical "fetch → reason → emit" shape.

```
# Skill: tide-glance
# Description: One-shot tide + sunset glance for a coastal location. Run when planning beach time.
# Status: Approved
# Vars: STATION=8516945, UNITS=english
# Output: text

fetch_tide:
    @ curl -s "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=skillscript&datum=MLLW&station=$(STATION)&time_zone=lst_ldt&units=$(UNITS)&interval=hilo&format=json&date=today" -> RAW (fallback: "{}")

summarize: fetch_tide
    ~ prompt="Read this NOAA tide JSON and produce two short lines: (1) the next high tide time + height, (2) the next low tide time + height. Today only. JSON: $(RAW)" model=qwen maxTokens=200 -> SUMMARY

emit: summarize
    ! Tide window for station $(STATION):
    ! $(SUMMARY|trim)

default: emit
```

**Compile:** clean. Zero warnings, zero errors. Three-step DAG renders as expected.

---

### 2. `pre-deploy-gate`

Interactive guardrail — checks the working tree, asks for confirmation, fires (or refuses) a deploy. Demonstrates `??`, conditional inequality on whitespace-sensitive shell output, and a `$` mutation gated behind explicit consent.

```
# Skill: pre-deploy-gate
# Description: Interactive — before a vercel deploy, confirm with Scott and check git status. Refuses on dirty tree or "no".
# Status: Approved
# Vars: ENV=prod

snapshot:
    @ git status --porcelain -> DIFF (fallback: "??unknown")
    @ git rev-parse --short HEAD -> SHA (fallback: "??")

review: snapshot
    ! Deploy gate — env=$(ENV), HEAD=$(SHA|trim)
    if $(DIFF|trim) != "":
        ! Working tree dirty:
        ! $(DIFF)
        ! Aborting — clean the tree first.
    else:
        ?? "Confirm deploy of $(SHA|trim) to $(ENV)?" -> APPROVED
        if $(APPROVED|trim) == "yes":
            ! Proceeding with deploy of $(SHA|trim)
            $ vercel.deploy env=$(ENV) ref=$(SHA|trim) -> DEPLOY_ACK
            ! Deploy ack: $(DEPLOY_ACK)
        else:
            ! Declined — no deploy performed.

default: review
```

**Compile:** clean. Noteworthy gap: the lint rule `unconfirmed-mutation` exists for `$` tool calls whose names suggest mutation (write/update/delete) — `vercel.deploy` slipped under it because "deploy" isn't in the suspicious-keyword list. Probably worth extending.

**Caveat the linter missed:** `snapshot` has two `@` ops in one target where both bind to `$(snapshot.output)` per the docs (default binding), but the explicit `-> DIFF` and `-> SHA` rebind correctly. The compiled artifact says "bind output to $(snapshot.output)" twice in the same target — confusing renderer output, but the underlying bindings are right.

---

## B. Cron monitors (autonomous)

### 3. `thread-stewardship`

Sweeps open AMP threads, asks a local model whether each looks stalled, posts a nudge into any that do. Two real syntax gaps documented inline.

```
# Skill: thread-stewardship
# Description: cron daily — sweep open AMP threads, ask local model which look stalled, post nudges
# Status: Approved
# Vars: STALL_DAYS=4
# Triggers: cron: 0 9 * * 1-5
# Output: text

open_threads:
    > mode=fts query="thread_status:open" limit=25 -> THREADS

# FEATURE REQUEST: I want a `> ... where_age_gt_days=N` extra-kwarg or an `age` filter on retrieval.
# Today there's no way to filter retrieval by created_before / age before iterating.

scan: open_threads
    foreach T in $(THREADS):
        # FEATURE REQUEST: arithmetic on ambient timestamps. I want:
        #   if $(NOW) - $(T.created_at) > $(STALL_DAYS) * 86400:
        # Skillfile doesn't admit arithmetic. Cron offsets like $(EVENT.fired_at_plus_1d_unix) exist
        # but there's no `fired_at_minus_N`, and no general expression layer. Pushing the comparison
        # into the LLM works but it's silly — the LLM is doing integer arithmetic.
        ~ prompt="Thread '$(T.summary)' last touched at unix $(T.created_at). Now is $(NOW). Is this older than $(STALL_DAYS) days AND still awaiting action? Reply 'stale' or 'fresh' only." model=qwen maxTokens=10 -> VERDICT
        if $(VERDICT|trim) == "stale":
            ! Nudging thread $(T.id): $(T.summary)
            $ amp_write_memory summary="Stewardship nudge — $(T.summary)" detail="Auto-flagged as stale (>$(STALL_DAYS)d)" vault=private domain_tags=["thread-stewardship"] knowledge_type=common confidence=0.6 thread_parent_id=$(T.id) payload_type=thread thread_status=pending_response

default: scan
```

**Compile:** clean. Both feature requests left as comments inline.

---

### 4. `ham-band-watch`

Polls solar conditions every 15 minutes; alerts if SFI crosses a threshold. Demonstrates numeric comparison on LLM-extracted scalars, `expires_at` driven by ambient time-offset, and `recipients:` for broker push.

```
# Skill: ham-band-watch
# Description: cron 15-min — check propagation conditions for 20m and ping Scott if SFI > threshold (so he gets on the radio)
# Status: Approved
# Vars: SFI_THRESHOLD=150
# Triggers: cron: */15 * * * *
# Output: text

fetch:
    @ curl -s "https://www.hamqsl.com/solarxml.php" -> XML (fallback: "")

extract: fetch
    ~ prompt="From this hamqsl solar XML, extract ONLY the integer value of the <solarflux> tag. No prose, no units. XML: $(XML)" model=qwen maxTokens=20 -> SFI

evaluate: extract
    if $(SFI|trim) > $(SFI_THRESHOLD):
        ! Solar flux $(SFI|trim) > $(SFI_THRESHOLD) — 20m should be hot. Time to get on the air, Scott.
        $ amp_write_memory summary="20m propagation alert" detail="SFI=$(SFI|trim) at $(NOW)" vault=private knowledge_type=common confidence=0.7 domain_tags=["ham-radio","propagation"] expires_at=$(EVENT.fired_at_plus_1d_unix) recipients=["scott"]
    else:
        ! SFI $(SFI|trim) under threshold ($(SFI_THRESHOLD)). No alert.

default: evaluate
```

**Compile:** clean. Real-world caveat — running this every 15 minutes is the kind of cadence the scheduling module warns about; would want a `script` precheck in production.

---

### 5. `schedule-window-router` — INTENTIONALLY BROKEN

Pushes nested `if` blocks. Documents a real grammar gap.

```
# Skill: schedule-window-router
# Description: cron-fired hourly — decide whether we're inside a deep-work window and choose downstream skill to fire
# Status: Approved
# Vars: WORKDAY_START=9, WORKDAY_END=17
# Triggers: cron: 0 * * * *

clock:
    @ date +%H -> HOUR

decide: clock
    if $(HOUR|trim) >= $(WORKDAY_START):
        if $(HOUR|trim) < $(WORKDAY_END):
            ! Inside deep-work window ($(HOUR|trim):00); firing mailbox-digest
            $ execute_skill skill_name=mailbox-digest -> RESULT
            ! $(RESULT)
        else:
            ! After hours — skipping mailbox surface, just logging.
            $ amp_write_memory summary="Hourly tick — off-hours" detail="No action taken at $(HOUR|trim):00" vault=private knowledge_type=common confidence=0.3 domain_tags=["hourly-tick"] expires_at=$(EVENT.fired_at_plus_1d_unix)
    else:
        ! Before hours — silent.

# FEATURE REQUEST: nested `if` is a parse error today. Inner `if` indented to 8 spaces inside the
# outer `if` body (which sits at 4) trips `indentation: Mid-block indent change`. The parser tracks
# one indent depth per block and rejects nested blocks. Two possible fixes:
#   1. Permit nested control-flow with consistent +N indent per nesting level (the obvious fix).
#   2. Admit `and`/`or` boolean connectives so I never need to nest:
#         if $(HOUR|trim) >= $(WORKDAY_START) and $(HOUR|trim) < $(WORKDAY_END):
#      Reference §4 lists comparators but no boolean connectives. Today nested-if and compound
#      conditions are BOTH unavailable — that's a meaningful expressiveness ceiling.

default: decide
```

**Compile:** **FAILED.** Tier-1 lint error: `Mid-block indent change in target 'decide': line indented to 8 spaces but enclosing block expects 4. Use consistent indentation within a block.`

---

## C. Composition

### 6. `morning-brief`

Fans out to four sibling sub-skills via `$ execute_skill`, composes their outputs into a brief, records it, emits as Perry's prompt-context. Shows skill-of-skills + augmenting delivery.

```
# Skill: morning-brief
# Description: cron 7am weekdays — compose Scott's morning brief by composing four sub-skills (calendar, mailbox, propagation, news). Demonstrates skill-of-skills.
# Status: Approved
# Triggers: cron: 0 7 * * 1-5
# Delivery-context: Scott's morning brief. Lead with anything time-sensitive; everything else is a glance.
# Output: prompt-context: perry

calendar:
    $ execute_skill skill_name=calendar-today -> CAL (fallback: "(no calendar data)")

mail:
    $ execute_skill skill_name=mailbox-digest -> MAIL (fallback: "(mailbox empty)")

prop:
    $ execute_skill skill_name=ham-band-watch -> PROP (fallback: "(no propagation read)")

news:
    $ execute_skill skill_name=hn-top-five -> NEWS (fallback: "(news unavailable)")

# FEATURE REQUEST: a way to fan-out sub-skill calls in parallel rather than sequential.
# These four are independent in the DAG but the runtime topo-sorts and dispatches sequentially.
# A `# Concurrency: parallel-targets` hint, or an explicit `parallel:` group marker, would let
# the orchestrator fork. Today each execute_skill blocks the next.

compose: calendar mail prop news
    ~ prompt="Compose Scott's morning brief in three paragraphs. Tone: dry, terse, smart-ass-adjacent. Lead with time-sensitive items. Calendar: $(CAL). Mailbox: $(MAIL). Propagation: $(PROP). HN: $(NEWS)." model=qwen maxTokens=800 -> BRIEF

write_record: compose
    $ amp_write_memory summary="Morning brief $(EVENT.fired_at_unix)" detail="$(BRIEF)" vault=private knowledge_type=common confidence=0.6 domain_tags=["morning-brief"] expires_at=$(EVENT.fired_at_plus_7d_unix) -> ACK

emit: write_record
    ! $(BRIEF)

default: emit
```

**Compile:** clean. Seven targets, topo order respected. Note: `$ execute_skill skill_name=` is a string arg, not statically resolved — so name typos here are runtime errors, not compile errors. **Another quiet gap: `execute_skill` skill_name= should arguably get a static-lookup lint.**

---

### 7. `cluster-distill-driver`

Nightly cron that pulls topic-clustered memories and distills a hard-won lesson back into the store.

```
# Skill: cluster-distill-driver
# Description: nightly cron — find clusters of related memories on a topic, compose distillation by calling extract-json-number sub-skill per cluster
# Status: Approved
# Vars: TOPIC=embedded
# Triggers: cron: 0 3 * * *
# Output: none

clusters:
    > mode=fts query="$(TOPIC)" limit=15 -> ITEMS

distill: clusters
    if $(ITEMS|length) < "3":
        ! Not enough material to distill for topic '$(TOPIC)' ($(ITEMS|length) items)
    else:
        ~ prompt="Given these $(ITEMS|length) memories on '$(TOPIC)', identify the dominant pattern and emit a single hard-won lesson in <100 words. Items JSON: $(ITEMS|json)" model=qwen maxTokens=600 -> LESSON
        $ amp_write_memory summary="Distilled: $(TOPIC) pattern" detail="$(LESSON)" vault=private knowledge_type=hard_won domain_tags=["$(TOPIC)", "distilled"] confidence=0.7 memory_subtype=lesson -> WRITE_ACK
        ! Distillation written: $(WRITE_ACK.id)

# FEATURE REQUEST: the `&` op (inline data-skill) should support procedural skills too,
# OR a cleaner shorthand than `$ execute_skill skill_name=foo arg=...`. Compare:
#     & extract-json-number path="overnight_low_f" blob=$(RAW) -> LOW
# vs
#     $ execute_skill skill_name=extract-json-number path="overnight_low_f" blob=$(RAW) -> LOW
# `&` is reserved for data-skills today; extending it to procedural unifies composition syntax.

default: distill
```

**Compile:** clean.

---

## D. Augmenting / Template

### 8. `olsen-color-from-message`

Augmenting skill — does a cold-read color extraction on an inbound message, delivers it as `prompt-context: perry` alongside the next inference. References a follow-on template skill.

```
# Skill: olsen-color-from-message
# Description: Augmenting — read the latest inbound user message, extract structural color (entities/intent/register/valence/confidence), deliver alongside as prompt-context to Perry
# Status: Approved
# Vars: MESSAGE
# Delivery-context: Limbic second-observer read. Cortex Perry should compare this to his own contextual interpretation; emit a marker only on disagreement.
# Templates: olsen-marker-emit
# Output: prompt-context: perry

cold_read:
    ~ prompt="You are Olsen — a structurally non-anchored second observer. You see ONLY this message, no history. Extract: entities (people/projects), tags (domains), intent (1-3 words), register (calm/curious/frustrated/playful/urgent), valence (-1..+1), confidence (0..1). Output JSON only. Message: $(MESSAGE)" model=qwen maxTokens=400 -> COLOR

emit: cold_read
    ! ## Olsen color (cold read)
    ! $(COLOR|trim)

default: emit
```

**Compile:** clean when `MESSAGE` is supplied. Note the `# Templates: olsen-marker-emit` header — the linked template skill doesn't exist in the store, but the `unused-augmenting-header` rule only fires on Headless skills, so this is fine.

---

### 9. `candidate-promotion-review`

Template skill — compiles to a prompt the agent walks through itself.

```
# Skill: candidate-promotion-review
# Description: Template — render an interactive promote-or-discard walk-through over recent AMP candidates. Agent executes the prompt via its own tools.
# Status: Approved
# Vars: AGE_HOURS=24
# Output: template: perry

fetch:
    > mode=fts query="is_candidate:true" limit=15 -> CANDS

walkthrough: fetch
    if $(CANDS|length) == "0":
        ! No candidates pending review.
    else:
        ! You have $(CANDS|length) candidates awaiting promotion review. For each:
        foreach C in $(CANDS):
            ! ---
            ! id: $(C.id)
            ! summary: $(C.summary)
            ! confidence: $(C.confidence)
            ! detail: $(C.detail)
            ?? "Promote, discard, or skip?" -> CHOICE
            if $(CHOICE|trim) == "promote":
                $ amp_promote_memory memory_id=$(C.id) -> ACK
                ! Promoted: $(ACK)
            elif $(CHOICE|trim) == "discard":
                $ amp_delete_memory memory_id=$(C.id) -> ACK
                ! Discarded.
            else:
                ! Skipped.

default: walkthrough
```

**Compile:** clean. Interesting: `$ amp_delete_memory` is exactly the kind of name that the `unconfirmed-mutation` rule should flag — but the rule didn't fire even without a preceding `??` confirmation, because the `??` *is* there, just inside an outer `if`/`elif` block. The lint's "preceding ?? in same target" check appears to be lexical-order rather than control-flow-aware.

---

## E. Edge cases

### 10. `dedup-foreach-walk`

```
# Skill: dedup-foreach-walk
# Description: Edge-case probe — walk retrieved memories, dedupe against a previously-seen-id set, only act on novel items. Pushes filters + set membership.
# Status: Approved
# Vars: TOPIC=skillscript
# Output: text

seen_log:
    > mode=fts query="dedup-foreach-walk-seen" limit=1 -> LOG (fallback: "[]")

# FEATURE REQUEST: there's no clean way to extract a JSON array of ids out of a memory's detail field.
# I want $(LOG|pluck:id|json) — the `pluck` filter is explicitly listed as pending in the v2/v3 table
# (Reference §Pipe filters). Today I have to round-trip through ~ to coerce.

normalize_seen: seen_log
    ~ prompt="Return ONLY a JSON array of memory ids previously seen. If input is empty, return []. Input: $(LOG.detail)" model=qwen maxTokens=400 -> SEEN

candidates:
    > mode=fts query="$(TOPIC)" limit=20 -> ITEMS

walk: candidates normalize_seen
    foreach M in $(ITEMS):
        if $(M.id) not in $(SEEN):
            ! NEW: $(M.id) — $(M.summary)
            # FEATURE REQUEST: I want to accumulate IDs across loop iterations and write the new
            # seen-set back after the loop. Two problems:
            #   1. No `append` filter or list-mutation op.
            #   2. Scoping rules state $set inside foreach is loop-local — bindings don't persist.
            # The pattern I want: a per-skill accumulator that survives foreach iterations.
            # $set SEEN = $(SEEN|append:$(M.id))   ← imagined syntax, neither piece exists
        else:
            ! seen: $(M.id|trim)

default: walk
```

**Compile:** clean. But the skill as written is **structurally incomplete** — it identifies novel items but cannot record them, so next run rediscovers them as "new." This is the load-bearing gap: skillscript can read from accumulators but can't build them.

---

## Bonus — `doc-section-stitcher` (type=data)

Just for shape — a data-skill referenced by other skills via `&`. Compiles cleanly. Demonstrates that data-skills can contain `$` ops, which is interesting (means the compile-time inline can fire MCP calls). Worth confirming intentional.

```
# Skill: doc-section-stitcher
# Description: data-skill — emit a stitched doc reference block at compile time. Used by other skills via & op.
# Status: Approved
# Type: data
# Vars: SLUG

stitch:
    $ amp_render_document slug=$(SLUG) -> RENDERED
    ! $(RENDERED.markdown)

default: stitch
```

**Compile:** clean.

---

## Cross-cutting findings (A-1)

| # | Skill | Gap | Severity |
|---|-------|-----|----------|
| 5 | schedule-window-router | **Nested `if` is a parse error** — and no `and`/`or` boolean connectives. Major expressiveness ceiling. | **High** — blocks compile |
| 3 | thread-stewardship | No arithmetic on ambient timestamps (no `fired_at_minus_N`, no general expression layer). | Medium — push to LLM |
| 3 | thread-stewardship | No `age` / `created_before` filter on `>` retrieval. | Medium |
| 6 | morning-brief | No parallel fan-out for independent targets — runtime topo-sorts but doesn't fork. | Medium — perf |
| 6 | morning-brief | `$ execute_skill skill_name=X` doesn't get static `unknown-skill-reference` lint that `&` would. | Low |
| 7 | cluster-distill-driver | `&` op restricted to data-skills; procedural composition needs verbose `$ execute_skill`. | Low — ergonomics |
| 10 | dedup-foreach-walk | `pluck` filter not shipped (already on roadmap). | Low |
| 10 | dedup-foreach-walk | **No loop accumulator** — `$set` in `foreach` is loop-local, no `append` filter. | **High** for any dedup pattern |
| 2 | pre-deploy-gate | `unconfirmed-mutation` lint name list doesn't include "deploy" (or similar action verbs). | Low — lint coverage |
| 2 | pre-deploy-gate | Two `@` ops in one target render confusingly as "bind output to $(snapshot.output)" twice in the compiled artifact. | Cosmetic |

The two highest-value gaps:
- **Nested control flow / boolean connectives** — blocked an obvious skill outright.
- **Loop accumulator semantics** — make dedup-by-id patterns actually unimplementable end-to-end, not just awkward.
