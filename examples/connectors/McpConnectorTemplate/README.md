# McpConnectorTemplate — fork-me skeleton

A skeleton `McpConnector` implementation for adopters writing their own. Not runnable; every method throws a `TODO` error. Copy this directory, rename, fill in the substrate-specific work.

**Most adopters don't need this template.** Bundled impls already cover the common cases:

| Bundled impl | What it covers |
|---|---|
| `HttpMcpConnector` | Speaks Streamable HTTP MCP (JSON-RPC over HTTP + SSE) directly — no subprocess. Works against any compliant HTTP MCP server (Anthropic's hosted MCP, GitHub MCP, Linear MCP, etc.). JSON-configurable via `connectors.json`. |
| `RemoteMcpConnector` | Stdio bridging to remote MCP servers (`npx mcp-remote ...`). For MCPs distributed as binaries you spawn (YouTrack, GitHub, Linear when run locally) or HTTP MCPs that need an HTTPS-to-stdio adapter. JSON-configurable. |
| `CallbackMcpConnector` | Wraps a JS function. Test rigs + embedder-wired transports where the dispatch is local code. |
| `LocalModelMcpConnector` | Bridges a registered `LocalModel` as `$ llm prompt=...`. Auto-wired when `substrate.local_model` is set. |
| `DataStoreMcpConnector` | Bridges a registered `DataStore` as `$ data_read mode=...` + `$ data_write content=...`. Auto-wired when `substrate.data_store` is set. |
| `SkillStoreMcpConnector` (v0.15.0) | Bridges a registered `SkillStore` as in-skill `$ skill_write` + `$ skill_read` dispatch (Lisp-shape: skills program skills). Auto-wired against `substrate.skill_store`. In-skill writes are forced to `# Status: Draft` at the bridge per the v0.15.0 trust boundary. |

**Fork this template only when none of those fit** — e.g.:

- WebSocket MCP
- In-process MCP (call methods directly without IPC)
- Custom transport that doesn't match stdio framing or Streamable HTTP
- Cross-thread / worker-pool dispatch
- An HTTP MCP server that diverges from the spec (custom auth handshake, non-SSE response framing, tool-name normalization, etc.) in ways `HttpMcpConnector` doesn't expose

If you're trying to wire a remote stdio MCP server like YouTrack or GitHub run locally, **you want `RemoteMcpConnector` in `connectors.json`**, not this template. See `connectors.json.example` for the wiring pattern.

If you're trying to wire a Streamable HTTP MCP server (Anthropic's hosted MCP, GitHub MCP via HTTPS, etc.), **declare an `HttpMcpConnector` instance in `connectors.json`** — no subprocess, no implementation. See `docs/adopter-playbook.md` §Case 2 path (b) for the full shape.

## Forking workflow

```bash
cp -r examples/connectors/McpConnectorTemplate examples/connectors/MyMcpConnector
```

1. **Rename the class.** Convention: `<Transport>McpConnector` (e.g., `HttpMcpConnector`, `WebSocketMcpConnector`, `InProcessMcpConnector`).
2. **Define your config interface.** Edit `McpConnectorTemplateConfig` to declare what your transport needs (URL, auth, timeouts, etc.).
3. **Implement `call()`** — translate `(toolName, args)` to your transport's wire format; dispatch; return the result.
4. **Implement `manifest()`** — return transport metadata for `runtime_capabilities` discovery.
5. **Update `staticCapabilities()`** to declare what your impl supports.
6. **(Optional) Implement `staticTools()`** — return the closed-set list of tools your connector exposes if static; lint validates `$ name.tool` against this list. Return `null` (or omit) if the surface is runtime-discovered.
7. **Wire from your adopter bootstrap:**

   ```typescript
   import { Registry } from "skillscript-runtime";
   import { MyMcpConnector } from "./MyMcpConnector.js";

   const registry = new Registry();
   registry.registerMcpConnector("mytool", new MyMcpConnector({ /* config */ }));
   ```

8. **(Optional) For `connectors.json` JSON-instantiability** — add a static `fromConfig(config)` factory + register the class via `registerConnectorClass()`:

   ```typescript
   import { registerConnectorClass } from "skillscript-runtime/connectors";

   registerConnectorClass("MyMcpConnector", {
     ctor: MyMcpConnector,
     fromConfig: (cfg) => MyMcpConnector.fromConfig(cfg),
   });
   ```

   Call this BEFORE `loadConnectorsConfig` runs in your bootstrap. Then adopters can declare instances in `connectors.json`:

   ```json
   {
     "myinstance": {
       "class": "MyMcpConnector",
       "config": { "endpoint": "https://...", "authToken": "${MY_TOKEN}" }
     }
   }
   ```

## Reference implementations

The bundled impls are the canonical reference:

- **`src/connectors/mcp-remote.ts`** — `RemoteMcpConnector`. Most comprehensive: stdio framing (LSP and newline), child process lifecycle (spawn → initialize → tools/list cache → SIGTERM/SIGKILL on dispose), `fromConfig` factory with strict validation, per-message timeout discipline. The closest reference for any transport that needs robust lifecycle management.
- **`src/connectors/mcp.ts`** — `CallbackMcpConnector`. Minimal reference: 60 LOC. The closest reference for embedder-wired transports.

When in doubt, read both + the bridge classes (`local-model-mcp.ts`, `data-store-mcp.ts`) for how single-substrate bridges work.

## Contract surface (2 methods)

McpConnector is the narrowest of the five contracts:

| Method | What it does | When called |
|---|---|---|
| `call(toolName, args, ctx?)` | Dispatch a tool call to your transport | Every `$ <connector> ...` op |
| `manifest()` | Transport metadata for discovery | At startup + on-demand from MCP clients |

Plus `staticCapabilities()` (required static) and `staticTools()` (optional static).

### `call()` semantics

- **`toolName`** — the tool the caller wants:
  - `$ youtrack.search_issues query="..."` → `toolName = "search_issues"`
  - `$ youtrack query="..."` (bare form) → `toolName` is the *unqualified op name* (typically the connector's auto-routing target)
- **`args`** — kwargs from the skill source as a plain object
- **`ctxOverrides`** — optional identity propagation (`agentId`, `isAdmin`). Connectors that support identity-propagation thread these to upstream
- **Return** — whatever the upstream MCP returns. Skills bind via `-> R`; if the return shape isn't statically discoverable, lint emits a tier-3 advisory when callers descend (`$(R.field)`)

On dispatch failure, **throw** — the runtime's op-level `(fallback: ...)` machinery handles it cleanly. Don't return error envelopes silently; the v0.5.0+ contract surfaces inner-tool errors via throw.

### `staticTools()` lint integration

If your connector exposes a known closed set of tools (e.g., a JIRA wrapper that only exposes `search_issues`, `get_issue`, `create_issue`), implementing `staticTools()` lets lint validate `$ name.tool` references at authoring time:

```typescript
static staticTools(): string[] {
  return ["search_issues", "get_issue", "create_issue"];
}
```

Skills that write `$ jira.unknown_tool ...` fail lint with `unknown-tool-on-connector` (tier-1 error).

If your surface is runtime-discovered (e.g., `RemoteMcpConnector` wrapping an arbitrary upstream MCP), return `null` or omit the method. Lint emits a tier-3 advisory on dotted dispatch instead of green-lighting.

## Wiring against the dashboard / MCP

Runtime hosts (MCP server + web dashboard) honor whichever McpConnector instances your registry has. There's no `substrate` slot for McpConnector — that's intentional, because McpConnector is intrinsically *instanced* (you'll have multiple: `youtrack`, `github`, `jira`, ...) not singleton.

Two registration paths:

- **Programmatic** (your bootstrap):
  ```typescript
  registry.registerMcpConnector("youtrack", new RemoteMcpConnector({ command: "npx", args: ["mcp-remote", "..."] }));
  registry.registerMcpConnector("github", new RemoteMcpConnector({ ... }));
  ```
- **Declarative** (`connectors.json`):
  ```json
  {
    "youtrack": { "class": "RemoteMcpConnector", "config": { "command": "npx", ... } },
    "github":   { "class": "RemoteMcpConnector", "config": { ... } }
  }
  ```

The declarative path is the canonical adopter pattern for stdio-bridged remote MCPs. Your fork is for transports the declarative path can't express.

## McpConnector vs. SkillStore / DataStore differences

| Aspect | McpConnector | SkillStore / DataStore |
|---|---|---|
| Methods | 2 (call, manifest) | 3-8 (more state machine) |
| Cardinality | Many instances per deployment | One singleton per slot |
| Substrate config | Per-instance via top-level keys | `substrate` section short/object/custom |
| Class extensibility | `registerConnectorClass()` for adopter-custom classes | Programmatic bootstrap (or `substrate.skill_store: {type: "custom", ...}` once async-bootstrap lands) |
| Auto-wired bridges | `llm` + `data_read` + `data_write` + `skill_read` + `skill_write` (v0.15.0 — LocalModel + DataStore + SkillStore exposed via bridge connectors) | n/a (these ARE the substrates being bridged) |

McpConnector is fundamentally the "dispatch to external tools" surface — narrowest contract, broadest range of impls.

## Further reading

- **[`../../../docs/configuration.md`](../../../docs/configuration.md)** — `connectors.json` wiring (substrate + named MCP instances)
- **[`../../../docs/adopter-playbook.md`](../../../docs/adopter-playbook.md)** — Case 1 vs Case 2 wiring patterns; substrate-portable vs substrate-locked
- **`src/connectors/types.ts`** — authoritative `McpConnector` interface
- **`src/connectors/mcp-remote.ts`** — full-featured reference impl with stdio framing + lifecycle
- **`src/connectors/mcp.ts`** — minimal reference impl
- **`src/connectors/config.ts`** — `registerConnectorClass()` + `loadConnectorsConfig()`
