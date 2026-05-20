# Skillscript

> A small declarative language for authoring agent workflows.

**Status: v1 in progress.** The public API, language syntax, and connector contracts will change. No compatibility guarantees until v1.0.0 ships. Expect breakage.

A skillscript is a declarative recipe — a small program with a dependency DAG of named targets, each composed of typed operations. Skills are authored once and executed many times, either by an interpreter (autonomous, cron-fired) or by an agent reading a compiled prompt artifact.

## Three-command first run

```sh
npm install -g skillscript-runtime
skillfile init
skillfile run examples/hello.skill
```

That works on cold install — no Ollama, no environment setup. With Ollama running, additional examples demonstrate local-model dispatch.

## What's in the box

- **`skillfile` CLI** — `init`, `run`, `compile`, `lint`, `list`.
- **Bundled-default connectors** — filesystem SkillStore, SQLite MemoryStore, Ollama LocalModel, MCP scaffold.
- **Container image** — multi-arch, wired in the sample `docker-compose.yml` alongside Ollama and a SQLite volume.
- **Library exports** — `import { compile, execute, lint } from "skillscript-runtime"` for embedding.

## Docs

The canonical spec lives in `docs/`:

- [`docs/LANGUAGE_REFERENCE.md`](./docs/LANGUAGE_REFERENCE.md) — syntax, ops, lifecycle, connectors
- [`docs/ERD.md`](./docs/ERD.md) — engineering requirements
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — one-page map of which file does what

## License

MIT. See [`LICENSE`](./LICENSE).
