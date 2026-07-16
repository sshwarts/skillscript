/**
 * RestConnector — a *working* McpConnector that fronts a plain REST/HTTP API.
 *
 * Unlike `McpConnectorTemplate` (a throws-`TODO` skeleton that surfaces the
 * contract surface), this is a **complete, runnable** connector. Copy the
 * directory, edit the `ENDPOINTS` table + base URL + auth, register it, and
 * `$ <name>.<tool>` dispatches from a skill body hit your REST backend.
 *
 * ─── The point this example proves ──────────────────────────────────────────
 *
 * **The McpConnector contract is wire-protocol-agnostic.** "MCP" is in the type
 * name because `$ connector.tool` is the *dispatch surface skills call* — it is
 * NOT a requirement that the backend speak the MCP wire protocol.
 *
 *   - `HttpMcpConnector` speaks JSON-RPC-over-HTTP because it fronts MCP servers.
 *   - This connector speaks plain REST because it fronts a REST API.
 *   - A `WebSocketMcpConnector`, a gRPC bridge, an in-process call — all the same.
 *
 * All satisfy the same two-method contract (`call` + `manifest`). A skill can't
 * tell them apart, and **a single skill body can mix them**:
 *
 *   $ gmail.send to="ops@acme.io" subject="Deploy done"      # an MCP connector
 *   -> _
 *   $ tickets.create title="Deploy 4.2" severity="info"       # this REST connector
 *   -> ticket
 *
 * Both are just `$ <name>.<tool>` ops. The registry holds a heterogeneous set;
 * each op routes to whatever connector owns that name.
 *
 * ─── What you edit to adopt it ──────────────────────────────────────────────
 *
 *   1. `ENDPOINTS` — one entry per tool: HTTP method + path (with `:param`
 *      placeholders) + a description + an optional `inputSchema` for lint.
 *   2. `RestConnectorConfig` — base URL, auth header name, token source.
 *   3. Register it (see README): programmatic `registerMcpConnector`, or the
 *      declarative `connectors.json` path via the `fromConfig` factory below.
 *
 * Everything else — path templating, query vs. body routing, auth headers,
 * timeout, error surfacing, `staticTools()` lint, `describeTools()` discovery —
 * works as written.
 */

import type {
  McpConnector,
  McpDispatchCtx,
  McpToolDescriptor,
  McpConnectorCapabilities,
  ManifestInfo,
} from "skillscript-runtime/connectors";

/** One REST endpoint, addressed by its skill-facing tool name (the `ENDPOINTS` key). */
interface RestEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * Path relative to `baseUrl`. `:name` segments are filled from `args` and
   * consumed (so they don't also land in the query string / body).
   * e.g. `/tickets/:id` + `{ id: 42 }` → `/tickets/42`.
   */
  path: string;
  /** Human-readable; surfaced through `describeTools()` for author-time discovery. */
  description?: string;
  /** JSON-Schema for the args. Feeds connector-aware input lint. Optional. */
  inputSchema?: Record<string, unknown>;
}

/**
 * The tool surface. **This is the one table you edit.** Each key is a tool name
 * a skill dispatches as `$ <connector>.<key>`. Non-GET/DELETE methods send the
 * (non-path) args as a JSON body; GET/DELETE send them as a query string.
 *
 * The example fronts a generic "tickets" service — replace wholesale.
 */
const ENDPOINTS: Record<string, RestEndpoint> = {
  list_tickets: {
    method: "GET",
    path: "/tickets",
    description: "List tickets. Optional args: status, assignee, limit → query string.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "closed", "all"] },
        assignee: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
  },
  get_ticket: {
    method: "GET",
    path: "/tickets/:id",
    description: "Fetch one ticket by id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: ["string", "integer"] } },
    },
  },
  create_ticket: {
    method: "POST",
    path: "/tickets",
    // Mutating. The contract has no `mutating` flag on the tool descriptor, so
    // convey it in the description — the HTTP method already tells the story.
    description: "Create a ticket (POST /tickets). Args become the JSON body.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        severity: { type: "string", enum: ["info", "warn", "crit"] },
        assignee: { type: "string" },
      },
    },
  },
  update_ticket: {
    method: "PATCH",
    path: "/tickets/:id",
    description: "Patch a ticket (PATCH /tickets/:id). `id` → path; rest → JSON body.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: ["string", "integer"] },
        status: { type: "string", enum: ["open", "closed"] },
        assignee: { type: "string" },
      },
    },
  },
};

/** Connection + auth config. Passed to the constructor, or built by `fromConfig`. */
export interface RestConnectorConfig {
  /** Base URL, e.g. `https://api.internal.acme.io/v1`. Trailing slash optional. */
  baseUrl: string;
  /**
   * Bearer/API token. Prefer `authTokenEnvVar` over hardcoding — never commit a
   * literal token. If both are set, `authToken` wins.
   */
  authToken?: string;
  /** Read the token from this env var at call time (e.g. `TICKETS_API_TOKEN`). */
  authTokenEnvVar?: string;
  /** Header carrying the token. Default `Authorization`. */
  authHeader?: string;
  /**
   * Formats the header value from the token. Default `Bearer <token>`.
   * For an `X-API-Key` style header, set `authHeader: "X-API-Key"` and
   * `authScheme: "raw"`.
   */
  authScheme?: "bearer" | "raw";
  /** Extra headers sent on every request (Accept, tenant id, etc.). */
  defaultHeaders?: Record<string, string>;
  /** Per-request timeout. Default 30_000 ms. */
  timeoutMs?: number;
}

export class RestConnector implements McpConnector {
  private readonly baseUrl: string;
  private readonly cfg: RestConnectorConfig;

  constructor(config: RestConnectorConfig) {
    if (!config?.baseUrl || typeof config.baseUrl !== "string") {
      throw new Error("RestConnector: `baseUrl` is required.");
    }
    // Normalize: drop a trailing slash so `baseUrl + path` never doubles up.
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.cfg = config;
  }

  /**
   * Declare what this impl supports. A plain REST wrapper does none of the
   * advanced dispatch features by default — flip a flag only once you actually
   * implement it (see the `ctxOverrides` note in `call()` for identity).
   */
  static staticCapabilities(): McpConnectorCapabilities {
    return {
      connector_type: "mcp_connector",
      implementation: "RestConnector",
      contract_version: "1.0.0",
      features: {
        supports_identity_propagation: false,
        supports_streaming_responses: false,
        supports_batch: false,
      },
    };
  }

  /**
   * Closed-set tool surface → lint validates `$ name.tool` at authoring time.
   * Because our tools are a fixed table, we can return it: a skill that writes
   * `$ tickets.delete_everything` fails lint with `unknown-tool-on-connector`
   * instead of failing at runtime. (Connectors whose surface is discovered at
   * runtime return `null` / omit this — see `McpConnectorTemplate`.)
   */
  static staticTools(): string[] {
    return Object.keys(ENDPOINTS);
  }

  /**
   * Declarative-wiring factory for `connectors.json`. Register the class once in
   * your bootstrap (see README), then adopters declare instances in JSON:
   *
   *   { "tickets": { "class": "RestConnector",
   *       "config": { "baseUrl": "https://...", "authTokenEnvVar": "TICKETS_API_TOKEN" } } }
   *
   * Note this makes the *instance* JSON-configurable; the `ENDPOINTS` table is
   * still code. A fully config-only REST connector (endpoints in JSON too) is a
   * natural next fork — the mechanics here are the same.
   */
  static fromConfig(config: Record<string, unknown>): RestConnector {
    if (typeof config.baseUrl !== "string") {
      throw new Error("RestConnector.fromConfig: `config.baseUrl` (string) is required.");
    }
    return new RestConnector(config as unknown as RestConnectorConfig);
  }

  /**
   * Dispatch `$ <connector>.<toolName>` → an HTTPS request.
   *
   * `ctxOverrides` carries the caller identity (`agentId`, `isAdmin`). This
   * example ignores it (`supports_identity_propagation: false`). To honor it,
   * forward it as a header here — e.g. `headers["X-On-Behalf-Of"] = ctx.agentId`
   * — and flip the capability flag (which then obligates the Level 1/Level 2
   * conformance probes; see `McpConnectorTemplate` for that contract).
   */
  async call(
    toolName: string,
    args: Record<string, unknown>,
    _ctxOverrides?: McpDispatchCtx,
  ): Promise<unknown> {
    const ep = ENDPOINTS[toolName];
    if (!ep) {
      const known = Object.keys(ENDPOINTS).join(", ");
      throw new Error(`RestConnector: unknown tool "${toolName}". Known tools: ${known}.`);
    }

    const supplied = { ...(args ?? {}) };

    // Fill `:param` path segments from args; consume them so they don't also
    // appear in the query string / body.
    const path = ep.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
      if (supplied[name] === undefined) {
        throw new Error(`RestConnector: "${toolName}" needs path param "${name}".`);
      }
      const val = String(supplied[name]);
      delete supplied[name];
      return encodeURIComponent(val);
    });

    const url = new URL(this.baseUrl + path);
    const hasBody = ep.method !== "GET" && ep.method !== "DELETE";

    if (!hasBody) {
      for (const [k, v] of Object.entries(supplied)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(this.cfg.defaultHeaders ?? {}),
    };
    if (hasBody) headers["Content-Type"] = "application/json";

    const token = this.cfg.authToken ??
      (this.cfg.authTokenEnvVar ? process.env[this.cfg.authTokenEnvVar] : undefined);
    if (token) {
      const headerName = this.cfg.authHeader ?? "Authorization";
      headers[headerName] = this.cfg.authScheme === "raw" ? token : `Bearer ${token}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: ep.method,
        headers,
        body: hasBody ? JSON.stringify(supplied) : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
      });
    } catch (err) {
      // Network / timeout — throw so the skill's op-level `(fallback: ...)`
      // can catch it. Never return an error envelope silently.
      throw new Error(
        `RestConnector: ${ep.method} ${url.pathname} failed: ${(err as Error).message}`,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `RestConnector: ${ep.method} ${url.pathname} → HTTP ${res.status}. ${text.slice(0, 500)}`,
      );
    }

    // Return parsed JSON when the server sends it; fall back to raw text.
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /**
   * Author-time tool discovery. The contract descriptor is
   * `{ name, description?, inputSchema? }` — there is no `mutating` field, so
   * the mutating/read distinction rides in the description + the method prefix.
   */
  async describeTools(): Promise<McpToolDescriptor[]> {
    return Object.entries(ENDPOINTS).map(([name, ep]) => ({
      name,
      description: `[${ep.method}] ${ep.description ?? ""}`.trim(),
      inputSchema: ep.inputSchema,
    }));
  }

  /** Capability snapshot for `runtime_capabilities` discovery. */
  async manifest(): Promise<ManifestInfo<"mcp_connector">> {
    return {
      capabilities_version: "1",
      manifest: {
        kind: "rest",
        base_url: this.baseUrl,
        tools_available: Object.keys(ENDPOINTS),
      },
    };
  }
}
