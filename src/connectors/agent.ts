// AgentConnector — the substrate-neutral contract for delivering payloads
// to a frontier agent. Locked at v1.0 per the v0.9.6 audit (memory b722bbf4).
//
// Substrate examples — the contract is neutral; adopters wire impls:
//
//   - tmux session: `deliver` via `tmux send-keys` to a pane
//   - webhook:      POST to /augment or /template endpoint
//   - file-watch:   write to `<path>/augment-<id>.txt`
//   - Slack thread: post to monitored thread
//   - IPC pipe:     write to named pipe
//
// Adopter-side impl note: this contract is typically implemented by the
// adopter's AGENT (not the human programmer) — see memory `9fbeb1a1`. The
// human's role is closer to "supervise the agent." Keep surface MINIMAL +
// STABLE so adopter forks merge cleanly across upstream releases.
//
// The bundled default is `NoOpAgentConnector` — `list_agents` returns [],
// `deliver` / `wake` resolve cleanly after a stderr warning. Lets runtimes
// start with no AgentConnector wired; `# Output: agent:` decls still
// complete (with a warning instead of a thrown error). Use the bundled
// `HttpWebhookAgentConnector` (separate impl session, post-v0.9.6) as the
// canonical worked-example for adopter impls.

import type { StaticCapabilities } from "./types.js";

/**
 * Runtime-filled envelope metadata. Adopters CONSUME this (substrate-side
 * serialization); they NEVER construct it. The runtime populates every
 * required field at the `deliver()` call site.
 *
 * Locked v1.0 shape per v0.9.6 audit Q8. Optional fields are intentionally
 * sparse; additive growth is non-breaking (TypeScript discriminated union
 * semantics), so future fields land additively per real adopter feedback.
 */
export interface DeliveryMeta {
  /**
   * UUID per `notify()` op invocation. Same dispatch_id across multi-
   * connector broadcast (one `notify()` op, N wired connectors for the
   * same agent_id → all N `deliver()` calls share this id). Sequential
   * `notify()` calls in the same skill produce distinct dispatch_ids per
   * call. Author's call-site boundary is what defines the dispatch event.
   *
   * Agent-side idempotency primitive — receivers dedupe substrate retries
   * by dispatch_id.
   */
  dispatch_id: string;

  /**
   * Runtime emit-clock timestamp (unix ms) — when `notify()` / `# Output:`
   * hook fired. Distinct from receipt-side `delivered_at` (substrate
   * confirmation). Staleness checks need both surfaces; delta = effective
   * queue lag.
   */
  sent_at: number;

  /**
   * Origin tracking. Runtime auto-fills from execution context. Receiver
   * uses for attribution + routing decisions.
   */
  origin: {
    /** Immediate emitter — the skill that fired this delivery. */
    skill_name: string;
    /**
     * Root entry-point skill when distinct from `skill_name`. Set when the
     * emit happens inside a composed helper (e.g., skill A inlines B via
     * `&`, B emits → entry_skill_name=A). Intermediate composition steps
     * are NOT captured here — those live in runtime trace logs. Surface
     * boundaries are decisions, not accidents.
     */
    entry_skill_name?: string;
    /**
     * Triggering pathway that fired the originating skill. From the
     * RECEIVER's lens — not the kind of OUTPUT (which is captured by
     * `kind: "augment" | "template"`).
     *
     * v0.19.0 — `"session"` removed from the enum (trigger-source collapse
     * to cron + event; the value was never functionally emitted, pre-v1.0
     * makes this a cheap contract cleanup per Scott's full-scrub call).
     */
    trigger_kind: "cron" | "event" | "webhook" | "agent" | "cli" | "dashboard" | "inline";
    /**
     * Root-trigger agent IF identifiable, else undefined. Composition
     * doesn't reset the calling-agent context — if X triggered the chain,
     * X is the caller regardless of how deep the call stack is when the
     * emit happens. Cron / event / cli / dashboard / inline triggers
     * have no calling agent.
     */
    caller_agent_id?: string;
  };

  /**
   * Adopter-defined routing vocabulary — opaque to skillscript. Set via
   * `notify(event_type=...)` kwarg OR `# Event-type:` skill frontmatter
   * (kwarg takes precedence; frontmatter is the fallback). Receiver uses
   * for handler routing without parsing content.
   *
   * Lifecycle-hook deliveries (`# Output: agent:` / `# Output: template:`)
   * carry frontmatter value if set. `notify()` deliveries can override via
   * the kwarg.
   */
  event_type?: string;

  /**
   * Reply-correlation primitive for the future v0.10 `exchange()` op /
   * `request_response()` substrate path. When sender sets correlation_id,
   * receiver echoes it on reply. Kind-independent — both augment and
   * template kinds may carry correlation_id; receiver may reply regardless
   * of kind.
   *
   * Settable via `notify(correlation_id=...)` kwarg ONLY (NOT via `#
   * Output:` lifecycle hook).
   */
  correlation_id?: string;
}

/**
 * Discriminated payload union for `deliver`. The runtime picks `kind`
 * based on the source declaration:
 *   - `# Output: agent: <name>` / `notify(agent=...)` → `{ kind: "augment", ... }`
 *   - `# Output: template: <name>`                   → `{ kind: "template", ... }`
 *
 * Closed set for v1.0 per audit Q4. Additive growth (e.g., `kind: "binary"`)
 * is non-breaking via discriminated union semantics — adopters whose
 * substrate can't handle a future kind throw at `deliver()` time.
 */
export type DeliveryPayload =
  | { kind: "augment"; content: string; meta: DeliveryMeta }
  | { kind: "template"; prompt: string; meta: DeliveryMeta };

export interface DeliveryReceipt {
  /** Unix-ms timestamp the substrate accepted the delivery. */
  delivered_at: number;
  /** Substrate-specific id for callers to correlate later. */
  delivery_id?: string;
  /**
   * v0.18.2 — the session that received the delivery. Set when the
   * substrate routes to a specific session (mailbox-pull per terminal,
   * webhook per running-tab, etc.). Omit if the substrate is
   * agent-level only (Slack DM, email — no session concept) or if the
   * substrate elected to fan out / accept without specific session.
   */
  session_id?: string;
  /**
   * Adopter signals "accepted but not pushed to the agent" — agent offline,
   * rate-limit drop, tmux session exists but agent hasn't read, etc.
   * Distinct from outright dispatch failure (which throws). Runtime echoes
   * this on the receipt record so dashboards + observability can surface it.
   *
   * v0.9.6 promotion: was previously runtime-set on `AgentDeliveryReceiptRecord`
   * (v0.9.2 P1.1); now contract-set so adopters can signal explicitly.
   * Runtime preserves NoOp-fallback inference when adopter doesn't set it.
   */
  delivery_skipped?: boolean;
  /**
   * v0.18.4 — non-fatal substrate notes about the delivery. Surfaced
   * onto `AgentDeliveryReceiptRecord` so the dashboard + observability
   * surfaces show them instead of substrate-side stderr noise. Examples:
   *  - "stripped @session suffix — deliver is mailbox-class, only wake honors session"
   *  - "rate-limit hint: backoff 5s before next deliver"
   *  - "fan-out: delivered to 3 active sessions"
   *
   * Distinct from `delivery_skipped` (which signals "accepted-not-pushed")
   * and from thrown errors (which signal "delivery failed"). Warnings are
   * advisory — the delivery succeeded; the substrate just has commentary.
   */
  warnings?: string[];
}

/**
 * Synchronous request-response envelope — locked v1.0 shape per Q1.
 * Impl deferred to v0.10 (when `exchange()` op ships). Adopters' agents
 * implementing this method will see `NotImplementedError` from
 * `NoOpAgentConnector` until v0.10 runtime support lands.
 */
export interface Response {
  /** Echoes the original `meta.correlation_id` of the request. */
  correlation_id: string;
  /** The reply content. */
  content: string;
  /** Unix-ms timestamp the agent emitted the reply. */
  sent_at: number;
  /** The replying agent_id. */
  agent_id: string;
}

export interface RequestResponseOpts {
  /** Max wait in ms before throwing TimeoutError. */
  timeout_ms: number;
}

export interface WakeOpts {
  /** Optional preamble to prepend to the wake message. */
  context?: string;
  /** `"immediate"` (default) or a unix-ms timestamp for scheduled wake. */
  when?: "immediate" | number;
  /**
   * v0.18.2 — optional structured session targeting. Alternative to
   * embedding `agent@session` in the `agent_id` opaque string. Callers
   * with the session already separated (e.g., dashboard's per-session
   * "wake this terminal" action) pass it here. Substrates that don't
   * track sessions ignore the field; substrates that do route the wake
   * to the named session. Per Perry's `e1ef003`-thread session-granular
   * targeting requirement.
   */
  session_id?: string;
}

/**
 * v0.18.2 — `woken` is the required honesty signal. Wake-capable
 * substrates (live tmux session, browser-tab open, push-channel
 * connected) set `woken: true` after delivering an attention signal.
 * Passive substrates (webhook, file-drop, store-only) can't interrupt
 * and degrade gracefully: deliver the content, set `woken: false`. Per
 * Perry's graceful-degradation requirement — "conform by degrading,
 * never by erroring." Callers reading the receipt distinguish
 * interrupted-them from delivered-only without needing per-substrate
 * knowledge.
 */
export interface WakeReceipt {
  woken_at: number;
  /** `true` if substrate actually woke the session; `false` if degraded to deliver-only. */
  woken: boolean;
  /**
   * The session that received the wake (or delivery, if degraded). Set
   * when the substrate knows; omit if the substrate doesn't track
   * sessions. With session-targeted wake input, this typically echoes
   * the requested session; with bare `agent_id`, the substrate's
   * choice if it picks one.
   */
  session_id?: string;
  /**
   * v0.18.5 — symmetric with `DeliveryReceipt.warnings` (v0.18.4).
   * Non-fatal substrate notes about the wake. Examples:
   *   - "session not currently attached; degraded to mailbox-class"
   *   - "rate-limit hint: backoff before next wake"
   *   - "interrupt sent, awaiting acknowledgement"
   * Runtime also uses this field to record routing decisions (`notify()`
   * routed here because `@session` was present on the address); see the
   * address-routed-notify rule in the language reference.
   */
  warnings?: string[];
}

export interface AgentDescriptor {
  agent_id: string;
  agent_name?: string;
  capabilities?: ReadonlyArray<"deliver" | "wake" | "augment" | "template">;
}

/**
 * Signal-only metadata about an agent's reachability/availability. Adopter
 * implements iff they have per-agent tracking (e.g., a webhook adopter
 * tracking last-ACK timestamp). Runtime does NOT auto-gate delivery on
 * `agent_status` values — pure metadata. If you want runtime to skip
 * delivery for offline agents, set `delivery_skipped: true` on the
 * `DeliveryReceipt` (Q7) instead.
 *
 * Distinct from `health_check()` which is the connector substrate's
 * health, not per-agent.
 */
export type AgentStatus = "active" | "idle" | "asleep" | "unknown";

/**
 * The contract. v0.9.6 audit locked Q1-Q12.
 *
 * Required methods: `list_agents`, `deliver`, `wake`, `health_check`,
 * `request_response`. Optional: `agent_status`.
 *
 * `health_check()` is invoked at `Registry.registerAgentConnector()` —
 * bootstrap-throws on false. Adopters wanting soft dev-mode behavior wrap
 * their AgentConnector with a retry / always-healthy shim; the contract
 * stays clean.
 */
export interface AgentConnector {
  list_agents(): Promise<AgentDescriptor[]>;
  /**
   * Durable put — "it's in their inbox, no interrupt."
   *
   * `agent_id` is an opaque string. The substrate may treat it as:
   * - a bare agent identifier (Slack `@user`, email address, Discord user ID)
   * - a composite `agent@session` (e.g., `"perry@kitchen-terminal"`) when the
   *   substrate tracks multiple live sessions per identity — the substrate
   *   decomposes the composite if it cares; non-session substrates ignore
   *   the suffix or treat the whole string as the address.
   *
   * Per Perry's v0.18.2 session-granular-targeting requirement: every
   * messaging substrate needs to address either a bare identity or a
   * specific live session. The opaque-composite form keeps the contract
   * substrate-neutral while preserving the routing capability.
   */
  deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt>;
  /**
   * Attention signal — "go look at this now."
   *
   * `agent_id` accepts the same opaque/composite form as `deliver` (bare
   * identity or `agent@session`). `opts.session_id` is the structured
   * alternative for callers with the session already separated.
   *
   * Passive substrates that can't interrupt (webhook, file-drop, store-only)
   * degrade gracefully — deliver the payload as if it were a `deliver()`
   * call and set `woken: false` on the receipt. The contract's graceful-
   * degradation rule (never throw for missing wake-capability) keeps
   * non-wake-capable substrates conformant.
   */
  wake(agent_id: string, opts?: WakeOpts): Promise<WakeReceipt>;
  /**
   * Bootstrap-time health probe. Adopter returns `true` if the substrate
   * is reachable + configured correctly. Registry throws on `false` so
   * wiring failures surface at boot, not at first skill-fire.
   */
  health_check(): Promise<boolean>;
  /**
   * Synchronous send-and-await-reply. Required signature; impl deferred
   * to v0.10 (when the `exchange()` op ships). Adopters' agents writing
   * AgentConnector impls before v0.10 should throw `NotImplementedError`
   * here — see `NoOpAgentConnector` for the canonical pattern.
   */
  request_response(agent_id: string, payload: DeliveryPayload, opts: RequestResponseOpts): Promise<Response>;
  agent_status?(agent_id: string): Promise<AgentStatus>;
}

export interface AgentConnectorClass {
  new (...args: never[]): AgentConnector;
  staticCapabilities(): StaticCapabilities;
}
