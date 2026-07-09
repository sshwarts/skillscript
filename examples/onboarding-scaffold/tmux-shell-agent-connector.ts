// Onboarding scaffold: tmux-shell AgentConnector.
//
// Delivers skill output to a named tmux session via `tmux send-keys`.
// Matches what nanoclaw-style agent harnesses do internally — adopters
// with agents running in tmux sessions can wire `# Output: agent: <agent>`
// end-to-end against this impl.
//
// **Scope.** Implements the full AgentConnector contract: `deliver()` +
// `list_agents()` + `wake()` + `agent_status()` + `health_check()` +
// `request_response()` + `manifest()`. `wake()` degrades to a no-op (tmux
// panes are always live; wake is for harnesses with sleep modes) and
// `request_response()` throws not-implemented (send-keys is fire-and-forget).

import { spawn } from "node:child_process";
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
} from "skillscript-runtime/connectors";
import type { ManifestInfo, StaticCapabilities } from "skillscript-runtime/connectors";

export interface TmuxShellAgentConnectorConfig {
  /** Map agent ID → tmux session name. Lookup at deliver-time. */
  sessionMap: Record<string, string>;
  /** Window index within the session. Default `0`. */
  windowIndex?: number;
  /** Pane index within the window. Default `0`. */
  paneIndex?: number;
}

export class TmuxShellAgentConnector implements AgentConnector {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "agent_connector",
      implementation: "TmuxShellAgentConnector",
      contract_version: "1.0.0",
      // AgentConnector flags are method-presence shape (one per contract
      // method). `wake` is present but degrades to a no-op — see wake()'s
      // `woken: false` receipt.
      features: { deliver: true, wake: true, list_agents: true, agent_status: true },
    };
  }

  constructor(private readonly config: TmuxShellAgentConnectorConfig) {}

  async list_agents(): Promise<AgentDescriptor[]> {
    return Object.keys(this.config.sessionMap).map((agent_id) => ({
      agent_id,
      capabilities: ["deliver", "augment", "template"] as const,
    }));
  }

  async deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt> {
    const session = this.config.sessionMap[agent_id];
    if (session === undefined) {
      throw new Error(`TmuxShellAgentConnector: no tmux session mapped for agent '${agent_id}'.`);
    }
    const winIdx = this.config.windowIndex ?? 0;
    const paneIdx = this.config.paneIndex ?? 0;
    const target = `${session}:${winIdx}.${paneIdx}`;

    // Extract the deliverable text. `augment` (prompt-context) carries it
    // on `content`; `template` carries it on `prompt`.
    const text = payload.kind === "augment" ? payload.content : payload.prompt;
    if (text === "") {
      return { delivered_at: Date.now(), delivery_id: `tmux:${target}:noop` };
    }

    await this.tmux(["send-keys", "-t", target, "-l", text]);
    await this.tmux(["send-keys", "-t", target, "Enter"]);

    return {
      delivered_at: Date.now(),
      delivery_id: `tmux:${target}:${Date.now()}`,
    };
  }

  async wake(agent_id: string, _opts?: WakeOpts): Promise<WakeReceipt> {
    // tmux panes are always live — there is nothing to wake. `woken: false`
    // is the honest receipt: the substrate performed no wake action (the
    // contract reads false as "degraded to deliver-only").
    const session = this.config.sessionMap[agent_id];
    return {
      woken_at: Date.now(),
      woken: false,
      ...(session !== undefined ? { session_id: session } : {}),
    };
  }

  async agent_status(agent_id: string): Promise<AgentStatus> {
    return this.config.sessionMap[agent_id] !== undefined ? "active" : "unknown";
  }

  /**
   * Substrate liveness: is the `tmux` binary reachable? Invoked at
   * `Registry.registerAgentConnector()` — a false return refuses the wiring
   * early instead of failing on the first deliver.
   */
  async health_check(): Promise<boolean> {
    try {
      await this.tmux(["-V"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * tmux send-keys is fire-and-forget — there is no reply channel to
   * correlate a response on. Throw not-implemented per the contract's
   * documented pattern (see NoOpAgentConnector) rather than fake a reply.
   */
  async request_response(agent_id: string, _payload: DeliveryPayload, _opts: RequestResponseOpts): Promise<Response> {
    throw new Error(
      `TmuxShellAgentConnector: request_response(${agent_id}) not implemented — ` +
      `tmux send-keys has no reply channel. Use deliver() for one-way output.`,
    );
  }

  async manifest(): Promise<ManifestInfo> {
    return {
      capabilities_version: "1",
      manifest: {
        kind: "tmux-shell-agent-connector",
        agents_configured: Object.keys(this.config.sessionMap),
      },
    };
  }

  private tmux(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("tmux", args, { stdio: "ignore" });
      child.on("exit", (code: number | null) => {
        if (code === 0) resolve();
        else reject(new Error(`tmux ${args.join(" ")} exited ${code}`));
      });
      child.on("error", reject);
    });
  }
}
