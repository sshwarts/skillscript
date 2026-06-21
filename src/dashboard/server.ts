import { createServer } from "node:http";
import { timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer, JsonRpcRequest } from "../mcp-server.js";
import type { Scheduler } from "../scheduler.js";
import type { SkillStore } from "../connectors/types.js";
import { EventNotFoundError, EventParamMismatchError } from "../errors.js";
import { resolveRuntimeConfigFromEnv, pickEnvOptionalOption } from "../runtime-env-resolver.js";
import { stampApprovalEd25519, isSecuredMode } from "../approval.js";
import { parse } from "../parser.js";
import { findStaticDependents } from "../skill-dependents.js";
import { defaultApprovalKeyFile } from "../bootstrap.js";

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
  /**
   * v0.20.2 — in-browser approval (passcode session-unlock). When BOTH a
   * `skillStore` and `approvalPasscode` are wired (and secured mode is on), the
   * dashboard mounts `POST /unlock` + `POST /approve`. The approver enters the
   * passcode once per browser session (`/unlock`) to unlock signing; `/approve`
   * then signs the named skill with the operator's private key and stores it
   * Approved. The unlock is in-memory, session-cookie-bound, and expires
   * (default 15 min idle) — the dashboard holds no STANDING signing power, only
   * a live human-entered passcode unlocks it.
   *
   * SECURITY: enabling this gives the dashboard process read access to the
   * private key. Run it only where the agent can't reach it (operator-side /
   * isolated uid). Default unset → no `/approve`, dashboard stays review-only.
   */
  skillStore?: SkillStore;
  /** Path to the operator's Ed25519 private key (signing). Defaults via env. */
  approvalKeyFile?: string;
  /** Passcode gating in-browser signing. Falls back to `SKILLSCRIPT_APPROVAL_PASSCODE`. */
  approvalPasscode?: string;
}

/** v0.20.2 — idle lifetime of an in-browser approval unlock session. */
const UNLOCK_TTL_MS = 15 * 60 * 1000;

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
  // v0.20.2 — in-browser approval (passcode session-unlock).
  private readonly skillStore: SkillStore | undefined;
  private readonly approvalKeyFile: string | undefined;
  private readonly approvalPasscode: string | undefined;
  /** sessionId → expiry epoch-ms. An entry means "this session unlocked signing". */
  private readonly unlockSessions = new Map<string, number>();
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
    // v0.20.2 — in-browser approval wiring.
    this.skillStore = config.skillStore;
    // v0.21.0 — ONE shared resolver for the key path (adopter finding 46e9b6f7):
    // bootstrap() provisions the keypair at defaultApprovalKeyFile(); the dashboard
    // MUST resolve the same path, or a programmatic adopter who sets only
    // SECURED_MODE+passcode gets a silent lockout (key provisioned at the default
    // path, dashboard looking at `undefined`). Fall back to the same default.
    this.approvalKeyFile = config.approvalKeyFile ?? process.env["SKILLSCRIPT_APPROVAL_KEY_FILE"] ?? defaultApprovalKeyFile();
    this.approvalPasscode = config.approvalPasscode ?? (process.env["SKILLSCRIPT_APPROVAL_PASSCODE"] || undefined);
  }

  /** In-browser signing is available only when fully wired + secured. */
  private signingEnabled(): boolean {
    return (
      isSecuredMode() &&
      this.skillStore !== undefined &&
      this.approvalPasscode !== undefined &&
      this.approvalKeyFile !== undefined &&
      existsSync(this.approvalKeyFile)
    );
  }

  /**
   * v0.21.0 — fail LOUD, not silent (adopter finding 46e9b6f7 + Perry's security
   * lens). When the operator EXPLICITLY asked for in-browser approval (secured
   * mode + a passcode) but signing can't wire, a silent no-op leaves the system
   * locked (secured) AND unapprovable-from-the-web with no signal — undiagnosable,
   * and it drives operators to just turn secured mode off. Announce the exact gap
   * + the fix at boot. A security control that can't do its job must say so.
   */
  private warnIfSigningMisconfigured(): void {
    if (!isSecuredMode() || this.approvalPasscode === undefined || this.signingEnabled()) return;
    const reasons: string[] = [];
    if (this.skillStore === undefined) reasons.push("no skillStore wired into DashboardServer (pass `skillStore` in its config)");
    if (this.approvalKeyFile === undefined || !existsSync(this.approvalKeyFile)) {
      reasons.push(`no approval private key at ${this.approvalKeyFile ?? "(unresolved path)"} — start once in secured mode to auto-provision, or set SKILLSCRIPT_APPROVAL_KEY_FILE`);
    }
    const bar = "!".repeat(72);
    process.stderr.write(
      `\n${bar}\n` +
      `⚠  SECURED MODE + approval passcode are set, but IN-BROWSER APPROVE IS NOT WIRED.\n` +
      `   Skills are locked (secured) AND cannot be approved from the dashboard:\n` +
      reasons.map((r) => `     • ${r}\n`).join("") +
      `   Until fixed, approve at a terminal: \`skillfile approve <name>\` / \`reapprove --apply\`\n` +
      `   (filesystem SkillStore only — for a non-FS store the browser path is the only one).\n` +
      `${bar}\n\n`,
    );
  }

  async start(): Promise<void> {
    this.httpServer = createServer((req, res) => {
      void this.handle(req, res);
    });
    return new Promise<void>((resolve, reject) => {
      const server = this.httpServer!;
      // Reject (don't hang) on bind errors — e.g. EADDRINUSE — so callers fail
      // fast instead of waiting on a promise that never resolves.
      const onError = (err: Error): void => { server.off("listening", onListening); reject(err); };
      const onListening = (): void => { server.off("error", onError); this.warnIfSigningMisconfigured(); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, this.bindAddress);
    });
  }

  /** The actual bound port after `start()` — read this when constructed with
   *  port 0 (OS-assigned ephemeral port). Falls back to the configured port. */
  boundPort(): number {
    const addr = this.httpServer?.address();
    return typeof addr === "object" && addr !== null ? addr.port : this.port;
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
      // v0.20.2 — in-browser approval (passcode session-unlock). Both routes
      // 404 when signing isn't wired (dashboard stays review-only by default).
      if (url.pathname === "/unlock" || url.pathname === "/approve") {
        if (!this.signingEnabled()) {
          res.statusCode = 404;
          res.end("Not Found (in-browser approval not enabled)");
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        await (url.pathname === "/unlock" ? this.handleUnlock(req, res) : this.handleApprove(req, res));
        return;
      }
      // Operator-only destructive delete. Behind the dashboard auth gate (token,
      // top of handler); the SPA confirm + reverse-dependency check are the
      // safety, so no signing passcode (unlike /approve, which mints a
      // signature). 404 when no skill store is wired.
      if (url.pathname === "/delete") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        if (this.skillStore === undefined) {
          res.statusCode = 404;
          res.end("Not Found (no skill store wired)");
          return;
        }
        await this.handleDelete(req, res);
        return;
      }
      // v0.20.2 — lets the SPA decide whether to render in-browser approve UI.
      if (url.pathname === "/signing-status") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ enabled: this.signingEnabled() }));
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

  // ─── v0.20.2 — in-browser approval (passcode session-unlock) ─────────────────

  /** Is this request's `skillscript_unlock` cookie a live (unexpired) session? */
  private hasLiveUnlock(req: IncomingMessage): boolean {
    const cookie = req.headers["cookie"];
    if (typeof cookie !== "string") return false;
    const m = /(?:^|;\s*)skillscript_unlock=([^;]+)/.exec(cookie);
    if (!m || m[1] === undefined) return false;
    const expiry = this.unlockSessions.get(m[1]);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) { this.unlockSessions.delete(m[1]); return false; }
    return true;
  }

  /** POST /unlock — verify the passcode, mint an in-memory unlock session. */
  private async handleUnlock(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let passcode: unknown;
    try { passcode = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { passcode?: unknown }).passcode; }
    catch { passcode = undefined; }
    if (typeof passcode !== "string" || !tokensEqual(passcode, this.approvalPasscode!)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ unlocked: false, error: "incorrect passcode" }));
      return;
    }
    // Mint a session (random id, in-memory, idle-TTL). The decrypted/plaintext
    // key is NOT cached — signing reads it per-approve while the session lives.
    const sessionId = randomBytes(18).toString("base64url");
    this.unlockSessions.set(sessionId, Date.now() + UNLOCK_TTL_MS);
    res.statusCode = 200;
    res.setHeader("Set-Cookie", `skillscript_unlock=${sessionId}; HttpOnly; SameSite=Strict; Path=/`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ unlocked: true, ttl_seconds: UNLOCK_TTL_MS / 1000 }));
  }

  /** POST /approve {name} — sign the named skill with the operator's key + store
   *  it Approved. Requires a live unlock session (passcode entered this session). */
  private async handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (!this.hasLiveUnlock(req)) {
      json(401, { approved: false, needs_passcode: true });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let name: unknown;
    try { name = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name?: unknown }).name; }
    catch { name = undefined; }
    if (typeof name !== "string" || name.length === 0) {
      json(400, { approved: false, error: "missing skill name" });
      return;
    }
    try {
      const loaded = await this.skillStore!.load(name);
      const priv = await readFile(this.approvalKeyFile!, "utf8");
      const signed = stampApprovalEd25519(loaded.source, priv);
      const info = await this.skillStore!.store(name, signed, { status: "Approved" });
      if (info.status === "Approved") {
        // Re-register the skill's declarative triggers in the live scheduler —
        // approval just activated them. An edit→Draft (forced in secured mode)
        // drops them; without this re-sync they stay dropped, so the now-Approved
        // skill won't fire on cron/event and won't appear in the Triggers view.
        // Mirrors the MCP skill_status path (McpServer.syncTriggersForSkill).
        if (this.scheduler !== undefined) {
          try {
            const parsed = parse(signed);
            this.scheduler.syncDeclarativeTriggersForSkill(
              name, parsed.triggers, parsed.vars.map((v) => v.name), "Approved",
            );
          } catch { /* parse failure → leave triggers as-is; an unparseable body isn't dispatchable anyway */ }
        }
        json(200, { approved: true, name, version: info.version });
      } else {
        // Public key didn't verify the signature → store forced Draft.
        json(500, { approved: false, error: "signature did not verify against the configured public key" });
      }
    } catch (err) {
      json(404, { approved: false, error: (err as Error).message });
    }
  }

  /**
   * Operator-only destructive delete (POST /delete). Preflight-then-commit: a
   * first POST without `force` is a pure scan — it runs the reverse-dependency
   * check and returns `{ deleted: false, preflight: true, dependents }` WITHOUT
   * touching anything, so the SPA can fold any dependents into a single confirm
   * ("X references this — permanently delete anyway?"). A POST with `force: true`
   * commits the delete. The delete is permanent (no trash, no restore) and drops
   * all the skill's triggers from the live scheduler.
   */
  private async handleDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let name: unknown;
    let force = false;
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name?: unknown; force?: unknown };
      name = parsed.name;
      force = parsed.force === true;
    } catch { name = undefined; }
    if (typeof name !== "string" || name.length === 0) {
      json(400, { deleted: false, error: "missing skill name" });
      return;
    }
    try {
      await this.skillStore!.load(name);
    } catch {
      json(404, { deleted: false, error: `skill '${name}' not found` });
      return;
    }
    const dependents = await findStaticDependents(this.skillStore!, name);
    if (!force) {
      // Preflight — scan only, never delete. The SPA uses `dependents` to build
      // a single confirm before re-POSTing with force.
      json(200, { deleted: false, preflight: true, dependents });
      return;
    }
    try {
      await this.skillStore!.delete(name);
      this.scheduler?.dropAllTriggersForSkill(name);
      json(200, { deleted: true, name, dependents });
    } catch (err) {
      json(500, { deleted: false, error: (err as Error).message });
    }
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
