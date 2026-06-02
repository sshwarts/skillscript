# Examples

Curated production-quality skills demonstrating distinct language patterns. The `.skill.md` files live in [`skillscripts/`](./skillscripts/); each compiles + lints clean and can be run directly via `skillfile run examples/skillscripts/<name>.skill.md` (some require connectors — see the per-skill notes below).

For full language semantics, see [`../docs/language-reference.md`](../docs/language-reference.md).

| Example | Patterns demonstrated |
|---|---|
| [`hello-world.skill.md`](./skillscripts/hello-world.skill.md) | Phase 1 cold-adopter probe — no substrate; `# Vars:` + `--input` override; baseline runtime check |
| [`skill-store-roundtrip.skill.md`](./skillscripts/skill-store-roundtrip.skill.md) | Phase 1 cold-adopter probe — Lisp-shape `$ skill_write` + `$ skill_read`; child lands as Draft per bridge trust boundary |
| [`data-store-roundtrip.skill.md`](./skillscripts/data-store-roundtrip.skill.md) | Phase 1 cold-adopter probe — `$ data_write` + `$ data_read` FTS round-trip |
| [`morning-brief.skill.md`](./skillscripts/morning-brief.skill.md) | Multi-target with `needs:`; cron-fired with `EVENT.fired_at_*`; `# OnError:` fallback; dual `# Output:` (slack + prompt-context); `# Requires:` user-var cascade with fallback; LocalModel + retrieval composition |
| [`doc-qa-with-citations.skill.md`](./skillscripts/doc-qa-with-citations.skill.md) | Single-target retrieval; `(fallback: [])` op-level fallback; LLM-with-citation pattern; pipe filter `\|json` for prompt embedding |
| [`classify-support-ticket.skill.md`](./skillscripts/classify-support-ticket.skill.md) | `if`/`elif`/`else` multi-branch routing; classifier-cascade pattern; DataStore `$` writes with structured `domain_tags`; `$set` literal binding |
| [`service-health-watch.skill.md`](./skillscripts/service-health-watch.skill.md) | `foreach` iteration; cron-fired with `expires_at=$(EVENT.fired_at_plus_1d_unix)` TTL math; classifier-gated DataStore writes; pipe filter `\|url` for path-safe interpolation |
| [`feedback-sentiment-scan.skill.md`](./skillscripts/feedback-sentiment-scan.skill.md) | `in` / `not in` set-membership ops; dedupe-via-seen-markers idiom; nested `if`/`elif` classification cascade; TTL on bookkeeping writes |

## Connector requirements

Most examples assume the bundled-default connectors:

- `hello-world.skill.md` — zero deps (runs cold)
- `doc-qa-with-citations.skill.md` — Ollama (LocalModel) + DataStore for the retrieval cache
- `morning-brief.skill.md`, `feedback-sentiment-scan.skill.md` — Ollama + DataStore + a calendar MCP connector (the `$ calendar.list_events` op)
- `classify-support-ticket.skill.md` — Ollama + DataStore
- `cut-release-tag.skill.md` — git CLI on `PATH`; expects to run inside a git repo
- `service-health-watch.skill.md` — `curl` on `PATH`; network egress to `status.internal/*`

Skills that talk to MCP tools (like `calendar.list_events`) need that tool wired into the `Registry` via `registerMcpConnector()`. The `CallbackMcpConnector` in `skillscript-runtime/connectors` lets you stub one inline for development.

## Running an example

```sh
# Cold install — no Ollama, no MCP, no external state
skillfile run examples/skillscripts/hello-world.skill.md

# With overrides
skillfile run examples/skillscripts/hello-world.skill.md --input WHO=Scott

# Preview the compiled artifact without execution
skillfile compile examples/skillscripts/hello-world.skill.md

# Mechanical preview — $/~/> ops short-circuit (useful for examining flow
# without firing real LLM calls)
skillfile run examples/skillscripts/morning-brief.skill.md --mechanical

# Render the control-flow graph
skillfile diagram examples/skillscripts/cut-release-tag.skill.md
```

## Programmatic example

`programmatic-trace-demo.mjs` shows the library API path — wiring a `FilesystemSkillStore` + `FilesystemTraceStore` + `Scheduler`, dispatching a skill, and reading back the recorded trace + per-skill health metrics.

```sh
node examples/programmatic-trace-demo.mjs
```
