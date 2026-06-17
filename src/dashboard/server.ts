import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer, JsonRpcRequest } from "../mcp-server.js";
import type { Scheduler } from "../scheduler.js";
import { EventNotFoundError, EventParamMismatchError } from "../errors.js";
import { resolveRuntimeConfigFromEnv, pickEnvOptionalOption } from "../runtime-env-resolver.js";

/**
 * Dashboard HTTP server (T6b Phase 2). Bundles the SPA assets + a
 * /rpc endpoint that forwards JSON-RPC requests to the runtime's
 * McpServer. Single-process colocation with the runtime — no stdio
 * child process needed.
 *
 * SPA: GET / and GET /index.html serve index.html; GET /app.js and
 * /styles.css serve the assets. Anything else 404s.
 *
 * RPC: POST /rpc with JSON-RPC 2.0 body; routes to McpServer.handle();
 * responds with JSON-RPC 2.0 result/error.
 *
 * Binds to 127.0.0.1 by default (per kickoff criterion #12 — localhost-
 * only, no multi-user auth in v1). Operators in shared environments
 * configure a reverse proxy with auth.
 */

export interface DashboardServerConfig {
  mcpServer: McpServer;
  port?: number;
  bindAddress?: string;
  /** Absolute path to the directory containing index.html + app.js + styles.css. Auto-detected when omitted. */
  assetsDir?: string;
  /**
   * When false, GET routes for the browser SPA (`/`, `/index.html`,
   * `/app.js`, `/styles.css`) return 404 — only `POST /rpc` is served.
   * v0.2.7 addition supporting `skillfile serve` (headless deployments).
   * Default true preserves existing `skillfile dashboard` behavior.
   */
  mountSpa?: boolean;
  /**
   * v0.17.0 — name of the inbound HTTP header carrying host-attested caller
   * identity (e.g., `"X-Agent-Id"`). When set, `handleRpc` reads the header
   * from each `/rpc` request and threads the value as
   * `McpRequestCtx.callerIdentity` into `McpServer.handle()`. The
   * `skill_write` handler captures it as `SkillMeta.author`.
   *
   * Lookup is case-insensitive — Node lowercases inbound header names.
   * Absent header on a configured runtime → `callerIdentity` is undefined
   * for that request → SkillStore.store() falls back to its default author
   * capture (existing v0.16.8 behavior). Multi-agent hosts (NanoClaw-style)
   * inject this header; simple-substrate adopters don't configure it.
   *
   * Same header name as v0.16.9's outbound `HttpMcpConnector.identityHeader`
   * by convention. Two layers, two semantics — inbound = request-scoped
   * caller; outbound = dispatch-scoped owner derived from `SkillMeta.author`.
   * Don't forward inbound → outbound (setuid hazard); they meet at the
   * stored author. Per warm-adopter `6ce97894` prototype + Perry `2a9c234a`.
   */
  mcpCallerIdentityHeader?: string;
  /**
   * v0.19.0 — when set, the server mounts the `POST /event` route per
   * Perry's spec (memory `ceaf4579`). Default false: route returns 404.
   * Off-by-default + localhost-bind enforce the DMZ assumption by the
   * bind, not by hope. Adopters wanting external HTTP-triggered skills
   * opt in.
   *
   * Required when set: `scheduler` reference (so the route can call
   * `Scheduler.fireEvent()`).
   */
  eventIngressEnabled?: boolean;
  /**
   * v0.19.0 — optional bearer-token auth for `POST /event`. When set,
   * every event POST must carry `Authorization: Bearer <token>` matching
   * this value; 401 otherwise. When unset, the route is open-internally
   * (still gated by the bind address). Per Perry's "cheap to wire early"
   * rule: plumbed now even if default-unset, so adding auth later isn't
   * a refactor.
   */
  eventIngressAuthToken?: string;
  /**
   * v0.19.0 — Scheduler reference required when `eventIngressEnabled`.
   * The /event route calls `scheduler.fireEvent(event_name, params)` to
   * dispatch async. Independent from `mcpServer` so a headless serve
   * mode can mount event ingress without the full MCP surface (though
   * the typical adopter wires both).
   */
  scheduler?: Scheduler;
  /**
   * v0.20.1 — optional shared-secret gate for the dashboard surface (SPA + the
   * `/rpc` it uses). When set, every request must present the token via
   * `?token=<x>` (browser entry — a cookie is then set so follow-up requests
   * pass), a `skillscript_dash` cookie, or `Authorization: Bearer <x>` (for
   * programmatic `/rpc` callers); 401 otherwise. Default unset → open (localhost
   * bind is the only gate, as before). `/event` keeps its own bearer token.
   *
   * This is NETWORK/CASUAL hygiene (keep network parties out when binding beyond
   * localhost), NOT an agent-forgery boundary — the dashboard holds no signing
   * key. Falls back to `SKILLSCRIPT_DASHBOARD_AUTH_TOKEN`.
   */
  authToken?: string;
}

/** Constant-time token comparison (length-guarded so timingSafeEqual won't throw). */
function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export class DashboardServer {
  private readonly mcpServer: McpServer;
  private readonly port: number;
  private readonly bindAddress: string;
  private readonly assetsDir: string;
  private readonly mountSpa: boolean;
  private readonly callerIdentityHeader: string | undefined;
  private readonly eventIngressEnabled: boolean;
  private readonly eventIngressAuthToken: string | undefined;
  private readonly scheduler: Scheduler | undefined;
  private readonly authToken: string | undefined;
  private httpServer: Server | null = null;

  constructor(config: DashboardServerConfig) {
    this.mcpServer = config.mcpServer;
    // v0.19.1 — env-fallback per adopter CR `aeccddac`. Pre-v0.19.1
    // each env→option lived only in the CLI cascade, so programmatic
    // adopters constructing DashboardServer directly hit silent
    // default-off on event ingress (and silent defaults on other
    // server-level knobs). The shared resolver covers ALL
    // SKILLSCRIPT_* knobs in one place; new knobs added in future
    // versions inherit env support automatically.
    //
    // Per Perry's explicit-wins guard: any defined config field —
    // including `false`, `""`, `0` — is authoritative; only
    // `undefined` falls back to env.
    const envCfg = resolveRuntimeConfigFromEnv();
    this.port = pickEnvOptionalOption(config.port, envCfg.port) ?? 7878;
    this.bindAddress = pickEnvOptionalOption(config.bindAddress, envCfg.host) ?? "127.0.0.1";
    this.assetsDir = config.assetsDir ?? locateAssetsDir();
    this.mountSpa = config.mountSpa ?? true;
    // v0.17.0 — Node lowercases inbound header names; normalize the
    // configured name once at constructor time so per-request lookup is
    // a single Map access (req.headers[<lowercased-name>]).
    const headerRaw = pickEnvOptionalOption(config.mcpCallerIdentityHeader, envCfg.mcpCallerIdentityHeader);
    this.callerIdentityHeader = headerRaw?.toLowerCase();
    // v0.19.0/v0.19.1 — event ingress config now env-aware via shared
    // resolver. Memory `ceaf4579` (event ingress) + `aeccddac`
    // (env-resolver generalization).
    this.eventIngressEnabled = config.eventIngressEnabled !== undefined
      ? config.eventIngressEnabled
      : envCfg.eventIngressEnabled ?? false;
    this.eventIngressAuthToken = pickEnvOptionalOption(config.eventIngressAuthToken, envCfg.eventIngressAuthToken);
    this.scheduler = config.scheduler;
    if (this.eventIngressEnabled && this.scheduler === undefined) {
      throw new Error("DashboardServer: eventIngressEnabled requires a scheduler reference");
    }
    // v0.20.1 — dashboard auth gate. Empty string treated as unset.
    this.authToken = config.authToken ?? (process.env["SKILLSCRIPT_DASHBOARD_AUTH_TOKEN"] || undefined);
  }

  async start(): Promise<void> {
    this.httpServer = createServer((req, res) => {
      void this.handle(req, res);
    });
    return new Promise<void>((resolve) => {
      this.httpServer!.listen(this.port, this.bindAddress, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.httpServer === null) return;
    return new Promise<void>((resolve, reject) => {
      this.httpServer!.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** Exposed for direct testing — doesn't go through the network stack. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${this.bindAddress}:${this.port}`);
      // v0.20.1 — dashboard auth gate (SPA + /rpc). `/event` self-authenticates
      // with its own bearer token, so it's exempt here.
      if (url.pathname !== "/event" && !this.checkDashboardAuth(req, url, res)) {
        return;
      }
      // /rpc is POST-only — any other method on /rpc is 405 (not falling
      // through to the static handler, which would 404 with misleading
      // semantics).
      if (url.pathname === "/rpc") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        await this.handleRpc(req, res);
        return;
      }
      // v0.19.0 — POST /event for external HTTP-triggered skills.
      // Off-by-default per memory `ceaf4579`; returns 404 when not
      // enabled (operator hasn't opted in).
      if (url.pathname === "/event") {
        if (!this.eventIngressEnabled) {
          res.statusCode = 404;
          res.end("Not Found (event ingress disabled)");
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        await this.handleEvent(req, res);
        return;
      }
      if (req.method === "GET") {
        if (!this.mountSpa) {
          res.statusCode = 404;
          res.end("Not Found (SPA disabled — running in `serve` mode)");
          return;
        }
        await this.handleStatic(url.pathname, res);
        return;
      }
      res.statusCode = 405;
      res.end("Method Not Allowed");
    } catch (err) {
      res.statusCode = 500;
      res.end(`Internal server error: ${(err as Error).message}`);
    }
  }

  /**
   * v0.20.1 — dashboard auth gate. Returns true when the request may proceed
   * (no token configured, or a valid token presented); false when it already
   * sent a 401. On a browser `?token=` entry it sets a cookie so the SPA's
   * follow-up asset + `/rpc` requests carry the token without re-tokening.
   */
  private checkDashboardAuth(req: IncomingMessage, url: URL, res: ServerResponse): boolean {
    if (this.authToken === undefined) return true; // gate disabled (default)
    const presented = this.extractDashboardToken(req, url);
    if (presented !== undefined && tokensEqual(presented, this.authToken)) {
      if (url.searchParams.has("token")) {
        // Persist for the browser session so assets + /rpc don't need ?token=.
        res.setHeader("Set-Cookie", `skillscript_dash=${encodeURIComponent(this.authToken)}; HttpOnly; SameSite=Strict; Path=/`);
      }
      return true;
    }
    res.statusCode = 401;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("401 Unauthorized — append ?token=<SKILLSCRIPT_DASHBOARD_AUTH_TOKEN> to the URL (or send it as a Bearer token).");
    return false;
  }

  /** Token from `?token=` query, the `skillscript_dash` cookie, or a Bearer header. */
  private extractDashboardToken(req: IncomingMessage, url: URL): string | undefined {
    const q = url.searchParams.get("token");
    if (q) return q;
    const cookie = req.headers["cookie"];
    if (typeof cookie === "string") {
      const m = /(?:^|;\s*)skillscript_dash=([^;]+)/.exec(cookie);
      if (m && m[1] !== undefined) return decodeURIComponent(m[1]);
    }
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
    return undefined;
  }

  /**
   * v0.19.0 — POST /event handler (memory `ceaf4579`).
   *
   * Wire contract:
   *   - Request body: `{ event_name: string, params: Record<string, unknown> }`
   *   - Optional bearer-token auth via `Authorization: Bearer <token>` when
   *     `eventIngressAuthToken` configured (401 if missing/wrong)
   *   - 200 + `{run_id, durability: "in-process"}` on accept (NOT skill-completed)
   *   - 404 if event_name not registered
   *   - 400 if params don't match declared (missing or extra)
   *
   * Async semantics: 200 = ACCEPTED into THIS process's in-memory queue.
   * Best-effort / at-most-once / NOT durable across restart. The
   * `durability` field on the response self-describes this — adopters
   * needing at-least-once delivery wrap with their own queue.
   */
  private async handleEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Auth check first — short-circuit BEFORE body parsing so unauthorized
    // callers don't get to chew through arbitrary bodies.
    if (this.eventIngressAuthToken !== undefined) {
      const auth = req.headers["authorization"];
      const expected = `Bearer ${this.eventIngressAuthToken}`;
      if (typeof auth !== "string" || auth !== expected) {
        res.statusCode = 401;
        res.setHeader("content-type", MIME[".json"]!);
        res.end(JSON.stringify({ error: "Unauthorized", reason: "missing or invalid bearer token" }));
        return;
      }
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    let parsed: { event_name?: unknown; params?: unknown };
    try {
      parsed = JSON.parse(body) as { event_name?: unknown; params?: unknown };
    } catch {
      res.statusCode = 400;
      res.setHeader("content-type", MIME[".json"]!);
      res.end(JSON.stringify({ error: "Bad Request", reason: "body is not valid JSON" }));
      return;
    }
    if (typeof parsed.event_name !== "string" || parsed.event_name === "") {
      res.statusCode = 400;
      res.setHeader("content-type", MIME[".json"]!);
      res.end(JSON.stringify({ error: "Bad Request", reason: "body must include non-empty 'event_name' string" }));
      return;
    }
    const params = (typeof parsed.params === "object" && parsed.params !== null && !Array.isArray(parsed.params))
      ? parsed.params as Record<string, unknown>
      : {};
    try {
      const result = this.scheduler!.fireEvent(parsed.event_name, params);
      res.statusCode = 200;
      res.setHeader("content-type", MIME[".json"]!);
      res.end(JSON.stringify({ ...result, durability: "in-process" }));
    } catch (err) {
      if (err instanceof EventNotFoundError) {
        res.statusCode = 404;
        res.setHeader("content-type", MIME[".json"]!);
        res.end(JSON.stringify({ error: "Not Found", reason: err.message }));
        return;
      }
      if (err instanceof EventParamMismatchError) {
        res.statusCode = 400;
        res.setHeader("content-type", MIME[".json"]!);
        res.end(JSON.stringify({
          error: "Bad Request",
          reason: err.message,
          declared: err.declared,
          missing: err.missing,
          extra: err.extra,
        }));
        return;
      }
      throw err;
    }
  }

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    let rpcReq: JsonRpcRequest;
    try {
      rpcReq = JSON.parse(body) as JsonRpcRequest;
    } catch {
      res.statusCode = 400;
      res.setHeader("content-type", MIME[".json"]!);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }
    // v0.17.0 — when an identity header is configured, read it from the
    // inbound request and thread as the per-call McpRequestCtx so
    // `skill_write` can stamp SkillMeta.author from the calling agent.
    // Absent header → callerIdentity stays undefined → SkillStore.store()
    // falls back to its default author capture (existing v0.16.8 behavior
    // — backwards compatible).
    let callerIdentity: string | undefined;
    if (this.callerIdentityHeader !== undefined) {
      const raw = req.headers[this.callerIdentityHeader];
      if (typeof raw === "string" && raw !== "") {
        callerIdentity = raw;
      } else if (Array.isArray(raw) && raw.length > 0 && raw[0] !== "") {
        callerIdentity = raw[0];
      }
    }
    const response = await this.mcpServer.handle(rpcReq, { callerIdentity });
    res.statusCode = 200;
    res.setHeader("content-type", MIME[".json"]!);
    res.end(JSON.stringify(response));
  }

  private async handleStatic(pathname: string, res: ServerResponse): Promise<void> {
    const requested = pathname === "/" ? "/index.html" : pathname;
    const file = join(this.assetsDir, requested);
    if (!file.startsWith(this.assetsDir)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    if (!existsSync(file)) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const body = await readFile(file);
    res.statusCode = 200;
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.end(body);
  }
}

/** Locate the dashboard SPA assets directory (compiled output, runs from dist/). */
function locateAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Built dist runs from dist/dashboard/server.js; spa/ is sibling.
  // Source dev (vitest) runs from src/dashboard/server.ts; spa/ is sibling.
  const candidates = [
    resolve(here, "spa"),
    resolve(here, "..", "..", "src", "dashboard", "spa"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to src/ even if missing — error surfaces at request time.
  return candidates[0]!;
}
