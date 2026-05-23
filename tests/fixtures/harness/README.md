# Skillscript Wild-and-Crazy Harness — 2026-05-23

Six fresh sub-agents authored creative Skillscript portfolios against runtime v0.2.9 (live dashboard `192.168.1.64:7878`). The harness was Scott's design: "produce 10 examples that showcase what Skillscript can do; be creative; hallucinated syntax welcome as comments."

## Layout

- `README.md` (this file) — index + consolidated findings + categorized skill list
- `pass-a-1-portfolio.md` — Pass A minion 1 (full Language Reference loaded via AMP)
- `pass-a-2-portfolio.md` — Pass A minion 2
- `pass-a-3-portfolio.md` — Pass A minion 3
- `pass-b-1-portfolio.md` — Pass B minion 1 (help-only, no spec access)
- `pass-b-2-portfolio.md` — Pass B minion 2
- `pass-b-3-portfolio.md` — Pass B minion 3

Each portfolio file contains 10 (sometimes 11) skill sources with the author minion's intent annotation, compile result, and inline feature-request comments. The minions' own cross-cutting findings appear at the bottom of each portfolio.

## Pass A vs Pass B differential

- **Pass A** had full access to the Skillscript Language Reference (rendered from AMP doc atom `50fcecc8`) plus the `help()` tool.
- **Pass B** had only `help()` and other `mcp__skillscript__*` MCP tools — no AMP queries, no spec access.

**Finding:** Pass A surfaces fewer concrete bugs but **deeper architectural feature requests** (boolean connectives, parallel dispatch, structured returns, sort/slice connectors). Pass B surfaces **more concrete parser bugs and lint gaps** that Pass A authors avoided by reading the spec. The combination is more valuable than either alone.

## Frequency-ranked feature requests (across 6 minions)

| # | Request | Frequency |
|---|---|---|
| 1 | **Parallel dispatch / concurrency primitive** | **6/6 unanimous** |
| 2 | **Loop accumulator / mutable `$set` across `foreach`** | **6/6 unanimous** |
| 3 | Forward-reference deferred resolution (`&`, `# OnError:`) | 5/6 |
| 4 | Retry/backoff primitive | 5/6 |
| 5 | Better data primitives (arithmetic, JSON parse, destructuring) | 5/6 |
| 6 | Date/time arithmetic + formatting | 4/6 |
| 7 | `and`/`or` boolean connectives in conditionals | 3/6 |
| 8 | `continue` inside `foreach` | 2/6 |
| 9 | try/catch with typed error filters | 2/6 |
| 10 | Typed result destructuring (`-> {a: A, b: B}`) | 2/6 |
| 11 | Streaming op kinds (`@@` / `~~`) | 1/6 (B-1) |
| 12 | Per-target output routing | 1/6 (B-3) |
| 13 | Utility MCP connector for arithmetic/sort/slice | 1/6 (A-3) |
| 14 | Better diagnostics on unknown grammar keywords | 1/6 (B-1) |

## Real bugs surfaced (multi-observer or concrete repro)

1. **`-> VAR` binding renders as `$(<target>.output)` in compile artifact** — Perry + B-3 + A-1 + A-3 = 4 observers
2. **`# Vars:` parser doesn't escape commas in defaults** (`LOCATION=Asheville,NC` becomes two declarations) — B-2 + A-3
3. **Nested control flow parse-fails** in multiple shapes (if-in-if, foreach-in-if, if-then-sibling-op) — A-1, B-2, A-3
4. **`unsafe-shell-ambiguous-subst` lint fires on documented ambient refs** inside `@ unsafe`, suggests wrong fix — A-3
5. **`@ unsafe` compiles clean even when `unsafe_enabled: false` at runtime** — B-2
6. **`unconfirmed-mutation` keyword list too narrow** — missing `archive` / `prune` / `deploy` / `expire` — A-1 + A-2
7. **`$ execute_skill skill_name=X` doesn't get static `unknown-skill-reference` lint** that `&` would — A-1
8. **Two `@` ops in one target render confusingly** as duplicate "bind output to $(target.output)" lines — A-1
9. **`unsafe-shell-op` lint behavior shape-inconsistent** — A-2 saw warning fire, B-2 didn't (different op shapes; needs reconciliation)
10. **Indent-tracker loses position after closing `else:`** — sibling op at outer indent triggers indent error — A-3

## Categorized skill index

### One-shots / utilities (~11 skills)

- `pass-a-1-portfolio.md` #1 `tide-glance` — NOAA fetch + LLM summarize
- `pass-a-1-portfolio.md` #2 `pre-deploy-gate` — interactive guardrail with `??`
- `pass-a-2-portfolio.md` #1 `morning-brief` — retrieve + summarize + emit
- `pass-a-3-portfolio.md` #2 `mailbox-urgency-triage` — foreach + set-membership
- `pass-b-1-portfolio.md` #1 `tarot-pull` — shell entropy + LLM composition
- `pass-b-1-portfolio.md` #8 `package-bump-wizard` — interactive npm bump
- `pass-b-2-portfolio.md` #5 `signature-block` + `brief-with-signature` — `&` data-skill inline
- `pass-b-3-portfolio.md` #1 `greet-stranger` — minimal LocalModel one-shot
- `pass-b-3-portfolio.md` #2 `ask-then-act` — interactive confirm-then-mutate
- `pass-a-2-portfolio.md` #9 `archive-old-threads` — `??` ask-user gate

### Cron monitors (~12 skills)

- `pass-a-1-portfolio.md` #4 `ham-band-watch` — solar flux ham radio alert (cute)
- `pass-a-2-portfolio.md` #3 `frost-watch` — overnight temp threshold
- `pass-a-2-portfolio.md` #4 `log-anomaly-watch` — unsafe shell + `|length` semantics gap
- `pass-a-3-portfolio.md` #3 `project-fingerprint-drift` — ref-vs-ref equality
- `pass-b-1-portfolio.md` #2 `disk-watch` — threshold alerting
- `pass-b-2-portfolio.md` #1 `morning-weather-greet` — daily greeting with weather
- `pass-b-2-portfolio.md` #2 `pr-drift-watch` — persistent state via /tmp workaround
- `pass-b-2-portfolio.md` #3 `olsen-overnight-distill` — nightly pattern-extractor
- `pass-b-3-portfolio.md` #3 `disk-watchdog` — root partition threshold

### Compositions / orchestrators (~8 skills)

- `pass-a-1-portfolio.md` #6 `morning-brief` — fan-out to 4 sub-skills
- `pass-a-2-portfolio.md` #5 `morning-routine` — DAG composition
- `pass-a-3-portfolio.md` #7 `weekly-status-roll-up` — Friday digest from 3 sub-skills
- `pass-b-1-portfolio.md` #4 `pr-triage-orchestrator` — `$ execute_skill` pipeline
- `pass-b-2-portfolio.md` #4 `drift-detection-orchestrator` — multi-skill fan-in
- `pass-b-3-portfolio.md` #5 `morning-brief` — composes 3 child skills

### Augmenting / Template (delivery to other agents, ~9 skills)

- `pass-a-1-portfolio.md` #8 `olsen-color-from-message` — meta-skill recreating today's color hook
- `pass-a-2-portfolio.md` #8 `ticket-router` — full augmenting delivery
- `pass-a-3-portfolio.md` #4 `session-start-handoff` — session-trigger augmenting
- `pass-a-3-portfolio.md` #5 `bug-triage-template` — Template-kind skill
- `pass-b-1-portfolio.md` #5 `handoff-to-builder` — augmenting feature handoff
- `pass-b-2-portfolio.md` #7 `status-card-augmenter` — git + memory → augment
- `pass-b-3-portfolio.md` #8 `pr-review-augment` — code review delivery
- `pass-b-3-portfolio.md` #9 `handoff-with-context` — research handoff

### Edge-case / feature-request manifestos (the gold for CC testing)

- **`pass-b-1-portfolio.md` #9 `log-fanout-classifier`** — files 3 FRs (parallel:, branch-scope, try/catch) — INTENTIONALLY FAILS COMPILE
- **`pass-b-1-portfolio.md` #10 `streaming-incident-narrator`** — files 4 FRs (`@@`, destructuring, `|json_parse`, `--confirm`) — INTENTIONALLY FAILS COMPILE
- **`pass-a-1-portfolio.md` #5 `schedule-window-router`** — repro of nested-if parse-fail — INTENTIONALLY FAILS COMPILE
- **`pass-a-3-portfolio.md` #10 `backup-rotator`** — repro of `unsafe-shell-ambiguous-subst` false positive
- **`pass-a-2-portfolio.md` #10 `cluster-distill`** — wishlist (parallel foreach, collection ops, retry, destructuring)
- **`pass-b-2-portfolio.md` #10 `feature-request-showcase`** — 8 FRs encoded as comments
- **`pass-b-3-portfolio.md` #10 `foreach-stress`** — nested foreach + accumulator gap repro
- **`pass-a-3-portfolio.md` #9 `olsen-digest-distill`** — wishlist (arithmetic in `$set`, `$sort`, `$slice`, `continue`)

### Data-skills (compile-time inline via `&`)

- `pass-a-2-portfolio.md` #6 `perry-voice-prelude`
- `pass-a-3-portfolio.md` #6 `perry-voice-style-block`
- `pass-b-2-portfolio.md` #5 `signature-block`
- `pass-b-3-portfolio.md` #7 `olsen-digest-aside`
- `pass-a-1-portfolio.md` bonus `doc-section-stitcher` — contains `$` op (interesting — means compile-time inline can dispatch MCP)

### Error handling demos

- `pass-a-3-portfolio.md` #8 `fingerprint-drift-recovery` — uses `$(ERROR_CONTEXT)` ambient
- `pass-b-1-portfolio.md` #7 `fragile-fetch` + `brief-on-error` — `# OnError:` skill-level handler
- `pass-b-3-portfolio.md` #9 `handoff-with-context` — Timeout + OnError stacked

## How to use this collection

For CC bug verification:
1. Pull individual skill sources from the portfolio files (each in a fenced code block).
2. Run through `mcp__skillscript__compile_skill({source: "..."})` to verify the reported bug/behavior.
3. Compare lint output against the minion's reported diagnostics.

For test fixture seeding:
- The edge-case skills are the most valuable — they encode specific bug repros + feature-request signal.
- The composition skills can serve as regression coverage for `$ execute_skill` + `&` op behavior.

For v0.2.10 / v0.3.0 planning:
- See the frequency-ranked table above.
- The full consolidated findings memory is at AMP `b6176e02-fac5-4e02-836a-2468d91deb82`.

## Provenance

- Generated 2026-05-23 ~11:25am EDT
- Runtime: skillscript-runtime v0.2.9
- Sub-agent spawning: `general-purpose` via SDK Agent tool, in parallel, ~3.5-5 min per minion
- Caveat: sub-agents inherited Perry's full MCP namespace and CLAUDE.local.md (per the morning's contamination probe). "Cold" means "cold-instructed" rather than "context-isolated."
