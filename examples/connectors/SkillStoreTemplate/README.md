# SkillStoreTemplate — fork-me skeleton

A skeleton `SkillStore` implementation for adopters writing their own. Not runnable; every method throws a `TODO` error. Copy this directory, rename, fill in the substrate-specific work.

Use this when you want skillscript skills backed by:
- A database the bundled impls don't cover (Postgres, MySQL, MongoDB, etc.)
- A vector store (Pinecone, Weaviate, Qdrant)
- A memory system (AMP, hosted memory API)
- An HTTP CRUD service
- Anything else with a query/write interface

## The three legs

```
SkillStore (choose which connector)
   ├── FilesystemSkillStore (bundled, FS-backed — src/connectors/skill-store.ts)
   ├── SqliteSkillStore     (bundled, DB-backed   — src/connectors/sqlite-skill-store.ts)
   └── Your fork from this template
```

The runtime is substrate-agnostic. Skills don't know which backend they're stored against — the contract is the `SkillStore` interface, and any class implementing it works.

## Forking workflow

```bash
cp -r examples/connectors/SkillStoreTemplate examples/connectors/MyDatabaseSkillStore
```

1. **Rename the class.** Convention: `<Substrate>SkillStore` (e.g., `PostgresSkillStore`, `PineconeSkillStore`, `AmpSkillStore`).
2. **Define your config interface.** Edit `SkillStoreTemplateConfig` to declare what your substrate needs (connection URL, API key, vault name, etc.).
3. **Implement each method.** Eight methods + `staticCapabilities()`. Each has a TODO comment in the skeleton explaining what to do.
4. **Update `staticCapabilities()`** to declare what your impl actually supports. The runtime + lint consult these flags before exercising features.
5. **Wire from your adopter bootstrap:**

   ```typescript
   import { Registry } from "skillscript-runtime";
   import { MyDatabaseSkillStore } from "./MyDatabaseSkillStore.js";

   const registry = new Registry();
   registry.registerSkillStore("primary", new MyDatabaseSkillStore({
     // your config
   }));
   ```

6. **Validate via the conformance suite:**

   ```typescript
   import { describe, it } from "vitest";
   import { SkillStoreConformance } from "skillscript-runtime/testing";
   import { MyDatabaseSkillStore } from "./MyDatabaseSkillStore.js";

   describe("MyDatabaseSkillStore conformance", () => {
     const tests = SkillStoreConformance.buildTests({
       build: () => new MyDatabaseSkillStore({ /* test config */ }),
       ctor: MyDatabaseSkillStore,
     });
     for (const t of tests) it(`[${t.category}] ${t.name}`, t.run);
   });
   ```

   The conformance suite verifies your impl honors the contract: method presence, return-type shape, error-class throw conditions, capability flag self-consistency. If it passes, the runtime treats your impl interchangeably with the bundled defaults.

## Reference implementations

When in doubt about semantics, read the bundled impls:

- **`src/connectors/skill-store.ts`** — `FilesystemSkillStore`, filesystem-backed. Skills as `.skill.md` files; version history in a sidecar `.versions.jsonl`. Simplest reference.
- **`src/connectors/sqlite-skill-store.ts`** — `SqliteSkillStore`, SQLite-backed. Two-table schema, transactional status transitions, WAL, JSON-extract tag filter. Closest reference for any database-backed fork.

Both implement the same `SkillStore` interface; the differences are in the substrate-specific code.

## Approval token semantics

The runtime ships an approval-token mechanism so headless MCP-only adopters get a runnable `Approved` state without a dashboard round-trip. When you `store()` or `update_status()` a body declaring `# Status: Approved`, the impl should stamp `# Status: Approved v1:<hex>` automatically.

Helpers from `src/approval.ts`:

```typescript
import { extractStatusFromBody, stampApprovalToken } from "skillscript-runtime";

// In store():
const extracted = extractStatusFromBody(source);
const body = extracted?.status === "Approved" ? stampApprovalToken(source) : source;

// In update_status() — when transitioning TO Approved:
const updated = status === "Approved"
  ? stampApprovalToken(rewriteStatusHeader(source, "Approved"))
  : rewriteStatusHeader(source, status);
```

Both bundled impls follow this pattern; your fork should too unless you're explicitly disabling approval tokens.

## Error classes to throw

From `src/errors.ts`:

- **`SkillNotFoundError(name, implementationName)`** — `load()` / `metadata()` / `versions()` / `update_status()` / `delete()` on a missing skill
- **`VersionNotFoundError(name, version, implementationName)`** — `load(name, version)` where `name` exists but `version` doesn't
- **`StorageConflictError(name, reason, implementationName)`** — `store()` rejects (e.g., name violates substrate constraints)

The `implementationName` is your class name — let cold authors trace errors back to the substrate.

## Schema-level decisions

Document your substrate's particulars in a README alongside your fork:

- **Versioning shape** — full body bytes per version (rich audit), or just hash + status (lightweight)?
- **Delete semantics** — hard-cascade (removes versions) or preserve (audit-grade retention)?
- **Concurrency model** — single-writer, multi-reader (e.g., WAL), or fully concurrent?
- **Tag filter** — indexed lookup, table scan, or unsupported?

These trade-offs are substrate-side; the contract just specifies what each method does, not how.

## Wiring against the CLI / dashboard

Runtime hosts (MCP server + web dashboard) honor whichever SkillStore impl your registry has. To make your fork visible through `skillfile dashboard`:

- Write a custom bootstrap that constructs the runtime with your SkillStore (see `src/bootstrap.ts` for the reference shape + `docs/adopter-playbook.md` for the pattern)
- OR (planned future) declare in `~/.skillscript/connectors.json`:

  ```json
  {
    "substrate": {
      "skill_store": {
        "type": "custom",
        "module": "./my-database-skill-store.js",
        "export": "MyDatabaseSkillStore",
        "config": { "postgresUrl": "${POSTGRES_URL}" }
      }
    }
  }
  ```

  Current limitation: sync `bootstrap()` can't dynamic-import, so the `custom` form surfaces an error today. Programmatic bootstrap is the path until async-bootstrap support lands.

The bundled CLI authoring commands (`skillfile compile`, `skillfile lint`, `skillfile audit`, `skillfile list`) stay filesystem-pinned by design — they're the FS-authoring loop. Adopter-substrate skills are authored via the dashboard UI or the `skill_write` MCP tool.

## Further reading

- **[`docs/configuration.md`](../../../docs/configuration.md)** — substrate selection via `connectors.json`
- **[`docs/sqlite-skill-store.md`](../../../docs/sqlite-skill-store.md)** — the bundled SqliteSkillStore's schema + semantics + forking checklist
- **`src/connectors/types.ts`** — authoritative `SkillStore` interface spec (lines 192-208)
- **`src/testing/conformance.ts`** — the conformance test suite
