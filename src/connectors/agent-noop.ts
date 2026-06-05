import type {
  AgentConnector,
  AgentDescriptor,
  AgentStatus,
  DeliveryPayload,
  DeliveryReceipt,
  RequestResponseOpts,
  Response,
  WakeOpts,
  WakeReceipt,
} from "./agent.js";
import type { AgentConnectorCapabilities } from "./types.js";

/**
 * Default AgentConnector — `list_agents` returns []; `deliver` and `wake`
 * resolve cleanly after logging a one-line warning so adopters notice the
 * dispatch happened without a wired substrate. Lets the runtime start
 * with no AgentConnector configured: `# Output: agent:` decls still
 * complete (with a warning instead of a thrown error) so authors don't
 * have to wire a substrate before running mechanical previews.
 *
 * Use this in tests + dev. For production, wire a real impl
 * (HttpWebhookAgentConnector, TmuxAgentConnector, FileAgentConnector, etc.)
 * via Registry.registerAgentConnector("primary", new MyImpl(...)).
 *
 * Reference pattern for adopter-agent authors (per memory `9fbeb1a1`): this
 * file is the canonical worked example. Adopter agents reading the contract
 * should look here for "how do I shape my impl."
 */
export class NoOpAgentConnector implements AgentConnector {
  static staticCapabilities(): AgentConnectorCapabilities {
    return {
      connector_type: "agent_connector",
      implementation: "NoOpAgentConnector",
      contract_version: "1.0.0",
      features: { deliver: true, wake: true, list_agents: true, agent_status: true, health_check: true },
    };
  }

  async list_agents(): Promise<AgentDescriptor[]> {
    return [];
  }

  async deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt> {
    process.stderr.write(
      `[NoOpAgentConnector] deliver(${agent_id}, kind=${payload.kind}, dispatch_id=${payload.meta.dispatch_id}) — no substrate wired; payload discarded.\n`,
    );
    return { delivered_at: Date.now() };
  }

  async wake(agent_id: string, _opts?: WakeOpts): Promise<WakeReceipt> {
    process.stderr.write(
      `[NoOpAgentConnector] wake(${agent_id}) — no substrate wired; wake skipped.\n`,
    );
    // v0.18.2 — graceful degradation: NoOp can't interrupt anything, so
    // it reports `woken: false`. Callers reading the receipt distinguish
    // delivered-only from actually-woke without needing per-substrate
    // knowledge. Per Perry's degradation requirement: conform by
    // degrading, never by erroring.
    return { woken_at: Date.now(), woken: false };
  }

  async health_check(): Promise<boolean> {
    // NoOp is always "healthy" — there's no real substrate to fail. Adopters
    // who want the runtime to refuse-to-start when no real connector is wired
    // should wire a real impl; the bootstrap-throws contract (Q6) only fires
    // when an adopter's connector returns false, not on the NoOp default.
    return true;
  }

  async request_response(
    agent_id: string,
    _payload: DeliveryPayload,
    _opts: RequestResponseOpts,
  ): Promise<Response> {
    // Locked contract shape per Q1; runtime impl deferred to v0.10 (when
    // exchange() op ships). Adopters' agents implementing real AgentConnectors
    // before v0.10 should throw NotImplementedError following this pattern
    // until their substrate has request-response semantics.
    throw new Error(
      `[NoOpAgentConnector] request_response(${agent_id}) — not implemented. ` +
      `Synchronous request-response shipping in v0.10 with the exchange() op. ` +
      `Adopters implementing this method against their substrate today should ` +
      `throw NotImplementedError until v0.10 runtime support lands.`,
    );
  }

  async agent_status(_agent_id: string): Promise<AgentStatus> {
    // Signal-only metadata; NoOp tracks no per-agent state, so always
    // "unknown." Runtime does NOT auto-gate delivery on this value — adopters
    // wanting to skip delivery for offline agents set delivery_skipped on
    // DeliveryReceipt instead.
    return "unknown";
  }
}
