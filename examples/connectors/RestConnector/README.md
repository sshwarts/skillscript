# RestConnector — a working REST-backed connector

A **complete, runnable** `McpConnector` that fronts a plain REST/HTTP API. Unlike [`McpConnectorTemplate`](../McpConnectorTemplate/) (a throws-`TODO` skeleton), you can register this as-is and dispatch to a real backend — you only edit the endpoint table and auth.

## Why this exists

It answers one question adopters keep asking: **"my backend speaks REST, not the MCP wire protocol — can skillscript still call it?"**

Yes. `McpConnector` is the *dispatch surface skills call* (`$ connector.tool`), **not** a requirement that the backend speak MCP. The name is about the skill-facing verb, not the wire:

| Connector | Backend wire protocol | Same contract? |
|---|---|---|
| `HttpMcpConnector` (bundled) | JSON-RPC-over-HTTP (it fronts MCP servers) | ✅ |
| **`RestConnector` (this)** | plain REST/HTTP | ✅ |
| a WebSocket / gRPC / in-process fork | anything | ✅ |

All satisfy the same two-method contract (`call` + `manifest`). **A skill can't tell them apart**, and one skill body can mix them freely:

```
$ gmail.send to="ops@acme.io" subject="Deploy done"    # an MCP connector
-> _
$ tickets.create title="Deploy 4.2" severity="info"     # this REST connector
-> ticket
```

The registry holds a heterogeneous set; each `$ <name>.<tool>` op routes to whichever connector owns that name.

## What you edit

Three things, all in [`RestConnector.ts`](./RestConnector.ts):

1. **`ENDPOINTS`** — one entry per tool: HTTP method + path (with `:param` placeholders) + description + optional `inputSchema`. This is the tool surface skills dispatch to.
2. **`RestConnectorConfig`** (via the constructor or `connectors.json`) — `baseUrl`, auth header, token source.
3. **Registration** — programmatic or declarative (below).

Everything else works as written: path templating (`:id` → path, filled from args), query-vs-body routing (GET/DELETE → query string, POST/PUT/PATCH → JSON body), auth header injection, per-request timeout, error surfacing via `throw` (so op-level `(fallback: ...)` catches it), `staticTools()` lint, and `describeTools()` discovery.

## Wiring

**Programmatic** (your bootstrap):

```typescript
import { Registry } from "skillscript-runtime";
import { RestConnector } from "./RestConnector.js";

const registry = new Registry();
registry.registerMcpConnector(
  "tickets",
  new RestConnector({
    baseUrl: "https://api.internal.acme.io/v1",
    authTokenEnvVar: "TICKETS_API_TOKEN", // read from env, never hardcode
  }),
);
```

**Declarative** (`connectors.json`) — register the class once, then adopters declare instances in JSON:

```typescript
import { registerConnectorClass } from "skillscript-runtime/connectors";
import { RestConnector } from "./RestConnector.js";

registerConnectorClass("RestConnector", {
  ctor: RestConnector,
  fromConfig: (cfg) => RestConnector.fromConfig(cfg),
});
```

```json
{
  "tickets": {
    "class": "RestConnector",
    "config": { "baseUrl": "https://api.internal.acme.io/v1", "authTokenEnvVar": "TICKETS_API_TOKEN" }
  }
}
```

Call `registerConnectorClass` **before** `loadConnectorsConfig` runs. This makes the *instance* JSON-configurable; the `ENDPOINTS` table is still code — a fully config-only REST connector (endpoints in JSON too) is a natural next fork.

## Credentials

- **Prefer `authTokenEnvVar`** over a literal `authToken` — never commit a token. See [`.env.example`](./.env.example).
- Default header is `Authorization: Bearer <token>`. For an API-key header, set `authHeader: "X-API-Key"` + `authScheme: "raw"`.
- **Credential-free egress:** if you deploy behind an outbound proxy that injects auth (so no token lives in the runtime at all), you don't need `authToken`/`authTokenEnvVar` here — point `baseUrl` at the gateway. See the proxy-egress pattern in [`docs/adopter-playbook.md`](../../../docs/adopter-playbook.md).

## What the contract does *not* have

There is **no `mutating` flag** on the tool descriptor (`McpToolDescriptor` is `{ name, description?, inputSchema? }`). The read/write distinction rides in the description text + the HTTP method — see how `describeTools()` prefixes `[POST]` / `[GET]`. If your host needs a first-class effect classification, that's a skill-body concern (the op's declared footprint), not a connector-descriptor field.

## Identity propagation

`call()` receives `ctxOverrides` (`agentId`, `isAdmin`) but this example ignores it (`supports_identity_propagation: false`). To honor it, forward it as a header (`headers["X-On-Behalf-Of"] = ctx.agentId`) and flip the flag — which then obligates the Level 1 / Level 2 conformance probes documented in [`McpConnectorTemplate`](../McpConnectorTemplate/McpConnectorTemplate.ts).

## Contract surface

| Method | Required | What it does |
|---|---|---|
| `call(toolName, args, ctx?)` | ✅ | Map tool + args → an HTTPS request; return parsed JSON |
| `manifest()` | ✅ | Transport metadata for `runtime_capabilities` discovery |
| `describeTools()` | optional | Endpoints-as-tools for author-time discovery + input lint |
| `staticCapabilities()` | ✅ static | Declare supported features |
| `staticTools()` | optional static | Closed tool set → lint validates `$ name.tool` at authoring time |

## Further reading

- **[`../McpConnectorTemplate/`](../McpConnectorTemplate/)** — the fork-me skeleton + the full contract walkthrough (identity propagation, `fromConfig`, capability flags)
- **[`../../../docs/connector-contract-reference.md`](../../../docs/connector-contract-reference.md)** — the connector contracts, and why they're wire-protocol-agnostic
- **[`../../../docs/adopter-playbook.md`](../../../docs/adopter-playbook.md)** — wiring patterns + the credential-free proxy-egress deployment
- **`src/connectors/types.ts`** — authoritative `McpConnector` interface
- **`src/connectors/http-mcp.ts`** — `HttpMcpConnector`, the bundled HTTP impl (JSON-RPC-over-HTTP, for actual MCP servers)
