import type {
  AgentConnector,
  AgentDescriptor,
  DeliveryPayload,
  DeliveryReceipt,
  WakeOpts,
  WakeReceipt,
  AgentStatus,
} from "./agent.js";
import type { StaticCapabilities, ManifestInfo } from "./types.js";

/**
 * Default AgentConnector — `list_agents` returns []; `deliver` and `wake`
 * resolve cleanly after logging a one-line warning so adopters notice the
 * dispatch happened without a wired substrate. Lets the runtime start
 * with no AgentConnector configured: `# Output: agent:` decls
 * still complete (with a warning instead of a thrown error) so authors
 * don't have to wire a substrate before running mechanical previews.
 *
 * Use this in tests + dev. For production, wire a real impl
 * (FileAgentConnector, WebhookAgentConnector, TmuxAgentConnector, etc.)
 * via Registry.registerAgentConnector("primary", new MyImpl(...)).
 */
export class NoOpAgentConnector implements AgentConnector {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "agent_connector",
      implementation: "NoOpAgentConnector",
      contract_version: "1.0.0",
      features: { deliver: true, wake: true, list_agents: true, agent_status: true },
    };
  }

  async list_agents(): Promise<AgentDescriptor[]> {
    return [];
  }

  async deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt> {
    process.stderr.write(
      `[NoOpAgentConnector] deliver(${agent_id}, kind=${payload.kind}) — no substrate wired; payload discarded.\n`,
    );
    return { delivered_at: Date.now() };
  }

  async wake(agent_id: string, _opts?: WakeOpts): Promise<WakeReceipt> {
    process.stderr.write(
      `[NoOpAgentConnector] wake(${agent_id}) — no substrate wired; wake skipped.\n`,
    );
    return { woken_at: Date.now() };
  }

  async agent_status(_agent_id: string): Promise<AgentStatus> {
    return "unknown";
  }

  async manifest(): Promise<ManifestInfo> {
    return {
      capabilities_version: "1.0.0",
      manifest: { reachable_agents: [] },
    };
  }
}
