# Pass B — Minion 3 Portfolio

**Variant:** Pass B (help-only, no AMP / spec access)
**Runtime:** v0.2.9, dashboard mode, structural-spawn shell, three LocalModels, one SqliteMemoryStore, no MCP connectors wired, no AgentConnectors wired.

---

## Category A — One-shots

### 1. `greet-stranger` — minimal LocalModel one-shot

```
# Skill: greet-stranger
# Description: Tiny one-shot — generate a warm greeting tailored to who's at the door.
# Status: Approved
# Vars: NAME=friend, MOOD=cheerful

compose:
    ~ prompt="Write one sentence greeting a person named $(NAME). Tone: $(MOOD). Keep it under 12 words." model=default maxTokens=60 -> LINE

deliver: compose
    ! $(LINE|trim)

default: deliver
```

**Intent:** Smallest "feels like a skill" — declared vars, one LLM call, one emission.
**Compile:** clean, no warnings.

### 2. `ask-then-act` — interactive confirm-then-mutate

```
# Skill: ask-then-act
# Description: Interactive — confirms a destructive action before firing it. Demonstrates `??` and mutation-confirmation lint flow.
# Status: Approved
# Vars: TARGET_PATH=/tmp/scratch

probe:
    @ ls -la $(TARGET_PATH) -> LISTING (fallback: "missing")

confirm: probe
    ! About to delete contents of $(TARGET_PATH):
    ! $(LISTING)
    ?? Proceed with deletion? (yes / no) -> ANSWER

act: confirm
    if $(ANSWER|trim) == "yes":
        # Mutation tool call that should be PRECEDED by `??` — confirmed by `confirm` target.
        $ delete_path path=$(TARGET_PATH) -> RESULT
        ! Deleted. Result: $(RESULT)
    else:
        ! Aborted by user.

default: act
```

**Intent:** demonstrates the `??` ask-user op + lint convention that mutating `$` calls should be preceded by confirmation.
**Compile:** clean — but notable surprise: `$(LISTING)` and `$(RESULT)` are referenced and emit through render, yet `undeclared-var` doesn't fire. The renderer prints `$(probe.output)` as the bound var, not `$(LISTING)`. **Behavioral feature request: docs say `@ cmd -> VAR` binds `$(VAR)`; render shows it binds `$(<target>.output)`. One of those is wrong.** Same finding appears in #3, #4, #5, #9.

---

## Category B — Cron monitors

### 3. `disk-watchdog`

```
# Skill: disk-watchdog
# Description: Cron-fired disk-usage check; emits a warning when root partition is past threshold.
# Status: Approved
# Vars: THRESHOLD=85
# Triggers: cron: */15 * * * *

measure:
    @ df --output=pcent / -> RAW (fallback: "100%")

extract: measure
    ~ prompt="Extract just the integer percentage (no % sign) from this df output. Reply with only the number: $(RAW)" model=qwen maxTokens=10 -> PCT

evaluate: extract
    if $(PCT|trim) >= $(THRESHOLD):
        ! Disk pressure: root at $(PCT|trim)% (threshold $(THRESHOLD)%). Time to prune.
    else:
        ! Disk ok: root at $(PCT|trim)%.

default: evaluate
```

**Compile:** clean. Same `@` binding surprise.

### 4. `retry-with-backoff` — feature-request loud edge case

```
# Skill: retry-with-backoff
# Description: Edge-case probe — wants per-op retry with exponential backoff. No native support; documented as feature request.
# Status: Approved
# Vars: ENDPOINT=https://api.example.com/health, MAX_TRIES=3

# FEATURE-REQUEST: no built-in retry/backoff. The `(fallback: "...")` form catches one failure but doesn't retry.
# Wanted:
#   @ curl -fsS $(ENDPOINT) -> HEALTH (retry: 3, backoff: exponential, base_ms: 500)
# Today's best workaround: unroll attempts manually, which is ugly.

attempt_1:
    @ curl -fsS $(ENDPOINT) -> R1 (fallback: "")

attempt_2:
    needs: attempt_1
    if $(R1|trim) == "":
        @ curl -fsS $(ENDPOINT) -> R2 (fallback: "")
    else:
        $set R2=$(R1)

attempt_3:
    needs: attempt_2
    if $(R2|trim) == "":
        @ curl -fsS $(ENDPOINT) -> R3 (fallback: "")
    else:
        $set R3=$(R2)

report:
    needs: attempt_3
    if $(R3|trim) == "":
        ! Endpoint failed after $(MAX_TRIES) attempts.
    else:
        ! Endpoint healthy. Response: $(R3|trim)

default: report
```

**Intent:** what an author has to write when retry-with-backoff isn't a primitive. Manual unroll = ugly + non-parametric (the `MAX_TRIES` var is decorative; the structure hardcodes 3).
**Compile:** clean. The ugliness is the feature signal.

---

## Category C — Compositions

### 5. `morning-brief` — orchestrates three child skills

```
# Skill: morning-brief
# Description: Composes a daily brief by orchestrating three child skills, then emits a unified narrative.
# Status: Approved
# Vars: USER_NAME=Scott
# Triggers: cron: 0 7 * * *

weather:
    $ execute_skill skill_name=disk-watchdog -> DISK_REPORT (fallback: "disk: unknown")

mail:
    $ execute_skill skill_name=mailbox-triage AGENT_ID=perry MAX_ITEMS=10 -> MAIL_REPORT (fallback: "mail: unknown")

calendar:
    # FEATURE-REQUEST: no built-in date/time helper. Want `$(NOW|date:"YYYY-MM-DD")` or a `$ now timezone=...` op.
    @ date +%Y-%m-%d -> TODAY (fallback: "today")

synthesize:
    needs: weather
    needs: mail
    needs: calendar
    ~ prompt="Compose a 3-bullet morning brief for $(USER_NAME) dated $(TODAY|trim). Sources:\nDISK: $(DISK_REPORT)\nMAIL: $(MAIL_REPORT)\nKeep it punchy." model=default maxTokens=300 -> BRIEF

deliver: synthesize
    ! Good morning, $(USER_NAME). Today is $(TODAY|trim).
    ! $(BRIEF|trim)

default: deliver
```

**Intent:** Built-in `$ execute_skill` lets parents orchestrate children without an MCP connector. **Compile:** clean. Surfaces the `$(TODAY|trim)` ambient-date pain point — no date helper.

### 6. `nightly-summary` — inlines a data-skill via `&`

```
# Skill: nightly-summary
# Description: Composes a nightly status memo by inlining the olsen-digest-aside data-skill plus its own LLM pass.
# Status: Approved
# Vars: DATE=today
# Triggers: cron: 0 23 * * *

stats:
    @ wc -l /var/log/olsen.log -> LINES (fallback: "0")

inline_aside:
    needs: stats
    & olsen-digest-aside RUNS=12 SURFACED=88 DEFERRED=3 VERDICT="green" -> ASIDE

compose:
    needs: inline_aside
    ~ prompt="Write a 4-sentence nightly memo for $(DATE). Include this aside verbatim:\n$(ASIDE)\nThen add one forward-looking note based on log volume: $(LINES|trim)." model=default maxTokens=400 -> MEMO

deliver: compose
    ! $(MEMO|trim)

default: deliver
```

**Intent:** show the compile-time `&` data-skill inline.
**Compile:** **fails** — `unknown-skill-reference` on `olsen-digest-aside`. **Behavioral feature request:** `&` is checked against the actual SkillStore at compile time, with no way to mark a forward-reference. Authoring two co-dependent skills means writing them in order and you can't validate the composition until both are committed. Wanted: `& olsen-digest-aside ... (resolve: deferred)` or a compile flag to lint-only.

### 7. `olsen-digest-aside` — the data-skill `nightly-summary` references

```
# Skill: olsen-digest-aside
# Description: Data-skill — emits a one-paragraph human-style aside about Olsen's day. Inlined by other skills.
# Status: Approved
# Type: data
# Vars: RUNS=0, SURFACED=0, DEFERRED=0, VERDICT=neutral

paragraph:
    ! Olsen ran $(RUNS) decomposition passes, surfaced $(SURFACED) atoms,
    ! deferred $(DEFERRED). Net: $(VERDICT).

default: paragraph
```

**Intent:** the inlined fragment — `# Type: data`, called by `&` from #6.
**Compile:** clean (on the second attempt — first attempt without `# Vars:` failed with four `undeclared-var` errors). Worth recording: there's no way for a data-skill to declare "these vars are always passed by the caller, don't require defaults" — every arg has to have a default value or be in `# Requires:`.

---

## Category D — Augmenting delivery to other agents

### 8. `pr-review-augment`

```
# Skill: pr-review-augment
# Description: Pulls recent commit diff, scores risk, augments delivery to reviewer agent with template hooks.
# Status: Approved
# Vars: REPO_PATH=/workspace/repo, SINCE=24h
# Output: prompt-context: reviewer
# Delivery-context: Take a 60-second risk read on this diff. Flag anything with side effects.
# Templates: deep-diff-walkthrough, regression-checklist

snapshot:
    @ git -C $(REPO_PATH) log --since=$(SINCE) --patch -> DIFF (fallback: "")

score: snapshot
    if $(DIFF|length) == "0":
        ! No commits in the last $(SINCE). Nothing to review.
    else:
        ~ prompt="Score risk on this diff (low / medium / high) and give one-sentence rationale: $(DIFF)" model=default maxTokens=200 -> VERDICT
        ! Risk: $(VERDICT|trim)
        ! ---
        ! Diff slice (truncated by length):
        ! $(DIFF)

default: score
```

**Intent:** show off `# Output: prompt-context:`, `# Delivery-context:`, and `# Templates:` working together. **Compile:** clean.

### 9. `handoff-with-context` — research handoff with timeout + OnError

```
# Skill: handoff-with-context
# Description: Hands a research task to a partner agent with full context-augmenting headers + follow-on templates.
# Status: Approved
# Vars: TOPIC, PARTNER=researcher
# Output: prompt-context: researcher
# Delivery-context: We need a 3-source synthesis on $(TOPIC). Mainstream + adversarial + one contrarian.
# Templates: deep-citation-chase, contradiction-finder
# Timeout: 120
# OnError: handoff-fallback

gather_known:
    > mode=fts query="$(TOPIC)" limit=20 -> KNOWN (fallback: "[]")

frame: gather_known
    ~ prompt="In one paragraph, describe what we already know about $(TOPIC) based on these atoms: $(KNOWN). Identify the gap that needs external research." model=default maxTokens=400 -> FRAME

# FEATURE-REQUEST: no way to set per-target output channel. The whole skill routes via top-level `# Output:` only.
# Wanted: `target_name -> output: prompt-context: $(PARTNER)` so a single skill can fan out to different agents.

handoff: frame
    ! TOPIC: $(TOPIC)
    ! WHAT WE KNOW:
    ! $(FRAME|trim)
    ! ---
    ! Please return a structured synthesis with the three viewpoints.

default: handoff
```

**Compile:** **fails** with `Skill references missing fallback skill 'handoff-fallback' in # OnError: header.` Same forward-reference problem as #6.

Also notable: `# Delivery-context:` contains `$(TOPIC)`, and the help docs don't say whether variable substitution happens *into* the delivery-context header before it's transmitted. The renderer didn't get far enough to show me.

---

## Category E — Language stress tests

### 10. `foreach-stress` — nested foreach, set-membership, naive accumulator

```
# Skill: foreach-stress
# Description: Edge-case probe — nested foreach with membership checks and aliased vars.
# Status: Approved
# Vars: TAG=lesson

primary:
    > mode=fts query="domain:$(TAG)" limit=50 -> RECENT (fallback: "[]")

secondary:
    > mode=fts query="domain:related" limit=50 -> RELATED (fallback: "[]")

# Cross-join: emit each RECENT item that has a matching RELATED.author
join:
    needs: primary
    needs: secondary
    $set SEEN_AUTHORS=
    foreach R in $(RECENT):
        foreach A in $(RELATED):
            # FEATURE-REQUEST: no way to reference outer-loop iterator inside a nested foreach without aliasing.
            # Wanted: `if $(R.author) == $(A.author):` should work and does — but membership over a *list* of fields
            # like `if $(A.author) in $(RECENT[].author):` isn't supported.
            if $(R.author) == $(A.author):
                if $(R.author) not in $(SEEN_AUTHORS):
                    ! Match: author=$(R.author) recent=$(R.id) related=$(A.id)
                    # FEATURE-REQUEST: no list-append. Want `$set SEEN_AUTHORS=$(SEEN_AUTHORS)+[$(R.author)]`
                    $set SEEN_AUTHORS=$(R.author)

default: join
```

**Intent:** push the iteration model — nested foreach, in/not-in checks, set-accumulator hack. Two real feature requests inline.
**Compile:** clean. But the runtime semantics are dubious: `$set SEEN_AUTHORS=$(R.author)` *replaces* rather than accumulates, so the `not in` check only works against the most recently seen author. A list-append primitive or `concat` filter would fix this. The `in`/`not in` check against `SEEN_AUTHORS` (a string) is treating it as set membership but the docs don't actually specify the type contract for the right-hand operand.

---

## Bonus — `mailbox-triage` (referenced from #5)

```
# Skill: mailbox-triage
# Description: Pull addressed memories from the mailbox, classify urgency per item, summarize the urgent ones.
# Status: Approved
# Vars: AGENT_ID=perry, MAX_ITEMS=15

fetch:
    > mode=fts query="addressed:$(AGENT_ID)" limit=$(MAX_ITEMS) -> ITEMS (fallback: "[]")

triage: fetch
    $set URGENT_LINES=
    foreach M in $(ITEMS):
        ~ prompt="Reply with just 'urgent' or 'normal'. Item summary: $(M.summary)" model=qwen maxTokens=8 -> VERDICT
        if $(VERDICT|trim) == "urgent":
            # FEATURE-REQUEST: there is no string-append filter or `$set VAR=$(VAR)\n...` accumulator pattern documented.
            # Wanted: $set URGENT_LINES=$(URGENT_LINES)\n- $(M.id): $(M.summary)
            ! URGENT — $(M.id): $(M.summary)

report: triage
    ! Triage complete. See urgent items above.

default: report
```

**Compile:** clean. Same accumulator-shaped gap as #10.

---

## Cross-cutting findings (B-3) — filed as behavior

1. **`-> VAR` on `@`/`$` ops renders as `$(<target>.output)` not `$(VAR)`** in the compiled artifact, even though help docs and lint rules treat `VAR` as the canonical binding. References to `$(VAR)` downstream do *not* fire `undeclared-var`. Either lint is under-strict, the renderer is wrong, or the docs are wrong — pick one.
2. **No date/time primitives.** `$(NOW)` is documented as a tier-1 ambient, but with no formatter you're forced into shelling `date` or asking an LLM to render a timestamp. Want `|date:"format"` filter and/or `$ now format=...`.
3. **No retry/backoff.** `(fallback: "...")` catches one error; multi-attempt logic must be unrolled manually (see #4).
4. **No accumulator primitives.** `$set` replaces; no list-append, no string concat operator. Skills doing iterate-and-collect have to work around it (see #10 and `mailbox-triage`).
5. **Forward references fail at compile.** Both `& other-skill` and `# OnError: other-skill` validate against the SkillStore — no deferred-resolve mode for authoring co-dependent skills before either is committed.
6. **No per-target output routing.** `# Output:` is skill-global; a fan-out skill that emits to two different agents needs two skills (see #9).
7. **Data-skill arg passing requires `# Vars:` with defaults in the data-skill itself.** Caller-supplied args aren't a separate channel from declared vars — they overlay `# Vars:`. A `# Args:` (caller-required) vs `# Vars:` (skill-local) split would document intent better.
8. **`in` / `not in` operand types are under-specified.** The grammar accepts `$(X) in $(Y)` where `Y` is any var — but what does it mean when `Y` is a string? Lint doesn't complain; runtime semantics unclear.

Lint behavior was notably *permissive* — half of these gaps compiled clean even though they expose real runtime hazards. The lint rules catch authoring-time spelling but not the bind-name drift between `@`-op docs and the renderer, which is the kind of bug that would burn a real author.
