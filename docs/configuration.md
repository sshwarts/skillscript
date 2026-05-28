# Configuration

How to configure a skillscript-runtime deployment.

The single config file is **`~/.skillscript/connectors.json`** (or any path passed via `--connectors`). It has two top-level concerns:

1. **`substrate`** — which `SkillStore`, `MemoryStore`, and `LocalModel` the runtime hosts (MCP server + web dashboard) use. (v0.10+)
2. **Named MCP connector instances** — `youtrack`, `github`, etc. — invoked via `$ <name>` in skill source. (v0.4.0+)

The runtime loads `connectors.json` at startup. Missing file → graceful empty config (substrate defaults to filesystem skills + conditional sqlite memories; no MCP connectors). Malformed JSON or unknown fields → structured errors surfaced at bootstrap.

---

## Quick start

A typical out-of-the-box `~/.skillscript/connectors.json`:

```json
{
  "substrate": {
    "skill_store": "filesystem",
    "memory_store": "sqlite",
    "local_model": null
  }
}
```

Equivalent to omitting the file entirely — these are the v0.10 base config defaults.

To switch skills storage to SQLite:

```json
{
  "substrate": {
    "skill_store": "sqlite"
  }
}
```

Restart `skillfile dashboard` (or `skillfile serve`). The MCP server + dashboard UI now read/write skills from `~/.skillscript/skills/skills.db` instead of `.skill.md` files.

---

## The substrate section

Singleton substrate connectors. Each slot accepts one of four shapes:

### Short form — bare string

```json
"skill_store": "sqlite"
```

Wires the bundled implementation for that type with default config (e.g., dbPath under `~/.skillscript/`).

Valid short-form values per slot:

| Slot | Values |
|---|---|
| `skill_store` | `"filesystem"` \| `"sqlite"` |
| `memory_store` | `"sqlite"` |
| `local_model` | `"ollama"` |

### Null — explicit "no substrate"

```json
"local_model": null
```

The runtime doesn't register a connector for this slot. Useful for explicitly disabling LocalModel when nothing local is available.

### Object form — override defaults

```json
"skill_store": {
  "type": "sqlite",
  "config": {
    "dbPath": "/var/skillscript/skills.db"
  }
}
```

`type` picks the bundled impl; `config` is passed to its constructor. Per-type config fields:

| Type | Config fields |
|---|---|
| `filesystem` (skill_store) | none — uses the CLI's `skillsDir` |
| `sqlite` (skill_store) | `dbPath` (default: `<skillsDir>/skills.db`) |
| `sqlite` (memory_store) | `dbPath` (default: CLI's `MEMORY_DB` or `<skillsDir>/memories.db`) |
| `ollama` (local_model) | `baseUrl` (default: `OLLAMA_BASE_URL` env or `http://localhost:11434`), `defaultModelTag` (default: `gemma2:9b`) |

### Custom form — adopter-written impl

```json
"skill_store": {
  "type": "custom",
  "module": "./my-amp-skill-store.js",
  "export": "AmpSkillStore",
  "config": {
    "vault": "team"
  }
}
```

References an adopter-written class implementing the relevant contract. `module` is the path to the JS file; `export` is the named export (defaults to `default`); `config` is passed to the constructor.

> **v0.10 limitation**: sync `bootstrap()` can't dynamic-import. Custom-via-connectors.json surfaces a clear error and falls back to the default. Adopters wanting custom impls today write a programmatic bootstrap that calls `registry.registerSkillStore("primary", new AmpSkillStore(...))` directly — same pattern as the runtime's reference `bootstrap()`. Async-bootstrap with dynamic-import support is planned for a follow-up.

---

## Precedence

When multiple config sources speak:

1. **Programmatic opts** (`opts.skillStore` passed to `bootstrap()`) — explicit, highest priority
2. **`connectors.json` substrate section** — declarative, deployment-durable
3. **Built-in default** — fallback (filesystem skill_store; conditional sqlite memory_store; no local_model)

If two configs disagree, the higher-priority one wins; lower-priority is ignored without error.

---

## Which surfaces honor substrate config?

| Surface | Honors substrate? | Reasoning |
|---|---|---|
| **MCP server** (`skillfile serve`, dashboard `/rpc`) | ✓ | MCP is the agent-facing surface; must read/write whichever store the deployment chose |
| **Web dashboard** (`skillfile dashboard`) | ✓ | Same as MCP — agents and humans connect to the same runtime |
| **Programmatic embed** (your own bootstrap) | ✓ | You pass `opts.skillStore` directly; the runtime takes whatever |
| `skillfile compile` | ✗ filesystem-only | Authoring loop: `vim foo.skill.md && skillfile compile foo`. Only coherent against FS. |
| `skillfile lint` | ✗ filesystem-only | Same as compile. |
| `skillfile audit` | ✗ filesystem-only | Operates on a provenance file + the FS-authored source. |
| `skillfile list` | ✗ filesystem-only | Filesystem listing of `.skill.md` files. |

The four authoring CLI commands stay FS-pinned by design — they're the filesystem-first authoring loop. Sqlite-backed skills are authored via the dashboard UI or the `skill_write` MCP tool, not these CLI commands.

---

## Named MCP connector instances

Per-host MCP connector wiring. Each top-level key (other than `substrate`) defines a named connector referenced via `$ <name>` in skill source.

```json
{
  "substrate": { "skill_store": "sqlite" },

  "youtrack": {
    "class": "RemoteMcpConnector",
    "config": {
      "command": "npx",
      "args": ["mcp-remote", "https://example.youtrack.cloud/mcp"],
      "env": { "AUTH_HEADER": "Bearer ${YOUTRACK_TOKEN}" }
    }
  },

  "github": {
    "class": "RemoteMcpConnector",
    "config": { /* ... */ },
    "allowed_tools": ["search_repos", "get_issue"]
  }
}
```

Each entry needs:

- **`class`** — a class from the closed-set registry. Today: `RemoteMcpConnector` (stdio-bridged remote MCP). Adopters can register custom classes via `registerConnectorClass()` from their bootstrap.
- **`config`** — passed to the class's `fromConfig()` factory. Schema is class-specific.
- **`allowed_tools`** (optional) — per-connector tool allowlist. `undefined` = allow all; `[]` = allow none; listed array = exactly those.

### Credential discipline

`connectors.json` is secret-bearing. The repo `.gitignore` excludes it by default; `connectors.json.example` (not real values) is committed as a template. For deployments, prefer `${VAR}` env-var substitution over literals — commit the `${...}` references; keep secrets in deployment environment.

Skillscript warns at bootstrap if `connectors.json` lives in a git-tracked directory without a `.gitignore` entry.

### `${VAR}` substitution

```json
"env": { "AUTH_HEADER": "Bearer ${YOUTRACK_TOKEN}" }
```

`${NAME}` resolves from `process.env` at load time. Missing env var → clear startup error (not silent empty string).

The `config.env` block is itself resolved first, then merged into the substitution scope for the rest of the config — letting you compose values:

```json
"config": {
  "env": { "AUTH_HEADER": "Bearer ${YOUTRACK_TOKEN}" },
  "args": ["--header", "Authorization:${AUTH_HEADER}"]
}
```

This matches the Claude Desktop `mcp.json` convention.

### Inline comments

Underscore-prefixed top-level keys (`_comment`, `_note_security`, etc.) are ignored by the parser. Use them inline to document your config without external comments — the JSON spec doesn't natively support comments, so the runtime treats `_*` keys as the convention.

```json
{
  "_comment": "Last edited 2026-05-28 — switched skill_store to sqlite for AMP-style dogfooding",
  "substrate": { "skill_store": "sqlite" }
}
```

---

## Adopter-custom substrate impls

Write `class FooSkillStore implements SkillStore { ... }` (or MemoryStore, LocalModel). Wire it via either:

**(a) Programmatic bootstrap (recommended today)** — write your own bootstrap script that constructs the registry directly:

```typescript
import { Registry, McpServer, Scheduler } from "skillscript-runtime";
import { FooSkillStore } from "./foo-skill-store.js";

const registry = new Registry();
registry.registerSkillStore("primary", new FooSkillStore({ /* config */ }));
// ... register other substrates, then construct Scheduler + McpServer + DashboardServer
```

See [`docs/adopter-playbook.md`](adopter-playbook.md) for the full pattern.

**(b) `connectors.json` custom form** (deferred to follow-up):

```json
"skill_store": {
  "type": "custom",
  "module": "./foo-skill-store.js",
  "export": "FooSkillStore",
  "config": { ... }
}
```

Currently surfaces an error and falls back to the default — sync `bootstrap()` can't dynamic-import. Track the async-bootstrap promotion as future work.

---

## Operational tips

### Switching substrates without losing data

The substrate switch is a runtime wiring change, not a data migration. Switching from `filesystem` to `sqlite` doesn't move your `.skill.md` files into the Sqlite db automatically — the dashboard will show an empty skill list because the new Sqlite db is fresh.

To preserve your skills across a switch:

1. Read each `.skill.md` file from `~/.skillscript/skills/` (or your `skillsDir`)
2. Call `skill_write` MCP tool (or `store.store(name, source)` programmatically) to land them in the new substrate

A bundled migration tool isn't shipped — different adopters want different things (rename normalization, metadata enrichment, dry-run safety).

### Multi-instance posture

Running both a dev instance (filesystem) and an adopter instance (sqlite or custom) side by side is common for v0.10+ deployments. Use separate `--port` + `--connectors` paths:

```bash
# Dev — filesystem skills, port 7878
skillfile dashboard --host 127.0.0.1 --port 7878

# Adopter — sqlite skills, port 7879
skillfile dashboard --host 127.0.0.1 --port 7879 --connectors ~/.skillscript/adopter-connectors.json
```

See [`docs/adopter-playbook.md`](adopter-playbook.md) § "Two-instance posture" for the broader pattern.

### Verifying which substrate is wired

After a config change + restart, verify via `runtime_capabilities`:

```bash
curl -s -X POST http://localhost:7878/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"runtime_capabilities","arguments":{"include":["skillStores"]}}}' | jq
```

Output includes the wired SkillStore's `implementation` field (`FilesystemSkillStore` or `SqliteSkillStore`).
