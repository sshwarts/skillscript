# Connector Contract Reference

The substrate-neutral contracts skillscript-runtime exposes for adopters to wire their own substrate behind. This doc is the **canonical source of truth** for the AgentConnector contract as locked at v1.0 by the v0.9.6 audit (Perry's thread `b722bbf4`).

**Audience**: this doc is written for the agent that's implementing an adopter's AgentConnector — typically an LLM-class agent supervised by a human. If you're a human reading it directly, the same content applies; the prose is tightened for agent comprehension (literal field semantics, explicit precedence rules, worked examples).

Other contracts (McpConnector, SkillStore, MemoryStore, LocalModel) audit + lock in subsequent v0.9.x slots; this doc grows with each lock.

---

## AgentConnector — v1.0 contract (locked v0.9.6)

### Purpose

Substrate-neutral delivery of payloads to a *frontier agent*. The runtime calls into the contract; the adopter implements the substrate (webhook, tmux session, file drop, IPC pipe, Slack thread, whatever).

The contract is intentionally minimal. Every required method represents a thing the adopter must implement correctly for their substrate. The runtime fills `DeliveryMeta` envelope on every `deliver()` call — adopters CONSUME meta (substrate-side translation), they NEVER CONSTRUCT it.

### Interface

```typescript
interface AgentConnector {
  list_agents(): Promise<AgentDescriptor[]>;
  deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt>;
  wake(agent_id: string, opts?: WakeOpts): Promise<WakeReceipt>;
  health_check(): Promise<boolean>;
  request_response(agent_id: string, payload: DeliveryPayload, opts: RequestResponseOpts): Promise<Response>;
  agent_status?(agent_id: string): Promise<AgentStatus>;
}
```

**Required**: `list_agents`, `deliver`, `wake`, `health_check`, `request_response`.
**Optional**: `agent_status`.

`request_response` is locked at v1.0 for the upcoming `exchange()` op shipping in v0.10. Until v0.10 runtime support lands, adopters should throw `NotImplementedError` from this method (see `NoOpAgentConnector` for the canonical pattern).

### DeliveryPayload + DeliveryMeta

```typescript
type DeliveryPayload =
  | { kind: "augment"; content: string; meta: DeliveryMeta }
  | { kind: "template"; prompt: string; meta: DeliveryMeta };

interface DeliveryMeta {
  dispatch_id: string;       // UUID per emit; same across broadcast branches
  sent_at: number;           // unix ms — runtime emit-clock
  origin: {
    skill_name: string;
    entry_skill_name?: string;
    trigger_kind: "cron" | "session" | "webhook" | "agent" | "cli" | "dashboard" | "inline";
    caller_agent_id?: string;
  };
  event_type?: string;
  correlation_id?: string;
}
```

#### Field semantics (read each carefully — these are the agent-actionable contract)

- **`kind`**: `"augment"` = context to absorb; `"template"` = playbook to execute. Closed set for v1.0. If a future minor adds `kind: "binary"` (or similar), the adopter substrate that can't handle it throws — substrate-side validation, not runtime concern.

- **`meta.dispatch_id`**: unique-per-emit identifier. Used by receivers for substrate-retry idempotency. **Rule: one `notify()` op invocation = one dispatch_id.** Multi-connector broadcast (one `notify()` op, N wired connectors for the same `agent_id`) share the same `dispatch_id` across all N `deliver()` calls. Sequential `notify()` calls produce distinct dispatch_ids per call. Author's call-site boundary is what defines the dispatch event.

- **`meta.sent_at`**: runtime emit-clock timestamp (unix ms). When `notify()` / `# Output:` fired — NOT when the substrate confirmed delivery. Distinct from receipt-side `delivered_at`. Staleness checks need both timestamps: `delivered_at - sent_at` = effective substrate queue lag.

- **`meta.origin.skill_name`**: immediate emitter. The skill that called `notify()` or fired `# Output: agent:`.

- **`meta.origin.entry_skill_name`**: root entry-point skill when distinct from `skill_name`. Set when emit happens inside a composed helper (e.g., A inlines B via `&`, B emits → `skill_name=B, entry_skill_name=A`). Intermediate composition steps (A→B→C) are NOT captured here — C's emit shows `skill_name=C, entry_skill_name=A`; B is in runtime trace logs, not the envelope.

- **`meta.origin.trigger_kind`**: how the originating skill was fired. Receiver routes on this without parsing content (cron-fired triage vs agent-initiated request vs webhook from external system).

- **`meta.origin.caller_agent_id`**: root-trigger agent IF identifiable, else undefined. The general rule: if the chain was initiated by an agent, that agent is the caller regardless of how deep the call stack is when the emit happens. Cron / session / cli / dashboard / inline triggers leave it undefined.

- **`meta.event_type`**: adopter-defined routing vocabulary — opaque to skillscript. Set via `notify(event_type=...)` kwarg (per-emit) OR `# Event-type:` skill frontmatter (skill-wide fallback). Kwarg takes precedence per-emit.

- **`meta.correlation_id`**: reply-correlation for the future `exchange()` op / `request_response()` substrate path. Sender sets; receiver echoes on reply. Kind-independent — both augment and template payloads may carry it.

### DeliveryReceipt

```typescript
interface DeliveryReceipt {
  delivered_at: number;
  delivery_id?: string;
  delivery_skipped?: boolean;
}
```

- **`delivered_at`**: substrate-acknowledgement timestamp. When the substrate confirmed it accepted the delivery.
- **`delivery_id`**: substrate-specific id for callers to correlate later.
- **`delivery_skipped`**: adopter signals "accepted but not pushed to the agent" — offline, rate-limit drop, tmux session exists but agent hasn't read, etc. Distinct from outright failure (which throws). Runtime echoes this on the receipt record for dashboard observability.

---

## Use-site cross-reference table

| Language surface | Runtime method | DeliveryPayload kind | meta sourced from |
|---|---|---|---|
| `# Output: agent: X` lifecycle hook | `AgentConnector.deliver()` | `augment` | Frontmatter `# Event-type:` (if set); `event_type` & `correlation_id` always undefined |
| `# Output: template: X` lifecycle hook | `AgentConnector.deliver()` | `template` | Same as above |
| `notify(agent=X, message=..., event_type=..., correlation_id=...)` op | `AgentConnector.deliver()` | `augment` | Kwargs override frontmatter for `event_type`; `correlation_id` from kwarg only |
| `exchange(agent=X, message=..., timeout=...)` op (v0.10, locked-shape) | `AgentConnector.request_response()` | `augment` | Same as notify; correlation_id required |

---

## Adopter wiring canonical pattern

```typescript
import { Registry } from "skillscript-runtime";
import { MyHttpWebhookAgentConnector } from "./my-impls/http-webhook.js";

const registry = new Registry();

// registerAgentConnector is async — bootstrap-throws on health_check() returning false
await registry.registerAgentConnector("primary", new MyHttpWebhookAgentConnector({
  endpoint: "https://my-agent.example.com/inbox",
  api_key: process.env.MY_AGENT_API_KEY,
}));
```

Wiring failures surface at boot (health_check throws), not at first skill-fire. Adopters wanting soft dev-mode behavior wrap the connector with a retry/always-healthy shim; the contract stays clean.

### Writing your own AgentConnector

If you're an agent implementing this contract against an adopter substrate, the canonical worked example is `HttpWebhookAgentConnector` (shipping post-audit; see `examples/` once bundled).

Implementation checklist:

1. **Implement `list_agents()`** — return the set of agent ids your substrate knows about. If your substrate is single-agent (e.g., a fixed webhook), return one. If it's multi-agent (e.g., a registry of webhook URLs keyed by agent_id), return all.

2. **Implement `deliver(agent_id, payload)`** — serialize `payload` to your substrate's format. For HTTP: JSON body with `kind`, `content`/`prompt`, and `meta`. For tmux: serialize meta as a header line, write content via `tmux send-keys`. For file-drop: write a file under `<dir>/<dispatch_id>.{json,txt}`.

3. **Implement `wake(agent_id, opts?)`** — substrate-specific "rouse the agent." Webhook: POST to a `/wake` endpoint. Tmux: send a wake-up sequence. Etc.

4. **Implement `health_check()`** — return `true` if substrate is reachable + configured. Webhook: HEAD/OPTIONS your endpoint. Tmux: check the session exists. File-drop: check the directory is writable.

5. **Implement `request_response()`** — throw `NotImplementedError` until v0.10 ships. When v0.10 lands and your substrate supports synchronous reply, implement the contract: send payload, await reply matched by `correlation_id`, time out per `opts.timeout_ms`.

6. **Optional: implement `agent_status?()`** — return `"active"` / `"idle"` / `"asleep"` / `"unknown"` per agent. Pure metadata; runtime does NOT gate delivery on this value (skip delivery via `delivery_skipped: true` on the receipt instead).

### Forking / customizing the bundled connectors

If your substrate matches the shape of a bundled connector closely (e.g., HTTP webhook with a tweaked auth header), forking `HttpWebhookAgentConnector` is acceptable. To keep upstream merges painless:

- Don't touch `src/connectors/agent.ts` (contract) — that's the highest-merge-cost surface
- Fork `src/connectors/agent-noop.ts` or `src/connectors/agent-http-webhook.ts` into your own file; register YOUR fork via `registry.registerAgentConnector()`
- Stay on the `AgentConnector` interface — don't add methods; if you need substrate-specific helpers, make them adopter-local

---

## Migration from v0.7.x / v0.8.x / pre-v0.9.6

The pre-adoption rule (no external users yet) applies; v0.9.6 is the contract's first stable lock. If you were experimenting against pre-v0.9.6 code, the changes you'll hit:

- `manifest()` removed (Q2). Adopter impls drop the method.
- `health_check()` + `request_response()` added (Q1, Q6). Adopter impls must add these.
- `DeliveryPayload.format`, `source_skill`, `triggered_by`, `delivery_context`, `templates` removed from contract (Q8, Q10, Q11). All folded into `meta` (`source_skill` → `meta.origin.skill_name`; `triggered_by` → `meta.origin.trigger_kind` + `meta.sent_at`).
- `DeliveryReceipt.delivery_skipped` added (Q7). Adopter impls can set; runtime honors.
- `TriggerProvenance` interface dropped (Q12). `name` + `fired_at_ms` no longer surface in the envelope (trace-only).
- `# Delivery-context:` frontmatter renamed to `# Event-type:` (Q9). Old name is no longer accepted by the parser.

---

## Footnotes pinned during the v0.9.6 audit (Perry's thread b722bbf4)

These are the load-bearing semantic rules. Internalize before implementing.

1. **dispatch_id — broadcast vs sequential**: one `notify()` op invocation = one dispatch_id. Multi-connector broadcast (same agent_id across N wired connectors) shares; sequential `notify()` calls produce distinct ids. Author's call-site boundary defines the dispatch event.

2. **entry_skill_name — deeper-than-2-level chains lose middle**: A→B→C, C emits → `skill_name=C, entry_skill_name=A`. B is in runtime trace logs, NOT the envelope. Surface boundaries are decisions, not accidents.

3. **caller_agent_id — general rule**: root-trigger agent IF identifiable, else undefined. All substrate-specific cases (cron/session/webhook/agent/cli/dashboard/inline) drop out cleanly from this rule. Cron / session / cli / dashboard / inline trigger paths leave it undefined.

4. **sent_at vs delivered_at**: `meta.sent_at` is the runtime's emit-clock (when `notify()` / `# Output:` fired). Receipt-side `delivered_at` is the substrate's acknowledgement timestamp. Substrate-side queueing may mean significant gaps (file-drop poller intervals, webhook retries, broker buffering). Adopters running staleness checks need both surfaces; `delivered_at - sent_at` = effective queue lag.

---

*This doc reflects the v0.9.6 lock; future contract changes update this file alongside the code.*
