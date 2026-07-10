---
title: SqliteSkillStore
description: "Worked example of SkillStore against a SQLite database — schema, semantics, forking checklist."
mode: wide
---

Worked example of `SkillStore` against a SQLite database. Copy this directory into your codebase, customize per your storage needs, register with skillscript-runtime's `Registry`. This README is written for the agent implementing your adopter's connector — including the human reviewing the PR.

**What this demonstrates**: the locked SkillStore contract surface (8 methods + `staticCapabilities`) wired through real SQL with two-table versioning, transactional status transitions, and JSON-extract tag filters.

---

## The three-leg model

SkillStore is pluggable. Three legs ship out of the box, but the third is the open one:

```
SkillStore (choose which connector)
   ├── FilesystemSkillStore (bundled, FS-backed)
   ├── SqliteSkillStore     (this example, DB-backed)
   └── Adopter-custom        (you write your own)
```

If your substrate is Pinecone, S3, Postgres, Redis, or anything else, write a `class FooSkillStore implements SkillStore { ... }` and call `registry.registerSkillStore("primary", new FooSkillStore(...))`. The runtime is none the wiser.

This SqliteSkillStore is one such impl — useful as a copy-paste starting point, or directly usable if your needs match.

---

## Quick start

```typescript
import { Registry } from "skillscript-runtime";
import { SqliteSkillStore } from "./SqliteSkillStore.js";

const registry = new Registry();
registry.registerSkillStore("primary", new SqliteSkillStore({ dbPath: "skills.db" }));

// Wire the rest of the runtime (scheduler, mcpServer) using the registry.
```

Author skills programmatically:

```typescript
const store = registry.getSkillStore("primary");
await store.store("morning-status", `# Skill: morning-status
# Status: Approved
t:
    emit(text="report status")
default: t
`);
```

Or via the dashboard, or via `skill_write` MCP tool — same backend, same result.

---

## When to use SqliteSkillStore (and when not)

**Use it when**:

- You're embedding skillscript-runtime as a library and want skills in a database rather than `.skill.md` files
- Your deployment has no persistent filesystem (container-only) but does have SQLite
- You need richer query semantics than filesystem listing (tag filters, transactional status transitions)

**Don't use it when**:

- You're using the bundled CLI (`skillfile compile`, `skillfile lint`, `skillfile list`). The CLI is filesystem-first by design — `vim foo.skill.md && skillfile lint foo` is the natural authoring loop. The CLI does NOT use SqliteSkillStore. Sqlite-backed skills are authored via dashboard or `skill_write` MCP tool.
- Your skills are authored as files-on-disk and committed to git as part of the source tree. FilesystemSkillStore is the right choice there.

This is "first-class" in the **programmatic-embedding** sense, not the CLI sense. Treat the example as a substrate-portability proof point + a copy-paste starting point.

---

## Schema

Two tables:

```sql
CREATE TABLE skills (
  name TEXT PRIMARY KEY,
  current_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,                  -- 'Draft' | 'Approved' | 'Disabled'
  source TEXT NOT NULL,                  -- the .skill.md body bytes
  description TEXT,                      -- extracted from `# Description:` header
  metadata_json TEXT,                    -- optional metadata bag (tags, author, etc.)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status_changed_at INTEGER
);

CREATE TABLE skill_versions (
  name TEXT NOT NULL,
  version TEXT NOT NULL,                 -- short hash (12 chars)
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL,                  -- full body, preserved per version
  status TEXT NOT NULL,
  previous_status TEXT,                  -- populated by update_status
  changed_at INTEGER NOT NULL,
  changed_by TEXT,
  PRIMARY KEY (name, version)
);
```

`skills` is the fast-path read for `load()` / `metadata()` / `query()`. `skill_versions` is the append-only history for `versions()` — and unlike FilesystemSkillStore, it preserves full body bytes per version, so `load(name, version)` can return historical content.

WAL is enabled at bootstrap so concurrent readers don't block writers.

---

## Footgun guard: `delete()` is hard-cascade

**`delete()` removes both the `skills` row AND its `skill_versions` rows.** If you need recovery, back up adopter-side BEFORE calling delete. Skill names can be reused after delete (no orphan history left behind).

This is the locked semantic. If your adopter substrate has compliance requirements (audit-grade retention) or you hit a "wait, I deleted that" moment, the upgrade path is soft-delete (tombstone `status='Deleted'` + filter from query results) — but that's an adopter-side choice; the bundled SqliteSkillStore stays hard-cascade.

---

## Feature flags

`staticCapabilities()` declares:

| Feature | Value | What it means |
|---|---|---|
| `supports_writes` | ✓ | `store()` / `update_status()` / `delete()` mutate state |
| `supports_versioning` | ✓ | `versions()` returns history; `load(name, version)` returns historical bytes |
| `supports_tag_filter` | ✓ | `query({ tag: "foo" })` works via `json_extract(metadata_json, '$.tags')` (O(n) scan) |
| `supports_audit_trail` | ✓ | `update_status()` populates `previous_status` on every transition |
| `supports_atomic_status_transitions` | ✓ | UPDATE skills + INSERT skill_versions wrapped in a transaction |

The atomic transitions are the SQL advantage over FilesystemSkillStore (which declares `supports_atomic_status_transitions: false` because filesystem writes can tear between body rewrite + sidecar append).

---

## Authoring loop

SqliteSkillStore is the storage layer. Authoring happens above:

- **Dashboard**: visit `http://localhost:7878`, create/edit skills through the UI; dashboard writes via `skill_write` MCP tool → SqliteSkillStore
- **MCP tool**: agents call `skill_write` directly; same path as the dashboard
- **Programmatic**: your code calls `store.store(name, source, metadata?)` directly

The dashboard defaults to FilesystemSkillStore. For a SqliteSkillStore-backed dashboard, set `substrate.skill_store: "sqlite"` in `connectors.json` — both `skillfile dashboard` and the programmatic `bootstrapFromEnv()` honor it; no custom bootstrap needed.

---

## Approval — the store doesn't mint it

`SqliteSkillStore.store()` persists the body as handed to it; it does **not** stamp or verify approval. That's the runtime's concern, and it differs by mode:

- **Unsecured mode** — a bare `# Status: Approved` is sufficient and is stored verbatim, no token.
- **Secured mode** — approval is a v3 Ed25519 signature applied by the **approve flow** (`skillfile approve` / the dashboard), never by `store()`. The MCP `skill_write` handler forces any unsigned `Approved` write to `Draft` before it reaches the store, and the bundled stores apply the same force as defense-in-depth (in both `store()` and `update_status()`). So `store()` only ever persists a genuinely-signed Approved body or a Draft.

The same holds for a fork: your `store()` neither stamps nor verifies — persist the body, let the runtime own the gate. See [Adopter Playbook](adopter-playbook.md) §"Approval + secured mode".

---

## Forking checklist

When forking into your codebase:

1. Rename the class (e.g., `PostgresSkillStore`, `RedisSkillStore`)
2. Replace the SQL with your substrate's API (HTTP, DataStore, vector DB, etc.)
3. Update `staticCapabilities()` to match what your substrate actually supports — drop `supports_versioning` if you can't track history, drop `supports_tag_filter` if querying tags isn't tractable
4. Update `manifest()` to describe your substrate (`kind: "postgres"` or whatever)
5. **Optional but high-value for network-backed forks: implement `version()`** — a cheap store-wide change-token computed WITHOUT loading bodies (a list ETag, max-revision, or metadata digest), where any add/remove/edit/status-change moves it. It lets `skill_list` skip its N+1 catalog rebuild on unchanged polls (each entry otherwise costs a `load()` — one network round-trip per skill against a remote store). `SqliteSkillStore` hashes `(name, status, current_version)` in one body-free query. Skip it and `skill_list` just always rebuilds.
6. Tests: copy `tests/SqliteSkillStore.test.ts` as a starting point + run the conformance suite (`SkillStoreConformance.buildTests()` from `skillscript-runtime/testing`)

The conformance suite catches drift from the contract surface. If your fork passes, the runtime treats it interchangeably with FilesystemSkillStore / SqliteSkillStore / etc.
