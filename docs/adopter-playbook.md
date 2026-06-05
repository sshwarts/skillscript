# Adopter playbook

How to wire skillscript-runtime into your deployment. Written for Joe-Programmer: you have your own substrate stack (data store, agent harness, LLM endpoint, filesystem), and you want skillscript to slot in rather than dictate.

This playbook covers the load-bearing decisions, the two wiring patterns, and the conventions that keep your local modifications upstream-merge-friendly.

## The four substrates skillscript expects

Skillscript-runtime is substrate-neutral and assumes you have (or will choose):

1. **A filesystem** — for skill source files (`.skill.md`), trace records, the bundled sqlite databases. Sandbox via container, chroot, or limited-privilege process — operator's call.
2. **A data store** — for retrieval and writes from skill ops. Could be SQLite-FTS (bundled), a vector database, an in-house store, an Obsidian-style notes system, a memory broker — whatever you already have.
3. **An LLM endpoint** — Ollama running locally (bundled), a hosted API like OpenAI / Anthropic / Azure, or your own inference server.
4. **An agent harness** — where skill output is delivered. Could be tmux sessions, a webhook receiver, an in-house agent runtime, or no harness at all (skills run for their text output only).

Each of these maps to a typed connector contract: `SkillStore`, `DataStore`, `LocalModel`, `AgentConnector`. Plus `McpConnector` for any external tool you want to invoke from a skill body.

## What the runtime promises connector implementors

You only need to know what methods the runtime will call. Everything else — where data lives, what fields you honor, internal authorization, expiration, indexing — is your implementation choice. The contracts:

```
DataStore — substrate-neutral data persistence
  query(filters)    runtime asks: "find records matching these filters"
  write(record)     runtime asks: "store this; return id + timestamp"
  get(id)           runtime asks: "give me this specific record"

SkillStore — substrate-neutral skill source persistence
  load(name)             "give me this skill's source"
  store(name, source)    "write/version this skill"
  query(filter)          "list matching skills"
  update_status()        "Draft → Approved → Disabled transition"
  versions(name)         "audit trail"
  metadata(name)         "header info without body"
  delete(name)           "remove all versions"

LocalModel — substrate-neutral LLM dispatch
  run(prompt, opts)      "complete this prompt; return text"

AgentConnector — substrate-neutral agent delivery
  list_agents()          "what agent ids do you handle?"
  deliver(id, payload)   "send this to that agent"
  wake(id, opts)         "rouse that agent"
  health_check()         "are you reachable?"
  request_response(...)  "deliver + collect a reply"

McpConnector — external tool dispatch (substrate-neutral wire)
  call(toolName, args, ctx?)   "invoke this tool with these kwargs"
```

What's NOT in the contracts (and is your concern as implementor):
- Where the data lives (sqlite / your DB / hosted service / vector store)
- What metadata fields your substrate honors or ignores (kwargs passed via `metadata.<key>` ride through; you choose what to do with them)
- Vaults, namespaces, tenants, access-control — substrate-specific
- Expiration / decay / pinning / reranking — substrate-specific
- Authentication into your own backend — your code, your decision

## Case 1 vs Case 2 — the load-bearing wiring decision

This is the most important architectural choice you'll make.

### Case 1 — typed-contract wiring (substrate-portable)

You implement the typed connector contracts (`DataStore`, `LocalModel`, etc.) against your substrate. The bridge classes (`DataStoreMcpConnector`, `LocalModelMcpConnector`) surface them as canonical `$ data_read` / `$ llm` dispatch.

```typescript
class MyDataStore implements DataStore {
  async query(filters: QueryFilters): Promise<PortableData[]> { /* ... */ }
  async write(record: DataWrite): Promise<DataWriteRecord> { /* ... */ }
  async get(id: string): Promise<PortableData | null> { /* ... */ }
  async manifest(): Promise<ManifestInfo> { /* ... */ }
}

registry.registerDataStore("primary", new MyDataStore());
```

**In skills:**
```
$ data_read mode=fts query="customer feedback" limit=10 -> CONTEXT
```

This same skill body runs unchanged against your substrate, against SQLite-FTS (bundled), against Pinecone, against any substrate that conforms to the typed contract. **Skills are portable.** Substrate-specific concerns (where the records live, what metadata you honor) stay inside your impl.

### Case 2 — MCP-tools wiring (substrate-locked)

Your substrate exposes itself as MCP tools (via a local MCP server or remote one). You wire it as an `McpConnector` and skills reference its tools by name with substrate-specific kwargs.

**MCP transport — two paths.** The protocol's wire layer is the same; the transport differs:

- **Stdio MCP** (most common for community servers — YouTrack, GitHub, Linear, etc.): the MCP server is a binary you spawn as a child process and communicate with via stdin/stdout. Wired via `RemoteMcpConnector`:

  ```json
  {
    "my_store": {
      "class": "RemoteMcpConnector",
      "config": {
        "command": "my-store-mcp-server",
        "args": ["--db", "/var/store"]
      }
    }
  }
  ```

- **HTTP MCP / Streamable HTTP** (Anthropic's hosted MCP, GitHub MCP, Linear MCP, etc.): the MCP server speaks JSON-RPC over HTTP with Server-Sent Events for the stream channel. Two ways to wire it:

  - **(a) Stdio bridge** — `RemoteMcpConnector` + `npx mcp-remote https://... --sse` runs a node child process that bridges HTTPS-SSE into stdio for the runtime to consume. Works today; adds the bridge subprocess overhead per call.
  - **(b) Direct HTTP connector (bundled)** — `HttpMcpConnector` speaks Streamable HTTP MCP directly, no subprocess. Substrate-neutral: works against any MCP server speaking the spec. Wired declaratively:

    ```json
    {
      "my_store": {
        "class": "HttpMcpConnector",
        "config": {
          "endpoint": "https://mcp.example.com/",
          "headers": {
            "Authorization": "Bearer ${API_TOKEN}"
          },
          "identityHeader": "X-Agent-Id",
          "maxPoolSize": 64
        }
      }
    }
    ```

    Identity-propagation config:
    - `identityHeader` — when set, the connector reads `ctx.agentId` per call and threads it as both a per-call request header AND the session-pinning key. Each distinct agent identity gets its own session, pinned to that identity at server-side `initialize` time. Required for substrates that pin sessions to the initializing identity (the common case for memory-substrate MCPs). Omit it when every caller shares one identity — all calls then share a single default session.
    - `maxPoolSize` — optional cap on the per-identity session pool (LRU eviction by access recency). Default unlimited; set when your substrate has session-count limits or you want bounded resource use.

    When `identityHeader` is set, `supports_identity_propagation: true` is declared in `runtime_capabilities`. The `RuntimeCapabilitiesConformance` suite then requires Level 1 + Level 2 probes wired via `flagProbes` — see [Connector Contract Reference](connector-contract-reference.md) for the probe contract.

  - **(c) Custom direct connector** — fork `examples/connectors/McpConnectorTemplate/` when you need behavior the bundled `HttpMcpConnector` doesn't cover (e.g., a non-spec auth handshake, tool-name normalization, custom retry logic).

Pick (b) by default — no subprocess, no implementation effort, works against any compliant Streamable HTTP MCP server. Pick (a) only when the server is behind tooling that requires the stdio bridge. Pick (c) only when your substrate needs behavior the bundled connector doesn't expose.

**In skills**, regardless of transport:

```
$ my_store.search query="customer feedback" region="eu-west" cluster="prod" -> CONTEXT
```

This skill body is locked to `my_store` — its specific kwargs (`region`, `cluster`) and response shape. To move to a different substrate, every call site has to be rewritten.

### Picking — the tradeoff

| Aspect | Case 1 (typed) | Case 2 (MCP) |
|---|---|---|
| Skill portability | ✓ portable | ✗ substrate-locked |
| Substrate feature coverage | Limited to typed contract surface | Full substrate surface |
| Implementation effort | Implement typed interface | Wire existing MCP server |
| Best for | Skills you want to ship | Substrate-specific power features |

**The choice is per-skill, not per-substrate.** You can wire both — register `data_read` (typed-contract via bridge) AND `my_store` (MCP) — and let skills opt into portability by which connector name they reference.

For the substrate-portability claim to hold, **the substrates you care about must be Case-1-wired**.

## Joe Programmer setup walkthrough

### 1. Install + initialize

```bash
npm install -g skillscript-runtime
skillfile init --here
```

This creates `~/.skillscript/` with `skills/`, `traces/`, an empty `connectors.json`, and a `config.toml` stub.

**If you're writing a custom bootstrap (not just using the bundled CLI):** the package is ESM-only. `npm init -y` produces a CJS `package.json` by default, which will fail your first bootstrap run with top-level-await / ESM-import errors. Switch your adopter project to ESM before authoring bootstrap code:

```bash
npm pkg set type=module
```

(Phase 2 cold-adopter dogfood, 2026-06-01: first improvisation an adopter hit was this exact gap — surfaced after a `bootstrap.ts` failed at module load. One-sentence flag saves the trip.)

### 2. Decide on substrate wiring

For each of the four substrates (data store, LLM, agent harness, MCP tools), decide Case 1 or Case 2. The onboarding scaffold (`examples/onboarding-scaffold/`) is Case 1 end-to-end against a file-backed data store + OpenAI + tmux.

### 3. Configure runtime knobs

Create `skillscript.config.json` in your `$SKILLSCRIPT_HOME`:

```json
{
  "skillsDir": "${SKILLSCRIPT_HOME}/skills",
  "traceDir": "${SKILLSCRIPT_HOME}/traces",
  "dataDbPath": "${SKILLSCRIPT_HOME}/data.db",
  "dashboard": { "port": 7878 }
}
```

`${VAR}` substitutes against `process.env`. See `skillscript.config.json.example` in the repo for the full surface.

### 4. Wire your substrates

**For the bundled CLI path** (no custom code): use `connectors.json` to declare your MCP servers; use `OPENAI_API_KEY` / `OLLAMA_BASE_URL` env vars; run `skillfile dashboard --config ./skillscript.config.json`.

**For custom substrates**: write your own bootstrap. See `examples/custom-bootstrap.example.ts` and `examples/onboarding-scaffold/bootstrap.ts` for complete worked walkthroughs.

Two security knobs that adopters wiring real substrates should know about:

- **Per-connector tool allowlists** — `allowed_tools` on each `connectors.json` MCP connector entry restricts which tools that connector can dispatch. Three-state (`undefined` = allow all, `[]` = allow none, listed = exactly those). Tier-1 `disallowed-tool` lint + runtime defense-in-depth refuse out-of-list dispatch. See `docs/configuration.md` §"Named MCP connector instances" for the JSON shape.
- **Shell-execution discipline** — `shell(command="...")` runs structured-spawn by default (binary on PATH, whitespace-tokenized argv, no bash). `shell(command="...", unsafe=true)` opts into bash interpretation (pipes, `$VAR`, command substitution) and refuses to fire unless the runtime is configured with `enable_unsafe_shell = true` in `config.toml`. Lint flags every `unsafe=true` op tier-2 to keep audit posture visible. See `scaffold/config.toml` for the documented default + `help({topic:"lint-codes"})` for the `unsafe-shell-disabled` rule.

If you have a custom JSON-instantiable `McpConnector` class, register it with `registerConnectorClass` before loading config:

```typescript
import { registerConnectorClass, loadConnectorsConfig } from "skillscript-runtime";
import { MyAdopterConnector } from "./my-adopter-connector.js";

registerConnectorClass("MyAdopterConnector", {
  ctor: MyAdopterConnector,
  fromConfig: (cfg) => new MyAdopterConnector(cfg),
});

const { connectors } = loadConnectorsConfig({ path: "./connectors.json" });
```

### 5. Two-instance posture

Running dev-skillscript alongside an adopter-wiring instance on the same machine:

```bash
# dev
skillfile dashboard

# adopter (different port + paths)
SKILLSCRIPT_HOME=/path/to/adopter skillfile dashboard --config /path/to/adopter/skillscript.config.json
```

Each instance reads its own config; ports/paths/db files don't collide.

## Wiring the AgentConnector

`AgentConnector` is the substrate-neutral delivery surface for `# Output: agent: X` / `# Output: template: X` lifecycle hooks and `notify()` / `exchange()` ops. The runtime calls into the contract; your impl decides where the payload lands (webhook, tmux session, file drop, IPC pipe, Slack thread, your own agent harness, etc.).

The full contract surface — methods, payload shapes, receipt shapes, the `agent@session` targeting convention, the graceful-degradation rule — lives in [Connector Contract Reference](connector-contract-reference.md) §AgentConnector. This section covers the **wiring path** for adopters: how to bring an impl online so the runtime uses it.

### Two wiring paths

Same shape as the other substrate slots — programmatic (recommended for custom impls today) or declarative (`connectors.json`, restricted to bundled types).

**(a) Programmatic — for adopter-written impls.** Construct the connector in your bootstrap and pass it via `BootstrapOpts.agentConnector`:

```typescript
import { bootstrap } from "skillscript-runtime";
import { MyAgentConnector } from "./my-agent-connector.js";

const { registry, scheduler, server } = await bootstrap({
  agentConnector: new MyAgentConnector({
    endpoint: process.env["MY_AGENT_ENDPOINT"],
    api_key: process.env["MY_AGENT_API_KEY"],
  }),
});
```

`bootstrap()` calls `registry.registerAgentConnector("primary", ...)` for you. `health_check()` fires during registration — wiring failures throw at boot, not at first delivery.

**(b) Declarative `connectors.json`** — for bundled types and the (deferred) custom-via-dynamic-import path:

```json
{
  "substrate": {
    "agent_connector": "noop"
  }
}
```

Bundled short-form values:

| Value | Behavior |
|---|---|
| `null` (or omitted) | `NoOpAgentConnector` — silent fallback. `deliver()` / `wake()` log + resolve; `# Output: agent:` declarations complete with a stderr warning. Lets a runtime start with no harness wired. |
| `"noop"` | Same as `null` but explicitly stated. |
| Object with `"type": "custom"` | Adopter impl resolved by dynamic-import (deferred — surfaces a clear error today; use programmatic path). |

For full configuration shape, see [Configuration](configuration.md) §"The substrate section."

### Precedence

Same as other substrate slots:

1. **Programmatic** `BootstrapOpts.agentConnector` — explicit, highest priority.
2. **Declarative** `connectors.json` `substrate.agent_connector` — deployment-durable.
3. **Built-in default** — `NoOpAgentConnector`. Skills with `# Output: agent:` fire warnings, not errors.

The NoOp fallback is the design choice that makes "runtime works out of box without any AgentConnector wiring" hold. Adopters who want strictness should explicitly wire their connector and let `health_check()` throw if it can't start.

### Worked example

The canonical bundled example is `examples/connectors/HttpWebhookAgentConnector/` — a complete `AgentConnector` impl against an HTTP-webhook substrate. It demonstrates:

- Per-agent URL routing (`HTTP_WEBHOOK_AGENTS` JSON env)
- Optional `wake_url` per agent — present means wake-capable, absent means degrade-on-wake
- Bearer + HMAC auth (combinable)
- Tolerant receipt synthesis (substrate returns substrate-shaped JSON; connector translates to canonical `DeliveryReceipt`)
- Tests covering the deliver / wake / health-check / request-response surface

Three patterns to copy when forking it for your substrate:

**Pattern 1 — `agent@session` opaque composite.** Every messaging substrate needs either bare-identity OR specific-live-session addressing. The contract keeps `agent_id` opaque; sessions ride as `"perry@kitchen-terminal"` or via `WakeOpts.session_id`. Substrates that care decompose; substrates that don't ignore.

As of v0.18.5, the runtime address-routes skill-author surfaces (`notify()` + `# Output: agent:` / `template:`) on `@session` presence: bare → your `deliver()`, composite → your `wake()`. You receive whichever method the runtime decided; your job is to honor what arrives. For `wake()`, expect the FULL composite (`"perry@kitchen-terminal"`) — decompose to route to the right session:

```typescript
async wake(agent_id: string, opts?: WakeOpts): Promise<WakeReceipt> {
  // Form A — composite in agent_id
  const [agent, embeddedSession] = agent_id.split("@");
  // Form B — opts.session_id wins if both supplied
  const session = opts?.session_id ?? embeddedSession;
  // ... route to (agent, session)
  return { woken_at: Date.now(), woken: true, ...(session ? { session_id: session } : {}) };
}
```

**Pattern 2 — graceful degradation on wake.** `wake()` must not throw because your substrate lacks interrupt capability. Distinguish capability-gap (degrade) from operational-fault (throw):

```typescript
async wake(agent_id: string, _opts?: WakeOpts): Promise<WakeReceipt> {
  const cfg = this.agents[agent_id];
  if (!cfg) throw new Error(`agent not configured: ${agent_id}`);  // operational fault
  if (!cfg.wake_url) {
    // capability gap — no interrupt channel for this agent — degrade
    return { woken_at: Date.now(), woken: false };
  }
  const response = await fetch(cfg.wake_url, { ... });
  if (!response.ok) throw new DeliveryFailedError(...);  // operational fault
  return { woken_at: Date.now(), woken: true };
}
```

Callers reading `WakeReceipt.woken` distinguish "the substrate woke them" from "the substrate stored the payload for later" without needing per-substrate knowledge.

**Pattern 3 — session echo on receipts.** When your substrate routes to a specific session, echo it back on `DeliveryReceipt.session_id` / `WakeReceipt.session_id`. Dashboards rendering "delivered to perry@kitchen-terminal" rather than just "delivered to perry" depend on this.

**Pattern 4 — read `meta.origin.caller_agent_id` to attribute, not for scope.** The `DeliveryMeta` envelope your `deliver()` receives carries `origin.caller_agent_id` = the *authenticated caller* who fired the dispatch (not the skill's owner — those are separate semantics; see [Connector Contract Reference](connector-contract-reference.md) §field semantics). Use it for *attribution* — rendering "from cc" on the receiving end, audit logs, accountability — not for authorization scoping. Outbound substrate scoping should derive from the *skill owner* (which the runtime applies at the connector layer via `ctx.agentId`, not via the envelope). If `caller_agent_id` is undefined on a delivery you receive, it means the chain originated from a non-human trigger (cron / scheduler / session-start) — your substrate should attribute it as "system-fired" or similar, not assume an identity.

**Pattern 5 — surface non-fatal notes via `DeliveryReceipt.warnings`.** When your substrate needs to signal something non-fatal about a delivery — "stripped @session because verb is deliver", "rate-limit hint", "fan-out: delivered to 3 sessions" — return them as `warnings: string[]` on the receipt instead of writing to stderr. The runtime echoes warnings onto `AgentDeliveryReceiptRecord.receipt.warnings`, where the dashboard can render them and observability tools can scrape them. Stderr noise gets lost; receipt warnings are structured + caller-visible.

### When to fork vs. when to write fresh

- **Fork `HttpWebhookAgentConnector`** when your substrate is HTTP-shaped and your changes are: tweaked auth (OAuth, mTLS), retry policy, different routing model. Most production deployments end up here.
- **Write fresh** when your substrate is fundamentally non-HTTP (tmux, file drop, gRPC, websocket-push). Implement the five required methods (`list_agents`, `deliver`, `wake`, `health_check`, `request_response`) + optional `agent_status`. Use `NoOpAgentConnector` as the minimal-shape reference.

In either case: write tests against the contract methods (the bundled example's `tests/HttpWebhookAgentConnector.test.ts` is a useful template), wire via `BootstrapOpts.agentConnector`, and let `health_check()` enforce the "fail-at-boot, not at first delivery" property.

## Authoring posture — who owns the skills you write

Every skill stored in a `SkillStore` carries a `SkillMeta.author` field captured at first-write. The author is then load-bearing at dispatch time: the runtime threads it into `ctx.agentId` so identity-scoped substrates (memory stores, multi-tenant DBs) read and write under that scope.

How `author` is captured depends on how the skill gets written:

- **CLI / dashboard / direct programmatic API.** When you call `SkillStore.store(name, body)` from your own code (CLI, bootstrap, scripts) or via the dashboard's approval flow, the SkillStore captures author from its bundled default. `FilesystemSkillStore` uses `os.userInfo().username`; adopter stores capture from their own auth context.

- **MCP `skill_write` from a single-tenant host.** If only one agent (or one human) calls your runtime, you don't need to configure anything — the `SkillStore.store()` default-author logic above applies. **Skip the multi-agent section below.**

- **MCP `skill_write` from a multi-agent host.** If multiple agents share one runtime instance via MCP (e.g., a host that bridges several authenticated agents into one transport), the runtime can't tell them apart at the protocol layer. See the next section.

### Direct-write authoring path

Adopters whose `SkillStore` is backed by an addressable substrate (e.g., a memory store) can author skills by writing the substrate record directly — without going through the MCP `skill_write` handler. This captures `SkillMeta.author` from the substrate's own writer-identity (whatever the direct-write API authenticates as).

**Gotcha:** direct-write must declare `# Status: Draft`, not `# Status: Approved`. The runtime's hash-token tamper gate (v0.9.0) rejects skills with `# Status: Approved` that lack a `vN:<token>` stamp; the stamp is computed by the runtime's `update_status` flow, not by the substrate. To publish:

1. Write the skill with `# Status: Draft` via your substrate's direct-write API.
2. Call `skill_status({name, new_state: "Approved"})` via MCP (or the dashboard's Approve button). This stamps the token and preserves the captured author.

Write-Approved-without-stamp will fail at execute time with `ApprovalRejectedError`. Always Draft-then-promote.

## Identity propagation — for multi-agent hosts

**Skip this section** if your runtime serves one agent (CLI tools, single-user dashboards, hobby deployments). The existing v0.16.8 default — `SkillMeta.author` captured from the SkillStore's writer identity — already attributes authorship correctly when there's only one writer.

This section is for adopters whose runtime is fronted by an MCP host that bridges multiple authenticated agents into one transport (e.g., a NanoClaw-style multi-agent gateway, or a multi-tenant SaaS where agents share a runtime pool).

### The gap MCP doesn't close on its own

JSON-RPC over HTTP doesn't carry a standard "calling identity" field. Without an extra convention, every `skill_write` call into your runtime stamps `SkillMeta.author = <runtime's own writer identity>` — regardless of which agent on the host actually originated the call. Subsequent `execute_skill` dispatches then run under the wrong scope. Identity-scoped reads return the runtime's own data, not the calling agent's.

### Opt-in: a configurable inbound header

When you configure `dashboard.mcpCallerIdentityHeader`, the runtime reads that header on every `/rpc` request and threads its value as the caller-identity through to `skill_write`. The handler stamps `SkillMeta.author = <header value>`. Different callers with different header values get distinct stored authors.

```json
{
  "dashboard": {
    "host": "127.0.0.1",
    "port": 7878,
    "mcpCallerIdentityHeader": "X-Agent-Id"
  }
}
```

Multi-agent host (NanoClaw, custom MCP gateway, etc.) is responsible for setting the header on every outbound request:

```http
POST /rpc HTTP/1.1
Host: skillscript-runtime
Content-Type: application/json
X-Agent-Id: alice

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"skill_write","arguments":{"name":"alice-skill","source":"..."}}}
```

- Header lookup is case-insensitive (Node lowercases inbound header names).
- Absent header on a configured runtime → caller identity is undefined for that request → `SkillStore.store()` falls back to its default author capture (existing single-tenant behavior). Backwards-compatible — hosts that don't inject identity behave exactly as before.
- Empty header value → treated as absent.

### Trust model

The runtime trusts the host's header attestation. There's no signature verification — anyone reaching the runtime with a forged `X-Agent-Id` could claim to be anyone. The runtime is **not** the authentication boundary; the host is. Bilateral trust:

- **The host** (your MCP gateway) authenticates the agent via its own auth surface (OAuth, JWT, session cookies, mTLS — whatever fits your platform) and injects the verified identity into the outbound `X-Agent-Id` header.
- **The runtime** trusts the host because you configured it to (`mcpCallerIdentityHeader` is opt-in; unset means "I don't trust any inbound identity claim, fall back to my own writer identity").

Don't expose the `/rpc` endpoint directly to untrusted clients with this configuration. Run behind your host's auth-enforcing reverse proxy or in a trusted-network deployment.

### Inbound vs outbound — same header, two layers

Connectors like `HttpMcpConnector` use the **same header name** (`X-Agent-Id` by convention) for outbound calls to substrates — see the [HttpMcpConnector configuration](#case-2--mcp-tools-wiring-substrate-locked) above. The two are NOT the same value in general:

- **Inbound** (this section) = request-scoped caller — who's currently calling the runtime via MCP.
- **Outbound** (`HttpMcpConnector.identityHeader`) = dispatch-scoped owner — derived from `SkillMeta.author` of the skill being executed, asserted to the substrate so reads land in the owner's scope.

They MEET at `SkillMeta.author`. The runtime captures inbound caller identity at `skill_write` (stamps it as the skill's author); at execute time, the runtime threads `author` into `ctx.agentId`; the outbound connector asserts that to the substrate. The same `X-Agent-Id` header carries two different identity claims at the two boundaries; the stored author is the bridge.

**Critical:** never forward an inbound `X-Agent-Id` header straight to an outbound connector. The skill's owner is who should access the substrate, not the current caller. If anyone invokes alice's skill and the outbound used the caller's identity instead of alice's, the substrate would scope to the caller — a setuid hazard. The runtime keeps the two separate; outbound identity is always derived from author at dispatch.

### Verification

After wiring + restart, a smoke test:

```bash
# Write a skill as alice
curl -X POST http://localhost:7878/rpc \
  -H "content-type: application/json" \
  -H "X-Agent-Id: alice" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"skill_write","arguments":{"name":"smoke","source":"# Skill: smoke\n# Status: Draft\nrun:\n    emit(text=\"hi\")\ndefault: run"}}}'

# Verify author was stamped from the header
curl -X POST http://localhost:7878/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"skill_metadata","arguments":{"name":"smoke"}}}' \
  | jq '.result.content[0].text | fromjson | .metadata.author'
# Expected: "alice"
```

If the second call returns the runtime's own writer identity instead of `"alice"`, either the config field is unset, the header didn't reach the runtime (check your proxy / host wiring), or you sent the request with a different header name than configured.

## Conventions for upstream-merge-friendly modifications

If your wiring needs require modifying skillscript-runtime source (rather than just configuration), follow these conventions to minimize merge friction.

### 1. Prefer dedicated adopter files over editing upstream

Put your code in dedicated paths upstream won't touch:

```
src/connectors/local/my-data-store-adapter.ts    ← adopter-owned
src/connectors/local/my-llm-adapter.ts           ← adopter-owned
```

Upstream changes to `src/connectors/data-store.ts` won't conflict with your `local/` files.

### 2. Use the public registration API; don't edit the closed-set Map

`KNOWN_CONNECTOR_CLASSES` in `src/connectors/config.ts` is upstream-owned. Add your classes via `registerConnectorClass(name, entry)` from your bootstrap instead. Closes the merge-conflict bait of editing that file every release.

### 3. Mark unavoidable upstream-file edits with sentinels

When you genuinely have to edit an upstream file, mark the change:

```typescript
// ADOPTER:myorg — extend dispatch to call our auditor before forward
if (process.env["MYORG_AUDIT"] === "1") { /* ... */ }
```

The `// ADOPTER:myorg —` prefix is greppable across merges; your future-self can re-evaluate whether the modification is still needed when upstream changes the surrounding code.

### 4. Treat `src/bootstrap.ts` as reference, not canonical

The bundled `bootstrap()` is a starting point. For deployments with custom substrates, write your own bootstrap that imports the public APIs (`Registry`, the connector classes, `loadConnectorsConfig`, `loadSkillscriptConfig`, etc.). Modifying the bundled bootstrap creates churn on every upstream release.

See `examples/custom-bootstrap.example.ts` for a worked walkthrough.

## Substrate ship-status

| Substrate | Shipped contract | Shipped impls | Shipped bridge |
|---|---|---|---|
| SkillStore | ✓ 8 methods (`load` / `query` / `store` / `update_status` / `delete` / `versions` / `metadata` / `staticCapabilities`) | `FilesystemSkillStore`, `SqliteSkillStore` | n/a |
| DataStore | ✓ 3 methods (`query` / `write` / `get`) | `SqliteDataStore` | ✓ `DataStoreMcpConnector` |
| LocalModel | ✓ 1 method (`run`) | `OllamaLocalModel` | ✓ `LocalModelMcpConnector` |
| McpConnector | ✓ 1 method (`call`) | `RemoteMcpConnector`, `CallbackMcpConnector` | n/a |
| AgentConnector | ✓ 5 required (`list_agents` / `deliver` / `wake` / `health_check` / `request_response`) + 1 optional (`agent_status`) | `NoOpAgentConnector` (default), `HttpWebhookAgentConnector` | n/a |

**Notable things the playbook should be honest about:**

- **`SqliteDataStore` is a deliberately minimal reference impl.** It satisfies the contract (`query` / `write` / `get` / `staticCapabilities` / `manifest`) with FTS-style tag/text retrieval. It does NOT support semantic retrieval, pinning, decay scoring, or thread-status filtering (the relevant `supports_*` flags are all false). Deployments that need richer query semantics fork `examples/connectors/DataStoreTemplate/` and wire their backing substrate.
- **SkillStore and DataStore have different lifecycle models — by design.** SkillStore is mutable / versioned / named CRUD (Draft→Approved→Disabled→Delete with audit trail). DataStore is append-only with query/get (no per-record lifecycle in the contract). If you back both onto one substrate, you're serving both lifecycle models at once. Substrates that conflate "data record expiry" with "skill expiry" silently break authored code; the contract doesn't enforce this, you handle it impl-side.
- **Durability is implementer's responsibility.** The typed contracts assume durable storage. Neither interface declares "writes live forever" — but the runtime + lint + dashboard all behave as if writes persist indefinitely. If your substrate has GC / TTL / decay scoring, build adopter-side guards (pin-rules, retention policies, periodic re-pin sweeps) or pick a substrate posture that satisfies "durable forever." Silent staleness is the failure mode the contract won't catch.
- **Mutation ops require runtime-enforced authorization.** `$ data_write` / `file_write` / `$ <mutating-name-tool>` (write/update/delete/etc.) fire `UnconfirmedMutationError` at the runtime boundary unless the skill carries `# Autonomous: true` (cron/agent-fired) OR a preceding `??` / `ask(...)` confirms in the same target OR the op carries `approved="reason"` per-op kwarg. This fires regardless of how the skill was invoked — `execute_skill({name})` AND `execute_skill({source})` honor the gate identically; lint stays advisory. Adopters running unattended skills programmatically should set `# Autonomous: true` at the header.
- **In-skill writes have asymmetric trust models.** `$ skill_write` lands its child as `# Status: Draft` regardless of body declaration — the bridge forces it. Authoring an executable artifact has unbounded blast radius (the child fires arbitrarily many times in arbitrary contexts); the Draft default keeps autonomously-written skills out of the immediate execution loop. `$ data_write` writes verbatim — one bad data row is bounded blast radius. SkillStore impls receive the body already Draft-stamped; DataStore impls receive entries as authored.
- **Your `DataStore.write()` is never called if the mutation gate rejects the skill.** The runtime gates `$ data_write` (and other mutation ops) upstream of the bridge — substrates only see authorized writes. If your own probes hit `UnconfirmedMutationError`, that's a skill-body issue (missing `# Autonomous: true` / `??` / `approved=`), not a substrate issue.
- **Filter scope is enforced at the bridge.** `DataStoreMcpConnector` rejects every filter key outside the substrate's declared `manifest().supported_filters` set, throwing `UnsupportedFilterError`. This prevents silent scope leaks where unsupported filters get dropped without the caller knowing. Per-call opt-out: `permissive_filters: true` acknowledges "unknown keys are advisory; substrate may ignore them." Substrate implementors: declare every filter your `query()` actually honors so the bridge validates against your truth, not a guess.
- **FTS matching strictness varies by substrate.** The `DataStore.query()` contract names the modes (`fts` / `semantic` / `rerank`) but doesn't pin down matching semantics within each mode — token-OR, phrase-tokens, fuzzy, exact, FTS5-syntax-passthrough, etc. are all conformant. The bundled `data-store-roundtrip` demo asserts `N ≥ 1` (a successful round-trip) rather than a specific count, which works across any FTS-supporting substrate. For adopters who need deterministic exact-count reads (round-trip tests, idempotency checks, exact-record-matched fetches), the portable strict-match path is `domain_tags=[...]` filtering — the bridge enforces tag-key against `supported_filters` and substrates declaring `supports_tag_filter: true` honor exact-tag any-of-match per the contract. Use FTS for relevance ranking against open content; use tag filters when you need to be sure you got the specific record you wrote.
- **Durable-forever opt-in via `expires_at: null`.** `DataWrite.expires_at` accepts a unix timestamp for finite expiry, `null` to opt into "durable forever" (the portable verb for substrates with default TTL — AMP memory vaults, Redis with default expiry, hosted memory APIs), or omitted (substrate's default lifecycle, may be durable or may have decay). Substrates that are durable-by-default (the bundled `SqliteDataStore`) treat `null` as a no-op. Substrates with default sweep should map `null` to their pin / no-decay flag.
- **4 of 6 trigger sources parse but don't fire.** `cron` and `session: start` work; `event`, `agent-event`, `file-watch`, `sensor` are parser-only stubs awaiting the event-bus surface.
- **Output kinds are intentionally substrate-neutral.** `# Output:` accepts `text` / `agent: <name>` / `template: <name>` / `file: <path>` / `none`. Substrate-specific values (`slack:`, `card:`, etc.) are out of scope — adopters wanting Slack / WhatsApp / Discord / etc. delivery use either `$ slack.post ...` MCP dispatch inside the skill body OR deliver via `agent: <name>` and let the receiving agent decide.
- **Authorization is hash-token approval.** Skills must carry `# Status: Approved vN:<token>` where the token re-computes from the body minus its `# Status:` line. Bundled `v1:` is CRC32 — discipline-barrier strength, suited to single-operator deployments. Adversarial threat models swap a stronger function:

  ```ts
  import { registerApprovalFn, setPreferredApprovalVersion } from "skillscript-runtime";
  import { createHmac } from "node:crypto";

  // v2: HMAC-SHA256 with operator-held key. Agent that knows the algorithm
  // can no longer self-stamp without the key.
  const key = process.env["APPROVAL_HMAC_KEY"]!;
  registerApprovalFn("v2", (body) => createHmac("sha256", key).update(body).digest("hex"));
  setPreferredApprovalVersion("v2"); // dashboard now stamps v2 on Approve clicks
  ```

  Wire this in your bootstrap BEFORE any skill is stamped — otherwise existing skills carry `v1:` tokens that still verify (CRC32 stays registered) but new approvals use the upgraded function. The runtime maintains a per-version registry, so mixed-version skill bodies coexist cleanly.

## Skill discovery + cross-agent composition

If you back your SkillStore against a substrate that ALSO holds general data records (one substrate serving both contracts), skill discovery can use the canonical `$ data_read` surface to find skills via tag/query:

```
$ data_read mode=fts query="incident triage" limit=5 -> SKILLS
foreach S in ${SKILLS.items}:
    execute_skill(skill_name="${S.name}", ...) -> RESULT
```

This works *only* when the data substrate is Case-1 wired (typed-contract via bridge) AND your substrate's records identify skills somehow (a tag, a payload-type marker, etc. — your impl's choice). Under Case-2 wiring, you'd need substrate-specific tool calls which are non-portable.

For most deployments, skill discovery goes through the canonical `skill_list` MCP tool (which calls `SkillStore.query()`). The `$ data_read`-as-discovery pattern is for the niche case where skills and other records share a backing store with rich tag/query semantics.

## Contributing — dispatch-shape discipline

The multi-layer-promise pattern (lint passes; runtime fails, or vice versa) is the recurring failure mode for dispatch-shape work. `validateQualifiedDispatch` is the shared validator lint and runtime both call. To prevent the next recurrence, every PR that introduces a new dispatch shape (a new way of writing `$ ...` ops, a new connector class entry point, a new lifecycle hook on `# Output:`) must land with:

1. **Lint test** — fixture that exercises the shape with lint only (`lint(source, {registry})`)
2. **Runtime test** — same shape executed end-to-end (`executeSkillByName` or `executeSkillFromSource`)
3. **E2E test** — the full user path (write skill → store → execute via MCP, or trigger fire → dispatch)

PR description must call out which dispatch shape is exercised. If you can't write all three for a shape, that's a signal the shape is incompletely specified — file a thread before merging.

Connector class authors implementing new `McpConnectorClass`-shaped contracts should also implement `staticTools(): string[] | null` whenever the tool surface is closed and knowable at compile time. Lift `unknown-tool-on-connector` from "advisory you fix at runtime" to "tier-1 error caught at compile time" for every adopter who wires your class.

## Resources

- **Onboarding scaffold** — `examples/onboarding-scaffold/` — complete adopter deployment with a file-backed data store + OpenAI + tmux
- **Custom bootstrap walkthrough** — `examples/custom-bootstrap.example.ts` — registering custom MCP connector classes
- **Connectors example** — `scaffold/connectors.json` — annotated `connectors.json` shape
- **Language reference** — `docs/language-reference.md` — skill syntax + frontmatter + lint codes
- **Connector contracts** — `docs/connector-contract-reference.md` — substrate-neutral contract surfaces
- **Configuration** — `docs/configuration.md` — `connectors.json` shape + substrate selection
