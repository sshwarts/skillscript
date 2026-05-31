# DataStoreTemplate — fork-me skeleton

A skeleton `DataStore` implementation for adopters writing their own. Not runnable; every method throws a `TODO` error. Copy this directory, rename, fill in the substrate-specific work.

Use this when you want skillscript data persistence backed by:
- A vector database (Pinecone, Weaviate, Qdrant, Chroma)
- A data store backing (memory broker like AMP, hosted memory API, vector DB, etc.)
- A different SQL flavor (Postgres + pgvector, MySQL)
- An HTTP CRUD service
- Anything else with query + write semantics

## The three legs

```
DataStore (choose which connector)
   ├── SqliteDataStore (bundled, SQLite + FTS5 — src/connectors/data-store.ts)
   ├── (no other bundled impl — vector DBs and remote services are adopter-side)
   └── Your fork from this template
```

The runtime is substrate-agnostic. Data records don't know which backend they're stored against — the contract is the `DataStore` interface, and any class implementing it works.

## Forking workflow

```bash
cp -r examples/connectors/DataStoreTemplate examples/connectors/MyDataStore
```

1. **Rename the class.** Convention: `<Substrate>DataStore` (e.g., `PineconeDataStore`, `PostgresDataStore`, `AmpDataStore`).
2. **Define your config interface.** Edit `DataStoreTemplateConfig` to declare what your substrate needs (connection URL, API key, vault name, index name, etc.).
3. **Implement each method.** Three methods + `staticCapabilities()`. Each has a TODO comment in the skeleton explaining what to do.
4. **Update `staticCapabilities()`** to declare what your impl actually supports. The runtime + lint consult these flags before exercising features.
5. **Wire from your adopter bootstrap:**

   ```typescript
   import { Registry } from "skillscript-runtime";
   import { MyDataStore } from "./MyDataStore.js";

   const registry = new Registry();
   registry.registerDataStore("primary", new MyDataStore({
     // your config
   }));
   ```

6. **Validate via the conformance suite:**

   ```typescript
   import { describe, it } from "vitest";
   import { DataStoreConformance } from "skillscript-runtime/testing";
   import { MyDataStore } from "./MyDataStore.js";

   describe("MyDataStore conformance", () => {
     const tests = DataStoreConformance.buildTests({
       build: () => new MyDataStore({ /* test config */ }),
       ctor: MyDataStore,
     });
     for (const t of tests) it(`[${t.category}] ${t.name}`, t.run);
   });
   ```

   The conformance suite verifies your impl honors the contract: method presence, return-type shape, capability flag self-consistency. Passes → runtime treats your impl interchangeably with `SqliteDataStore`.

## Reference implementation

When in doubt about semantics, read the bundled impl:

- **`src/connectors/data-store.ts`** — `SqliteDataStore`, SQLite + FTS5-backed. Schema lives in `bootstrap()` (memories table + FTS virtual table + AFTER INSERT/UPDATE/DELETE triggers). Single-process. Capability flags: `supports_writes: true`, `supports_tag_filter: true`, FTS only (semantic / rerank false).

## Contract surface (3 methods)

The DataStore contract is narrower than SkillStore. Three methods + `staticCapabilities()`:

| Method | What it does | When called |
|---|---|---|
| `query(filters)` | Read records by mode + filter; return `PortableData[]` | Every `$ data_read mode=... query=...` op |
| `write(entry)` | Persist a new record; return `{id, created_at}` | Every `$ data_write content=... -> R` op + `data_write` skill notify routes |
| `manifest()` | Capability snapshot for `runtime_capabilities` discovery | At startup + on-demand from MCP clients |

Per the curated-subset framing in `src/connectors/types.ts`, `PortableData` has a 4-tier field model:

1. **Core fields** — `id`, `summary`, `detail`, `score` (always-meaningful)
2. **Curated substrate subset** — top-level fields with portable concepts: `domain_tags`, `payload_type`, `knowledge_type`, `pinned`, `confidence`, `thread_status`, `recipients`, `expires_at`, `agent_id`, `vault`
3. **Substrate-specific** — accessed via `metadata.X` (catch-all)
4. **Ambient passthrough** — literal `$(MEMORY.field)` references for unknowns

**Connector duplication discipline**: a curated-subset field must be at top-level only, never also in `metadata`. Silent divergence otherwise.

## Query modes

`QueryFilters.mode` is the dispatch axis:

- **`"fts"`** — full-text search; substrate-defined (BM25, BM25F, etc.). `SqliteDataStore` supports this via FTS5.
- **`"semantic"`** — embedding-based similarity. Vector-DB substrates support this; `SqliteDataStore` does not.
- **`"rerank"`** — substrate-defined hybrid (e.g., FTS retrieve + embedding rerank). Optional.
- **substrate-specific strings** — your fork can define its own modes; document them in `manifest().manifest.supported_modes`.

Throw a clear error on unsupported modes (don't silently fall back; cold authors will be confused).

## Filter fields

`QueryFilters` extends a base shape with arbitrary additional filter keys. Common filters substrates honor:

- **`domain_tags`** — string or array; substrate-specific match semantics (substring vs exact; AND vs OR)
- **`payload_type`** — usually exact match
- **`thread_status`** — usually exact match (set if your substrate has thread lifecycle)
- **`pinned`** — boolean
- **`agent_id`** — adopter-side scoping
- **`recipients`** — array match (any-of)

Honor what your substrate supports; ignore the rest. Document the supported set in `manifest().manifest.supported_filters`.

## `write()` semantics

The `DataWrite` shape:

- **`content`** (required) — the record body
- **`tags`** (optional) — routed to your substrate's tag mechanism
- **`recipients`** (optional) — advisory hint; substrates with alerting (e.g., AMP's mailbox model) use it
- **`expires_at`** (optional) — unix seconds; substrates with TTL honor it
- **`metadata`** (optional) — catch-all for substrate extensions (`vault`, `payload_type`, `confidence`, etc.)

Return `{id, created_at}` — the substrate-assigned identifier + creation timestamp (unix seconds).

If your substrate doesn't support writes (read-only store like a search index over a static corpus), set `supports_writes: false` in `staticCapabilities()` and throw from `write()`. The runtime + lint will respect the flag.

## Wiring against the dashboard / MCP

Runtime hosts honor whichever DataStore impl your registry has. To make your fork visible through `skillfile dashboard`:

- Write a custom bootstrap that constructs the runtime with your DataStore (see `src/bootstrap.ts` for the reference shape)
- OR (planned future) declare in `~/.skillscript/connectors.json`:

  ```json
  {
    "substrate": {
      "data_store": {
        "type": "custom",
        "module": "./my-data-store.js",
        "export": "MyDataStore",
        "config": { "pineconeApiKey": "${PINECONE_KEY}" }
      }
    }
  }
  ```

  Current limitation: sync `bootstrap()` can't dynamic-import, so the `custom` form surfaces an error today. Programmatic bootstrap is the path until async-bootstrap support lands.

## DataStore vs SkillStore differences

Both are substrate-agnostic, but they differ in shape:

| Aspect | SkillStore | DataStore |
|---|---|---|
| Methods | 8 (load, query, metadata, versions, store, delete, update_status, manifest) | 3 (query, write, manifest) |
| Versioning | First-class (`versions()`, `load(name, version)`) | Substrate-side (e.g., `supersededById` in AMP); not in contract |
| Status lifecycle | Draft/Approved/Disabled with approval-token stamping | None |
| Mutation gates | Approved transitions require approval token | None — writes are append-only |
| Curated-subset fields | None | Many (`domain_tags`, `pinned`, `confidence`, `recipients`, etc.) |
| Forking complexity | Higher (multi-method state machine) | Lower (three methods, simpler semantics) |

The narrower contract is why DataStoreTemplate ships sooner + smaller than SkillStoreTemplate.

## Further reading

- **[`../../../docs/configuration.md`](../../../docs/configuration.md)** — substrate selection via `connectors.json`
- **[`../../../docs/adopter-playbook.md`](../../../docs/adopter-playbook.md)** — programmatic-bootstrap patterns; two-instance posture
- **`src/connectors/types.ts`** — authoritative `DataStore` interface, `PortableData`, `QueryFilters`, `DataWrite` types
- **`src/testing/conformance.ts`** — the per-contract conformance test suites
- **`src/connectors/data-store.ts`** — `SqliteDataStore` reference impl + schema
