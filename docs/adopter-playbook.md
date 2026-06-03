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
