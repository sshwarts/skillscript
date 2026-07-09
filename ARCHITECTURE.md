# Architecture

One-page map of the `skillscript-runtime` codebase. The *narrow core* (parser + compile + runtime + lint + connectors/) stays under a nudged LOC ceiling — currently **12300** across fewer than 23 files, enforced by `scripts/loc-ceiling.mjs` (the full nudge history, one line per feature-driven bump, lives in that file's header comment). Auxiliary surface (CLI, dashboard, MCP server, scheduler, observability, config loaders) is reported but doesn't gate the build. Tests count separately.

## Top-level layout

```
src/
  index.ts              — library entrypoint; named exports for embedders
  cli.ts                — `skillfile` CLI entrypoint
  parser.ts             — source text → AST (NARROW CORE)
  compile.ts            — AST → resolved skill model → rendered artifact (NARROW CORE; owns toposort)
  filters.ts            — pipe-filter implementations (rides with the core language; not in the gated CORE_PATHS)
  lint.ts               — structural validation (NARROW CORE)
  runtime.ts            — executor: walks compiled artifact, dispatches ops (NARROW CORE)
  composition.ts        — runtime skill composition: `$ execute_skill` intercept + recursion guard
  dispatch-validate.ts  — shared qualified-dispatch validator (lint + runtime both call it)
  mutation-gate.ts      — non-interactive mutation authorization (# Autonomous / approved=)
  approval.ts           — approval gate: status semantics + secured-mode Ed25519 sign/verify
  safe-path.ts          — filesystem path allowlist: canonicalize (realpath) + under-root check
  secrets.ts            — `{{secret.NAME}}` use-only references: SecretProvider + marker machinery
  skill-surface.ts      — effectful-footprint extractor (skill_preflight + dashboard approver checklist)
  skill-catalog.ts      — buildSkillCatalog: SkillStore metadata + parsed source → SkillCatalog
  skill-dependents.ts   — static reverse-dependency scan (which skills reference X; feeds `skillfile delete`)
  observed-shape.ts     — observed output-shape capture for `$ conn.tool` results (keys + types, not values)
  errors.ts             — OpError class hierarchy + structured runtime errors
  provenance.ts         — ProvenanceBlock + content_hash recording
  scheduler.ts          — trigger registry + cron scan + /event dispatch + EVENT.* ambient population
  audit.ts              — `skillfile audit` recompile-staleness detector
  trace.ts              — TraceBuilder + on-disk trace store
  metrics.ts            — health-metrics aggregator
  skill-manager.ts      — high-level skill lifecycle helpers
  runtime-config.ts     — skillscript.config.json loader + ${ENV} substitution
  runtime-env-resolver.ts — SKILLSCRIPT_* env-var resolution + precedence
  dotenv-loader.ts      — .env file parsing
  sqlite-warning-suppress.ts — silences the node:sqlite experimental warning
  help-content.ts       — `help({topic})` MCP tool content + server-delivered instructions
  version.ts            — single-source RUNTIME_VERSION from package.json
  bootstrap.ts          — wires everything: substrates + Registry + Scheduler + MCP server + dashboard
  bootstrap-from-env.ts — bootstrapFromEnv(): one blessed embedder entry that wires exactly like the CLI
  mcp-server.ts         — JSON-RPC 2.0 MCP server (17 tools)
  connectors/           — NARROW CORE
    types.ts            — contracts: SkillStore, DataStore, LocalModel, McpConnector, AgentConnector
    agent.ts            — AgentConnector contract (augment/template delivery + wake)
    agent-noop.ts       — default AgentConnector (no-op delivery)
    registry.ts         — per-kind instance registry + three-layer resolution
    skill-store.ts      — bundled default: filesystem at $SKILLSCRIPT_HOME/skills/
    sqlite-skill-store.ts — bundled SQLite SkillStore (two-table versioned)
    skill-store-mcp.ts  — SkillStore → MCP-surface bridge
    data-store.ts       — bundled SQLite + FTS DataStore at $SKILLSCRIPT_HOME/data.db
    data-store-mcp.ts   — DataStore → `$ data_read` bridge (filter-scope enforced)
    filter-enforcement.ts — supported_filters validation → UnsupportedFilterError
    local-model.ts      — bundled default: Ollama at localhost:11434
    local-model-mcp.ts  — LocalModel → `$ llm` bridge
    mcp.ts              — bundled stub McpConnector (no servers wired by default)
    mcp-remote.ts       — RemoteMcpConnector: stdio child-process MCP (lsp + newline framing)
    http-mcp.ts         — HttpMcpConnector: direct Streamable HTTP MCP + identity propagation
    config.ts           — connectors.json loader: parse + validate + ${ENV}/env-block-as-scope + closed-set class registry + gitignore-detect
    index.ts            — barrel re-exports
  dashboard/            — Vite SPA + dashboard HTTP server (also hosts /rpc + /event + approval routes)
  testing/              — test-only helpers (conformance suites) shipped with the package
```

## What each core-language file owns

| File | Responsibility |
| --- | --- |
| `parser.ts` | Tokenize and parse skill source. Header lines, target blocks, the canonical op grammar — `$ <connector>` dispatch, `$set`/`$append` mutations, function-call intrinsics (`emit`/`shell`/`file_read`/`file_write`/`notify`/`inline`/`execute_skill`), `if`/`elif`/`else`/`foreach`, compound conditions (`and`/`or`/`not` + parens). Legacy sigil forms (`!`, `@`, `>`, `~`, `&`, `?`, `??`) are still recognized for back-compat and precise migration diagnostics. Produces AST; syntax errors only — semantic checks downstream. Never-throws-on-bad-input is a structural commitment (depth-cap + length-cap + non-backtracking regex). |
| `compile.ts` | Three subsystems: (1) variable resolution against the `# Requires:` cascade + caller inputs; (2) data-skill compile-time inlining; (3) topo-sort + render. Output formats: `prompt` (canonical), `prose`. Forward-reference deferral for missing composition references. Produces compiled artifact + provenance sidecar. |
| `filters.ts` | Pipe-filter implementations dispatched by `${NAME\|filter}` syntax: `url`, `shell`, `json`, `trim`, `length`, `isodate`, `contains:`, `fallback:`, and the chain machinery. Adding a filter = a case in `applyFilter` + registration in `KNOWN_FILTERS` + a `help-content.ts` entry. (Structured JSON parsing is the `$ json_parse … -> OUT` op, not a filter.) |
| `lint.ts` | Structured diagnostics across 3 tiers (~77 rules): parse errors, var resolution, condition grammar, composition refs, shell safety (`unsafe-shell-op`, `unsafe-shell-disabled`, quote-trap), mutation safety (`unconfirmed-mutation`), secret hygiene (`secret-use-only`, `secret-undeclared`, `secret-dynamic-name`, `credential-in-args`), accumulator safety, dispatch-shape (`connector-as-tool`, `disallowed-tool`, `unknown-tool-on-connector`), retrieval-arg validation. Lint is local advisory; the runtime is authoritative. |
| `runtime.ts` | Executor that walks the compiled artifact and dispatches ops through connector instances. Owns `evalCondition`, filter-chain-aware `substituteRuntime`, `resolveRef` (dotted + indexed). Handles error propagation, per-op timeout chain, `foreach` loop-local scope, op-level `(fallback:)` containment (uniform across every fallible op — dispatch errors, empty results, and raised throws all degrade to the fallback, reason recorded in `fallbacks[]`), target-level `else:` recovery, secret sink resolution (mask → substitute → gate → splice; values never bind to vars or land in traces), mechanical-mode previews, and the secured-mode effect gate (refuses effectful ops when `effectsAuthorized !== true`). |
| `connectors/*` | The integration boundary — every external system (skill storage, data, local model, MCP tools, agent delivery) plugs in through one typed contract. Registry handles multi-instance + three-layer resolution: per-call override > skill-declared > primary default. Bridges (`*-mcp.ts`) surface typed contracts as canonical `$`-dispatch. |

## Auxiliary surface (outside narrow core)

| File | Responsibility |
| --- | --- |
| `cli.ts` | `skillfile` CLI. Commands: `init`, `execute`, `compile`, `audit`, `lint`, `list`, `fires`, `diagram`, `approve`, `reapprove`, `delete`, `shell-audit`, `sign`, `verify`, `replay`, `health`, `serve`, `dashboard`. Per-command `--help`; version from `version.ts`. |
| `mcp-server.ts` | JSON-RPC 2.0 MCP server, 17 tools: `skill_list` / `skill_preflight` / `skill_read` / `skill_status` / `skill_write`, `data_read`, `list_` / `register_` / `unregister_trigger` / `set_trigger_enabled`, `lint_skill`, `compile_skill`, `execute_skill`, `runtime_capabilities`, `health_metrics`, `blocked_shell_attempts`, `help`. Rolled-by-hand JSON-RPC handler (no `@modelcontextprotocol/sdk` dependency). Hosts the secured-mode approval closure (forces unsigned-Approved writes to Draft regardless of substrate). |
| `approval.ts` | The approval boundary. Draft/Approved/Disabled status gate (both modes); secured mode adds asymmetric Ed25519 signing — private key signs at approve-time, public key verifies on every execution. `evaluateApprovalGate`, `stampApprovalEd25519`, `setSecuredMode`. |
| `secrets.ts` | `{{secret.NAME}}` use-only references. `SecretProvider` contract + bundled `EnvSecretProvider` (`SKILLSCRIPT_SECRET_*`); author-template-only marker masking/splicing so a secret resolves only at a sink (`shell` / `$` dispatch) and never from data. Declared via `# Requires: secret.NAME`; redacted from every error and trace. |
| `composition.ts` | In-skill composition runtime. `$ execute_skill` intercept + recursion-depth guard (default 10). Distinct from compile-time inlining. |
| `scheduler.ts` | Trigger registry + cron firing + `/event` dispatch + EVENT.* ambient auto-population. Both cron and event funnel through one `dispatchSkill` that re-verifies the approval signature before minting `effectsAuthorized`. |
| `mutation-gate.ts` | Authorizes mutation ops (`$ data_write` / `$ skill_write` / `file_write` / mutating MCP tools) in non-interactive contexts via `# Autonomous: true` or per-op `approved="reason"`. |
| `safe-path.ts` | Filesystem path allowlist: realpath-canonicalizes target + roots before the under-root check, so `..` and symlink escapes can't pass. Default-deny. |
| `skill-surface.ts` | AST-walks a parsed skill into its effectful footprint (connectors / builtins / shell binaries / file-write / file-read / unsafe-shell / notify / secrets). Feeds `skill_preflight`, every `skill_list` entry, and the dashboard's "what this skill touches" approver checklist. |
| `skill-dependents.ts` | Best-effort static reverse-dependency scan: which stored skills literally reference a target via `execute_skill` / `inline`. Guards `skillfile delete`. |
| `observed-shape.ts` | Records the shape (keys + types, never values) of what a `$ conn.tool` dispatch returns under approval — feeds connector discovery. |
| `bootstrap.ts` / `bootstrap-from-env.ts` | Top-level wiring: resolves config + env → constructs substrates, Registry, Scheduler, MCP server, dashboard. `bootstrapFromEnv()` is the blessed embedder entry that wires exactly the way `skillfile dashboard` / `serve` does. |
| `dashboard/` | Vite SPA + HTTP server. Skill list / status / trace viewer + the approval queue (review signals + footprint; in-browser passcode signing when armed). Hosts `/rpc`, `/event`, and the approval routes; `skillfile serve` runs headless (no SPA). |
| `audit.ts` | `skillfile audit` — detects stale compiled artifacts when source data-skills changed since compile. |
| `trace.ts` / `metrics.ts` | TraceBuilder + FilesystemTraceStore (per-op timing, dispatch, error chain) → aggregated into the `health_metrics` response. |
| `runtime-config.ts` / `runtime-env-resolver.ts` / `dotenv-loader.ts` | Config resolution: `skillscript.config.json` + `${ENV}` substitution, `SKILLSCRIPT_*` precedence, `.env` parsing. |
| `help-content.ts` / `version.ts` | `help({topic})` content (7 topics incl. `error-handling`) + the server-delivered usage instructions; single-sourced runtime version from `package.json`. |

## Non-source

```
docs/                   — adopter docs: playbook, agent guide, configuration, connector contracts,
                          language reference, SQLite skill store, docs index
examples/               — worked example skills (examples/skillscripts/), onboarding scaffold,
                          custom-bootstrap + programmatic-trace walkthroughs, and a full example
                          connector (examples/connectors/HttpWebhookAgentConnector, with its own spec)
scripts/loc-ceiling.mjs — CI check; fails if narrow core exceeds budget. Header carries the full nudge history.
tests/                  — vitest specs (~2,230 tests across 175 files, incl. the example-connector spec
                          and the examples-corpus guard)
.github/workflows/      — ci.yml (typecheck + tests on push/PR to main) + release.yml (fires on tag push)
Dockerfile              — multi-arch (linux/amd64 + linux/arm64) image base
```

## CI pipeline (release.yml)

Tag push (`vX.Y.Z`) → typecheck → loc-check → build → full vitest → version verify (tag matches `package.json`) → **npm publish** → GitHub Release (CHANGELOG section as body) → **multi-arch GHCR container build** (best-effort, `continue-on-error` + timeout). npm publish runs *before* the container build so a slow/hung container job can't block the package shipping.

Required secret: `NPM_TOKEN` (granular access token with **Bypass two-factor authentication when publishing** enabled). A pushed tag is the only trigger; never run `npm publish` by hand.

## Build + dev

- `pnpm install --frozen-lockfile` — install deps
- `pnpm run build` — `tsc -p tsconfig.build.json` + copy dashboard SPA assets to `dist/` + published-paths check
- `pnpm exec vitest run` — full suite
- `pnpm run loc-check` — narrow-core ceiling check (CI gate)
- `node dist/cli.js dashboard --host 0.0.0.0 --port 7878` — local dashboard
- `node dist/cli.js execute <skill>` — run a skill end-to-end
- `node dist/cli.js compile <skill>` — render compiled artifact without executing

ESM-only. Node 22+ required (`node:sqlite`). pnpm 11.
