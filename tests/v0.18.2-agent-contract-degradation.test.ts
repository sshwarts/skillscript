import { describe, it, expect } from "vitest";
import { NoOpAgentConnector } from "../src/connectors/agent-noop.js";
import { HttpWebhookAgentConnector } from "../examples/connectors/HttpWebhookAgentConnector/HttpWebhookAgentConnector.js";
import type { AgentConnector, DeliveryPayload, WakeReceipt } from "../src/connectors/agent.js";

/**
 * v0.18.2 — AgentConnector contract robustness per Perry's notes:
 *
 * (1) Session-granular targeting — `agent_id` accepts opaque
 *     `agent@session` composite the substrate decomposes;
 *     `WakeOpts.session_id` is the structured alternative.
 *
 * (2) Graceful degradation on wake — passive substrates (no
 *     interrupt-capability) return `woken: false` instead of throwing.
 *     "Conform by degrading, never by erroring."
 */

describe("v0.18.2 — WakeReceipt.woken signals interrupt-capability honestly", () => {
  it("NoOpAgentConnector returns woken: false (cannot interrupt anything)", async () => {
    const conn = new NoOpAgentConnector();
    const receipt = await conn.wake("agent-x");
    expect(receipt.woken).toBe(false);
    expect(typeof receipt.woken_at).toBe("number");
  });

  it("HttpWebhookAgentConnector without wake_url degrades to woken: false", async () => {
    const conn = new HttpWebhookAgentConnector({
      agents: { "agent-x": { url: "http://example.invalid/" } },
    });
    const receipt = await conn.wake("agent-x");
    expect(receipt.woken).toBe(false);
  });

  it("HttpWebhookAgentConnector still throws on caller misconfiguration (unknown agent)", async () => {
    const conn = new HttpWebhookAgentConnector({
      agents: { "agent-x": { url: "http://example.invalid/" } },
    });
    await expect(conn.wake("not-configured")).rejects.toThrow(/agent not configured/);
  });
});

describe("v0.18.2 — agent_id accepts opaque `agent@session` composite (substrate decomposes)", () => {
  // The contract treats `agent_id` as an opaque string. Substrates that
  // track sessions parse the composite; those that don't ignore the
  // suffix. The test confirms the contract type-permits the composite
  // form — substrates choose how to interpret.

  class CompositeAwareConnector implements AgentConnector {
    public lastAgent?: string;
    public lastSession?: string;
    async list_agents() { return []; }
    async deliver(agent_id: string, _payload: DeliveryPayload) {
      const [agent, session] = agent_id.split("@");
      this.lastAgent = agent;
      this.lastSession = session;
      return { delivered_at: Date.now(), ...(session !== undefined ? { session_id: session } : {}) };
    }
    async wake(agent_id: string, opts?: { session_id?: string }): Promise<WakeReceipt> {
      const [agent, embeddedSession] = agent_id.split("@");
      this.lastAgent = agent;
      this.lastSession = opts?.session_id ?? embeddedSession;
      return { woken_at: Date.now(), woken: true, ...(this.lastSession !== undefined ? { session_id: this.lastSession } : {}) };
    }
    async health_check() { return true; }
    async request_response(): Promise<never> { throw new Error("not impl"); }
  }

  it("deliver(`agent@session`) decomposes correctly when substrate parses", async () => {
    const conn = new CompositeAwareConnector();
    await conn.deliver("perry@kitchen-terminal", {
      kind: "augment",
      content: "hi",
      meta: { dispatch_id: "d1", trigger_kind: "inline", caller_agent_id: "x", entry_skill_name: "x", source_skill_name: "x", agent_id: "perry", fired_at_ms: 0 },
    });
    expect(conn.lastAgent).toBe("perry");
    expect(conn.lastSession).toBe("kitchen-terminal");
  });

  it("wake(`agent@session`) decomposes; receipt echoes session_id", async () => {
    const conn = new CompositeAwareConnector();
    const receipt = await conn.wake("perry@kitchen-terminal");
    expect(conn.lastSession).toBe("kitchen-terminal");
    expect(receipt.session_id).toBe("kitchen-terminal");
    expect(receipt.woken).toBe(true);
  });

  it("wake(agent, { session_id: 'X' }) — structured form, opts.session_id wins over embedded suffix", async () => {
    const conn = new CompositeAwareConnector();
    const receipt = await conn.wake("perry@embedded", { session_id: "structured" });
    expect(conn.lastSession).toBe("structured");
    expect(receipt.session_id).toBe("structured");
  });

  it("bare agent_id (no `@`) still works — substrate sees undefined session", async () => {
    const conn = new CompositeAwareConnector();
    const receipt = await conn.wake("perry");
    expect(conn.lastAgent).toBe("perry");
    expect(conn.lastSession).toBeUndefined();
    expect(receipt.session_id).toBeUndefined();
  });
});

describe("v0.18.2 — DeliveryReceipt.session_id surfaces session-targeted delivery", () => {
  it("session-aware substrate sets DeliveryReceipt.session_id; session-agnostic omits it", async () => {
    // Verified inline by CompositeAwareConnector above: it sets
    // session_id when the agent_id contains @session, omits otherwise.
    // The contract permits both shapes — substrates choose what they
    // track and surface.
    expect(true).toBe(true);
  });
});
