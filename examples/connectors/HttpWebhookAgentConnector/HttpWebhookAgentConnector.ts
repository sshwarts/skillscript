/**
 * HttpWebhookAgentConnector — example AgentConnector for HTTP-webhook substrates.
 *
 * This is the canonical worked example for adopter agents writing their own
 * AgentConnector against an HTTP substrate. It's intentionally readable + small,
 * not feature-complete. Adopters fork this directory into their own codebase
 * and customize per their substrate's specifics.
 *
 * What it does:
 *   - Maps `agent_id` → URL via JSON config (per audit v0.9.7 Q6).
 *   - POSTs DeliveryPayload (with `agent_id` at top-level for receiver routing)
 *     as JSON to the configured URL.
 *   - Synthesizes a DeliveryReceipt from the HTTP response (substrate-specific
 *     response shapes are translated here, not assumed canonical).
 *   - health_check() pings configured agents (or returns true if none configured).
 *   - wake() throws if no wake URL configured for the agent.
 *   - agent_status?() not implemented (optional per contract).
 *   - request_response() throws NotImplementedError until v0.10 exchange() ships.
 *
 * Deployment models the wire format supports without code changes:
 *   - Model A: one URL per agent_id. Routing decided by URL (different hosts /
 *     ports / paths). Adopter runs multiple receivers or one with URL-distinguished
 *     routing.
 *   - Model B: single URL, router receiver. Agent_id lives in the POST body;
 *     receiver inspects + dispatches. Cleaner when adopter already has a
 *     routing layer.
 *   - Model C: variable-driven channel selection IN THE SKILL —
 *     `notify(agent="agent-${CHANNEL}", ...)` — works on top of A or B.
 *
 * Auth: no auth by default. Bearer-token and HMAC-SHA256 paths are stubbed +
 * commented; adopters enable per their threat model.
 *
 * What it deliberately doesn't do (fork to add):
 *   - Retry on 5xx — fail-fast; adopters' retry semantics differ per substrate.
 *   - Multi-region failover URLs per agent.
 *   - OAuth flows, mTLS, SAML — adopter-specific auth providers.
 *   - Streaming / chunked deliveries (HTTP/2 push, websockets).
 *   - Async-callback reply pattern for request_response() (v0.10 design choice).
 */

// Adopters who fork this example: replace these relative imports with
// `import type { ... } from "skillscript-runtime/connectors";`
import type {
  AgentConnector,
  AgentDescriptor,
  DeliveryPayload,
  DeliveryReceipt,
  RequestResponseOpts,
  Response as AgentResponse,
  WakeOpts,
  WakeReceipt,
  StaticCapabilities,
} from "skillscript-runtime/connectors";

/** Per-agent config — `url` required; `wake_url` + `status_url` optional. */
export interface HttpWebhookAgentConfig {
  url: string;
  wake_url?: string;
  status_url?: string;
}

/** Connector construction options — all derivable from `.env`. */
export interface HttpWebhookAgentConnectorOptions {
  /** Map of agent_id → per-agent config. Required; empty map means no agents wired. */
  agents: Record<string, HttpWebhookAgentConfig>;
  /** Per-request timeout in ms (total request duration via AbortSignal.timeout). Default 5000. */
  timeout_ms?: number;
  /**
   * `Authorization` header value (e.g., `"Bearer abc123"`). When set, every
   * outbound POST includes `Authorization: <value>`. Can be combined with
   * `hmac_secret` for auth + body-integrity; most adopters need only one.
   */
  authorization?: string;
  /**
   * HMAC-SHA256 secret. When set, every outbound POST is signed:
   * `X-Signature: sha256=<hex(HMAC_SHA256(secret, raw_body))>`.
   * Receiver MUST validate signature against the RAW HTTP body BEFORE
   * parsing JSON — common foot-gun if validation happens post-parse
   * (key ordering / whitespace drift breaks the hash).
   */
  hmac_secret?: string;
}

/** Thrown when an HTTP request fails (network error, timeout, 4xx/5xx, or local validation). */
export class DeliveryFailedError extends Error {
  constructor(
    public readonly agent_id: string,
    public readonly cause_kind: "network" | "timeout" | "http_status" | "malformed_response" | "client_validation",
    public readonly http_status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "DeliveryFailedError";
  }
}

export class HttpWebhookAgentConnector implements AgentConnector {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "agent_connector",
      implementation: "HttpWebhookAgentConnector",
      contract_version: "1.0.0",
      features: { deliver: true, wake: true, list_agents: true, health_check: true },
    };
  }

  private readonly agents: Record<string, HttpWebhookAgentConfig>;
  private readonly timeout_ms: number;
  private readonly authorization?: string;
  private readonly hmac_secret?: string;

  constructor(opts: HttpWebhookAgentConnectorOptions) {
    this.agents = opts.agents;
    this.timeout_ms = opts.timeout_ms ?? 5000;
    this.authorization = opts.authorization;
    this.hmac_secret = opts.hmac_secret;
  }

  /**
   * Convenience: build from process.env (looks up the bundled env-var names).
   *
   * Validates env-var shape strictly — adopter footguns (NaN timeout, malformed
   * agents JSON, missing required fields) surface at construction time, not at
   * first dispatch failure. The validation pattern below is intentionally
   * educational: adopter forks should copy it.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): HttpWebhookAgentConnector {
    const raw = env["HTTP_WEBHOOK_AGENTS"];
    if (raw === undefined || raw === "") {
      throw new Error("HTTP_WEBHOOK_AGENTS env var is required (JSON map of agent_id → config).");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`HTTP_WEBHOOK_AGENTS must be valid JSON: ${(err as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("HTTP_WEBHOOK_AGENTS must be a JSON object (map of agent_id → config).");
    }
    for (const [agent_id, cfg] of Object.entries(parsed)) {
      if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
        throw new Error(`HTTP_WEBHOOK_AGENTS["${agent_id}"]: must be a config object (got ${typeof cfg}).`);
      }
      if (typeof (cfg as HttpWebhookAgentConfig).url !== "string" || (cfg as HttpWebhookAgentConfig).url === "") {
        throw new Error(`HTTP_WEBHOOK_AGENTS["${agent_id}"]: missing required "url" string field.`);
      }
    }
    const agents = parsed as Record<string, HttpWebhookAgentConfig>;

    const rawTimeout = env["HTTP_WEBHOOK_TIMEOUT_MS"];
    const timeout_ms = rawTimeout !== undefined ? Number.parseInt(rawTimeout, 10) : 5000;
    if (Number.isNaN(timeout_ms) || timeout_ms <= 0) {
      throw new Error(`HTTP_WEBHOOK_TIMEOUT_MS must be a positive integer (got: "${rawTimeout}").`);
    }

    return new HttpWebhookAgentConnector({
      agents,
      timeout_ms,
      ...(env["HTTP_WEBHOOK_AUTH"] !== undefined && env["HTTP_WEBHOOK_AUTH"] !== "" ? { authorization: env["HTTP_WEBHOOK_AUTH"] } : {}),
      ...(env["HTTP_WEBHOOK_HMAC_SECRET"] !== undefined && env["HTTP_WEBHOOK_HMAC_SECRET"] !== "" ? { hmac_secret: env["HTTP_WEBHOOK_HMAC_SECRET"] } : {}),
    });
  }

  async list_agents(): Promise<AgentDescriptor[]> {
    // Unconditional return per audit Q5.1 — no network ping on the list path
    // (runtime dispatch calls this to validate connector ownership; ping-first
    // would double round-trips on every dispatch).
    return Object.keys(this.agents).map((agent_id) => ({ agent_id }));
  }

  async deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt> {
    const cfg = this.agents[agent_id];
    if (cfg === undefined) {
      throw new DeliveryFailedError(
        agent_id, "client_validation", null,
        `Agent '${agent_id}' is not configured. Wired agents: ${Object.keys(this.agents).join(", ") || "(none)"}.`,
      );
    }

    // Wire body: include agent_id at top-level alongside the canonical
    // DeliveryPayload shape so Model B (single-URL router receivers) can
    // dispatch without inspecting URL.
    const body = JSON.stringify({ agent_id, ...payload });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authorization !== undefined) {
      headers["Authorization"] = this.authorization;
    }
    if (this.hmac_secret !== undefined) {
      const { createHmac } = await import("node:crypto");
      const sig = createHmac("sha256", this.hmac_secret).update(body, "utf8").digest("hex");
      headers["X-Signature"] = `sha256=${sig}`;
    }

    let response: globalThis.Response;
    try {
      response = await fetch(cfg.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.timeout_ms),
      });
    } catch (err) {
      const e = err as Error;
      const kind = e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : "network";
      throw new DeliveryFailedError(agent_id, kind, null, `${kind} error: ${e.message}`);
    }

    if (response.status >= 400) {
      throw new DeliveryFailedError(
        agent_id, "http_status", response.status,
        `HTTP ${response.status} from ${cfg.url}`,
      );
    }

    // Receiver returns the canonical DeliveryReceipt shape when it can.
    // Real-world webhooks (NanoClaw, Discord, Slack) return their own shapes;
    // we tolerantly accept either by parsing what we can and synthesizing
    // a canonical receipt.
    let receiverBody: unknown = {};
    try {
      const text = await response.text();
      if (text.length > 0) receiverBody = JSON.parse(text);
    } catch {
      // Malformed JSON from receiver — synthesize a minimal receipt rather
      // than throw. The HTTP layer reported success; agent-side observability
      // sees delivered_at populated.
    }
    return synthesizeReceipt(receiverBody);
  }

  async wake(agent_id: string, _opts?: WakeOpts): Promise<WakeReceipt> {
    const cfg = this.agents[agent_id];
    if (cfg === undefined) {
      // Caller misconfiguration (agent not in HTTP_WEBHOOK_AGENTS) — still
      // throws. Distinct from the substrate-can't-wake case below.
      throw new Error(`wake('${agent_id}'): agent not configured`);
    }
    if (cfg.wake_url === undefined) {
      // v0.18.2 — graceful degradation. No wake URL configured for this
      // agent means this connector is "passive" for them — webhook can
      // deliver content but can't interrupt. Per Perry's degradation
      // requirement: conform by degrading, never by erroring. Caller
      // reads `woken: false` and knows the wake was downgraded.
      return { woken_at: Date.now(), woken: false };
    }
    // Adopter-specific wake protocol; bundled example just POSTs to the URL.
    const response = await fetch(cfg.wake_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id }),
      signal: AbortSignal.timeout(this.timeout_ms),
    });
    if (response.status >= 400) {
      // Real substrate-side failure — still throws. Distinct from the
      // graceful-degradation case above (no wake URL configured at all).
      throw new Error(`wake('${agent_id}'): HTTP ${response.status}`);
    }
    return { woken_at: Date.now(), woken: true };
  }

  async health_check(): Promise<boolean> {
    // Default: ping each configured agent's status_url (if any). If no
    // status_urls configured, return true (we have no probe surface; trust
    // the URL config until first deliver() proves otherwise).
    const probes = Object.values(this.agents).filter((c) => c.status_url !== undefined);
    if (probes.length === 0) return true;
    try {
      const results = await Promise.all(probes.map((c) =>
        fetch(c.status_url!, { method: "GET", signal: AbortSignal.timeout(this.timeout_ms) }),
      ));
      return results.every((r) => r.status >= 200 && r.status < 300);
    } catch {
      return false;
    }
  }

  async request_response(
    agent_id: string,
    _payload: DeliveryPayload,
    _opts: RequestResponseOpts,
  ): Promise<AgentResponse> {
    // v0.10 design choice pending: (a) synchronous hold-connection — sender
    // keeps HTTP connection open, receiver returns reply in body; (b) async
    // callback — sender provides callback URL in request, receiver POSTs
    // reply back. The HTTP impl picks one when v0.10 exchange() ships.
    throw new Error(
      `[HttpWebhookAgentConnector] request_response('${agent_id}') — not implemented. ` +
      `Synchronous request-response shipping with v0.10 exchange() op.`,
    );
  }
}

/**
 * Translate the receiver's HTTP response body into a canonical DeliveryReceipt.
 * Receivers may return our exact shape, or substrate-specific shapes (Discord
 * message JSON, NanoClaw `{status, id}`, Slack ts+channel, etc.). Tolerate
 * variation; synthesize the canonical fields.
 *
 * Adopters with strict substrate shape can replace this function (or write
 * a wrapper) to enforce. Bundled example is permissive by design.
 */
function synthesizeReceipt(body: unknown): DeliveryReceipt {
  const now = Date.now();
  if (body === null || typeof body !== "object") {
    return { delivered_at: now };
  }
  const obj = body as Record<string, unknown>;
  const receipt: DeliveryReceipt = {
    delivered_at: typeof obj["delivered_at"] === "number" ? (obj["delivered_at"] as number) : now,
  };
  // Common substrate response fields that map to delivery_id:
  //   - NanoClaw: { status, id }
  //   - Discord: { id, ... }
  //   - Slack: { ts, channel, ... }
  const idCandidate = obj["delivery_id"] ?? obj["id"] ?? obj["ts"];
  if (typeof idCandidate === "string") {
    receipt.delivery_id = idCandidate;
  }
  // Adopter signals "accepted but not pushed":
  if (obj["delivery_skipped"] === true) {
    receipt.delivery_skipped = true;
  }
  return receipt;
}
