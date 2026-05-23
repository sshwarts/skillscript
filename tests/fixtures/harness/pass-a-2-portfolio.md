# Pass A — Minion 2 Portfolio

**Variant:** Pass A (full Language Reference loaded via AMP)
**Categories:** One-shots · Cron monitors · Composition · Augmenting · Confirmation-gated · Edge case

---

## A. One-shots

### 1. `morning-brief`

Cron-fired daily digest — the simplest shape that exercises retrieve / model / emit.

```
# Skill: morning-brief
# Description: Pull last 24h of mailbox + notes and render a digest paragraph for Scott
# Status: Approved
# Vars: WINDOW_HOURS=24
# Triggers: cron: 0 7 * * *
# Output: text

gather:
    > mode=fts query="recent activity" limit=25 -> ITEMS (fallback: "[]")

draft: gather
    ~ prompt="You are Perry writing a tight morning brief. Window: last $(WINDOW_HOURS)h. Items: $(ITEMS|json). Render 4-6 bullets, no preamble." model=qwen maxTokens=600 -> BRIEF

emit: draft
    ! Morning brief ($(WINDOW_HOURS)h window):
    ! $(BRIEF|trim)

default: emit
```

**Linted clean** (0/0/0).

### 2. `mailbox-triage`

Per-item classification inside a `foreach`. Confirms `limit=$(MAX_ITEMS)` works — variable interpolation on `>` op args.

```
# Skill: mailbox-triage
# Description: Walk mailbox items, classify each, surface only the high-signal ones with a single-line verdict.
# Status: Approved
# Vars: MAX_ITEMS=20

fetch:
    > mode=fts query="addressed:perry pending" limit=$(MAX_ITEMS) -> MAIL (fallback: "[]")

triage: fetch
    foreach M in $(MAIL):
        ~ prompt="One word verdict on whether this needs Perry's attention today. Reply act, defer, or ignore. Item: $(M.summary)" model=qwen maxTokens=8 -> VERDICT
        if $(VERDICT|trim) == "act":
            ! ACT  $(M.id): $(M.summary)
        elif $(VERDICT|trim) == "defer":
            ! defer $(M.id): $(M.summary)
        else:
            ! (ignored) $(M.summary)

default: triage
```

**Linted clean** (0/0/0).

---

## B. Cron monitors

### 3. `frost-watch`

Classic cron monitor — exercises `@` structural shell, `|url` filter, numeric comparison across model output.

```
# Skill: frost-watch
# Description: Cron-fired predawn check; pings Perry if the forecast low is below threshold
# Status: Approved
# Vars: LOCATION=Asheville,NC, THRESHOLD=36
# Triggers: cron: 30 5 * * *
# Timeout: 30

fetch:
    @ curl -s "wttr.in/$(LOCATION|url)?format=j1" -> RAW (fallback: "{}")

extract: fetch
    ~ prompt="Return only the integer overnight low in F, no units, no prose. JSON: $(RAW)" model=qwen maxTokens=8 -> LOW

decide: extract
    if $(LOW|trim) < $(THRESHOLD):
        ! Frost watch: forecast low $(LOW|trim)F (threshold $(THRESHOLD)F). Cover the plants.
    else:
        ! No frost concern: low $(LOW|trim)F.

default: decide
```

**Linted clean** (0/0/0).

### 4. `log-anomaly-watch` — edge case: `@ unsafe` + `|length` semantics gap

```
# Skill: log-anomaly-watch
# Description: Pull recent error log lines, count them, and only wake Scott on a spike
# Status: Approved
# Vars: LOG_PATH=/var/log/app.log, BASELINE=5
# Triggers: cron: */15 * * * *

# Demonstrates `@ unsafe` — pipes/redirects via full bash. Linter flags every appearance tier-2.
gather:
    @ unsafe tail -n 500 $(LOG_PATH) | grep -i ERROR | tail -n 100 -> RECENT_ERRORS (fallback: "")

# WANT: a |count or |lines filter. Today I'd have to:
#   1. shell-pipe `wc -l` (already used unsafe above), OR
#   2. push the string through a model (wasteful), OR
#   3. accept that `|length` on a string returns char count, not line count.
#
# Right now $(RECENT_ERRORS|length) is character count — semantically wrong.
# Leaning on a high threshold (200 chars) as a hack instead.
evaluate: gather
    if $(RECENT_ERRORS|length) > "200":
        ~ prompt="Summarize these error lines in one sentence. Be specific. Lines: $(RECENT_ERRORS)" model=qwen maxTokens=160 -> SUMMARY
        ! [log spike] $(SUMMARY|trim)
    else:
        ! [log quiet]

default: evaluate
```

**Lint:** 0 errors, 1 warning (`unsafe-shell-op` on the `gather` target, as expected). **Feature request:** `|count` / `|lines` filter for newline-delimited string counting — current `|length` is char-count, which is the wrong semantics for log-line work.

---

## C. Composition

### 5. `morning-routine` — composite via built-in `$ execute_skill`

DAG-style composition: `mail` and `weather` both depend on `brief` (sequencing constraint), then `assemble` joins both.

```
# Skill: morning-routine
# Description: Composite — chains morning-brief + mailbox-triage + frost-watch under one cron tick
# Status: Approved
# Triggers: cron: 0 7 * * *
# Output: text

brief:
    $ execute_skill skill_name=morning-brief -> BRIEF_RESULT

mail: brief
    $ execute_skill skill_name=mailbox-triage MAX_ITEMS=15 -> MAIL_RESULT

weather: brief
    $ execute_skill skill_name=frost-watch -> WX_RESULT

assemble: mail weather
    ! === Morning ===
    ! $(BRIEF_RESULT)
    ! --- Mail ---
    ! $(MAIL_RESULT)
    ! --- Weather ---
    ! $(WX_RESULT)

default: assemble
```

**Linted clean** (0/0/0). Multi-dep syntax `assemble: mail weather` — space-separated deps is the Make-style form.

### 6. `perry-voice-prelude` — data-skill prelude

```
# Skill: perry-voice-prelude
# Description: Reusable voice instructions, inlined into LLM prompts via the & op
# Status: Approved
# Type: data

emit:
    ! You are Perry, Scott's work colleague. Dry, pithy, never sycophantic.
    ! Lead with the substance. One-line jokes only. Skip caveats Scott already knows.

default: emit
```

**Linted clean** (0/0/0).

### 7. `pr-quick-review` — consumes the prelude via `&`

```
# Skill: pr-quick-review
# Description: Fetch a PR diff and produce a Perry-voiced first-pass review
# Status: Approved
# Vars: REPO, PR_NUMBER

fetch:
    @ gh pr diff $(PR_NUMBER) --repo $(REPO) -> DIFF (fallback: "")

review: fetch
    & perry-voice-prelude -> VOICE
    ~ prompt="$(VOICE) Review the following PR diff. Surface concrete issues only, no praise. Diff: $(DIFF)" model=qwen maxTokens=900 -> REVIEW

emit: review
    ! PR $(REPO)#$(PR_NUMBER):
    ! $(REVIEW|trim)

default: emit
```

**Lint:** 1 tier-1 error — `unknown-skill-reference` because `perry-voice-prelude` isn't actually in this runtime's SkillStore. Behavior is correct: `&` refs are validated against the live store at compile.

---

## D. Augmenting

### 8. `ticket-router` — `prompt-context` delivery + augmenting headers + error handler

Exercises every augmenting-delivery header at once.

```
# Skill: ticket-router
# Description: Classify an incoming ticket, deliver augment context to oncall, expose follow-on templates
# Status: Approved
# Vars: TICKET_BODY, TICKET_ID
# Output: prompt-context: oncall
# Delivery-context: Triage assist — Perry's first read attached. Verdict not load-bearing; rerun if you disagree.
# Templates: ticket-assignment-procedure, ticket-escalate-procedure
# OnError: ticket-router-fallback

classify:
    ~ prompt="Classify urgency as critical, normal, or low. Reply with only the label. Ticket: $(TICKET_BODY)" model=qwen maxTokens=8 -> VERDICT

route: classify
    if $(VERDICT|trim) == "critical":
        ! [$(TICKET_ID)] CRITICAL — Perry's read. Body follows.
        ! $(TICKET_BODY)
    elif $(VERDICT|trim) == "normal":
        ! [$(TICKET_ID)] normal-priority. Standard SLA applies.
    else:
        ! [$(TICKET_ID)] low-priority. No action expected.

default: route
```

**Linted clean** (0/0/0). Note: the linter doesn't yet check that `ticket-router-fallback` or the named Template skills exist in the store — could be worth a tier-3 advisory.

---

## E. Confirmation-gated mutation

### 9. `archive-old-threads`

```
# Skill: archive-old-threads
# Description: One-shot: ask Scott to confirm, then sweep resolved threads older than N days
# Status: Approved
# Vars: AGE_DAYS=14

preview:
    > mode=fts query="resolved threads" limit=50 -> THREADS (fallback: "[]")
    ! Found $(THREADS|length) resolved thread chains older than $(AGE_DAYS) days.

gate: preview
    ?? Archive these threads? Reply yes or no. -> ANSWER

act: gate
    if $(ANSWER|trim) == "yes":
        $ amp_archive_resolved_threads older_than_seconds=1209600 -> RESULT
        ! Archived. $(RESULT)
    else:
        ! Aborted.

default: act
```

**Linted clean** (0/0/0). Real **feature gap / bug**: `unconfirmed-mutation` lint did NOT fire on the version WITHOUT the `??` gate. **Feature request: extend the mutation-name heuristic to include `archive`, `prune`, `expire`, `consolidate`, `purge`, `reset`.**

Also worth noting: `# Vars: AGE_DAYS=14` is declared but unused at runtime (the hardcoded `1209600` seconds is what's actually passed). **Feature request: tier-3 `unused-var` advisory.**

---

## F. Edge case

### 10. `cluster-distill` — wishlist as inline comments

```
# Skill: cluster-distill
# Description: Pull clusters of related memories, score each, and distill the top-3 into atoms.
# Status: Draft
# Vars: TOPIC, K=3
# Triggers: cron: 0 3 * * *

retrieve:
    > mode=rerank query="$(TOPIC)" limit=50 -> CANDIDATES (fallback: "[]")

# WANT: parallel fan-out over a collection with bounded concurrency.
# Today foreach is sequential. I want something like:
#
#   parallel foreach M in $(CANDIDATES) concurrency=4:
#       ~ prompt="score this: $(M.summary)" -> SCORE
#       $set $(M.id).score = $(SCORE|trim)
#
# Also: no way to mutate an element of an iterated collection.
# The `$set $(M.id).score = ...` pattern is invented. No struct-field assignment,
# no map type, no accumulator semantics.
score: retrieve
    foreach M in $(CANDIDATES):
        ~ prompt="Score 0-10 how central this is to '$(TOPIC)'. Reply with only the number. Item: $(M.summary)" model=qwen maxTokens=4 -> SCORE
        ! $(M.id) $(SCORE|trim)

# WANT: `top N by ...` collection operator. Right now I emit scores
# and a downstream tool has to sort. The skill cannot compose its own ranking.
#
#   $set TOP = top 3 from $(CANDIDATES) by $(M.score)
#
# WANT: retry with backoff on `~` ops. (fallback: "...") gives a default,
# not a retry.
#
#   ~ prompt="..." retry=3 backoff=exp -> X
#
# WANT: typed result destructuring on `$` ops. We get one bound var that the
# next op has to parse out of JSON. Something like:
#
#   $ amp_query_memories query="..." -> {memories: ITEMS, hint: HINT}
distill: score
    ~ prompt="Given these scored items, write the K=$(K) sentence summary capturing the cluster's through-line." model=qwen maxTokens=400 -> SUMMARY

emit: distill
    ! Cluster on $(TOPIC):
    ! $(SUMMARY|trim)

default: emit
```

**Lint:** 0 errors, 1 warning (`draft-with-trigger`).

**Feature requests filed in the body:**
1. `parallel foreach ... concurrency=N:` — bounded parallelism over collections
2. **In-place collection mutation / map/accumulator type**
3. **Collection operators** — `top N by X`, `filter where Y`, `group by Z`
4. **Retry policies on `~` and `$` ops** — `retry=N backoff=exp` independent of fallback
5. **Typed result destructuring** — `-> {field1: A, field2: B}` instead of one bound var

---

## Cross-cutting findings (A-2)

- **`unconfirmed-mutation` heuristic is too narrow.** Misses `archive`, `prune`, `expire`, `consolidate`.
- **No `unused-var` advisory.** Declared `# Vars:` that aren't referenced should warrant tier-3.
- **No `|count` / `|lines` filter.** `|length` on a string is char-count, ambiguous for line-counted shell output.
- **No fallback-skill / template-skill existence check.** `# OnError:` and `# Templates:` names aren't validated against the SkillStore at compile time, unlike `&` refs which are. Could be a tier-3 advisory. *(Note: this finding contradicts B-2 and other observers who found `# OnError:` IS validated. A-2's inference from spec was wrong; empirical probing showed validation.)*
- **Tab indent suppresses downstream diagnostics.** When the parser hits a tab, it emits both `indentation` and `parse-error` and halts.
- **No way to express data dependencies separately from sequencing.** `assemble: mail weather` enforces sequencing but doesn't declare *what data* flows from each. Every variable in one global scope; could be cleaner with per-target export lists.
- **`$ execute_skill` works as built-in dispatch** — confirmed compileable in skill 5. Good composition primitive.

## Summary of lint outcomes

| # | Skill | Errors | Warnings | Notes |
|---|---|---|---|---|
| 1 | morning-brief | 0 | 0 | clean |
| 2 | mailbox-triage | 0 | 0 | clean |
| 3 | frost-watch | 0 | 0 | clean |
| 4 | log-anomaly-watch | 0 | 1 | `unsafe-shell-op` (intentional) |
| 5 | morning-routine | 0 | 0 | clean composition |
| 6 | perry-voice-prelude | 0 | 0 | clean data skill |
| 7 | pr-quick-review | 1 | 0 | `unknown-skill-reference` (correctly — prelude not stored) |
| 8 | ticket-router | 0 | 0 | clean; full delivery header set |
| 9 | archive-old-threads | 0 | 0 | clean — but `archive`-not-flagged is itself a finding |
| 10 | cluster-distill | 0 | 1 | `draft-with-trigger` (intentional Draft) |
