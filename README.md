# Skillscript

> A small declarative language for authoring agent workflows.

**Status: v1 in progress.** The public API, language syntax, and connector contracts will change. No compatibility guarantees until v1.0.0 ships. Expect breakage.

A skillscript is a declarative recipe — a small program with a dependency DAG of named targets, each composed of typed operations. Skills are authored once and executed many times, either by an interpreter (autonomous, cron-fired) or by an agent reading a compiled prompt artifact.

## Three-command first run

```sh
npm install -g skillscript-runtime
skillfile init
skillfile run examples/hello.skill.md
```

That works on cold install — no Ollama, no environment setup. With Ollama running, additional examples demonstrate local-model dispatch.

## Browser dashboard

The runtime ships with a browser dashboard for non-CLI operators — see skills, fire history, trigger configuration, status transitions, connector health. Localhost-only by default; no auth in v1.

```sh
# Local install
skillfile dashboard               # http://localhost:7878

# Via docker-compose (runtime + dashboard colocated)
docker compose up --build
```

The dashboard talks to the runtime via an MCP server contract (JSON-RPC 2.0) — same wire protocol that future MCP clients (Claude Desktop, Cursor, etc.) can use.

## What's in the box

- **`skillfile` CLI** — `init`, `run`, `compile`, `lint`, `list`, `fires`, `diagram`, `sign`/`verify`, `replay`, `health`, `dashboard`.
- **Bundled-default connectors** — filesystem SkillStore, SQLite MemoryStore, Ollama LocalModel, MCP scaffold.
- **Browser dashboard** — five views (overview / skills / triggers / connectors), 30s polling, write paths for status + trigger management.
- **MCP server contract** — JSON-RPC 2.0 over stdio or HTTP; seven tool endpoints wrapping runtime primitives.
- **Container image** — `docker-compose.yml` for one-command local setup.
- **Library exports** — `import { compile, execute, lint, Scheduler, McpServer, DashboardServer } from "skillscript-runtime"` for embedding.

## Docs

The canonical spec lives in `docs/`:

- [`docs/LANGUAGE_REFERENCE.md`](./docs/LANGUAGE_REFERENCE.md) — syntax, ops, lifecycle, connectors
- [`docs/ERD.md`](./docs/ERD.md) — engineering requirements
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — one-page map of which file does what

## License

MIT. See [`LICENSE`](./LICENSE).
