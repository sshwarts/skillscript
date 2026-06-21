---
title: Adopter Playbook
description: "Stand up the runtime, wire your substrates, supervise it as a service, and point your agent at it over MCP."
mode: wide
---

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
        "args": ["--db", "/var/store"],
        "framing": "newline"
      }
    }
  }
  ```

  Set `"framing": "newline"` explicitly — `mcp-remote` and most spec-compliant MCP stdio servers use newline-delimited JSON. The legacy `lsp` default silently hangs to `init_timeout` against newline-framed servers. See [configuration.md — `RemoteMcpConnector` config — stdio framing](configuration.md#remotemcpconnector-config---stdio-framing).

  The `command` (server binary, `node`/`npx`, `uv`/`uvx`, etc.) must be on the runtime host's PATH at spawn time. A programmatic bootstrap inherits its launching shell's PATH; the CLI inherits the user's shell PATH at invocation.

- **HTTP MCP / Streamable HTTP** (Anthropic's hosted MCP, GitHub MCP, Linear MCP, etc.): the MCP server speaks JSON-RPC over HTTP with Server-Sent Events for the stream channel. Two ways to wire it:

  - **(a) Stdio bridge** — `RemoteMcpConnector` + `npx mcp-remote https://...` runs a node child process that bridges HTTP MCP into stdio for the runtime to consume. `mcp-remote` auto-negotiates the transport (Streamable HTTP first, falling back to SSE); add `--sse` only if the server requires SSE explicitly. Works today; adds the bridge subprocess overhead per call.
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

**⚠ Programmatic `bootstrap()` adopters: `connectors.json` is NOT auto-loaded.** The CLI (`skillfile dashboard` / `serve`) discovers and loads `$SKILLSCRIPT_HOME/connectors.json` automatically. The programmatic path does NOT — `bootstrap()` only reads `connectors.json` when you pass `connectorsConfigPath`. Skip it and your `$ name.tool` calls fail at runtime with `unknown-connector` and no hint that the file simply wasn't read. See §"Programmatic bootstrap path" below for the explicit-wiring pattern. (Same CLI-auto-vs-programmatic-explicit asymmetry as `.env` and `SKILLSCRIPT_*` env vars — three instances of the same pattern now.)

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

**If you're writing a custom bootstrap (not just using the bundled CLI):** install the package locally (`npm install skillscript-runtime` in your adopter project) so `tsx`/`node` can resolve it alongside your project dependencies. A global install is convenient for the bundled CLI but doesn't expose the package to your custom bootstrap's module resolution.

The package is ESM-only. `npm init -y` produces a CJS `package.json` by default, which will fail your first bootstrap run with top-level-await / ESM-import errors. Switch your adopter project to ESM before authoring bootstrap code:

```bash
npm pkg set type=module
```

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

Security knobs that adopters wiring real substrates should know about:

- **The approval boundary (secured mode).** `SKILLSCRIPT_SECURED_MODE=true` enforces that only key-signed skills perform effects. Default-deny by design — leave it off only for trusted-author / single-operator setups. Full detail, the approve flow, and key custody: [Approval + secured mode](#approval--secured-mode).
- **Filesystem path allowlist.** `SKILLSCRIPT_FS_ALLOWLIST` is default-deny — `file_read` / `file_write` refuse every path until you wire roots. See [Filesystem path allowlist](#filesystem-path-allowlist). (Keep your approval-key directory out of it.)
- **Per-connector tool allowlists** — `allowed_tools` on each `connectors.json` MCP connector entry restricts which tools that connector can dispatch. Three-state (`undefined` = allow all, `[]` = allow none, listed = exactly those). Tier-1 `disallowed-tool` lint + runtime defense-in-depth refuse out-of-list dispatch. **`allowed_tools` belongs at the entry top-level**, sibling to `class` and `config` — NOT inside the `config` block. The loader hard-errors on misplacement (placing it inside `config:` would silently allow-all every tool — the worst-case failure mode for a security control). See `docs/configuration.md` §"Named MCP connector instances" for the JSON shape.
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

### 6. Running as a supervised service

For cron/event fires to be reliable, the dashboard/MCP host must run supervised — surviving both reboot and crash. The scheduler is in-process, at-most-once, with no catch-up (see [Trigger model — durability honesty](#durability-honesty)): a down process silently misses fires. A cron skill like `0 3 * * *` only fires if the process happens to be up at 3am. `nohup`-from-a-shell isn't sufficient (dies on reboot/logout/crash).

Use the OS supervisor: a macOS LaunchAgent (`RunAtLoad` + `KeepAlive`) or a Linux systemd unit.

**macOS — `~/Library/LaunchAgents/com.skillscript.adopter.plist`:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.skillscript.adopter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>--import=tsx</string>
    <string>/path/to/adopter/bootstrap.ts</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/adopter</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>SKILLSCRIPT_HOME</key><string>/path/to/adopter</string>
  </dict>
  <key>StandardOutPath</key><string>/path/to/adopter/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>/path/to/adopter/logs/stderr.log</string>
</dict>
</plist>
```

Load with `launchctl load ~/Library/LaunchAgents/com.skillscript.adopter.plist`.

**Linux — `/etc/systemd/system/skillscript-adopter.service`:**

```ini
[Unit]
Description=Skillscript adopter runtime
After=network.target

[Service]
ExecStart=/usr/bin/node --import=tsx /path/to/adopter/bootstrap.ts
WorkingDirectory=/path/to/adopter
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=SKILLSCRIPT_HOME=/path/to/adopter
Restart=always
RestartSec=5
User=adopter

[Install]
WantedBy=multi-user.target
```

Enable with `systemctl enable --now skillscript-adopter.service`.

**The load-bearing gotcha — pin `PATH` in the supervisor environment.** launchd and systemd run with a bare PATH (typically `/usr/bin:/bin`), not your shell's. The runtime's spawned binaries — `node`/`npx` for `RemoteMcpConnector` (mcp-remote bridges), `uv`/`uvx` for Python MCP servers, every binary on the shell allowlist (`gh`, `curl`, `git`, etc.) — must be on that pinned PATH. Omit it and connectors + shell ops fail with "command not found" under the supervisor even though they work from your shell. This is the same class of environment-specific break as forgetting to pin `TMUX_TMPDIR` in a tmux launcher's plist.

Spirit-of: same PATH concern as the [Case-2 stdio host-PATH note](#case-2--mcp-tools-wiring-substrate-locked) — two surfaces (the shell that launches it ad-hoc AND the supervisor that keeps it up persistently).

**A few additional gotchas:**

- **`WorkingDirectory` matters.** Set it to the bootstrap's directory so relative imports (`./connectors-config.ts`) and `node_modules` resolve correctly. Without it, the supervisor runs from `/` and ESM imports fail.
- **Single supervisor only.** Don't also run the dashboard manually (`nohup skillfile dashboard &`) alongside the supervised instance — two listeners on the same port either collide or round-robin events, dropping fires silently.
- **`.env` still loads.** The runtime's `process.loadEnvFile` call reads `.env` from the working directory at boot, independent of the supervisor's environment block. Don't duplicate secrets in both — keep them in `.env` and let the bootstrap load them.

### 7. Wire your agent to the runtime over MCP

With the service running, point your agent at the runtime's `/rpc` endpoint.

**Simplest path (Claude Code + similar agent hosts):** just ask. "Add the skillscript MCP server at `http://localhost:7878/rpc`" — Claude Code writes the config for you. Skip the JSON below unless you want to understand what landed or you're on a host that doesn't write its own config.

**Manual config — standard HTTP MCP** (modern agent hosts that speak HTTP MCP directly) — drop the runtime in your agent's MCP config (`~/.claude.json`, `.mcp.json`, `claude_desktop_config.json`, etc.):

```json
{
  "mcpServers": {
    "skillscript": {
      "type": "http",
      "url": "http://localhost:7878/rpc"
    }
  }
}
```

**Stdio bridge** (older Claude Desktop builds + any client that doesn't speak HTTP MCP) — bridge via `mcp-remote` the same way you'd bridge any HTTP MCP server. Pair this with the [`framing: "newline"` note from Case 2](#case-2--mcp-tools-wiring-substrate-locked) if you wire it the other direction (runtime → external HTTP MCP):

```json
{
  "mcpServers": {
    "skillscript": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:7878/rpc"]
    }
  }
}
```

**Two operational notes:**

- **Port matches what the runtime binds.** Default `7878` (`SKILLSCRIPT_PORT` env var / `dashboard.port` config). Two-instance setups (dev + adopter side-by-side per §5) need distinct ports — e.g., adopter on `7879`. Whatever the supervisor unit specifies is what the agent config must point at.
- **Auth + bind address.** `/rpc` has no auth and binds to `127.0.0.1` by default — the right posture for a local agent talking to a local runtime. If you set `SKILLSCRIPT_HOST=0.0.0.0` to reach the runtime across the network, front it with your own auth layer (reverse proxy + bearer token, mTLS, etc.) — same posture as the `/event` HTTP ingress, which has its own bearer-token gate (`SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN`).

## Approval + secured mode

Every skill carries a lifecycle status — `Draft → Approved → Disabled`. **Only `Approved` skills execute**; `Draft` is the safety gate (a skill under authoring or review), `Disabled` is retired. That status gate applies in *both* runtime modes. What the mode decides is whether an `Approved` skill must additionally be **cryptographically keyed**:

| | Unsecured | Secured (`SKILLSCRIPT_SECURED_MODE=true`) |
|---|---|---|
| `Draft` skill | refused | refused |
| `Approved` skill | runs — a bare `# Status: Approved` is sufficient (unkeyed) | runs **only** if the body carries a valid operator signature |
| Tamper-evidence | none (an Approved body can be edited freely) | yes — editing the body breaks the signature |
| Effectful ops (`$`, `shell`, `file_*`, `notify`) | run | **refused unless the skill is signed** (the `effectsAuthorized` capability gate) |
| Who can grant approval | anyone who can set the status | only a holder of the operator's private key |

**Unsecured** is the trusted-author / single-operator convenience posture: you trust whoever writes skills, the status flag is the only barrier. **Secured** is the enforced boundary — an unapproved or tampered skill cannot perform a single effectful op, regardless of how it's dispatched (CLI, cron, `/event`, MCP, in-skill composition). Unsecured is the current default; secured is the recommended posture for any multi-author or networked deployment.

> The shell + filesystem allowlists (below) are **always enforced, in both modes** — they bound *what* a running skill may touch. Secured mode adds the orthogonal boundary on *whether an unapproved skill runs at all*.

### Asymmetric signing — how secured approval works

Approval is an Ed25519 signature, not a shared secret:

- **Private key** — held by the operator, read **only** by the approve flow. That flow is either `skillfile approve` at a terminal (the runtime process never loads the key) or, if you opt into in-browser approval, the dashboard's passcode-gated `/approve` — which reads the key only after a live human enters the session passcode, never on its own. For maximum isolation, keep signing terminal-side and run the runtime under a uid that cannot read the private key — then a co-resident agent can't forge approvals even with full read access to the runtime process. Same-uid (or in-browser signing) still works, but isn't fully isolated (a documented 1.0 precondition; managed custody closes it later).
- **Public key** — non-secret; the runtime reads it to *verify* signatures on every execution. No hot-path secret is the point: verification needs only the public key.

First-run provisioning is automatic — starting the runtime or `skillfile init` in secured mode generates the keypair if absent (private written `0600`, default `~/.config/skillscript/approval.{key,pub}`, deliberately outside `SKILLSCRIPT_HOME`, the agent-readable data dir).

### The approve flow

| Action | How |
|---|---|
| Approve one skill (review the body, then sign) | `skillfile approve <name>` at a terminal |
| Batch-approve everything pending | `skillfile reapprove --apply` (dry-run preview: `skillfile reapprove`) |
| Approve from the dashboard — terminal signing | the **Approvals** queue surfaces the pending set, each skill's security signals, and its effectful footprint; copy the emitted `skillfile approve` command and run it at your terminal |
| Approve from the dashboard — in-browser | with `SKILLSCRIPT_APPROVAL_PASSCODE` set, the queue's **Approve** button signs server-side after a one-time passcode unlock |

**Two signing paths, one custody rule: the private key stays operator-side.**

- **Terminal signing.** With no passcode configured, the dashboard is a pure **review** surface — pending queue, per-skill security signals, effectful-footprint checklist — but `/approve` is disabled and signing happens at your terminal where the key lives. The right posture when the dashboard host and the key-holder's terminal are the same machine.
- **In-browser signing.** With `SKILLSCRIPT_APPROVAL_PASSCODE` set, the dashboard can sign without a terminal round-trip, and holds **no standing signing power**: the first approve in a browser session prompts for the passcode (`POST /unlock`), unlocking signing for that session only (~15-minute idle TTL, server-side, cookie-bound). A live human with the passcode is in the loop for every session — the runtime never gains the ability to approve on its own. Pair it with `SKILLSCRIPT_DASHBOARD_AUTH_TOKEN` (network hygiene on the dashboard) when the dashboard is reachable beyond localhost.

Either way, `skill_write` / `skill_status` **cannot** grant approval in secured mode — an agent-written or status-flipped skill lands `Draft` until a key-holder signs it, enforced at the MCP handler regardless of the SkillStore substrate. (In unsecured mode, `skill_status → Approved` is honored directly, unkeyed.)

**Misconfiguration is loud.** If secured mode and a passcode are both set but signing isn't actually wired (no SkillStore reaches the dashboard, or no readable key), the dashboard surfaces the gap as a banner *and* a stderr boot-log line and stays review-only — skills remain inert (fail-closed) while you see and fix it. The boot-log is what reaches a headless / programmatic adopter who never opens the dashboard.

### Migrating an existing skill set

Turning secured mode on means any skill that's `Approved` without a valid signature is refused at execution. `skillfile reapprove` sweeps the store, reports the set needing re-blessing, and `--apply` re-signs them in one pass — so you don't run `skillfile approve` once per skill.

### Bundled demos

Bundled example skills ship as `# Status: Draft` — a signature baked at package-build time could never validate on your install (the key is per-operator). `skillfile init` locally approves the three seeded demos with *your* machine's authority (secured → provision keypair + sign; unsecured → bare Approved), so they're runnable immediately after init.

## Deleting skills

Deleting a skill is an **operator-only** action — there is **no agent / MCP delete surface** (an agent can author and disable, but only the operator removes). Two surfaces:

| Surface | How |
|---|---|
| CLI | `skillfile delete <name>` |
| Dashboard | the **Delete skill** button on a skill's detail view |

Both are **destructive**: the skill and its version history are erased — there is no trash and no restore in the bundled stores (`FilesystemSkillStore` unlinks the files; `SqliteSkillStore` hard-cascades both tables). Its triggers are dropped from the live scheduler, and its name frees up immediately for a fresh `skill_write`/`store`. The safety is the confirm step plus the reverse-dependency check, not recoverability.

Before deleting, both surfaces run a **best-effort reverse-dependency scan** — which other skills statically reference the target via `$ execute_skill(name="…")` or `inline(skill="…")`. If any do, the delete is **blocked** until you confirm ("`triage-flow` references this — delete anyway?" in the dashboard; `--force` on the CLI). The scan is literal-name only: a runtime-resolved `name="${VAR}"` reference can't be detected statically, so a dynamic caller may slip past the warning — and because delete is permanent, treat the scan as a heads-up, not a guarantee.

Adopter SkillStores implement `delete(name)` per the contract; the runtime only requires "remove from normal views," so a soft-delete (tombstone + filter) is a valid adopter-side choice if you need recovery or audit-grade retention — recovery semantics are the store's concern. See [Connector Contract Reference](connector-contract-reference.md).

## Shell binary allowlist

**The runtime enforces a default-deny operator allowlist for binaries reachable via `shell(...)` ops.** Skill authors are agents, agents are a weak trust anchor (hallucination, prompt-injection, no human-in-loop at scale), and operator-side scoping converts "a human reviews every skill" from discipline into an enforced constraint at the language level.

### The behavior

Two **independent** operator axes — do not conflate:

| Axis | Operator switch | Controls |
|---|---|---|
| **Binary scope** | `SKILLSCRIPT_SHELL_ALLOWLIST` | Which binaries `shell(...)` can invoke |
| **Syntax scope** | `SKILLSCRIPT_ENABLE_UNSAFE_SHELL` | Whether bash interpretation (pipes / `$VAR` / `$(...)`) is permitted |

Behavior matrix:

| Skill op | Binary on allowlist | Binary off allowlist |
|---|---|---|
| `shell(command="X ...")` (structural) | runs | refused with `ShellBinaryNotAllowedError` |
| `shell(argv=["X", ...])` (explicit token list) | runs | refused with `ShellBinaryNotAllowedError` |
| `shell(command="X ...", unsafe=true)` with `enableUnsafeShell=true` | runs (if `bash` on allowlist) | refused (off-list `bash` blocks ALL unsafe shell) |
| `shell(command="X ...", unsafe=true)` with `enableUnsafeShell=false` | refused with `UnsafeShellDisabledError` (syntax axis fires first) | — |

**Off-allowlist is final.** The skill author has no in-skill mechanism to escape it — not the `unsafe` keyword, not `# Autonomous: true`, not `approved="reason"`. Binary scope is an operator boundary the author cannot talk past.

### Three call shapes — `command=`, `argv=`, `unsafe=true`

Three ways to invoke a binary. Each picks a different point on the safety/expressiveness curve:

| Form | When to reach for it |
|---|---|
| `shell(command="curl -s https://example.com/${ID}") -> R` | Simple commands, no spaces or quote-special chars in substituted values. The string is whitespace-tokenized + quote-stripped; structural spawn (no shell). |
| `shell(argv=["say", "-v", "${VOICE}", "-f", "${PATH}"]) -> R` | **Args with spaces, JSON payloads, dynamic strings.** Each list element is exactly one argv token; substitution per element doesn't re-tokenize. Strictly safer than `unsafe=true` — no shell process, no metacharacter interpretation, injection-surface zero. The right tool when a `${VAR}` may contain whitespace. |
| `shell(command="echo hi && date", unsafe=true) -> R` | Pipes, redirects, shell built-ins, command-substitution. Requires `enableUnsafeShell: true` at the runtime; lint flags every appearance (tier-2 `unsafe-shell-op`). |

`argv=` is mutually exclusive with `command=` and with `unsafe=true` (parse errors on either combination — argv is execv-class, there's no shell to opt into). The same allowlist gate applies to `argv[0]`.

### Quote-trap lint (`shell-quoted-var-in-command`)

The pattern `shell(command="echo '${VAR}'")` looks safe — quotes around the substitution — but the structural tokenizer respects quotes during the *original* whitespace split, then strips them. After substitution, if VAR contains quote characters (`Jamie's`) the matching can drift. Tier-2 lint `shell-quoted-var-in-command` fires on this pattern and points at the `argv=` form as the safer answer. Works fine for known-simple values; the lint exists because the failure mode is silent-wrong, not loud-error.

### Discovering your corpus's binaries

The default-deny posture means a freshly-installed runtime with no allowlist wired refuses every `shell()` call. Use `skillfile shell-audit` to enumerate the binaries your skill corpus invokes:

```bash
skillfile shell-audit

# Sample output:
#   Scanned 12 skill(s) under /Users/you/.skillscript/skills.
#
#   Binaries used:
#     curl   (in: weather-fetch, status-probe)
#     git    (in: status-board)
#     jq     (in: weather-fetch, support-response, status-probe)
#     bash   (in: support-response)
#
#   Ready-to-paste .env entry:
#
#   SKILLSCRIPT_SHELL_ALLOWLIST=bash,curl,git,jq
#
#   Note: 'bash' is on the list because at least one skill uses
#   shell(..., unsafe=true). To permit unsafe shell, ALSO set
#   SKILLSCRIPT_ENABLE_UNSAFE_SHELL=true.
```

Paste into your `$SKILLSCRIPT_HOME/.env` (review/narrow as desired). The audit is the canonical path — running it lets you make explicit policy decisions instead of discovering refusals through runtime errors.

### Programmatic bootstrap path (`bootstrap()` adopters)

**The CLI-auto-vs-programmatic-explicit asymmetry.** The CLI (`skillfile dashboard` / `serve`) does several discovery steps automatically — load `$SKILLSCRIPT_HOME/.env`, read `SKILLSCRIPT_*` env vars, load `$SKILLSCRIPT_HOME/connectors.json`. The programmatic path (`bootstrap()` from your own embedder code) does NOT do any of these automatically. Each surface needs explicit wiring on the programmatic path:

| Surface | CLI path | Programmatic path |
|---|---|---|
| `.env` (env vars in a dotfile) | auto-loaded from `$SKILLSCRIPT_HOME/.env` | call `process.loadEnvFile()` yourself BEFORE `bootstrap()` |
| `SKILLSCRIPT_*` env vars | read from `process.env` automatically | read automatically once env is loaded (`bootstrap()` env-fallback) |
| `connectors.json` (MCP wiring) | auto-discovered at `$SKILLSCRIPT_HOME/connectors.json` | pass `connectorsConfigPath: "/path/to/connectors.json"` to `bootstrap()` |

Skip any of these and you get silent-empty surprises — a missing env var, an undeclared connector, etc. — with no hint that the file wasn't loaded. This is intentional: `bootstrap()` stays decoupled from the dotenv + `SKILLSCRIPT_HOME` convention so embedders can drive every input explicitly. The cost is doc-prominence — three surfaces, all silent-empty on omission, all noted here.

For your shell allowlist to work on the programmatic path, ensure the env var is in `process.env` BEFORE calling `bootstrap()`. Two patterns:

```typescript
// Pattern A — load .env yourself + pass connectorsConfigPath
import { join } from "node:path";
import { bootstrap } from "skillscript-runtime";

const home = process.env.SKILLSCRIPT_HOME ?? join(homedir(), ".skillscript");
try { process.loadEnvFile(join(home, ".env")); } catch {}  // Node 22+ built-in
const { mcpServer, scheduler } = bootstrap({
  skillsDir: join(home, "skills"),
  traceDir: join(home, "traces"),
  connectorsConfigPath: join(home, "connectors.json"),
  // shellAllowlist intentionally omitted → bootstrap reads env
});

// Pattern B — fully explicit (env-independent, no .env, no connectors.json)
const { mcpServer, scheduler } = bootstrap({
  skillsDir: join(home, "skills"),
  traceDir: join(home, "traces"),
  shellAllowlist: ["curl", "git", "jq"],
  // No connectorsConfigPath — adopter constructs Registry by hand
});
```

**`bootstrap()` env fallback semantics**: when `opts.shellAllowlist === undefined`, the runtime reads `SKILLSCRIPT_SHELL_ALLOWLIST` from `process.env` (comma-separated, trimmed). When `opts.shellAllowlist` is supplied — including the explicit `[]` deny-all — the option is authoritative and **env does NOT widen it**. This is security-load-bearing: an adopter passing `shellAllowlist: []` to assert lockdown gets lockdown regardless of ambient env.

| `opts.shellAllowlist` | `SKILLSCRIPT_SHELL_ALLOWLIST` env | Effective allowlist |
|---|---|---|
| `undefined` (omitted) | unset | `undefined` → default-deny |
| `undefined` (omitted) | `"curl,jq"` | `["curl", "jq"]` (env fallback) |
| `undefined` (omitted) | `""` (explicit empty) | `[]` (explicit deny-all from env) |
| `["curl"]` | anything | `["curl"]` (explicit opt wins) |
| `[]` (explicit) | `"ssh,kubectl"` | `[]` (explicit deny-all wins; env does NOT widen) |

### Trust model — lint vs. runtime

**Lint is local advisory; runtime is authoritative.** The `shell-binary-not-allowed` lint rule checks against the *author's* environment allowlist (their local `.env` or the linter's loaded config), which may differ from production. Passing lint does NOT guarantee the call will run.

- **Authors** lint with their own allowlist for immediate feedback ("you can't use `ssh` in your dev env, fix this skill").
- **CI pipelines** lint with the deployment's `.env` to catch production-specific gaps before merge.
- **Runtime** is the authoritative gate — refuses off-list binaries at first dispatch regardless of lint state.

This split is intentional: lint as discipline-only would let adopters disable it; runtime as the boundary means the constraint always holds.

### The scope caveat — don't oversell

The allowlist scopes **which** binaries are reachable, not **what they do**. Kills `ssh` / `kubectl` / `rm` / `nc` wholesale — that's real value. Does NOT stop misuse of a permitted binary: `curl` on the list still means curl-to-anywhere (exfil possible to attacker-controlled URLs).

Argument-level policy (host allowlists, URL pattern matching) and OS-level egress controls are **separate, heavier layers** — explicitly out of scope here. Don't let this create false confidence that shell is "solved." For the unsafe path, the proper binary-scope layer is OS-level:

- Restricted `PATH` (only allowed binaries reachable to the runtime process)
- `execve`/`seccomp` filters (kernel-level allowed-binary set)
- Container with curated `/usr/bin` (immutable distroless image)

Parse-based binary enumeration of `bash -c <body>` would be unsound — `e=curl; $e ...`, `$(printf cur)l ...`, `eval`, `xargs`, var-built command names all defeat it. Against agent-author threat models, false confidence is worse than no enforcement.

### Dashboard observability

The dashboard SPA at `http://<host>:<port>` exposes two security-focused surfaces for the observe→promote loop:

**Security view (`#security` route).** Cross-skill list of blocked shell attempts — `{skill, target, binary, body, timestamp}` per refused call. Aggregated by binary so you can see at a glance "what did skills try to invoke that I haven't allowlisted." Backed by the `blocked_shell_attempts` MCP tool, which filters trace records by `blocked_reason: "binary-not-allowed"`. Runtimes without the tool exposed degrade cleanly to an "unavailable" note.

**Skill detail view — footprint checklist + security signals + source highlighting.** Each skill's detail page (clicking a skill name from `#skills`) shows:
- A **"What this skill touches"** panel right at the approve action: the skill's **effectful footprint** — the MCP connectors it dispatches to, built-in `$` ops, shell binaries, and counts of `file_write` / `file_read` / unsafe-shell / `notify` ops, or "nothing effectful to authorize" for a pure skill. This is AST-derived — the *same* op enumeration the capability gate authorizes — so it's the authoritative surface the skill can touch once signed, not a textual guess. The least-privilege checklist the approver reads before signing.
- A **"Security signals"** panel: aggregated counts of shell ops + binaries used, unsafe-shell count, `# Autonomous: true`, per-op `approved="..."` authorizations, mutation ops (`$ skill_write` / `$ data_write` / `file_write`), wake-class `@session` deliveries, cron triggers. (A heuristic source scan — it adds risk-framing signals the footprint doesn't, e.g. the `approved=` bypass and the autonomous flag; the two panels complement each other.)
- **Inline tinted highlighting** on the skill source `<pre>` body. Two tiers: **orange** for HIGH-tier signals (`unsafe=true`, `# Autonomous: true`, `approved="..."`, mutation ops); **yellow** for MEDIUM-tier signals (`shell(...)` calls, `notify(agent="X@session", ...)` wake-class deliveries). Reviewers scan-prioritize: orange = review carefully; yellow = worth noting.

The surfaces compose: the footprint says WHAT the skill can do, the security-signals panel says WHAT to scrutinize, the highlights say WHERE to look. The same footprint rides every `skill_list` entry and the `skill_preflight` contract, so an agent composing against a skill reads the same truth the human approver does.

### Future direction

Per-skill capability declaration: skills declare what shell binaries they need in their frontmatter:

```
# Skill: status-board
# Shell: git, jq
# Status: Approved
```

The operator policy validates `declared ∩ allowlist` — each skill's shell footprint becomes self-documenting and auditable. Slated for a future ring once the chokepoint + observability surfaces ship.

## Filesystem path allowlist

**The runtime enforces a default-deny operator allowlist for paths reachable via `file_read(...)` / `file_write(...)` ops** — the third operator boundary, mirroring the shell allowlist with the same rationale (skill authors are agents; the operator scopes which parts of the filesystem skills may touch).

| Operator switch | Controls |
|---|---|
| `SKILLSCRIPT_FS_ALLOWLIST` | Comma-separated roots under which `file_read` / `file_write` may operate |

- **Default-deny.** An unset or empty allowlist refuses *every* file op with `FilePathNotAllowedError` — a freshly-installed runtime does no file I/O until you wire roots. Applies to `file_read` as well as `file_write` (a read-then-`emit` is an exfiltration path).
- **Canonicalized before the check.** Both the target and each allowed root are resolved to their real absolute path (realpath, component-by-component), so `..` traversal and symlink evasion can't escape an allowed root — the classic allowlist bypasses are closed.
- **Off-allowlist is final.** No in-skill keyword (`approved=`, `# Autonomous: true`) escapes it. **Keep secret / key directories OUT of the allowlist** — a skill must never be able to read the operator's approval key. (This is why the default key path lives outside `SKILLSCRIPT_HOME`.)

```bash
# permit reads/writes under a workspace + an event-drop dir
SKILLSCRIPT_FS_ALLOWLIST=/srv/skillscript/workspace,/var/skillscript/events
```

TOCTOU note: the check resolves the real path at call time; a symlink swapped between check and open is a residual closed by fd-based opens later. Checking the resolved real path is the standard mitigation shipped today.

## Trigger model

**The trigger surface is two primitives.**

| Primitive | Purpose |
|---|---|
| `cron` | Time-based fires (unchanged) |
| `event` | Generic external-signal fires via HTTP POST to `/event` |

Concepts that look like triggers but aren't — session lifecycle, agent events, file-watch, sensors — are **adapter responsibilities**: external code POSTs `/event` when relevant. Keeps the runtime substrate-neutral; the trigger surface stays tight. The `DeliveryMeta.origin.trigger_kind` receiver enum exposes only `"cron" | "event" | "webhook" | "agent" | "cli" | "dashboard" | "inline"`.

### The `event` primitive

Skills declare an event trigger in their frontmatter:

```
# Skill: prox-handler
# Status: Approved
# Triggers: event: prox
# Vars: ROOM, USER

t:
    emit(text="${USER} entered ${ROOM}")
default: t
```

External services drive the skill by POSTing:

```
POST /event HTTP/1.1
Host: localhost:7878
Content-Type: application/json
Authorization: Bearer <token>   # if SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN set

{
  "event_name": "prox",
  "params": { "ROOM": "kitchen", "USER": "alice" }
}
```

Response on accept:

```json
{ "run_id": "f4a8b21c-...", "durability": "in-process" }
```

The `run_id` is the runtime's `trace_id` — adopters paste it into the dashboard `/fires` view or query via the `fires({trace_id})` MCP tool to look up completion status.

### Wire contract

| HTTP status | Meaning |
|---|---|
| **200** | Accepted into THIS process's in-memory queue. `{run_id, durability: "in-process"}`. Skill fires async; the 200 does NOT mean skill-completed |
| **400** | Body not JSON; or `event_name` missing/empty; or params don't match declared (missing required or unknown extras) |
| **401** | Auth token configured + missing/wrong `Authorization: Bearer <token>` |
| **404** | `/event` route not enabled OR `event_name` not registered |
| **405** | Wrong method (POST-only) |

**Param validation is strict v1**: every declared param must be present; no unknown params accepted. No defaults; no type coercion. JSON already carries types, and a type mismatch fails inside the consuming op with a real error. Defaults + types may land in v2 if real adopter need surfaces.

### `# Autonomous: true` for event/cron skills doing mutations

Skills fired by cron OR event have **no interactive author** to confirm mutation ops. The runtime's mutation gate (`$ data_write` / `$ skill_write` / `file_write` / mutating MCP tools) requires explicit authorization in non-interactive contexts. Three authorization paths exist:

```
# Option A — skill-level: # Autonomous: true (recommended for cron/event skills)
# Skill: morning-sweep
# Status: Approved
# Triggers: cron: 0 9 * * *
# Autonomous: true

m:
    $ data_write content="..." tags=["digest"] -> R
    emit(text="sweep done")
default: m
```

```
# Option B — per-op: approved="<reason>" kwarg
# Skill: event-handler
# Status: Approved
# Triggers: event: incident-report
# Vars: SEVERITY

m:
    $ data_write content="${SEVERITY}" approved="event-fired" -> R
default: m
```

Option C (preceding `??` / `ask()` in same target) is for interactive contexts (CLI / dashboard) and doesn't apply to cron/event fires — there's no user to ask.

Without one of these, the runtime throws `UnconfirmedMutationError` at the mutation op + the skill fails its fire. Symptom in the trace: `class: "UnconfirmedMutationError"` on the offending op.

The mutation gate is identical for cron + event sources — both are non-interactive. Lint surfaces `unconfirmed-mutation` as tier-2 warning at compile time so authors get the signal before the first fire.

### `event_name` semantics

- **Public contract** addressed by POSTers. Skill behind the event can swap without breaking callers — the `skill_name` is private impl.
- **Case-insensitive** at register + lookup (normalized to lowercase internally).
- **1:1**: one `event_name` → exactly one skill in the deployment. Fan-out is NOT supported — a skill can call other skills via `$ execute_skill` if needed.
- **Cross-skill rebind allowed but audited**: registering an `event_name` that's already bound to a different skill replaces the binding (last-write-wins) AND logs a visible line (`event_name 'X' rebound: skill A → skill B`). Prevents silent cross-skill hijack without blocking the declarative re-save path. Same skill re-registering its own event is a silent upsert.

### Enabling the `/event` HTTP ingress

Off by default. Two operator knobs:

```bash
# Required to open the /event route
SKILLSCRIPT_EVENT_INGRESS_ENABLED=true

# Optional bearer-token auth (when set, required on every POST /event)
SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN=<token>
```

When `eventIngressEnabled=true`, the route mounts on the same HTTP server as the dashboard/RPC (no second port). Default bind is `127.0.0.1` (localhost-only) — adopters wanting `0.0.0.0` external reach pass `--host 0.0.0.0` explicitly. The DMZ assumption is enforced by the bind, not by hope.

### Durability honesty

**`200 = ACCEPTED, not durable**.** The skill is queued in this process's memory; if the process crashes or restarts before the queue drains, the fire is lost. The `durability: "in-process"` field on every successful response self-describes this — adopters reading the response know the contract without consulting docs. Cron triggers have the same property today (no catch-up replay if the process was down).

Durable / at-least-once delivery is a v2 if real adopter need surfaces. Don't oversell the 200 contract; build durable queueing on top yourself if you need it now.

### Bridging external sources

Anything that isn't time-based is an external adapter that POSTs to `/event`:

- **Session start/end** — your harness POSTs `/event` after boot or before shutdown if you want a skill to fire at session boundaries.
- **Agent events** — your agent emits `POST /event` when the event of interest occurs.
- **File-watch** — an external watcher script (`inotify` / `chokidar` / `fswatch`) POSTs to `/event` on changes. The file-watching itself is standard OS plumbing — you own that script.
- **Sensors** — same pattern as file-watch; the sensor adapter POSTs to `/event`.

Skills declaring unsupported `# Triggers:` sources fail to parse with a tier-1 parse error. `skillfile lint` against your corpus surfaces them.

## Output template — body text IS the output

A skill's body text — prose lines that don't sit inside a target — is its declarative output template. The runtime interpolates `${VAR}` references against final vars and publishes the rendered string as the skill's canonical output (`outputs.text` or the agent/template/file payload, depending on `# Output:` kind). No `emit()` ceremony required for the common case. The template may appear **anywhere a target doesn't** — at the top, at the bottom, or split between targets — so authors can put output where their language instincts suggest (most write the output line *after* the compute that fills it in).

### The shape

```
# Skill: get-weather
# Vars: AREA="Brooklyn", TEMP="72", UNIT="F", DESC="sunny"

${AREA}: ${TEMP}°${UNIT} and ${DESC}.

fetch:
    shell(command="curl -s --max-time 10 https://wttr.in/${AREA|url}?format=j1") -> RAW
    $ json_parse ${RAW} -> W
    $set TEMP = "${W.current_condition.0.temp_F}"
    $set DESC = "${W.current_condition.0.weatherDesc.0.value|trim}"
default: fetch
```

Strip the compute block and the skill still emits the template with whatever the `# Vars:` defaults are. The author writes the sentence they want as output; the compute block fills in the holes.

### Complementary channels — template vs. emit

Two independent output channels:

| Channel | Source | Consumer |
|---|---|---|
| Canonical output (`outputs.text`, agent/template/file payloads) | Body template if authored, else joined `emit()` text | The caller / lifecycle-hook recipient / file write |
| Transcript (`emissions[]`) | All `emit(text=...)` calls + reasoning ops (`?`, `@`) | Trace records, dashboard `/fires` view, debug log |

When a skill defines both a template AND `emit(text=...)` calls, the template owns canonical output; `emit()` populates transcript only. This is intentional — emit is the debugging / reasoning channel. The `emit-with-template` advisory lint surfaces this to confirm intent.

If you want emit to be your canonical output, don't write a body template. Emit-only skills route emissions to the canonical output channel.

### Output kinds

The body template populates whatever `# Output:` kind the skill declares:

- `# Output: text` (default) — caller reads `outputs.text`
- `# Output: agent: <name>` — rendered template delivered as augment payload to `<name>` via AgentConnector
- `# Output: template: <name>` — rendered template delivered as playbook payload
- `# Output: file: <path>` — rendered template written via file ops in the body

### Target syntax — what counts as a target

A target is `<name>:` alone on a line, with an indented op-block on the next non-blank line. Anything else in the body region — content after a colon, a bare `Note:` with no following op-block, plain prose — reads as template text.

Two examples that are legal but worth knowing:

```
Summary: today is hot.        ← template (content after colon, no op-block)
Temp: ${T}                    ← template (content after colon)

Note:                          ← AMBIGUOUS — lint `template-looks-like-target` fires
                                  bare word: alone, no op-block. Disambiguate by adding
                                  content after the colon OR indent an op-block under it.
```

Target declarations with dependencies still work via the explicit `needs:` keyword, which makes intent unambiguous:

```
report: needs: fetch_issues
    emit(text="…")
```

The legacy `report: fetch_issues` shape (deps after colon, no `needs:` keyword) is still parsed as a target when an indented op-block follows on the next line, but `needs:` is the recommended form for new skills.

### One template region per skill

A skill may carry template prose in one region. Splitting it into two — some prose above the targets AND some below — raises a tier-1 parse error: "skill has body template content in two places (before targets AND after targets). Pick one location." Picking is loud over silent-concat; the author chooses where the template lives, the runtime doesn't guess.

### Lints to know

- **`unset-template-var`** (tier-1) — every `${VAR}` in the template must resolve to a `# Vars:` / `# Requires:` input, an ambient ref (`NOW`, `USER`, ...), or a `$set` / `->` binding somewhere in the skill body. Tier-1 because an unbound ref renders empty silently.
- **`template-looks-like-target`** (tier-2) — bare `<word>:` alone in the template region, no following op-block. Ambiguous shape — author may have meant a target.
- **`connector-as-tool`** (tier-1) — `$ <connector> <tool>` space-separated catches the muscle-memory foot-gun (CLI-style `git status`). Bare-form dispatch treats the first token as the tool name, sending `name: "<connector>"` to the MCP server, which replies with a misdirecting `Tool '<connector>' not found.` The two correct shapes are `$ <connector>.<tool> args` (dotted) or `$ <tool> args` (bare-tool; runtime resolves).
- **`remote-result-needs-parse`** (tier-3) — `${R|length}` on an `R` bound by `$` dispatch. Per-MCP-server result shapes vary: if the server returns prose-wrapped or non-JSON text, the value binds as a STRING and `|length` returns the string's char-count instead of element-count. Add `$ json_parse ${R} -> P` after the dispatch and use `${P|length}`. Suppressed when the skill already does `$ json_parse ${R}` somewhere — your defensive parse is taken as intent.
- **`body-template-detected`** (tier-3) — non-blank, non-`#` lines in the body region, no `${...}` interpolations, no text-consuming `# Output:` declaration. Suggests "I wrote prose; it became template by accident." Prefix with `#` to mark as comments, or add an interpolation / `# Output:` to confirm intent.
- **`emit-with-template`** (tier-3) — skill has both a template AND `emit(text=...)` calls. Confirms the channel-shift is intentional.

## Fallback semantics — `(fallback: ...)` op-trailer and `|fallback:` filter

Two surfaces, **one emptiness predicate**. Both fire when the upstream value is any of:

- empty string after `trim()`
- empty array (`[]`)
- `null` / `undefined`

### Op-trailer — `(fallback: "value")`

Trails the `-> R` binding on `$` dispatch ops, `shell(...)`, `file_read(...)`. Binds the fallback value to `R` when the op throws OR produces an empty result.

```
$ ticketing.search query="open" -> ISSUES (fallback: [])

shell(argv=["gh", "pr", "list", "--repo", "owner/repo"]) -> PRS (fallback: "No current PRs.")

file_read(path="/var/reports/today.md") -> REPORT (fallback: "no report")
```

When the fallback fires, the runtime pushes a record onto `result.fallbacks[]` so callers can distinguish "real value" from "fallback substituted." The original error message rides on the fallback record's `reason` field; the op completes cleanly.

### Filter — `${VAR|fallback:"value"}`

Substitution-time fallback inside a template or kwarg. Same emptiness predicate; binds to the filter argument when the upstream value is empty.

```
Open PRs: ${PRS|fallback:"none today"}.

$ llm prompt="Triage this: ${INPUT|fallback:'(no input — skip)'}" -> JUDGMENT
```

The filter is positional in chains: `${RAW|trim|fallback:"-"}` applies trim first, then fallback if the trim left an empty string.

### When to use which

- **Op-trailer** for *binding-time* protection — the variable lands populated regardless of the op's outcome. Downstream consumers (other ops, template renders) don't need to know whether the value is real or fallback.
- **Filter** for *substitution-time* defaulting — the variable may legitimately be empty/unset, you just want a placeholder at the render site.

Most "no current results" patterns want the op-trailer (the variable becomes the canonical record of what happened). The filter is for "if the optional input wasn't supplied, show a placeholder" cases.

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

**Pattern 1 — `agent@session` opaque composite.** Every messaging substrate needs either bare-identity OR specific-live-session addressing. The contract keeps `agent_id` opaque; sessions ride as `"<agent>@<session>"` (e.g. `"alice@laptop-tab-3"`) or via `WakeOpts.session_id`. Substrates that care decompose; substrates that don't ignore.

The runtime address-routes skill-author surfaces (`notify()` + `# Output: agent:` / `template:`) on `@session` presence: bare → your `deliver()`, composite → your `wake()`. You receive whichever method the runtime decided; your job is to honor what arrives. For `wake()`, expect the FULL composite (`"<agent>@<session>"`) — decompose to route to the right session:

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

**Pattern 3 — session echo on receipts.** When your substrate routes to a specific session, echo it back on `DeliveryReceipt.session_id` / `WakeReceipt.session_id`. Dashboards rendering "delivered to alice@laptop-tab-3" rather than just "delivered to alice" depend on this.

**Pattern 4 — read `meta.origin.caller_agent_id` to attribute, not for scope.** The `DeliveryMeta` envelope your `deliver()` receives carries `origin.caller_agent_id` = the *authenticated caller* who fired the dispatch (not the skill's owner — those are separate semantics; see [Connector Contract Reference](connector-contract-reference.md) §field semantics). Use it for *attribution* — rendering `from <caller>` on the receiving end, audit logs, accountability — not for authorization scoping. Outbound substrate scoping should derive from the *skill owner* (which the runtime applies at the connector layer via `ctx.agentId`, not via the envelope). If `caller_agent_id` is undefined on a delivery you receive, it means the chain originated from a non-human trigger (cron / event / scheduler) — your substrate should attribute it as "system-fired" or similar, not assume an identity.

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

**Gotcha:** in **secured mode**, a direct-write declaring `# Status: Approved` without a valid signature is forced to `Draft` — the substrate can't mint approval, only the operator's key can. Publish by writing `Draft`, then signing via `skillfile approve <name>` or the dashboard Approvals queue (both preserve the captured author). In **unsecured mode** a bare `# Status: Approved` direct-write is honored as-is. Either way, in-skill `$ skill_write` always lands its child `Draft` regardless of body declaration. See [Approval + secured mode](#approval--secured-mode).

## Identity propagation — for multi-agent hosts

**Skip this section** if your runtime serves one agent (CLI tools, single-user dashboards, hobby deployments). The default — `SkillMeta.author` captured from the SkillStore's writer identity — already attributes authorship correctly when there's only one writer.

This section is for adopters whose runtime is fronted by an MCP host that bridges multiple authenticated agents into one transport (e.g., a multi-agent gateway, or a multi-tenant SaaS where agents share a runtime pool).

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

Multi-agent host (custom MCP gateway, etc.) is responsible for setting the header on every outbound request:

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

The runtime trusts the host's header attestation. There's no signature verification on the *identity claim* (distinct from secured-mode approval, which *is* signature-verified — different boundary, different mechanism): anyone reaching the runtime with a forged `X-Agent-Id` could claim to be anyone. The runtime is **not** the authentication boundary; the host is. Bilateral trust:

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
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"skill_preflight","arguments":{"name":"smoke"}}}' \
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
- **Two trigger primitives, both functional.** `cron` (time-based) and `event` (HTTP `/event` ingress, named registration). All other concepts that look like triggers — session-start, agent-event, file-watch, sensor — are adapter responsibilities: the adapter POSTs `/event` when relevant. Keeps the runtime substrate-neutral; the trigger surface stays tight.
- **Output kinds are intentionally substrate-neutral.** `# Output:` accepts `text` / `agent: <name>` / `template: <name>` / `file: <path>` / `none`. Substrate-specific values (`slack:`, `card:`, etc.) are out of scope — adopters wanting Slack / WhatsApp / Discord / etc. delivery use either `$ slack.post ...` MCP dispatch inside the skill body OR deliver via `agent: <name>` and let the receiving agent decide.
- **Authorization is signature-based in secured mode.** An `Approved` skill runs unkeyed in unsecured mode (a bare `# Status: Approved` is sufficient) and requires a valid Ed25519 operator signature in secured mode — verified on every execution against the operator's public key, with the private key held off the runtime. See [Approval + secured mode](#approval--secured-mode) for the model, the approve flow, key custody, and migration. The shell + filesystem allowlists bound blast radius in *both* modes; secured mode is what gates whether an unapproved skill runs at all.

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
