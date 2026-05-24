# Architecture

One-page map of the `skillscript-runtime` codebase. Per ERD §1, the *narrow core* (parser + compile + runtime + lint + connectors/) stays under the nudged LOC ceiling — currently 5650, tracked by `scripts/loc-ceiling.mjs` with full history in that file's header comment. Auxiliary surface (CLI, dashboard, MCP server, scheduler, observability) is reported but doesn't gate the build. Tests count separately.

## Top-level layout

```
src/
  index.ts              — library entrypoint; named exports for embedders
  cli.ts                — `skillfile` CLI entrypoint
  parser.ts             — source text → AST (NARROW CORE)
  compile.ts            — AST → resolved skill model → rendered artifact (NARROW CORE; owns toposort)
  filters.ts            — pipe-filter implementations (NARROW CORE via connectors/; see notes)
  lint.ts               — structural validation (NARROW CORE)
  runtime.ts            — executor: walks compiled artifact, dispatches ops (NARROW CORE)
  composition.ts        — `$ execute_skill` + `& invoke` runtime dispatch (v0.2.8)
  version.ts            — single-source RUNTIME_VERSION from package.json (v0.2.12)
  help-content.ts       — `help({topic})` MCP tool content
  errors.ts             — OpError class hierarchy + structured runtime errors
  provenance.ts         — ProvenanceBlock + content_hash recording (Phase 3)
  scheduler.ts          — trigger registry + cron scan + EVENT.* ambient population
  audit.ts              — `skillfile audit` recompile-staleness detector
  trace.ts              — TraceBuilder + on-disk trace store
  metrics.ts            — health-metrics aggregator
  skill-manager.ts      — high-level skill lifecycle helpers
  bootstrap.ts          — wires everything: SkillStore + Registry + MCP server + dashboard
  mcp-server.ts         — JSON-RPC 2.0 MCP server (13 tools)
  connectors/           — NARROW CORE
    types.ts            — contracts: SkillStore, MemoryStore, LocalModel, McpConnector
    agent.ts            — AgentConnector contract (Augmenting/Template delivery)
    agent-noop.ts       — default AgentConnector (no-op delivery)
    registry.ts         — per-kind instance registry + three-layer resolution
    skill-store.ts      — bundled default: filesystem at $SKILLSCRIPT_HOME/skills/
    memory-store.ts     — bundled default: SQLite + FTS at $SKILLSCRIPT_HOME/memory.db
    local-model.ts      — bundled default: Ollama at localhost:11434
    mcp.ts              — bundled default: stub; no servers wired by default
    config.ts           — connectors.json loader (v0.4.0+): parse + validate + ${ENV}/env-block-as-scope substitution + closed-set class registry + gitignore-detection (v0.4.1)
    mcp-remote.ts       — RemoteMcpConnector (v0.4.1): child-process spawn + JSON-RPC stdio framing (lsp + newline) + initialize handshake + tool dispatch + lifecycle
    index.ts            — barrel re-exports
  dashboard/            — Vite SPA + dashboard HTTP server (v0.2.7)
  testing/              — test-only helpers shipped with the package
```

Narrow-core LOC history (nudges driven by language extensions):
- 5000 (T7 baseline) → 5100 (v0.2.10 parser robustness) → 5200 (v0.2.12 lint coverage) → 5400 (v0.3.0 `$append` accumulator) → 5500 (v0.3.1 forward-reference deferred resolution) → 5650 (v0.3.2 and/or/not + filter chain + `|json_parse`) → 5700 (v0.3.3 `$ json_parse` op + lint advisory + Bug D parser-recovery; `|json_parse` filter removed) → 5750 (v0.3.4 conditional multi-filter chain + parse-error dedup + unified sink-scope recovery) → 6000 (v0.4.0 connectors.json loader + closed-set class registry + two new lint rules + credential discipline) → 6600 (v0.4.1 RemoteMcpConnector + allowed_tools allowlist + env-block-as-scope + framing config + gitignore-detect + lint auto-wire + foreach-over-parsed-JSON + kwarg coercion)

## What each narrow-core file owns

| File | Responsibility |
| --- | --- |
| `parser.ts` | Tokenize and parse skill source. Header lines, target blocks, op grammar (`!`/`$`/`$set`/`$append`/`?`/`@`/`>`/`~`/`&`/`??`), `if`/`elif`/`else`/`foreach`, compound conditions (`and`/`or`/`not` + parens since v0.3.2). Produces AST. Recursive structural decomposition for compound conditions in `validateCondition`. Syntax errors only — semantic checks downstream. |
| `compile.ts` | Three subsystems: (1) variable resolution against `# Requires:` cascade + caller inputs; (2) data-skill compile-time inlining; (3) topo-sort + render. Output formats: `prompt` (canonical), `prose`. Forward-reference deferral for missing `&` targets (v0.3.1). Produces compiled artifact + provenance sidecar. |
| `filters.ts` | Pipe-filter implementations dispatched by `$(NAME\|filter)` syntax. v1 set: `url`, `shell`, `json`, `trim`, `length`. (`json_parse` was a v0.3.2 addition removed in v0.3.3 — use the `$ json_parse $(VAR) -> OUT` op instead, which binds structured shape.) Adding a new filter = adding a case to `applyFilter` + registering in `KNOWN_FILTERS` + documenting in `help-content.ts`. |
| `lint.ts` | Structured diagnostics across 3 tiers. ~30 rules covering parse errors, var resolution, condition grammar, composition refs (`unknown-skill-reference` demoted to tier-2 in v0.3.1 with tier-3 `deferred-skill-reference` advisory), shell safety (`unsafe-shell-op`, `unsafe-shell-disabled`, `unsafe-shell-ambiguous-subst`), mutation safety (`unconfirmed-mutation`), accumulator safety (v0.3.0 `uninitialized-append`, `foreach-local-accumulator-target`, `append-to-non-list`), retrieval-arg validation, credential leak detection. |
| `runtime.ts` | Executor that walks the compiled artifact and dispatches ops through connector instances. Owns `evalCondition` (compound + leaf shapes), `substituteRuntime` (filter-chain aware since v0.3.2), `resolveRef` (dotted + indexed field access). Handles error propagation, per-op timeout chain, `foreach` iteration with loop-local scope, target-level `else:` error handler, `# OnError:` skill fallback, mechanical-mode placeholders. |
| `connectors/*` | The integration boundary — every external system (skill storage, memory, local model, MCP, agent delivery) plugs in through one of the typed contracts. Registry handles multi-instance + three-layer resolution: per-call override > skill-declared > primary default. |

## Auxiliary surface (outside narrow core)

| File | Responsibility |
| --- | --- |
| `cli.ts` | `skillfile` CLI entrypoint. Commands: `init`, `execute` (since v0.2.11; `run` alias dropped v0.2.12), `compile`, `audit`, `lint`, `list`, `fires`, `diagram`, `sign`, `verify`, `replay`, `health`, `serve`, `dashboard`. Per-command `--help`. Version from `src/version.ts`. |
| `mcp-server.ts` | JSON-RPC 2.0 MCP server exposing 13 tools: `skill_list/metadata/status/write`, `list/register/unregister_trigger`, `health_metrics`, `runtime_capabilities`, `lint_skill`, `compile_skill`, `execute_skill`, `help`. Rolled-by-hand JSON-RPC handler (no `@modelcontextprotocol/sdk` dependency). |
| `composition.ts` | In-skill composition primitive runtime. `$ execute_skill` intercept + recursion-depth guard (default 10). Distinct from data-skill `&` inlining which is compile-time. |
| `scheduler.ts` | Trigger registry + cron firing + EVENT.* ambient auto-population (`fired_at`, `fired_at_unix`, `fired_at_plus_{1h,1d,7d}_unix`). Status-aware: skips Draft/Disabled at fire time. Persistent trigger registry on disk (v0.2.7). |
| `bootstrap.ts` | Top-level wiring: takes `{skillsDir, traceDir, enableUnsafeShell?}` → returns `{registry, skillStore, scheduler, mcpServer, ...}`. The integration test entry point. |
| `dashboard/` | Vite SPA + Express HTTP server. Skill list + status + trace viewer. Mounted under `/` when `skillfile dashboard` runs; serve-headless mode (`skillfile serve`) omits the SPA. |
| `audit.ts` | `skillfile audit <provenance.json>` — detects stale compiled artifacts when source data-skills have been re-stored since compile. |
| `trace.ts` | TraceBuilder + FilesystemTraceStore. Records per-op timing, dispatch, error chain. |
| `metrics.ts` | Aggregates trace data into `health_metrics` MCP response (request counts, op latencies, error rates). |
| `help-content.ts` | Static markdown content for the `help({topic})` MCP tool. Topics: `ops`, `frontmatter`, `examples`, `composition`, `connectors`, `lint-codes`. |
| `version.ts` | Reads `package.json` at module load to single-source the runtime version (added v0.2.12 after a missed bump exposed the triple-source duplication). |

## Non-source

```
docs/                   — spec docs (ERD, Language Reference, README)
examples/               — bundled example skills (5 worked examples, see help({topic:"examples"}))
scripts/loc-ceiling.mjs — CI check; fails if narrow core exceeds budget. Header has full nudge history.
tests/                  — vitest specs (39 files, 829 passing)
tests/fixtures/harness/ — 66 cold-author skills + classified manifest (regression corpus)
.github/workflows/      — CI: release.yml fires on tag push → test → GHCR multi-arch + GitHub Release + npm publish
Dockerfile              — multi-arch (linux/amd64 + linux/arm64) image base
```

## CI pipeline (release.yml)

Tag push (`vX.Y.Z`) → typecheck → loc-check → build → full vitest → version verify (tag matches package.json) → Docker Buildx multi-arch GHCR push → GitHub Release with CHANGELOG section as body → npm publish.

Required secret: `NPM_TOKEN` (granular access token with **Bypass two-factor authentication when publishing** enabled). Token requirement documented in memory `feedback_npm_publish_2fa`. Resolved end-to-end at v0.3.1 after the chronic v0.2.5–v0.2.12 failure pattern (root cause: secret missing, then set without bypass-2FA flag).

## Build + dev

- `pnpm install --frozen-lockfile` — install deps
- `pnpm run build` — `tsc -p tsconfig.build.json` + copy dashboard SPA assets to `dist/`
- `pnpm exec vitest run` — full suite
- `pnpm run loc-check` — narrow-core ceiling check (CI gate)
- `node dist/cli.js dashboard --host 0.0.0.0 --port 7878` — local dashboard
- `node dist/cli.js execute <skill>` — run a skill end-to-end
- `node dist/cli.js compile <skill>` — render compiled artifact without executing

ESM-only. Node 22+ required (`node:sqlite`). pnpm 11.
