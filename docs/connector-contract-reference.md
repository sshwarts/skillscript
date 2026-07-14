---
title: Connector Contract Reference
description: "The substrate-neutral contracts adopters implement to wire their own backends. Interface signatures, payload shapes, durability + identity conventions."
mode: wide
---

The substrate-neutral contracts skillscript-runtime exposes for adopters to wire their own substrate behind. This doc is the **canonical source of truth** for the AgentConnector contract, whose interface shape is locked at v1.0. The wake/deliver receipt shapes carry refinements for session-targeting and graceful degradation.

**Audience**: this doc is written for the agent that's implementing an adopter's AgentConnector — typically an LLM-class agent supervised by a human. If you're a human reading it directly, the same content applies; the prose is tightened for agent comprehension (literal field semantics, explicit precedence rules, worked examples).

The other contracts (McpConnector, SkillStore, DataStore, LocalModel) are covered in the sections below; this doc grows to cover each.

---

## AgentConnector — v1.0 contract

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

`request_response` is locked at v1.0 for the planned `exchange()` op. Until the runtime support lands, adopters should throw `NotImplementedError` from this method (see `NoOpAgentConnector` for the canonical pattern).

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
    trigger_kind: "cron" | "event" | "webhook" | "agent" | "cli" | "dashboard" | "inline";
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

- **`meta.origin.caller_agent_id`**: the AUTHENTICATED CALLER who fired the dispatch — distinct from the skill's author/owner. When an MCP `/rpc` call carries the configured caller-identity header (e.g., `X-Agent-Id: web-ui`), that value flows here. The chain originator is preserved across composition: if `web-ui` invokes Alice's skill A which composes Bob's skill B, B's notify() still emits `caller_agent_id: web-ui`. Cron / event / cli / dashboard triggers leave it undefined (no human caller); direct `execute_skill` without an identity header also leaves it undefined (the owner is NOT used as fallback — caller-identity and ownership are deliberately distinct). See [Adopter Playbook](adopter-playbook.md) §"Identity propagation" for the inbound-header wiring.

- **`meta.event_type`**: adopter-defined routing vocabulary — opaque to skillscript. Set via `notify(event_type=...)` kwarg (per-emit) OR `# Event-type:` skill frontmatter (skill-wide fallback). Kwarg takes precedence per-emit.

- **`meta.correlation_id`**: reply-correlation for the future `exchange()` op / `request_response()` substrate path. Sender sets; receiver echoes on reply. Kind-independent — both augment and template payloads may carry it.

### DeliveryReceipt

```typescript
interface DeliveryReceipt {
  delivered_at: number;
  delivery_id?: string;
  session_id?: string;
  delivery_skipped?: boolean;
  warnings?: string[];
}
```

- **`delivered_at`**: substrate-acknowledgement timestamp. When the substrate confirmed it accepted the delivery.
- **`delivery_id`**: substrate-specific id for callers to correlate later.
- **`session_id`**: the session that received the delivery. Set when the substrate routes to a specific session (e.g., per-terminal mailbox, per-tab webhook). Omitted when the substrate is agent-level only (Slack DM, email — no session concept) or when the substrate fans out / accepts without committing to a session. See *agent@session targeting* below.
- **`delivery_skipped`**: adopter signals "accepted but not pushed to the agent" — offline, rate-limit drop, tmux session exists but agent hasn't read, etc. Distinct from outright failure (which throws). Runtime echoes this on the receipt record for dashboard observability.
- **`warnings`**: non-fatal substrate notes about the delivery. Surfaced onto `AgentDeliveryReceiptRecord` so the dashboard + observability surfaces show them instead of substrate-side stderr noise. Examples: `"stripped @session suffix — deliver is mailbox-class"`, `"rate-limit hint: backoff 5s before next deliver"`, `"fan-out: delivered to 3 active sessions"`. Distinct from `delivery_skipped` (accepted-not-pushed) and from thrown errors (delivery failed) — warnings are advisory; the delivery succeeded, the substrate just has commentary.

### WakeOpts + WakeReceipt

```typescript
interface WakeOpts {
  context?: string;
  when?: "immediate" | number;
  session_id?: string;
}

interface WakeReceipt {
  woken_at: number;
  woken: boolean;
  session_id?: string;
  warnings?: string[];
}
```

- **`WakeOpts.context`**: optional preamble to prepend to the wake message.
- **`WakeOpts.when`**: `"immediate"` (default) or a unix-ms timestamp for scheduled wake.
- **`WakeOpts.session_id`**: structured session targeting. Alternative to embedding `agent@session` in the `agent_id` opaque string. Callers with the session already separated (e.g., a dashboard's per-session "wake this terminal" action) pass it here. When both forms are supplied, `opts.session_id` takes precedence over the embedded suffix.
- **`WakeReceipt.woken_at`**: substrate's acknowledgement timestamp.
- **`WakeReceipt.woken`** (required): honest signal of whether the substrate actually interrupted the agent. See *Graceful degradation on wake* below — this is the read every caller does to distinguish interrupted-them from delivered-only.
- **`WakeReceipt.session_id`**: the session that received the wake (or delivery, if degraded). Set when the substrate knows; omit otherwise.
- **`WakeReceipt.warnings`**: optional non-fatal substrate notes about the wake — advisory commentary surfaced onto the receipt record for dashboard + observability instead of substrate-side stderr noise. Symmetric with `DeliveryReceipt.warnings`.

### agent@session targeting

`agent_id` is an opaque string. The substrate may treat it as:

- A bare agent identifier (`alice`, an email address, a Slack `@user`, a Discord user ID).
- A composite `agent@session` (e.g., `"alice@terminal-1"`) when the substrate tracks multiple live sessions per identity.

The substrate decomposes the composite if it cares; non-session substrates ignore the suffix or treat the whole string as the address. This keeps the contract substrate-neutral while preserving session-granular routing — every messaging substrate either addresses a bare identity OR a specific live session, and the opaque-composite form covers both without locking adopters into a particular session model.

**Address-routed dispatch**: the runtime uses the presence of `@` in `agent_id` to decide between `deliver()` and `wake()` for skill-author surfaces (`notify()` op + `# Output: agent:` / `# Output: template:` lifecycle hooks):

| Skill-author syntax | Address shape | Connector method called |
|---|---|---|
| `notify(agent="alice", …)` | bare | `deliver()` |
| `notify(agent="alice@terminal-1", …)` | composite | `wake()` |
| `# Output: agent: alice` | bare | `deliver()` |
| `# Output: agent: alice@terminal-1` | composite | `wake()` |
| `# Output: template: alice@tab-3` | composite | `wake()` |

The runtime threads the FULL composite to `wake()` — substrate decomposes per the rule above. For wake-routed dispatches, the skill's content (notify message or accumulated emissions) rides as `WakeOpts.context`. The rule: "the address encodes delivery class" — same convention as the broader `waiting_on` / mailbox / broker convention. No `wake=true` kwarg exists; the `@` IS the signal.

**Two forms, one wire**:

```typescript
// Form A — composite in agent_id (works for deliver + wake)
await conn.wake("alice@terminal-1");

// Form B — structured WakeOpts.session_id (wake only)
await conn.wake("alice", { session_id: "terminal-1" });
```

Substrates that care about sessions read both — `opts.session_id` wins if both are set. Substrates that don't care ignore both. Callers that already have agent + session as separate variables prefer Form B; callers passing an opaque user-supplied address prefer Form A.

`DeliveryReceipt.session_id` and `WakeReceipt.session_id` echo the resolved session back to the caller. Useful for dashboards rendering "delivered to alice@terminal-1" rather than just "delivered to alice."

### Graceful degradation on wake

Not every substrate can interrupt. A webhook receiver, a file-drop directory, or a store-only adopter has no attention channel — they can persist the payload but can't make the agent look at it now.

**The rule**: `wake()` must not throw because the substrate lacks interrupt capability. Conform by degrading: deliver the payload as if it were a `deliver()` call, set `woken: false` on the receipt. Callers reading the receipt distinguish "the substrate woke the agent" from "the substrate stored the payload for later" without needing per-substrate knowledge.

| Situation | `wake()` behavior | `WakeReceipt.woken` |
|---|---|---|
| Substrate has live interrupt channel + agent is reachable | Send interrupt | `true` |
| Substrate has no interrupt channel (webhook, file-drop) | Deliver content, no interrupt | `false` |
| Substrate has interrupt channel but agent unreachable / offline | Best-effort deliver, no interrupt | `false` |
| Caller misconfiguration (unknown `agent_id`, missing required config) | Throw `DeliveryFailedError` | — |
| Substrate fault (network, auth) | Throw | — |

The distinction `wake-capability` vs `network-fault` matters. The former is structural (this substrate fundamentally can't wake) and degrades silently. The latter is operational (the substrate could wake but something broke) and throws. Adopters writing connectors should keep this distinction explicit — the bundled `HttpWebhookAgentConnector` returns `woken: false` when `wake_url` is unconfigured (capability gap, fixed at config time) but throws on actual HTTP failure (operational fault, surfaces to caller).

---

## Use-site cross-reference table

| Language surface | Address shape | Runtime method | DeliveryPayload kind | meta sourced from |
|---|---|---|---|---|
| `# Output: agent: X` lifecycle hook | bare | `AgentConnector.deliver()` | `augment` | Frontmatter `# Event-type:` (if set); `event_type` & `correlation_id` always undefined |
| `# Output: agent: X@session` lifecycle hook | composite | `AgentConnector.wake()` | n/a (canonical output as `WakeOpts.context` — body template if present, else joined emissions) | n/a (wake has no envelope) |
| `# Output: template: X` lifecycle hook | bare | `AgentConnector.deliver()` | `template` | Same as agent-bare |
| `# Output: template: X@session` lifecycle hook | composite | `AgentConnector.wake()` | n/a | n/a |
| `notify(agent=X, message=..., event_type=..., correlation_id=...)` op | bare | `AgentConnector.deliver()` | `augment` | Kwargs override frontmatter for `event_type`; `correlation_id` from kwarg only |
| `notify(agent=X@session, message=..., ...)` op | composite | `AgentConnector.wake()` | n/a (message as `WakeOpts.context`) | n/a |
| `exchange(agent=X, message=..., timeout=...)` op (locked-shape, runtime support pending) | bare | `AgentConnector.request_response()` | `augment` | Same as notify; correlation_id required |

The address-routing rule is uniform across all skill-author surfaces: `@session` present → wake-class; bare → deliver-class. See *agent@session targeting* below for the contract-level convention.

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

If you're an agent implementing this contract against an adopter substrate, the canonical worked example is `HttpWebhookAgentConnector`, bundled under `examples/connectors/`.

Implementation checklist:

1. **Implement `list_agents()`** — return the set of agent ids your substrate knows about. If your substrate is single-agent (e.g., a fixed webhook), return one. If it's multi-agent (e.g., a registry of webhook URLs keyed by agent_id), return all.

2. **Implement `deliver(agent_id, payload)`** — serialize `payload` to your substrate's format. For HTTP: JSON body with `kind`, `content`/`prompt`, and `meta`. For tmux: serialize meta as a header line, write content via `tmux send-keys`. For file-drop: write a file under `<dir>/<dispatch_id>.{json,txt}`.

3. **Implement `wake(agent_id, opts?)`** — substrate-specific "rouse the agent." Wake-capable substrates: send an attention signal (tmux: wake-up sequence; webhook with a `/wake` endpoint: POST it; push channel: send notification). Set `woken: true` on the receipt. Passive substrates (file-drop, store-only, webhook without `/wake`): degrade gracefully — deliver the content, return `woken: false`. NEVER throw because the substrate lacks interrupt capability. Honor `opts.session_id` if your substrate tracks sessions; otherwise ignore it. Echo the resolved session on `WakeReceipt.session_id` so dashboards can render it.

4. **Implement `health_check()`** — return `true` if substrate is reachable + configured. Webhook: HEAD/OPTIONS your endpoint. Tmux: check the session exists. File-drop: check the directory is writable.

5. **Implement `request_response()`** — throw `NotImplementedError` until the runtime support for `exchange()` lands. When it does, and your substrate supports synchronous reply, implement the contract: send payload, await reply matched by `correlation_id`, time out per `opts.timeout_ms`.

6. **Optional: implement `agent_status?()`** — return `"active"` / `"idle"` / `"asleep"` / `"unknown"` per agent. Pure metadata; runtime does NOT gate delivery on this value (skip delivery via `delivery_skipped: true` on the receipt instead).

### Forking / customizing the bundled connectors

If your substrate matches the shape of a bundled connector closely (e.g., HTTP webhook with a tweaked auth header), forking `HttpWebhookAgentConnector` is acceptable. To keep upstream merges painless:

- Don't touch `src/connectors/agent.ts` (contract) — that's the highest-merge-cost surface
- Fork `src/connectors/agent-noop.ts` or `src/connectors/agent-http-webhook.ts` into your own file; register YOUR fork via `registry.registerAgentConnector()`
- Stay on the `AgentConnector` interface — don't add methods; if you need substrate-specific helpers, make them adopter-local

---

## Load-bearing semantic footnotes

These are the load-bearing semantic rules. Internalize before implementing.

1. **dispatch_id — broadcast vs sequential**: one `notify()` op invocation = one dispatch_id. Multi-connector broadcast (same agent_id across N wired connectors) shares; sequential `notify()` calls produce distinct ids. Author's call-site boundary defines the dispatch event.

2. **entry_skill_name — deeper-than-2-level chains lose middle**: A→B→C, C emits → `skill_name=C, entry_skill_name=A`. B is in runtime trace logs, NOT the envelope. Surface boundaries are decisions, not accidents.

3. **caller_agent_id — general rule**: root-trigger agent IF identifiable, else undefined. All substrate-specific cases (cron/event/webhook/agent/cli/dashboard/inline) drop out cleanly from this rule. Cron / event / cli / dashboard / inline trigger paths leave it undefined.

4. **sent_at vs delivered_at**: `meta.sent_at` is the runtime's emit-clock (when `notify()` / `# Output:` fired). Receipt-side `delivered_at` is the substrate's acknowledgement timestamp. Substrate-side queueing may mean significant gaps (file-drop poller intervals, webhook retries, broker buffering). Adopters running staleness checks need both surfaces; `delivered_at - sent_at` = effective queue lag.

---

## Storage-layer conventions (SkillStore + DataStore)

The following conventions live in the bundled reference impls but aren't first-class in the typed contracts. Adopters writing their own SkillStore/DataStore impls need to know about these, or skills/memories misbehave silently.

### SkillStore conventions

**`author` field on SkillMeta + filter on `query()`.** `SkillMeta.author` is optional; substrates that track authorship populate it (bundled `FilesystemSkillStore` reads from `os.userInfo().username`; `SqliteSkillStore` stores at write time). Substrates without an authorship concept leave it `undefined`; the catalog layer surfaces `null` to the wire.

`SkillStore.query({ author: "X" })` is an optional substrate-honored filter. Substrates that natively track authorship can filter at the substrate layer; substrates that don't return all status-matching rows and the `buildSkillCatalog()` layer filters in-memory per `meta.author`. Either way the caller sees only matching authors — a generic, connector-implemented, graceful-degrading filter. The substrate-neutrality property holds — adopters wire whichever shape fits their ownership model.

**`description` on SkillMeta is runtime-derivable — you don't have to populate it.** `SkillMeta.description` is optional. When your store leaves it `undefined`/empty, the runtime backfills it from the skill's `# Description:` frontmatter (it already has the source in hand), so `skill_list` and `skill_preflight` — and the dashboard — show the real description even for a store that tracks no description column. Populating it in your `metadata()`/`query()` metas is an *optimization* (lets `skill_list` skip a source parse, and lets a substrate that indexes descriptions filter natively), not a requirement. The bundled stores extract it at write time: `SqliteSkillStore` into a `description` column, `FilesystemSkillStore` via `extractHeader(source, "Description")`. **Contrast `author` above** — that one the runtime *cannot* recover from the source (it's writer identity, not body content), so if you track authorship you must surface it yourself. Rule of thumb: metadata that's a projection of the body (`description`, `vars`) the runtime can and will derive; metadata only your substrate knows (`author`, `version`, timestamps, status) you must return.

Adopter substrates with their own ownership concept (e.g., a native `author:<id>` tag) should map the filter onto their native query so subset-fetching stays efficient. Adopters with no ownership concept can leave `query()` unchanged and let the catalog-layer in-memory filter handle narrowing.



**`content_hash` semantics.** Bundled impls (`FilesystemSkillStore`, `SqliteSkillStore`) compute `content_hash = sha256(body)` — the SHA-256 of the canonicalized skill source *including* the `# Status:` line as persisted (a bare `# Status: Approved` in unsecured mode, or `# Status: Approved v3:<signature>` in secured mode). Diverge from this convention and cross-impl version equality breaks (skill content_hashes won't match across substrates even when the body is identical). The contract doesn't require SHA-256, but the convention is load-bearing for cross-substrate skill identity.

**`version` derivation.** `version = first 12 hex chars of content_hash`. Opaque-substrate-declared per the contract (`SkillSource.version` is just a string), but the 12-hex convention is what the bundled impls use. Adopters can derive their own scheme, but if other tools (lint diagnostics, dashboard) parse versions, the divergence shows.

**`store()` does NOT mint or stamp approval.** In **unsecured** mode a bare `# Status: Approved` is sufficient; the store persists the body verbatim, no token. In **secured** mode, approval is a v3 Ed25519 signature applied by the approve flow (`skillfile approve` / the dashboard), never by `store()`; the MCP `skill_write` handler forces any unsigned `Approved` write to `Draft` before it reaches the store (the bundled stores do the same as defense-in-depth). Your `store()` therefore persists the body as handed to it — it neither stamps nor verifies approval; the runtime owns the gate. See [Adopter Playbook](adopter-playbook.md) §"Approval + secured mode" and `src/approval.ts`.

**`delete()` is destructive in the bundled impls — permanent, name-reclaiming.** The contract signature is `delete(name): Promise<void>`. The bundled stores erase rather than tombstone: `FilesystemSkillStore` unlinks the skill file + version sidecar, `SqliteSkillStore` hard-cascades both tables. After delete the skill is gone from `query()`/`load()`/`metadata()`/`versions()`, the name frees up immediately for a fresh `store()` (clean history, no orphan rows), and there is no trash and no restore. Delete is **operator-only** (CLI `skillfile delete` / the dashboard) — there is no agent/MCP delete surface — and both surfaces gate it behind a confirm + reverse-dependency check. Your impl *may* soft-delete instead (tombstone + filter from normal views); the runtime only requires "remove from normal views," and recovery semantics are your store's concern.

**`version()` — OPTIONAL cheap change-token (helps remote stores).** A `version(): Promise<string>` method returns a store-wide token that fingerprints the whole namespace **without loading any skill bodies**. `skill_list` returns it as `catalog_version` and honors a caller's `if_none_match`: when the token still matches, the response is `{ not_modified: true }` and the catalog rebuild is skipped. That rebuild otherwise costs one `load()` *per skill* (to parse each entry's effectful footprint) — free against a local store, but a network round-trip per entry against a remote one, so a polling dashboard hammers the substrate. **Optional**: a store without `version()` just always rebuilds (today's behavior, no change).

**The contract invariant** — `version()` MUST change whenever the catalog's *observable content* changes: an add, a remove, a status change, **and a body edit even if the status is unchanged**. A token that fails this serves a stale catalog. ⚠ **The subtle trap:** a token over only `(id, status)` is exact in **secured mode** (an edit forces the skill back to `Draft`, so status moves) but goes **stale in unsecured mode** on a body-edit-with-unchanged-status. So fold a per-skill **content revision** (a content hash, version, or `updated_at`) into the fingerprint — don't ship a status-only token unless your deployment is secured-mode-only, and if it is, document that limitation. Bundled impls satisfy the invariant in *both* modes: `FilesystemSkillStore` hashes each skill file's `(name, mtime)` (a rewrite moves the mtime); `SqliteSkillStore` hashes `(name, status, current_version)` — `current_version` is the content hash. **Implement it on any network-backed SkillStore**, fingerprinting whatever your substrate exposes cheaply (a list ETag, a max-revision/seq, or a metadata digest), as long as every observable change moves it.

### DataStore conventions

**`summary`/`detail` split is convention, not contract field.** The DataStore contract gives `write()` a single `content: string`. Bundled `SqliteDataStore` maps this to `summary = first line (≤200 chars)` and `detail = full content`. Adopter substrates with native summary/detail concepts (their own `summary` + `detail` columns) can pre-compose and pass via `metadata`, but the basic mapping convention is "first line is the preview." Diverge and the dashboard's memory rendering looks weird, but skills still work.

**`get(id)` returns null on miss, doesn't throw.** Distinct from SkillStore's `load(name)` which throws `SkillNotFoundError`. DataStore's empty-set convention (`query()` returns `[]` not throws; `get()` returns `null` not throws) is **load-bearing for the runtime's control flow** — query callers branch on `result.length`, get callers branch on `result === null`. Don't change this in your impl.

### Durability stance (both contracts)

**The typed contracts assume durable storage.** Neither SkillStore nor DataStore declare "writes live forever" anywhere in the interface — but the runtime + lint + dashboard all behave as if writes persist indefinitely. Substrate backends with their own GC / TTL / decay scoring surprise the skillscript layer invisibly:

- A skill written to a substrate that auto-expires after N days disappears from `skill_list` without warning
- A memory written with an implicit TTL gets pruned, breaking later `$ data_read query` references
- A substrate that pin-deletes stale content silently invalidates persisted skill references

Implementer responsibility: either pick a substrate posture that satisfies "durable forever," or build adopter-side guards (e.g., pin-rules, retention policies, periodic re-pin sweeps) that maintain the assumption. The contract doesn't enforce — silent staleness is the failure mode.

### Filter-scope discipline

**Unsupported filters fail loud at the bridge, not silently.** The `DataStoreMcpConnector` bridge validates every `query()` filter key against the substrate's declared `manifest().supported_filters` set and throws `UnsupportedFilterError` for any key outside it — closing the silent-scope-leak class where an unhonored `vault` / tenant-id / access-control filter would drop without the caller knowing. Per-call opt-out: `permissive_filters: true` acknowledges "unknown keys are advisory; the substrate may ignore them."

Implementer responsibility: **declare every filter your `query()` actually honors** in `manifest().supported_filters`, so the bridge validates against your truth rather than a guess. Under-declare and legitimate filters get rejected; over-declare and you reopen the silent-drop leak for the keys you named but don't enforce.

### Why these aren't in the typed interface

The shape-vs-semantics split is deliberate: the typed contract guarantees shape portability (same methods, same return types); the conventions above are semantic portability concerns that the contract chose not to encode. Bundled impls follow them; custom impls SHOULD follow them. Capability flags + manifest fields make some conventions inspectable at runtime (`regexp_fallback_active`, `supported_filters`, `supported_modes`), but most live in source comments + this doc.

---

*Future contract changes update this file alongside the code; the CHANGELOG owns version history.*
