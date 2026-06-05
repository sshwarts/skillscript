# HttpWebhookAgentConnector — example

Worked example of `AgentConnector` against an HTTP-webhook substrate. Copy this directory into your codebase, customize per your substrate, register with skillscript-runtime's `Registry`. This README is written for the agent implementing your adopter's connector — including the human reviewing the PR.

**What this demonstrates**: the locked v1.0 contract surface (Q1-Q12 from the v0.9.6 audit) wired through real HTTP traffic, plus the three deployment models the wire format supports.

---

## Quick start

```typescript
import { Registry } from "skillscript-runtime";
import { HttpWebhookAgentConnector } from "./HttpWebhookAgentConnector.js";

const registry = new Registry();
// Async — bootstrap-throws on health_check() returning false (audit Q6).
await registry.registerAgentConnector("primary", HttpWebhookAgentConnector.fromEnv());
```

Author writes skills like:

```
# Skill: morning-status
# Status: Approved
# Output: agent: agent-slack
m:
    emit(text="overnight sweep clean")
default: m
```

Runs → POSTs to the URL configured for `agent-slack` → receiver lands the message in its substrate (Slack, Discord, NanoClaw, whatever).

---

## Configuration

Three env vars; see `.env.example`.

`HTTP_WEBHOOK_AGENTS` — required. Nested JSON map; keys are `agent_id` strings; values are per-agent config:

```json
{
  "agent-slack":    { "url": "http://localhost:3200/webhook/slack",    "wake_url": "http://localhost:3200/wake/slack" },
  "agent-whatsapp": { "url": "http://localhost:3200/webhook/whatsapp" }
}
```

- `url` (required) — POST destination for `deliver()` calls
- `wake_url` (optional) — POST destination for `wake()` calls. When absent, `wake()` degrades gracefully: returns `WakeReceipt {woken: false}` instead of throwing. Distinguishes capability-gap (this agent has no interrupt channel) from operational fault (HTTP error), per the contract's graceful-degradation rule.
- `status_url` (optional) — GET probe for `agent_status?()` + `health_check()`; skipped if missing

`HTTP_WEBHOOK_TIMEOUT_MS` — total request duration (connect + send + receive + parse). Default `5000`.

`HTTP_WEBHOOK_AUTH` — bearer-token value. When set, every POST includes `Authorization: <value>`. Use for substrate endpoints behind a shared secret.

`HTTP_WEBHOOK_HMAC_SECRET` — HMAC-SHA256 signing secret. When set, every POST includes `X-Signature: sha256=<hex>`. See [Auth section](#auth) for the body-signing semantics.

---

## Wire format

### Outbound (skillscript → your receiver)

`POST <configured-URL>` with `Content-Type: application/json`:

```json
{
  "agent_id": "agent-slack",
  "kind": "augment",
  "content": "the message text",
  "meta": {
    "dispatch_id": "uuid-v4",
    "sent_at": 1700000000000,
    "origin": {
      "skill_name": "morning-status",
      "trigger_kind": "cron"
    },
    "event_type": "status-update"
  }
}
```

Field semantics:

- **`agent_id`** (top-level, NOT in canonical DeliveryPayload) — included here so Model B receivers (single URL, body-routed) can dispatch without inspecting URL.
- **`kind`** — `"augment"` (context-to-absorb) or `"template"` (playbook-to-execute).
- **`content`** / **`prompt`** — message body. `content` for augment kind; `prompt` for template kind.
- **`meta`** — runtime-filled envelope (skillscript v1.0 contract Q8).
  - **`dispatch_id`** — UUID per `notify()` invocation. Receivers use for substrate-retry idempotency. Multi-connector broadcast shares dispatch_id; sequential `notify()` calls produce distinct ids.
  - **`sent_at`** — sender's emit-clock (unix ms). NOT the substrate's delivered_at.
  - **`origin.skill_name`** — emitter skill.
  - **`origin.entry_skill_name`** (optional) — root entry-point skill when distinct from `skill_name` (set during procedural composition).
  - **`origin.trigger_kind`** — `cron` / `session` / `webhook` / `agent` / `cli` / `dashboard` / `inline`.
  - **`origin.caller_agent_id`** (optional) — root-trigger agent IF identifiable, else absent.
  - **`event_type`** (optional) — adopter-defined routing vocabulary.
  - **`correlation_id`** (optional) — reply-correlation for future v0.10 `exchange()` op.

**Optional fields are ABSENT when not set, never present-as-null.** TypeScript `?` semantics: `JSON.stringify` elides `undefined` keys. Receiver code: `if (meta.event_type)` works; `if (meta.event_type !== null)` is wrong.

### Inbound (your receiver → skillscript)

Return JSON body matching canonical `DeliveryReceipt`:

```json
{
  "delivered_at": 1700000000005,
  "delivery_id": "your-substrate-id-optional",
  "session_id": "kitchen-terminal-optional",
  "delivery_skipped": false
}
```

**The connector is tolerant about receiver response shapes** — if your substrate returns something different (NanoClaw `{status, id}`, Discord message JSON, Slack `{ts, channel}`), the connector synthesizes a canonical receipt by reading common fields:

- `delivered_at` ← receiver's value, else `Date.now()`
- `delivery_id` ← `delivery_id` / `id` / `ts` (first match)
- `session_id` ← receiver's value if present (substrate-routed to a specific session)
- `delivery_skipped` ← receiver's value if `true`

Adopters with strict substrate shape can replace the `synthesizeReceipt()` helper. Bundled example is permissive.

### HTTP status codes

- **2xx** → parse JSON receipt; return through
- **4xx** → throw `DeliveryFailedError(kind: "http_status")` — permanent failure
- **5xx** → throw `DeliveryFailedError(kind: "http_status")` — transient (adopter with retry policy forks around this)
- **Network error / timeout** → throw `DeliveryFailedError(kind: "network" | "timeout")`

### Wake — capability gap vs. operational fault

`wake()` distinguishes two failure modes per the contract's graceful-degradation rule:

| Situation | `wake()` behavior | `WakeReceipt.woken` |
|---|---|---|
| `wake_url` configured for `agent_id`, POST returns 2xx | Send attention signal | `true` |
| `wake_url` NOT configured for `agent_id` (capability gap — this substrate has no interrupt channel for this agent) | No-op, return receipt | `false` |
| `agent_id` not configured at all (caller misconfiguration) | Throw `Error("agent not configured: ...")` | — |
| `wake_url` configured but POST fails (operational fault) | Throw `DeliveryFailedError` | — |

The capability-gap case (no `wake_url`) is a deliberate fork choice: passive substrates conform by degrading. Callers reading `WakeReceipt.woken` distinguish interrupted-them from delivered-only without needing per-substrate knowledge.

### `agent@session` targeting

`agent_id` is opaque to the connector at the wire level — whatever the skill passes flows through to the configured per-agent `url`. Substrates that track multiple live sessions per identity can address them via the `agent@session` composite (e.g., `"perry@kitchen-terminal"`) OR the structured `WakeOpts.session_id` form. The connector forwards the resolved `agent_id` in the POST body; the receiver decomposes if it cares. Echo the resolved session on `DeliveryReceipt.session_id` / `WakeReceipt.session_id` so dashboards can render "delivered to perry@kitchen-terminal" instead of just "delivered to perry."

See [Connector Contract Reference](../../../docs/connector-contract-reference.md) §"agent@session targeting" + §"Graceful degradation on wake" for the contract-level rules.

---

## Three deployment models

The wire format supports all three without connector code changes:

### Model A — One URL per agent_id

```json
{
  "agent-slack":    { "url": "http://nanoclaw-a:3200/webhook" },
  "agent-whatsapp": { "url": "http://nanoclaw-b:3201/webhook" }
}
```

Each URL is fully self-contained — receiver knows where to route by virtue of which host/port/path it was hit on. Adopter runs multiple receivers OR one receiver with URL-distinguished routing (paths/query params).

### Model B — Single URL, router receiver, agent_id in body

```json
{
  "agent-slack":    { "url": "http://receiver:3200/webhook" },
  "agent-whatsapp": { "url": "http://receiver:3200/webhook" }
}
```

Both POSTs go to the SAME URL. Receiver inspects `body.agent_id` and dispatches accordingly. Cleaner when adopter already has a routing layer (e.g., one Slack workspace with channel-as-agent_id).

### Model C — Variable-driven channel selection in the skill

```
# Skill: contextual-alert
# Status: Approved
# Vars: CHANNEL="slack"

m:
    notify(agent="agent-${CHANNEL}", message="alert")
default: m
```

Works on top of Model A or B. The skill picks channel at RUNTIME via `${VAR}` substitution. Caller can override per-invocation: `execute_skill(inputs={CHANNEL: "whatsapp"})`.

---

## Auth

### No auth (default)

Skip both `HTTP_WEBHOOK_AUTH` and `HTTP_WEBHOOK_HMAC_SECRET`. Suitable for substrates behind a network boundary (host-local, container-network, VPN-only).

### Bearer token

```
HTTP_WEBHOOK_AUTH=Bearer abc123
```

Connector adds `Authorization: Bearer abc123` to every POST. Receiver validates the header. Suitable for trusted internal endpoints; simple shared-secret pattern.

**Bearer + HMAC are combinable.** When both `HTTP_WEBHOOK_AUTH` and `HTTP_WEBHOOK_HMAC_SECRET` are set, every POST gets both an `Authorization` header AND an `X-Signature` header. Most adopters need only one; combine when you want auth-identity AND body-integrity (e.g., bearer identifies the caller, HMAC proves the body wasn't tampered with downstream of caller).

### HMAC-SHA256 body signing

```
HTTP_WEBHOOK_HMAC_SECRET=<base64-or-hex-secret>
```

Connector signs the RAW HTTP body with HMAC-SHA256 and adds `X-Signature: sha256=<hex>` header. Use when body-integrity matters (e.g., when HTTPS terminates somewhere unexpected, or when receiver wants tamper-detection).

**Receiver MUST validate signature against the RAW HTTP body BEFORE parsing JSON.** Common foot-gun: receiver decodes JSON first, then re-encodes for hashing → hash mismatch from key ordering / whitespace drift. The bundled receiver examples demonstrate the correct pattern (Express uses `express.raw()`; Flask uses `request.get_data()`).

### Roll your own (OAuth, mTLS, etc.)

Fork `HttpWebhookAgentConnector.ts` + customize the request-construction path. The contract is `AgentConnector.deliver()` — anything that satisfies it works.

---

## Receiver examples

Two reference snippets in `receiver-example/`:

- **`express.js`** — Node + Express. ~50 LOC including HMAC validation.
- **`flask.py`** — Python + Flask. ~50 LOC, same shape.

Both demonstrate:
- Raw-body parsing for HMAC validation
- Skillscript envelope → substrate routing translation
- Canonical DeliveryReceipt response shape
- Clock-skew note for staleness checks

Copy + customize per your substrate. These are reference patterns, not shipped code — there are no tests because this is your code path.

---

## What's deliberately out of scope (fork to add)

- **Retries** — example is fail-fast. Retry semantics are substrate-specific (webhook 5xx ≠ rate-limit 429 ≠ substrate-down). Adopters wanting retries customize `deliver()` directly.
- **Multi-region failover URLs per agent** — adopter-specific.
- **OAuth flows / mTLS / SAML** — adopter-specific auth providers.
- **Streaming deliveries (HTTP/2 push, websockets)** — different substrate class.
- **Async-callback reply pattern for `request_response()`** — v0.10 design choice (sync hold-connection vs async callback). Today the method throws `NotImplementedError` until v0.10 ships `exchange()`.

---

## Forking discipline

If you fork this example into your codebase:
- **Don't modify the canonical `DeliveryPayload` / `DeliveryReceipt` shapes** — those are skillscript-runtime contracts. Your customizations go in HOW you serialize / parse, not WHAT.
- **Keep `agent_id` at top-level in the POST body IF you want Model B receivers downstream of your fork** to route without URL inspection. Model-A-only deployments (URL-distinguished routing) can drop it; the canonical contract doesn't require it.
- **Preserve the `meta` envelope** — adopters downstream rely on `dispatch_id` / `sent_at` / `origin` / `event_type` / `correlation_id`.
- **If you change the auth model, document it** in your fork's README. Adopter-agents reading your code need to know what's at stake.

---

## Tests

`tests/HttpWebhookAgentConnector.test.ts` exercises:

- `deliver()` posts the correct body shape (agent_id + kind + content + meta)
- Both `kind: "augment"` and `kind: "template"` round-trip
- Receiver returns canonical receipt → parsed cleanly
- Receiver returns substrate-shaped response → synthesizeReceipt translates
- Receiver returns `delivery_skipped: true` → honored on the receipt
- 4xx / 5xx → throws `DeliveryFailedError`
- Network timeout → throws `DeliveryFailedError`
- `list_agents()` returns all configured agent_ids
- Multi-agent_id routes to distinct URLs
- `health_check()` returns true with no status_urls configured
- `request_response()` throws NotImplementedError (Q1 v0.10 deferred)
- HMAC signing produces the correct `X-Signature` header value
- Bearer auth sets the correct `Authorization` header
- `wake()` degrades to `woken: false` when `wake_url` is unconfigured (graceful degradation)
- `wake()` returns `woken: true` when the POST succeeds

Run via `vitest run examples/connectors/HttpWebhookAgentConnector/tests/`.

---

## Cross-references

- [Connector Contract Reference](../../../docs/connector-contract-reference.md) — canonical AgentConnector contract
- [Adopter Playbook](../../../docs/adopter-playbook.md) — broader adopter context
- [Language Reference](../../../docs/language-reference.md) — `notify()` op + `# Output: agent:` lifecycle hook syntax
