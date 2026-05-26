// AgentConnector — the fifth connector contract, added in T7.1 for v0.2.0.
//
// Augmenting and Template skill kinds both deliver to a *frontier agent*.
// The runtime needs a substrate-neutral way to (a) discover which agents
// are reachable, (b) deliver content into an agent's context, and (c)
// optionally wake a sleeping agent. AgentConnector covers all three.
//
// Substrate examples — the contract is neutral; adopters wire impls:
//
//   - tmux session: `deliver` via `tmux send-keys` to a pane
//   - webhook:      POST to /augment or /template endpoint
//   - file-watch:   write to `<path>/augment-<id>.txt`
//   - Slack thread: post to monitored thread
//   - IPC pipe:     write to named pipe
//   - AMP memory:   write `agent:` memory with recipients (T8)
//
// The bundled default is `NoOpAgentConnector` — list_agents returns [],
// deliver/wake resolve with a warning log. Lets the runtime start cleanly
// when no agent substrate is wired.

import type { StaticCapabilities, ManifestInfo } from "./types.js";

/**
 * Provenance record threaded onto every `DeliveryPayload` so the receiving
 * agent can disambiguate "what fired this delivery" — was it cron-scheduled?
 * a session boundary? a user-triggered manual run? v0.2.6 addition per the
 * AgentConnector polish in Perry's thread `f75477a4`.
 */
export interface TriggerProvenance {
  source: "cron" | "session" | "event" | "agent-event" | "file-watch" | "sensor" | "manual";
  /** Source-specific value: cron expression, session phase, event name, etc. */
  name: string;
  /** Unix-ms timestamp the trigger fired. */
  fired_at_ms: number;
}

/**
 * Discriminated payload union for `deliver`. The runtime picks `kind`
 * based on the source declaration:
 *   - `# Output: agent: <name>` → `{ kind: "augment", ... }`
 *   - `# Output: template: <agent>`       → `{ kind: "template", ... }`
 *
 * Common-shaped provenance + augmenting-context fields apply to both
 * variants (v0.2.6 addition). `source_skill` was template-only in T7.1;
 * now lives on both.
 */
export type DeliveryPayload =
  | {
      kind: "augment";
      content: string;
      format?: "text" | "markdown";
      source_skill?: string;
      triggered_by?: TriggerProvenance;
      delivery_context?: string;
      templates?: string[];
    }
  | {
      kind: "template";
      prompt: string;
      source_skill?: string;
      triggered_by?: TriggerProvenance;
      delivery_context?: string;
      templates?: string[];
    };

export interface DeliveryReceipt {
  /** Unix-ms timestamp the substrate accepted the delivery. */
  delivered_at: number;
  /** Substrate-specific id for callers to correlate later. */
  delivery_id?: string;
}

export interface WakeOpts {
  /** Optional preamble to prepend to the wake message. */
  context?: string;
  /** `"immediate"` (default) or a unix-ms timestamp for scheduled wake. */
  when?: "immediate" | number;
}

export interface WakeReceipt {
  woken_at: number;
  session_id?: string;
}

export interface AgentDescriptor {
  agent_id: string;
  agent_name?: string;
  capabilities?: ReadonlyArray<"deliver" | "wake" | "augment" | "template">;
}

export type AgentStatus = "active" | "idle" | "asleep" | "unknown";

/**
 * The contract. Two primary verbs (deliver + wake), one mandatory
 * discovery method (list_agents), one optional status probe.
 */
export interface AgentConnector {
  list_agents(): Promise<AgentDescriptor[]>;
  deliver(agent_id: string, payload: DeliveryPayload): Promise<DeliveryReceipt>;
  wake(agent_id: string, opts?: WakeOpts): Promise<WakeReceipt>;
  agent_status?(agent_id: string): Promise<AgentStatus>;
  manifest(): Promise<ManifestInfo>;
}

export interface AgentConnectorClass {
  new (...args: never[]): AgentConnector;
  staticCapabilities(): StaticCapabilities;
}
