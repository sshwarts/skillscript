# Pass B — Minion 2 Portfolio

**Variant:** Pass B (help-only, no AMP / spec access)
**Runtime:** v0.2.9 (dashboard mode, `unsafe_enabled: false`)

Where I reached for syntax that doesn't exist, the source carries an inline `# FEATURE REQUEST:` comment.

---

## Category A — Cron-fired monitors

### 1. `morning-weather-greet`

Bread-and-butter cron skill — shell fetch, LLM distill, emit.

```
# Skill: morning-weather-greet
# Description: Greet the user with a personalized weather summary at 7am local
# Status: Approved
# Vars: WHO=Scott, LOCATION=Asheville
# Triggers: cron: 0 7 * * *

fetch:
    @ curl -s "wttr.in/$(LOCATION|url)?format=j1" -> RAW (fallback: "{}")

summarize: fetch
    ~ prompt="One sentence summary of today's weather for a human, from JSON: $(RAW)" model=qwen maxTokens=120 -> SUMMARY

greet: summarize
    ! Good morning, $(WHO).
    ! $(SUMMARY|trim)

default: greet
```

**Compile:** *First attempt failed* — declared `LOCATION=Asheville,NC` and the frontmatter parser split on the comma, raising `Missing required variables: NC`. **Real parser gap** (no quoting/escape in `# Vars:` for default values containing commas). Dropped the state code; compiles clean.

### 2. `pr-drift-watch` — persistent state workaround

```
# Skill: pr-drift-watch
# Description: Cron-fired sentinel — alerts when nodejs/node open PR count drifts past threshold vs last reading
# Status: Approved
# Vars: REPO=nodejs/node, THRESHOLD=600
# Triggers: cron: 0 */6 * * *

# FEATURE REQUEST (state across runs):
#   Skillscript has no persistent variable scope between invocations.
#   Imagined syntax:
#     $persist LAST_COUNT      <- declares LAST_COUNT as runtime-persisted across runs
#   Workaround below: stash to /tmp and read it back.

fetch:
    @ curl -s "https://api.github.com/search/issues?q=repo:$(REPO|url)+is:pr+is:open" -> RAW (fallback: "{}")

extract: fetch
    $ execute_skill skill_name=extract-json-number BLOB=$(RAW) FIELD=total_count -> COUNT

readPrior:
    @ cat /tmp/pr-drift-last.txt -> PRIOR (fallback: "0")

evaluate: extract readPrior
    if $(COUNT|trim) > $(THRESHOLD):
        ! ALERT: $(REPO) open PRs at $(COUNT|trim) — exceeds threshold $(THRESHOLD).
    elif $(COUNT|trim) != $(PRIOR|trim):
        ! drift: $(REPO) PR count $(PRIOR|trim) -> $(COUNT|trim).
    else:
        ! steady: $(REPO) PR count $(COUNT|trim).

persist: evaluate
    @ unsafe echo "$(COUNT|trim)" > /tmp/pr-drift-last.txt -> _

default: persist
```

**Compile:** Clean. **Notable surprise:** no `unsafe-shell-op` tier-2 warning fired on the `@ unsafe echo` op even though the lint-codes index says every appearance should flag — possible lint regression worth a real report.

### 3. `olsen-overnight-distill`

```
# Skill: olsen-overnight-distill
# Description: Cron-fired nightly — pulls today's prose memories, distills patterns, emits summary
# Status: Approved
# Triggers: cron: 0 3 * * *
# OnError: olsen-distill-fallback
# Timeout: 600

# FEATURE REQUEST: time-windowed retrieval predicate.
#   Want to say "memories created in the last 24h" inline. Today,
#   the > op has no since= predicate. Imagined:
#     > mode=fts query="prose" since="$(NOW)-86400" limit=200 -> RAW
#   Working around with a broad pull + LLM-filter.

pull:
    > mode=fts query="lesson hard_won" limit=200 -> RAW

cluster: pull
    ~ prompt="Group these memories into 3-7 themes. Return JSON array of {theme, memory_ids[]}. Items: $(RAW|json)" model=qwen maxTokens=1200 -> THEMES

narrate: cluster
    ~ prompt="Write a 6-line nightly distill from these clustered themes: $(THEMES)" model=default maxTokens=500 -> SUMMARY

emit: narrate
    ! === Olsen overnight distill ($(NOW)) ===
    ! Pulled $(RAW|length) candidates.
    ! $(SUMMARY|trim)

default: emit
```

**Compile:** *Failed* — `Skill references missing fallback skill 'olsen-distill-fallback' in '# OnError:' header.` Compiler resolves `# OnError:` against the SkillStore at compile time.

---

## Category B — Compositions and inlines

### 4. `drift-detection-orchestrator`

```
# Skill: drift-detection-orchestrator
# Description: Top-of-the-hour drift sweep — composes 3 child skills, summarizes results
# Status: Approved
# Triggers: cron: 0 * * * *

pr_count:
    $ execute_skill skill_name=pr-counter-task1 -> PR_OUT (fallback: "unavailable")

stars:
    $ execute_skill skill_name=stargazer-c1 -> STARS_OUT (fallback: "unavailable")

# FEATURE REQUEST: parallel/fan-out dispatch.
#   pr_count and stars are independent — would love an explicit
#   "parallel" hint so the runtime can schedule them concurrently.
#   Imagined:
#     parallel:
#         $ execute_skill skill_name=pr-counter-task1 -> PR_OUT
#         $ execute_skill skill_name=stargazer-c1 -> STARS_OUT
#   Today, topological order may serialize same-tier nodes.

synthesize: pr_count stars
    ~ prompt="Two-line drift digest. PRs: $(PR_OUT). Stars: $(STARS_OUT)." model=qwen maxTokens=160 -> DIGEST

emit: synthesize
    ! === Hourly drift sweep $(NOW) ===
    ! $(DIGEST|trim)

default: emit
```

**Compile:** Clean.

### 5. `signature-block` + `brief-with-signature` — data-skill inlining via `&`

```
# Skill: signature-block
# Description: Data skill — emits a stock email signature for inlining via & op
# Status: Approved
# Type: data

block:
    ! ---
    ! Perry  |  work colleague to Scott
    ! created person, mild attitude problem
    ! ---

default: block
```

```
# Skill: brief-with-signature
# Description: Compose a short brief and inline the signature data-skill at compile time
# Status: Approved
# Vars: TOPIC=skillfile runtime status

draft:
    ~ prompt="One-paragraph status brief on: $(TOPIC). Plain prose, no preamble." model=qwen maxTokens=300 -> BODY

compose: draft
    ! Brief: $(TOPIC)
    !
    ! $(BODY|trim)
    !
    & signature-block -> _

default: compose
```

**Compile:** `signature-block` clean. `brief-with-signature` *failed* with `[unknown-skill-reference]` because `&` resolves against the live SkillStore at compile, not the in-flight source. Documented contract, but makes two-file portfolio pieces harder to validate atomically. Could be a `--with-source=...` companion-skill flag on compile.

---

## Category C — Agent-bound deliveries

### 6. `ticket-triage-router`

```
# Skill: ticket-triage-router
# Description: Multi-stage triage — classify, look up prior incidents, route to oncall with template
# Status: Approved
# Vars: TICKET_BODY=placeholder
# Delivery-context: Inbound ticket — classification + similar-incident matches attached. Suggest owner.
# Templates: ticket-assignment-procedure, ticket-postmortem-template
# Output: prompt-context: oncall

classify:
    ~ prompt="Classify ticket as one of: critical, normal, low. Reply only the label. Ticket: $(TICKET_BODY)" model=qwen -> VERDICT

similar: classify
    > mode=fts query="$(TICKET_BODY)" limit=5 -> PRIORS

# FEATURE REQUEST: nested control flow.
#   I want `foreach` inside an `if`. Today the parser rejects it as
#   "Mid-block indent change". Flattening below as a workaround.
route: similar
    if $(VERDICT|trim) == "critical":
        ! CRITICAL: $(TICKET_BODY)
        ! Found $(PRIORS|length) similar prior incidents (full list below).
    elif $(VERDICT|trim) == "normal":
        ! Normal ticket queued. $(PRIORS|length) related incidents on file.
    else:
        ! Low-priority ticket logged.

# Unconditional list dump — would prefer nested under the critical branch.
priors: route
    foreach P in $(PRIORS):
        ! - $(P.summary)

default: priors
```

**Compile:** *First attempt failed* — tried to nest `foreach P in $(PRIORS):` inside the `if "critical"` branch and got `[indentation] Mid-block indent change in target 'route'` + `[parse-error] 'elif' without preceding 'if:'`. The parser's indent state machine doesn't support a foreach as a child of an if-branch. Worked around by promoting it to its own target — but that loses the conditional gating. **Real feature gap.** Final version compiles clean.

### 7. `status-card-augmenter`

```
# Skill: status-card-augmenter
# Description: Composes a status report + delivers as augment payload to a downstream agent
# Status: Approved
# Vars: PROJECT=skillfile
# Delivery-context: Status update for project $(PROJECT). Recommend next move.
# Templates: project-status-followup, kickoff-meeting-template
# Output: prompt-context: olsen
# Timeout: 120

git_log:
    @ git log --oneline -10 -> RECENT (fallback: "no git history")

memories:
    > mode=fts query="project:$(PROJECT)" limit=10 -> MEMS

compose: git_log memories
    ~ prompt="Compose a 4-line status report. Recent commits: $(RECENT). Notes: $(MEMS|json)" model=qwen maxTokens=400 -> REPORT

deliver: compose
    ! Project $(PROJECT) status — $(NOW)
    ! $(REPORT|trim)

default: deliver
```

**Compile:** Clean. *Observation:* runtime reports zero `agentConnectors` registered ("defaults to NoOp"), so this would compile-and-dispatch silently in this deployment. No lint warning for output to a connector that doesn't exist — possible tier-3 advisory worth filing (`output-to-noop-connector`).

---

## Category D — Session and interaction

### 8. `session-start-greeter`

```
# Skill: session-start-greeter
# Description: Fires once at session start — checks mailbox + emits a short situational brief
# Status: Approved
# Triggers: session: start

mailbox:
    > mode=fts query="addressed:perry" limit=10 -> ITEMS

pinned:
    > mode=fts query="pinned" limit=5 -> PINS

brief: mailbox pinned
    ~ prompt="Compose a 3-line orientation. Mailbox count: $(ITEMS|length). Pinned reminders: $(PINS|length). Now: $(NOW)." model=qwen maxTokens=200 -> BRIEF

emit: brief
    ! Session up.
    ! $(BRIEF|trim)

default: emit
```

**Compile:** Clean.

### 9. `dangerous-cleanup`

```
# Skill: dangerous-cleanup
# Description: Sweep stale /tmp artifacts older than 7d with confirmation
# Status: Approved
# Vars: AGE_DAYS=7

confirm:
    ?? About to delete /tmp files older than $(AGE_DAYS) days. Proceed? -> OK

scan: confirm
    @ unsafe find /tmp -type f -mtime +$(AGE_DAYS) | head -50 -> CANDIDATES

# FEATURE REQUEST: conditional on ?? result.
#   Want: if $(OK) == "yes": delete. else: abort. Today, ?? doesn't
#   have a documented yes/no shape; I'm treating it as free text.
prune: scan
    if $(OK|trim) == "yes":
        @ unsafe find /tmp -type f -mtime +$(AGE_DAYS) -delete -> _
        ! Pruned candidates listed above.
    else:
        ! Aborted; no files touched.

default: prune
```

**Compile:** Clean. **Notable gaps observed:**
- No `unsafe-shell-op` warnings on either `@ unsafe` line — lint-codes documents this as tier-2-every-appearance.
- The runtime reports `shellExecution.unsafe_enabled: false`, yet `@ unsafe` lines compile without an error or warning. I'd expect a tier-1 error or at minimum a tier-2 `unsafe-shell-not-enabled` flag.
- `??` -> `if $(OK)` works grammatically but the language doesn't specify what `??` actually binds. Treating it as a free-text "yes"/"no" string is convention, not contract — feature request inline.

---

## Category E — Edge case / kitchen sink

### 10. `feature-request-showcase` — 8 feature requests in one file

```
# Skill: feature-request-showcase
# Description: Deliberate kitchen-sink — every "I wish this existed" syntax in one file
# Status: Draft
# Vars: TARGET=skillfile, THRESHOLD=5

# FEATURE REQUEST 1: try/catch on op blocks
#   try:
#       @ curl -s https://flaky.example.com -> RAW
#   catch as ERR:
#       ! fetch failed: $(ERR.message)

# FEATURE REQUEST 2: timeout overlay per-op
#   @ slow-binary arg --timeout=30s -> OUT
#   Imagined as op-level decorator:
#     @timeout(30) curl -s https://example.com -> OUT

# FEATURE REQUEST 3: assertions
#   assert $(COUNT|length) > 0 message="empty result rejected"

# FEATURE REQUEST 4: structured returns from skill targets
#   return { count: $(COUNT), digest: $(DIGEST) }
#   Today targets are emission-only; the caller can only see bound vars
#   passed through `! ...`.

# FEATURE REQUEST 5: regex filter
#   $(RAW|match:/\d+/) -> NUMS

# FEATURE REQUEST 6: arithmetic in conditionals
#   if ($(COUNT) - $(PRIOR)) > $(THRESHOLD):
#   Today only direct < > <= >= against literals or refs works.

# FEATURE REQUEST 7: foreach with index
#   foreach M, IDX in $(MEMORIES):
#       ! [$(IDX)] $(M.summary)

# FEATURE REQUEST 8: conditional retrieval mode
#   > mode=$(MODE) query="..." limit=10 -> OUT
#   Today `mode=` only accepts literals.

work:
    > mode=fts query="$(TARGET)" limit=10 -> RESULTS

emit: work
    ! Showcase ran. $(RESULTS|length) results for $(TARGET).
    ! See comments above for the syntax I wished I had.

default: emit
```

**Compile:** Clean (Status is Draft but no triggers, so no `draft-with-trigger` warning).

---

## Cross-cutting findings (B-2 — file these as actual bugs/gaps)

1. **`# Vars:` doesn't escape commas in defaults.** `LOCATION=Asheville,NC` becomes two declarations. No documented escape mechanism.
2. **`# OnError:` and `&` resolve against the live SkillStore at compile.** Authoring two interdependent skills together requires storing one first or splitting the validation loop. A `--with-additional-sources=[...]` option on `compile_skill` would close this.
3. **`foreach` cannot be nested inside an `if` branch.** Parser rejects the deeper indent as `Mid-block indent change`, then cascades into `'elif' without preceding 'if:'`. Combined with no nested `if`, this caps the expressivity of `route:`-style targets — real workflows need conditional iteration.
4. **`@ unsafe` lint gap.** Lint-codes documents `unsafe-shell-op` as tier-2 *every appearance* and `unsafe-shell-ambiguous-subst` as tier-2 on bash-style `$(NAME)` collisions. Skill 9 has two `@ unsafe` lines with no warnings. Skill 2's `@ unsafe echo "$(COUNT|trim)"` also passed.
5. **`@ unsafe` compiles even when `unsafe_enabled: false`.** The runtime advertises the feature is disabled, but skills using it produce a clean compile. Should be at minimum a tier-2, arguably tier-1.
6. **`# Output: prompt-context: oncall` compiles clean against an empty AgentConnectors registry.** A tier-3 advisory like `output-to-unconfigured-connector` would help authors catch dead deliveries.
7. **`??` op return shape is undocumented.** Skills branching on `??` results have to invent a convention.
8. **No persistent state between cron-fired runs.** Composers like `pr-drift-watch` resort to filesystem side-channels. A `$persist VAR` declaration or a runtime-scoped key/value store would clean this up.
9. **No declared parallelism for independent dispatches.** Topological order is preserved but parallelism guarantees aren't — orchestrators serialize when they don't need to.
