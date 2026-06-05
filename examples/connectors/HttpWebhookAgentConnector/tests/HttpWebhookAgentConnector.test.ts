/**
 * Tests for the HttpWebhookAgentConnector example.
 *
 * Uses Node's built-in `http.createServer` as a mock receiver — no
 * external dependencies. Each test spins up a fresh server bound to
 * port 0 (kernel-assigned) so tests can run in parallel.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { HttpWebhookAgentConnector, DeliveryFailedError } from "../HttpWebhookAgentConnector.js";
import type { DeliveryPayload } from "../../../../src/connectors/agent.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface MockServer {
  server: Server;
  url: string;
  port: number;
  received: RecordedRequest[];
  setResponse: (status: number, body: object | string) => void;
  close: () => Promise<void>;
}

async function startMock(): Promise<MockServer> {
  let responseStatus = 200;
  let responseBody: object | string = { delivered_at: 1700000000000 };
  const received: RecordedRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.statusCode = responseStatus;
      res.setHeader("content-type", "application/json");
      res.end(typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    port,
    received,
    setResponse: (status, body) => { responseStatus = status; responseBody = body; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const META_FIXTURE: DeliveryPayload["meta"] = {
  dispatch_id: "test-dispatch-id",
  sent_at: 1700000000000,
  origin: { skill_name: "test-skill", trigger_kind: "inline" },
};

describe("HttpWebhookAgentConnector — deliver()", () => {
  let mock: MockServer;
  beforeEach(async () => { mock = await startMock(); });
  afterEach(async () => { await mock.close(); });

  it("POSTs canonical envelope with agent_id at top-level", async () => {
    const conn = new HttpWebhookAgentConnector({
      agents: { "agent-x": { url: mock.url } },
    });
    await conn.deliver("agent-x", { kind: "augment", content: "hello", meta: META_FIXTURE });

    expect(mock.received).toHaveLength(1);
    const body = JSON.parse(mock.received[0]!.body.toString("utf8"));
    expect(body.agent_id).toBe("agent-x");
    expect(body.kind).toBe("augment");
    expect(body.content).toBe("hello");
    expect(body.meta.dispatch_id).toBe("test-dispatch-id");
    expect(body.meta.origin.skill_name).toBe("test-skill");
  });

  it("POSTs template kind round-trips", async () => {
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    await conn.deliver("agent-x", { kind: "template", prompt: "playbook body", meta: META_FIXTURE });
    const body = JSON.parse(mock.received[0]!.body.toString("utf8"));
    expect(body.kind).toBe("template");
    expect(body.prompt).toBe("playbook body");
  });

  it("sends Content-Type: application/json", async () => {
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    await conn.deliver("agent-x", { kind: "augment", content: "hi", meta: META_FIXTURE });
    expect(mock.received[0]!.headers["content-type"]).toBe("application/json");
  });

  it("parses canonical receipt response", async () => {
    mock.setResponse(200, { delivered_at: 1700000000999, delivery_id: "receiver-id-42", delivery_skipped: false });
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    const receipt = await conn.deliver("agent-x", { kind: "augment", content: "hi", meta: META_FIXTURE });
    expect(receipt.delivered_at).toBe(1700000000999);
    expect(receipt.delivery_id).toBe("receiver-id-42");
  });

  it("synthesizes receipt from substrate-shaped response (NanoClaw-style { status, id })", async () => {
    mock.setResponse(202, { status: "accepted", id: "wh-1234-abc" });
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    const receipt = await conn.deliver("agent-x", { kind: "augment", content: "hi", meta: META_FIXTURE });
    expect(typeof receipt.delivered_at).toBe("number");
    expect(receipt.delivery_id).toBe("wh-1234-abc");
  });

  it("honors delivery_skipped: true from receiver", async () => {
    mock.setResponse(200, { delivered_at: 1700000000999, delivery_skipped: true });
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    const receipt = await conn.deliver("agent-x", { kind: "augment", content: "hi", meta: META_FIXTURE });
    expect(receipt.delivery_skipped).toBe(true);
  });

  it("synthesizes minimal receipt from empty body (no fields available)", async () => {
    mock.setResponse(200, "");
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    const receipt = await conn.deliver("agent-x", { kind: "augment", content: "hi", meta: META_FIXTURE });
    expect(typeof receipt.delivered_at).toBe("number");
    expect(receipt.delivery_id).toBeUndefined();
  });

  it("throws DeliveryFailedError on 4xx", async () => {
    mock.setResponse(400, { error: "bad request" });
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    await expect(
      conn.deliver("agent-x", { kind: "augment", content: "hi", meta: META_FIXTURE }),
    ).rejects.toThrow(DeliveryFailedError);
  });

  it("throws DeliveryFailedError on 5xx", async () => {
    mock.setResponse(503, { error: "service unavailable" });
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    const err = await conn.deliver("agent-x", { kind: "augment", content: "hi", meta: META_FIXTURE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryFailedError);
    expect((err as DeliveryFailedError).http_status).toBe(503);
  });

  it("throws DeliveryFailedError when agent_id is not configured", async () => {
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    await expect(
      conn.deliver("not-wired", { kind: "augment", content: "hi", meta: META_FIXTURE }),
    ).rejects.toThrow(/not configured/);
  });
});

describe("HttpWebhookAgentConnector — Model A + Model B routing", () => {
  it("Model A: multi-agent_id with distinct URLs → POSTs to the matching URL", async () => {
    const mockA = await startMock();
    const mockB = await startMock();
    try {
      const conn = new HttpWebhookAgentConnector({
        agents: {
          "agent-slack": { url: mockA.url },
          "agent-whatsapp": { url: mockB.url },
        },
      });
      await conn.deliver("agent-slack", { kind: "augment", content: "via slack", meta: META_FIXTURE });
      await conn.deliver("agent-whatsapp", { kind: "augment", content: "via whatsapp", meta: META_FIXTURE });

      expect(mockA.received).toHaveLength(1);
      expect(mockB.received).toHaveLength(1);
      const bodyA = JSON.parse(mockA.received[0]!.body.toString("utf8"));
      const bodyB = JSON.parse(mockB.received[0]!.body.toString("utf8"));
      expect(bodyA.content).toBe("via slack");
      expect(bodyB.content).toBe("via whatsapp");
    } finally {
      await mockA.close();
      await mockB.close();
    }
  });

  it("Model B: multi-agent_id with same URL → agent_id in body distinguishes", async () => {
    const mock = await startMock();
    try {
      const conn = new HttpWebhookAgentConnector({
        agents: {
          "agent-slack": { url: mock.url },
          "agent-whatsapp": { url: mock.url },
        },
      });
      await conn.deliver("agent-slack", { kind: "augment", content: "x", meta: META_FIXTURE });
      await conn.deliver("agent-whatsapp", { kind: "augment", content: "y", meta: META_FIXTURE });

      expect(mock.received).toHaveLength(2);
      const ids = mock.received.map((r) => JSON.parse(r.body.toString("utf8")).agent_id);
      expect(ids).toEqual(["agent-slack", "agent-whatsapp"]);
    } finally {
      await mock.close();
    }
  });
});

describe("HttpWebhookAgentConnector — auth", () => {
  let mock: MockServer;
  beforeEach(async () => { mock = await startMock(); });
  afterEach(async () => { await mock.close(); });

  it("bearer-token sets Authorization header", async () => {
    const conn = new HttpWebhookAgentConnector({
      agents: { "agent-x": { url: mock.url } },
      authorization: "Bearer abc123",
    });
    await conn.deliver("agent-x", { kind: "augment", content: "hi", meta: META_FIXTURE });
    expect(mock.received[0]!.headers["authorization"]).toBe("Bearer abc123");
  });

  it("bearer + HMAC combinable — both headers set when both options provided", async () => {
    const conn = new HttpWebhookAgentConnector({
      agents: { "agent-x": { url: mock.url } },
      authorization: "Bearer combined-test",
      hmac_secret: "combined-secret",
    });
    await conn.deliver("agent-x", { kind: "augment", content: "hi", meta: META_FIXTURE });
    expect(mock.received[0]!.headers["authorization"]).toBe("Bearer combined-test");
    expect(typeof mock.received[0]!.headers["x-signature"]).toBe("string");
  });

  it("HMAC signing sets X-Signature header with correct value", async () => {
    const secret = "test-secret-key";
    const conn = new HttpWebhookAgentConnector({
      agents: { "agent-x": { url: mock.url } },
      hmac_secret: secret,
    });
    await conn.deliver("agent-x", { kind: "augment", content: "hi", meta: META_FIXTURE });

    const rawBody = mock.received[0]!.body.toString("utf8");
    const { createHmac } = await import("node:crypto");
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
    expect(mock.received[0]!.headers["x-signature"]).toBe(expected);
  });

  it("no auth headers set when neither auth_header nor hmac_secret configured", async () => {
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    await conn.deliver("agent-x", { kind: "augment", content: "hi", meta: META_FIXTURE });
    expect(mock.received[0]!.headers["authorization"]).toBeUndefined();
    expect(mock.received[0]!.headers["x-signature"]).toBeUndefined();
  });
});

describe("HttpWebhookAgentConnector — list_agents / health_check / wake / request_response", () => {
  let mock: MockServer;
  beforeEach(async () => { mock = await startMock(); });
  afterEach(async () => { await mock.close(); });

  it("list_agents returns all configured agent_ids", async () => {
    const conn = new HttpWebhookAgentConnector({
      agents: {
        "agent-slack": { url: mock.url },
        "agent-whatsapp": { url: mock.url },
      },
    });
    const agents = await conn.list_agents();
    expect(agents.map((a) => a.agent_id).sort()).toEqual(["agent-slack", "agent-whatsapp"]);
  });

  it("health_check returns true when no status_urls configured", async () => {
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    expect(await conn.health_check()).toBe(true);
  });

  it("health_check pings status_urls when configured + returns true on 2xx", async () => {
    const conn = new HttpWebhookAgentConnector({
      agents: { "agent-x": { url: mock.url, status_url: `${mock.url}/status` } },
    });
    mock.setResponse(200, { status: "ok" });
    expect(await conn.health_check()).toBe(true);
  });

  it("wake degrades gracefully when wake_url not configured (v0.18.2 — returns woken: false instead of throwing)", async () => {
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    const receipt = await conn.wake("agent-x");
    expect(receipt.woken).toBe(false);
    expect(typeof receipt.woken_at).toBe("number");
  });

  it("wake POSTs to wake_url when configured + reports woken: true", async () => {
    const conn = new HttpWebhookAgentConnector({
      agents: { "agent-x": { url: mock.url, wake_url: `${mock.url}/wake` } },
    });
    const receipt = await conn.wake("agent-x");
    expect(typeof receipt.woken_at).toBe("number");
    expect(receipt.woken).toBe(true);
    expect(mock.received).toHaveLength(1);
    expect(mock.received[0]!.url).toBe("/wake");
  });

  it("request_response throws NotImplementedError (v0.10 deferred)", async () => {
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    await expect(
      conn.request_response("agent-x", { kind: "augment", content: "ping", meta: META_FIXTURE }, { timeout_ms: 1000 }),
    ).rejects.toThrow(/not implemented/i);
  });
});

describe("HttpWebhookAgentConnector — fromEnv()", () => {
  it("constructs from process.env-shaped object", () => {
    const env = {
      HTTP_WEBHOOK_AGENTS: JSON.stringify({ "agent-x": { url: "http://example.com" } }),
      HTTP_WEBHOOK_TIMEOUT_MS: "8000",
      HTTP_WEBHOOK_AUTH: "Bearer xyz",
    };
    const conn = HttpWebhookAgentConnector.fromEnv(env as NodeJS.ProcessEnv);
    expect(conn).toBeInstanceOf(HttpWebhookAgentConnector);
  });

  it("throws when HTTP_WEBHOOK_AGENTS missing", () => {
    expect(() => HttpWebhookAgentConnector.fromEnv({} as NodeJS.ProcessEnv)).toThrow(/required/);
  });

  it("throws when HTTP_WEBHOOK_AGENTS is invalid JSON", () => {
    expect(() => HttpWebhookAgentConnector.fromEnv({ HTTP_WEBHOOK_AGENTS: "not-json" } as NodeJS.ProcessEnv)).toThrow(/valid JSON/);
  });

  it("throws when HTTP_WEBHOOK_AGENTS parses to non-object (string)", () => {
    expect(() => HttpWebhookAgentConnector.fromEnv({ HTTP_WEBHOOK_AGENTS: JSON.stringify("just-a-string") } as NodeJS.ProcessEnv))
      .toThrow(/must be a JSON object/);
  });

  it("throws when HTTP_WEBHOOK_AGENTS parses to array", () => {
    expect(() => HttpWebhookAgentConnector.fromEnv({ HTTP_WEBHOOK_AGENTS: JSON.stringify(["a", "b"]) } as NodeJS.ProcessEnv))
      .toThrow(/must be a JSON object/);
  });

  it("throws when an agent config is missing url", () => {
    const env = { HTTP_WEBHOOK_AGENTS: JSON.stringify({ "agent-x": { wake_url: "http://example.com" } }) };
    expect(() => HttpWebhookAgentConnector.fromEnv(env as NodeJS.ProcessEnv))
      .toThrow(/missing required "url"/);
  });

  it("throws when HTTP_WEBHOOK_TIMEOUT_MS is non-numeric (NaN guard)", () => {
    const env = {
      HTTP_WEBHOOK_AGENTS: JSON.stringify({ "agent-x": { url: "http://example.com" } }),
      HTTP_WEBHOOK_TIMEOUT_MS: "abc",
    };
    expect(() => HttpWebhookAgentConnector.fromEnv(env as NodeJS.ProcessEnv))
      .toThrow(/positive integer/);
  });

  it("throws when HTTP_WEBHOOK_TIMEOUT_MS is zero or negative", () => {
    const env = {
      HTTP_WEBHOOK_AGENTS: JSON.stringify({ "agent-x": { url: "http://example.com" } }),
      HTTP_WEBHOOK_TIMEOUT_MS: "0",
    };
    expect(() => HttpWebhookAgentConnector.fromEnv(env as NodeJS.ProcessEnv))
      .toThrow(/positive integer/);
  });
});

describe("HttpWebhookAgentConnector — defensive paths", () => {
  let mock: MockServer;
  beforeEach(async () => { mock = await startMock(); });
  afterEach(async () => { await mock.close(); });

  it("synthesizes minimal receipt when receiver returns malformed JSON", async () => {
    mock.setResponse(200, "{not-valid-json");
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    const receipt = await conn.deliver("agent-x", { kind: "augment", content: "hi", meta: META_FIXTURE });
    expect(typeof receipt.delivered_at).toBe("number");
    expect(receipt.delivery_id).toBeUndefined();
  });

  it("unconfigured agent throws DeliveryFailedError with cause_kind=client_validation", async () => {
    const conn = new HttpWebhookAgentConnector({ agents: { "agent-x": { url: mock.url } } });
    const err = await conn.deliver("not-wired", { kind: "augment", content: "hi", meta: META_FIXTURE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryFailedError);
    expect((err as DeliveryFailedError).cause_kind).toBe("client_validation");
    expect((err as DeliveryFailedError).http_status).toBeNull();
  });
});
