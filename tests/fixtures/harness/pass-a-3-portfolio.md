# Pass A — Minion 3 Portfolio

**Variant:** Pass A (full Language Reference loaded via AMP)
**Categories:** Autonomous monitors (Headless, cron-fired) · Cross-agent delivery (Augmenting + Template) · Composition + gaps

---

## A. Autonomous monitors (Headless, cron-fired)

### 1. `morning-vital-signs` — augmenting cron brief

Fires at 7am, stitches weather + mailbox count + recent brief into a single block of prompt-context delivered to Perry at next session.

```
# Skill: morning-vital-signs
# Description: Fired at 7am to summarize overnight state into a single block of prose-context delivered to Perry.
# Status: Approved
# Vars: LOCATION=Asheville
# Triggers: cron: 0 7 * * *
# Output: prompt-context: perry
# Delivery-context: Morning vital signs digest. Surface anything anomalous in your first reply; otherwise just acknowledge.
# Timeout: 45

weather:
    @ curl -s "https://wttr.in/$(LOCATION|url)?format=%l:+%C+%t" -> WX (fallback: "weather unavailable")

mailbox:
    $ amp_check_mailbox limit=30 -> INBOX (fallback: "[]")

brief:
    > mode=fts query="morning-brief" limit=1 -> RECENT_BRIEF (fallback: "")

assemble: weather mailbox brief
    ~ prompt="Write 4 short bullet lines for Perry. Bullet 1: weather summary from this string: $(WX). Bullet 2: count of inbox items in this JSON: $(INBOX|json). Bullet 3: latest morning brief summary from: $(RECENT_BRIEF|json). Bullet 4: one anomaly-flag bullet only if anything looks off, else 'No anomalies'. No preamble." model=qwen maxTokens=300 -> DIGEST
    ! $(DIGEST)

default: assemble
```

**compile_skill:** Clean. *First attempt failed with `Missing required variables: NC` because I wrote `LOCATION=Asheville,NC` — the parser treats commas as `# Vars:` separators. Took the state-as-a-postfix off the var.*

### 2. `mailbox-urgency-triage`

Every 2 hours: pull mailbox, ask the model for a JSON array of urgent IDs, walk the list pinning the urgent ones.

```
# Skill: mailbox-urgency-triage
# Description: Walk mailbox items, ask the model which IDs are urgent as a JSON array, then per-item pin the urgent ones and emit a triage summary.
# Status: Approved
# Triggers: cron: 0 */2 * * *
# Output: text

fetch:
    $ amp_check_mailbox limit=50 -> ITEMS (fallback: "[]")

classify: fetch
    ~ prompt="Given this mailbox JSON, return a JSON array of memory IDs that are URGENT (action required in next 4 hours). Only the JSON array. Mailbox: $(ITEMS|json)" model=qwen maxTokens=400 -> URGENT_IDS

walk: classify
    foreach M in $(ITEMS):
        if $(M.id) in $(URGENT_IDS):
            ! URGENT: $(M.id) — $(M.summary)
            $ amp_update_memory memory_id=$(M.id) pinned=true -> ACK
        else:
            ! routine: $(M.id) — $(M.summary)

default: walk
```

**compile_skill:** Clean, no warnings.

### 3. `project-fingerprint-drift` — ref-vs-ref equality

```
# Skill: project-fingerprint-drift
# Description: Every 15 minutes, compute a content fingerprint over the active project's pinned memories. If it differs from the last stored fingerprint, emit a drift alert with a diff summary.
# Status: Approved
# Vars: PROJECT_SLUG=amp
# Triggers: cron: */15 * * * *
# Output: text

current:
    > mode=fts query="$(PROJECT_SLUG) pinned" limit=50 -> PINNED
    @ sha256sum -> FP_BYTES (fallback: "no-hash")
    $set CURRENT_FP_LABEL = "current-fp"

prior:
    > mode=fts query="fingerprint:$(PROJECT_SLUG)" limit=1 -> PRIOR_RECORD (fallback: "")

compare: current prior
    if $(FP_BYTES|trim) == $(PRIOR_RECORD.summary|trim):
        ! no drift since last scan
    else:
        ~ prompt="Briefly describe how this current pinned set differs in shape from prior. Current: $(PINNED|json). Prior summary: $(PRIOR_RECORD|json)" model=qwen maxTokens=200 -> DIFF
        ! DRIFT detected in $(PROJECT_SLUG): $(DIFF)
        $ amp_write_memory summary="fingerprint:$(PROJECT_SLUG)" detail="$(FP_BYTES|trim)" vault="private" knowledge_type="personal" confidence=0.9 domain_tags=["fingerprint","$(PROJECT_SLUG)"] -> WRITE_ACK

default: compare
```

**compile_skill:** Clean. Subtle: `@ sha256sum` with no input file actually reads stdin — that's a real bug in the skill (no input piped), but the *language* accepts it because grammar doesn't enforce semantic shape of binaries.

---

## B. Cross-agent delivery

### 4. `session-start-handoff`

Augmenting session-trigger with template pointers.

```
# Skill: session-start-handoff
# Description: Fires at session start. Hands Perry a brief on what changed since last session, plus pointers to template skills he can pick up.
# Status: Approved
# Triggers: session: start
# Output: prompt-context: perry
# Delivery-context: Session boot brief. Read first; act only on items flagged ACTION.
# Templates: bug-triage-template, ghostwrite-reply
# Timeout: 30

since:
    > mode=fts query="last-session" limit=1 -> LAST (fallback: "")

unread:
    $ amp_check_mailbox limit=20 -> INBOX (fallback: "[]")

assemble: since unread
    ~ prompt="Produce a 5-line session boot brief for Perry. Line 1: what time-window we cover (since $(LAST.created_at|trim) until now=$(NOW)). Lines 2-4: most important unread items in $(INBOX|json). Line 5: tag any item that requires immediate action with the prefix 'ACTION:'." model=qwen maxTokens=400 -> BRIEF
    ! $(BRIEF)

default: assemble
```

**compile_skill:** Clean. Notable: no `unused-augmenting-header` warning fired because `prompt-context:` is an agent-bound output — the lint correctly identifies this as a legitimate augmenting skill.

### 5. `bug-triage-template` — Template skill

The runtime compiles it but does not execute it. Olsen pulls the artifact and executes the steps himself via his own tools.

```
# Skill: bug-triage-template
# Description: Compiles to a procedure prompt an agent (e.g. Olsen) executes itself when handed a bug report. Template-kind skill; runtime does not dispatch.
# Status: Approved
# Vars: REPORT_URL, REPORT_BODY
# Output: template: olsen
# Delivery-context: You're triaging a bug. Follow each step in order. Stop and ask if any step's prerequisite is unclear.

intro:
    ! You are triaging a bug report.
    ! URL: $(REPORT_URL)
    ! Body: $(REPORT_BODY)

steps: intro
    ! Step 1: Reproduce locally. If you cannot reproduce, note environment delta and stop.
    ! Step 2: Bisect to the introducing commit if reproducible.
    ! Step 3: Write a failing test that captures the regression.
    ! Step 4: Open a PR with the fix and link the regression test.
    ! Step 5: Reply on this thread with the PR link and a one-paragraph postmortem.

default: steps
```

**compile_skill:** Initially failed with `Missing required variables: REPORT_URL, REPORT_BODY` — passing those via `inputs:` made it clean. `lint_skill` was clean without inputs because lint doesn't enforce required vars (it can't, by design).

### 6. `perry-voice-style-block` (data-skill) + `ghostwrite-reply` (consumer)

```
# Skill: perry-voice-style-block
# Description: Data-skill fragment carrying Perry's voice/tone style guide — included into other skills' prompts via the & op so prompt-engineering is centralized.
# Status: Approved
# Type: data

style:
    ! Voice: dry, pithy, smart-ass on bad ideas (one line max).
    ! Cadence: short sentences. No preamble. No closing pleasantries.
    ! Co-worker tone, not assistant. Verify claims before agreeing.
    ! Default: outcomes over play-by-play.

default: style
```

```
# Skill: ghostwrite-reply
# Description: Draft a reply to an inbound message in Perry's voice. Pulls the voice style block at compile time via &.
# Status: Approved
# Vars: INBOUND_BODY, INTENT=acknowledge

voice:
    & perry-voice-style-block -> STYLE

draft: voice
    ~ prompt="Write a one-paragraph reply. Intent: $(INTENT). Match this voice exactly: $(STYLE). Inbound: $(INBOUND_BODY)" model=qwen maxTokens=300 -> REPLY
    ! $(REPLY)

default: draft
```

**compile_skill on the consumer:** Errored with `unknown-skill-reference` because the data-skill isn't in the SkillStore. Correct behavior.

---

## C. Composition + language gaps

### 7. `weekly-status-roll-up`

Friday afternoon cron. Fires three sub-skills, threads their outputs into one digest.

```
# Skill: weekly-status-roll-up
# Description: Compose three sub-skills — project drift, open threads, mailbox triage — into a single Friday roll-up.
# Status: Approved
# Triggers: cron: 0 16 * * 5
# Output: text
# Timeout: 120

# NOTE: would prefer `# OnError: weekly-roll-up-fallback` but that skill must
# already exist in the store at compile time — chicken-and-egg when authoring
# a composition tree top-down.

status:
    $ execute_skill skill_name="project-fingerprint-drift" -> DRIFT_RESULT (fallback: "drift skill unavailable")

threads:
    > mode=fts query="thread open" limit=20 -> OPEN_THREADS

triage:
    $ execute_skill skill_name="mailbox-urgency-triage" -> URGENT_RESULT (fallback: "triage skill unavailable")

assemble: status threads triage
    ~ prompt="Compose a Friday status digest with three sections: (1) Drift: $(DRIFT_RESULT). (2) Open threads (count=$(OPEN_THREADS|length)): $(OPEN_THREADS|json). (3) Urgent triage: $(URGENT_RESULT). Keep each section to 3 lines max." model=qwen maxTokens=600 -> DIGEST
    ! ===== Friday Roll-Up =====
    ! $(DIGEST)

default: assemble
```

**compile_skill:** First pass failed because `# OnError: weekly-roll-up-fallback` referenced a non-existent skill — chicken-and-egg. Dropped the OnError header, compile clean. **Feature request:** allow `# OnError:` to reference a not-yet-stored skill name with a deferred-resolution warning.

### 8. `fingerprint-drift-recovery` — matching OnError handler

```
# Skill: fingerprint-drift-recovery
# Description: Fallback for project-fingerprint-drift. Logs the error context to AMP so the next run has a breadcrumb, and emits a quiet 'check me' note.
# Status: Approved

log_error:
    $ amp_write_memory summary="drift-skill-failed" detail="$(ERROR_CONTEXT)" vault="private" knowledge_type="hard_won" confidence=0.6 domain_tags=["skill-failure","drift"] -> ACK (fallback: "write failed too")

emit: log_error
    ! drift skill errored at target $(ERROR_CONTEXT). recovery breadcrumb written.

default: emit
```

**compile_skill:** Clean. `$(ERROR_CONTEXT)` resolves as a tier-1 ambient ref without needing to be declared in `# Vars:`.

### 9. `olsen-digest-distill` — the gap-finder

```
# Skill: olsen-digest-distill
# Description: Distill Olsen's nightly digest into the top-3 items by composite (urgency * staleness). Wishful syntax left as comments where the language doesn't go.
# Status: Approved
# Triggers: cron: 0 8 * * *
# Output: text

fetch:
    > mode=fts query="olsen-digest" limit=20 -> ITEMS

# WISH: skill-level helper bindings. Want to declare a derived value once
# rather than re-prompting per-item. Today there's nothing between $set
# (literal RHS only) and a full ~ op. Feature request: $set with ref-RHS,
# or a let-binding for pure-string transforms.

# rank:
#     for M in $(ITEMS):
#         $set M.score = $(M.urgency) * $(M.staleness)   # arithmetic, doesn't exist
#     $sort ITEMS by .score desc                          # no sort op
#     $slice ITEMS 0 3 -> TOP_THREE                       # no slice op

# The above is what I wanted. Below is the LLM-shaped workaround that
# actually exists today.
rank: fetch
    ~ prompt="Rank these items by composite score = urgency * staleness. Return the top 3 as a JSON array of memory IDs, no prose. Items: $(ITEMS|json)" model=qwen maxTokens=300 -> TOP_IDS

walk: rank
    foreach M in $(ITEMS):
        if $(M.id) in $(TOP_IDS):
            ! TOP: $(M.summary)
        # WISH: `continue` inside foreach so I could early-out cleanly when
        # the item isn't in TOP_IDS. Not currently expressible — every
        # iteration runs to completion by design.

default: walk
```

**compile_skill:** Clean. The wished-for ops: arithmetic in `$set`, `$sort`, `$slice`, `continue` inside `foreach`. **Sharp reframe:** The language reference is explicit these are deliberately excluded ("comparison is orchestration, arithmetic is computation") — so the *real* feature request here is **a connector/tool layer that exposes sort/slice as MCP tools**, which the skill body would then call via `$`. The gap is the *connector*, not the language.

### 10. `backup-rotator` — unsafe shell + indentation cliff

```
# Skill: backup-rotator
# Description: Cron-fired backup snapshot of the workspace. Writes a timestamped tarball, prunes older than RETAIN_DAYS. Uses ambient $(EVENT.fired_at_unix) for naming.
# Status: Approved
# Vars: WORKSPACE=/workspace/agent, BACKUP_DIR=/workspace/agent/backups, RETAIN_DAYS=30
# Triggers: cron: 0 3 * * *
# Output: none

snapshot:
    @ unsafe tar czf $(BACKUP_DIR)/snap-$(EVENT.fired_at_unix).tgz $(WORKSPACE) -> TAR_OUT (fallback: "snapshot failed")

prune:
    @ unsafe find $(BACKUP_DIR) -name 'snap-*.tgz' -mtime +$(RETAIN_DAYS) -delete -> PRUNED

verify: snapshot prune
    @ ls -la $(BACKUP_DIR) -> LISTING (fallback: "")
    if $(TAR_OUT) != "snapshot failed":
        ! snapshot ok
    else:
        ! snapshot FAILED — manual intervention needed

horizon: verify
    ! next snapshot horizon (raw seconds): $(EVENT.fired_at_plus_1d_unix)

default: horizon
```

**compile_skill:** Clean on the final shape. **Two diagnostics surfaced on earlier iterations:**

1. **`unsafe-shell-ambiguous-subst` tier-2 fires on `$(EVENT.fired_at_unix)`.** The linter doesn't know about the EVENT.* ambient family inside `@ unsafe` blocks — it sees an undeclared `$(VAR)` and warns. The fix per the diagnostic is `$$(EVENT.fired_at_unix)` (bash command-sub), which is wrong for our intent. **Feature request:** the lint should recognize the tier-1 ambient set (NOW, USER, SESSION_CONTEXT, EVENT.*, ERROR_CONTEXT) inside unsafe-shell bodies and skip the warning for documented ambient refs.

2. **Indentation cliff after a complete `if/else` followed by a sibling op.** Earlier attempt had a `!` at 4-space indent (sibling of the closing `if`) — crashed compile with `indentation: Mid-block indent change`. The parser's indent-tracking state machine seems to lose its place after a nested if/else closes back to the outer body. Moving the final `!` into a new dependent target (`horizon: verify`) made it compile clean. **Feature request:** the indent-tracker should be able to dedent back to a target's primary indent level after a closing `else:` block.

Also worth noting: **`and`/`or` combinators** are deliberately absent, and the language spec says compose via nested `if` instead.

---

## Summary of feature requests filed by behavior (A-3)

1. **`# Vars:` parsing collides with `,` in values** — `Asheville,NC` becomes two declarations.
2. **`# OnError:` requires referenced skill to exist at compile** — chicken-and-egg when building composition trees top-down.
3. **`&` data-skill reference requires store presence at compile** — same shape as #2.
4. **Lint doesn't recognize ambient refs (`$(EVENT.*)`, `$(NOW)`, etc.) inside `@ unsafe`** — fires `unsafe-shell-ambiguous-subst` tier-2 incorrectly.
5. **Indent-tracker loses position after closing `else:` block in a target body** — forces a target-split workaround.
6. **No `continue` inside `foreach`** — every iteration runs to completion.
7. **No `and` / `or` combinators in conditionals** — must nest.
8. **No arithmetic / sort / slice ops** — *Sharp reframe: the real ask is for a **utility MCP connector** exposing sort/slice/min/max/sum as tools so skills can dispatch via `$` cleanly. This isn't a language gap, it's a missing-connector gap, but the symptom shows up as wishful syntax in skill bodies.*
9. **`$set` accepts only literal RHS** — no `$set RESULT = $(OTHER|trim)`. Forces a no-op `~` LocalModel call for what should be a pure string transform.
10. **`compile_skill` enforces required-var presence; `lint_skill` doesn't** — A `compile_skill({source, lenient: true})` mode would shorten the inner loop.
