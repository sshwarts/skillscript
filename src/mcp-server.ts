import type { SkillStore, SkillStatus, SkillListFilter, StaticCapabilities, ManifestInfo } from "./connectors/types.js";
import { VALID_SKILL_STATUSES, isSkillStatus } from "./connectors/types.js";
import { buildSkillCatalog } from "./skill-catalog.js";
import type { Scheduler, ResolvableTriggerSource, TriggerRegistration } from "./scheduler.js";
import type { TraceStore } from "./trace.js";
import type { Registry } from "./connectors/registry.js";
import { healthMetrics, type HealthMetrics } from "./metrics.js";
import { lint } from "./lint.js";
import { compile } from "./compile.js";
import { parse as parseSkill } from "./parser.js";
import { extractEffectfulFootprint, extractConnectorToolRefs } from "./skill-surface.js";
import { listKnownConnectorClasses } from "./connectors/config.js";
import { LintFailureError, MissingSkillReferenceError, OpError } from "./errors.js";
import {
  executeSkillByName,
  executeSkillFromSource,
  RecursionDepthExceededError,
  SkillNotFoundForCompositionError,
} from "./composition.js";
import { helpResponse, SKILLSCRIPT_USAGE_INSTRUCTIONS } from "./help-content.js";
import { RUNTIME_VERSION } from "./version.js";
import { evaluateApprovalGate, isSecuredMode, hasApprovalPublicKey } from "./approval.js";
import { forceDraftStatus } from "./connectors/skill-store-mcp.js";

/**
 * MCP server contract surface (T6b Phase 1). Exposes the runtime's
 * observability + management primitives as MCP tools over JSON-RPC 2.0
 * stdio per ERD §10.
 *
 * Implementation note: rolled-by-hand JSON-RPC handler rather than the
 * official `@modelcontextprotocol/sdk` to avoid pulling 16 transitive
 * deps (express, hono, jose, pkce-challenge, ajv, etc.) into a runtime
 * that's been built on zero production deps except cron-parser. Wire
 * protocol conforms to MCP — real MCP clients (Claude Desktop, Cursor,
 * future tools) can consume the server unchanged.
 *
 * Surface: tools wrapping existing T6 primitives, ordered by the cold-author
 * workflow loop the descriptions teach (learn → discover → draft → commit →
 * approve → run → automate → observe).
 *
 *   LEARN     help({topic?})                  → language quickstart + deep topics
 *             runtime_capabilities({include?})→ wired connectors + shell-exec mode
 *   DISCOVER  skill_list({filter?})           → SkillCatalog (grouped by audience; entries carry the full contract)
 *             skill_preflight({name})         → one skill's contract: takes/returns/requires/touches + approval + lifecycle
 *             skill_read({name, version?})    → {name, version, status, source} (the body itself)
 *             data_read({id, store?})         → PortableData | null (direct lookup; no data_write MCP by design)
 *   DRAFT     lint_skill({source?|name})      → tiered diagnostics (inner loop)
 *             compile_skill({source?|name, inputs?})→ rendered artifact + errors + exec order (pre-commit)
 *   COMMIT    skill_write({name, source, overwrite?})→ store the body (write; secured mode forces unsigned→Draft)
 *   APPROVE   skill_status({name, new_state}) → Draft/Approved/Disabled (write; secured promote needs a signature)
 *   RUN       execute_skill({name|source, inputs?, mechanical?})→ run + return result (write)
 *   AUTOMATE  register_trigger / list_triggers / set_trigger_enabled / unregister_trigger → autonomous dispatch
 *   OBSERVE   health_metrics({filter?})       → per-skill/connector aggregates
 *             blocked_shell_attempts()        → allowlist-refused shell ops (observe→promote loop)
 */

// ─── JSON-RPC 2.0 ──────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ─── MCP tool definition ───────────────────────────────────────────────────

/**
 * v0.17.0 — request-scoped MCP-side context passed from the HTTP/stdio
 * transport into `McpServer.handle()` and through to tool handlers.
 *
 * Inbound mirror of the outbound `McpDispatchCtx` (v0.16.9), one layer up:
 * outbound = dispatch-scoped owner identity the runtime asserts TO substrates
 * (derived from `SkillMeta.author`); inbound = request-scoped caller identity
 * the runtime receives FROM hosts. They MEET at `SkillMeta.author` — the
 * `skill_write` handler reads `callerIdentity` and threads it as
 * `store({author: callerIdentity})`, then later dispatches derive outbound
 * identity from that stored author. Do NOT forward an inbound caller-identity
 * header straight to an outbound connector — outbound is always derived from
 * the skill's owner at dispatch, not the current caller (setuid hazard).
 */
export interface McpRequestCtx {
  /**
   * Host-attested caller identity (e.g., the agent invoking `skill_write`
   * via an MCP host that bridges agent identity into transport headers).
   * Trust is bilateral: the runtime trusts the host's attestation when the
   * adopter has configured `mcpCallerIdentityHeader`. Hosts that don't
   * inject identity leave this undefined; runtime falls back to its own
   * writer identity (existing v0.16.8 behavior).
   */
  callerIdentity?: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: McpRequestCtx) => Promise<unknown>;
}

export interface McpServerDeps {
  skillStore: SkillStore;
  scheduler: Scheduler;
  traceStore: TraceStore;
  /** Optional — required for `runtime_capabilities`. When omitted the tool returns empty arrays. */
  registry?: Registry;
  /** Surfaced via `runtime_capabilities` so cold agents know whether `@ unsafe` is permitted. */
  enableUnsafeShell?: boolean;
  /**
   * v0.18.8 — operator's shell binary allowlist. Threaded into every
   * `execute_skill` dispatch ctx so the runtime enforces binary-scope.
   * See `ExecuteContext.shellAllowlist` for full semantic.
   */
  shellAllowlist?: string[];
  /** v1.0 Gate #7 — filesystem path allowlist threaded into the execute_skill
   * dispatch ctx so the runtime enforces file_read/file_write path bounds. */
  fsAllowlist?: string[];
  /**
   * v0.16.8 — approval-posture override. When true, the outside-MCP
   * `skill_write` handler forces every write to land in `Draft` status
   * regardless of what the body declares. The body's `# Status: Approved`
   * intent is preserved as a signal (the runtime knows what the author
   * wanted), but the persisted state is `Draft` until a human or
   * adopter-specific approval flow explicitly promotes it.
   *
   * Default `false` — preserves the v0.9.1 auto-stamp behavior (body
   * declares Approved → SkillStore stamps the hash token). Adopters
   * wanting stricter posture (every skill needs explicit promotion
   * regardless of body claim) set this flag at runtime startup. Per
   * Perry's `787b6b95` Option A.
   *
   * The in-skill bridge dispatch (`SkillStoreMcpConnector`) is
   * Draft-by-default regardless — that's a separate v0.15.0 trust
   * boundary, unaffected by this flag.
   */
  forceAlwaysDraft?: boolean;
  /**
   * v0.17.0 — name of the inbound HTTP header carrying host-attested caller
   * identity. When configured, `DashboardServer.handleRpc` reads the header
   * from each `/rpc` request and threads the value as
   * `McpRequestCtx.callerIdentity` into `McpServer.handle(req, ctx)`. The
   * `skill_write` handler then captures `SkillMeta.author` from
   * `ctx.callerIdentity` so MCP-authored skills get the calling agent's
   * identity stamped at write time (not the runtime's wiring identity).
   *
   * Default unset — preserves v0.16.8 behavior (author = runtime's writer
   * identity). Simple-substrate adopters (single-user CLI, single-tenant
   * deployments) never need to configure this surface.
   *
   * Convention: `"X-Agent-Id"` (case-insensitive at lookup; Node lowercases
   * inbound header names). Same header name as v0.16.9's outbound
   * `identityHeader` by convention — two layers, two semantics, meet at
   * `SkillMeta.author`. Per warm-adopter's `6ce97894` prototype + Perry's
   * `2a9c234a` charter ack.
   */
  mcpCallerIdentityHeader?: string;
  /** Runtime mode label — `"serve"` (headless) or `"dashboard"` (SPA mounted). v0.2.7. */
  runtimeMode?: "serve" | "dashboard";
  /** Path to the persistent imperative-trigger registry, when configured. v0.2.7. */
  triggersFilePath?: string;
  serverVersion?: string;
}

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "skillscript-runtime";

export class McpServer {
  private readonly tools: Map<string, McpTool> = new Map();
  private readonly version: string;

  constructor(private readonly deps: McpServerDeps) {
    // v0.2.12 Bug 20. Default to the package.json-derived RUNTIME_VERSION
    // so the version surface stays single-sourced (was hardcoded "0.2.10"
    // pre-v0.2.12 and slipped on the v0.2.11 ship). Caller may still
    // override via deps.serverVersion for custom embedding scenarios.
    this.version = deps.serverVersion ?? RUNTIME_VERSION;
    this.registerBuiltinTools();
  }

  registerTool(tool: McpTool): void {
    this.tools.set(tool.name, tool);
  }

  listTools(): McpTool[] {
    return Array.from(this.tools.values());
  }

  async handle(req: JsonRpcRequest, ctx: McpRequestCtx = {}): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: SERVER_NAME, version: this.version },
              // Canonical agent-usage block — every connecting agent learns the
              // workflow at session start, no CLAUDE.md copy-paste required.
              instructions: SKILLSCRIPT_USAGE_INSTRUCTIONS,
            },
          };
        case "tools/list":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              tools: Array.from(this.tools.values()).map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            },
          };
        case "tools/call": {
          const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
          if (params === undefined || typeof params.name !== "string") {
            return errorResponse(id, -32602, "Invalid params: tools/call requires { name, arguments? }");
          }
          const tool = this.tools.get(params.name);
          if (!tool) {
            return errorResponse(id, -32601, `Tool '${params.name}' not found`);
          }
          const args = params.arguments ?? {};
          const result = await tool.handler(args, ctx);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result) }],
            },
          };
        }
        default:
          return errorResponse(id, -32601, `Method '${req.method}' not found`);
      }
    } catch (err) {
      return errorResponse(id, -32603, (err as Error).message);
    }
  }

  /**
   * Run the server attached to stdin/stdout with newline-delimited
   * JSON-RPC. Each line is one request; responses are written one per
   * line to stdout.
   */
  runStdio(): void {
    process.stdin.setEncoding("utf8");
    let buffer = "";
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        let req: JsonRpcRequest;
        try {
          req = JSON.parse(line) as JsonRpcRequest;
        } catch {
          continue;
        }
        void this.handle(req).then((resp) => {
          process.stdout.write(JSON.stringify(resp) + "\n");
        });
      }
    });
  }

  // ─── Built-in tools ─────────────────────────────────────────────────────

  private registerBuiltinTools(): void {
    this.registerTool({
      name: "skill_list",
      description: "Discover skills in the configured SkillStore. Returns a `SkillCatalog` pre-grouped by audience-derived category: `receives` (skills that push to the calling agent via `# Output: agent:`), `skills` (skills the agent can invoke), `headless` (admin-view only). Category derived from each skill's `# Output:` declarations. Filter by audience / status / trigger_kind / domain_tags / name_prefix / author (AND-composed). Default: audience=\"agent\", status=\"Approved\". Every entry carries the full preflight contract — `vars` (inputs), `returns` (exported vars), `requires` (capability needs), `effectful_footprint` (which connectors / shell binaries / file + notify ops it touches), plus `gate_ok` (cleared-to-run under the current mode) and `author` (when the substrate tracks it). So you can read a skill's whole I/O + effect contract here without a per-skill `skill_preflight` call; reach for `skill_preflight` when you want one skill's contract + version/lifecycle detail, or `skill_read` for the body.",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: {
              audience: { type: "string", enum: ["agent", "all", "headless"] },
              status: { type: "string", enum: ["Draft", "Approved", "Disabled"] },
              trigger_kind: { type: "string", enum: ["cron", "event"] },
              domain_tags: { type: "array", items: { type: "string" } },
              name_prefix: { type: "string" },
              author: { type: "string", description: "Narrow to skills authored by this identity. AND-composes with other filters. Graceful degradation: substrates that don't track authorship return all rows and the runtime filters in-memory (per skill_meta.author)." },
            },
            additionalProperties: false,
          },
          if_none_match: { type: "string", description: "Change-token from a prior response's `catalog_version`. If the store's current token matches, the response is `{ not_modified: true, catalog_version }` and the catalog rebuild is skipped — a cheap unchanged-poll path for remote stores." },
        },
      },
      handler: async (args) => {
        const filter = (args["filter"] as SkillListFilter | undefined) ?? {};
        // v0.23.x — change-token / ETag. If the store can cheaply fingerprint
        // its state (optional version()) and the caller's if_none_match still
        // matches, skip the N+1 catalog rebuild entirely (each entry otherwise
        // costs a load() — a network call against a remote store). Stores
        // without version() always rebuild (today's behavior).
        const store = this.deps.skillStore as SkillStore & { version?: () => Promise<string> };
        const ifNoneMatch = typeof args["if_none_match"] === "string" ? args["if_none_match"] : undefined;
        let catalogVersion: string | undefined;
        if (typeof store.version === "function") {
          try { catalogVersion = await store.version(); } catch { catalogVersion = undefined; }
        }
        if (catalogVersion !== undefined && ifNoneMatch === catalogVersion) {
          return { not_modified: true, catalog_version: catalogVersion };
        }
        const catalog = await buildSkillCatalog(this.deps.skillStore, filter);
        return catalogVersion !== undefined ? { ...catalog, catalog_version: catalogVersion } : catalog;
      },
    });

    this.registerTool({
      name: "blocked_shell_attempts",
      description: "List shell op dispatches refused by the binary allowlist gate. Queries the trace store cross-skill, filtering to op records carrying `blocked_reason: \"binary-not-allowed\"`. Returns a flat list for the dashboard's observe→promote loop: the operator sees what binaries skills tried to invoke, then decides whether to add any to `SKILLSCRIPT_SHELL_ALLOWLIST`. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          since_ms: { type: "number", description: "Earliest unix-ms timestamp to include (default: last 7 days)." },
          limit: { type: "number", description: "Max records to return (default: 100)." },
        },
      },
      handler: async (args) => {
        const sinceMs = typeof args["since_ms"] === "number"
          ? args["since_ms"]
          : Date.now() - 7 * 24 * 60 * 60 * 1000;
        const limit = typeof args["limit"] === "number" ? args["limit"] : 100;
        // Query trace store for the recent window. Filter in-memory:
        // ops carrying blocked_reason: "binary-not-allowed". Substrates
        // that natively index by blocked_reason could optimize this,
        // but the v0.18.9 reference path is in-memory filtering against
        // the standard trace shape.
        const traces = await this.deps.traceStore.query({ since_ms: sinceMs, limit: 500 });
        const attempts: Array<{
          skill_name: string;
          target: string;
          binary: string;
          body: string;
          fired_at_ms: number;
        }> = [];
        for (const trace of traces) {
          for (const op of trace.ops) {
            if (op.blocked_reason !== "binary-not-allowed") continue;
            // Extract first token from the op body — same shape the
            // runtime checks against the allowlist. For unsafe ops the
            // body is the unsafe payload; the actual blocked binary is
            // always `bash` per v0.18.8 reframe. Heuristic: if body
            // contains a pipe or other bash syntax tokens, label `bash`;
            // else use the first whitespace-delimited token.
            const trimmed = op.body.trim();
            const binary = /[|;&$`]/.test(trimmed) || trimmed.startsWith("bash")
              ? "bash"
              : (/^([^\s]+)/.exec(trimmed)?.[1] ?? "(unknown)");
            attempts.push({
              skill_name: trace.skill_name,
              target: op.target,
              binary,
              body: op.body.length > 200 ? `${op.body.slice(0, 200)}...` : op.body,
              fired_at_ms: op.started_at_ms,
            });
            if (attempts.length >= limit) break;
          }
          if (attempts.length >= limit) break;
        }
        // Sort newest first so the dashboard surfaces "what just got blocked."
        attempts.sort((a, b) => b.fired_at_ms - a.fired_at_ms);
        return { attempts, total: attempts.length };
      },
    });

    this.registerTool({
      name: "skill_preflight",
      description: "PRE-EXECUTION CONTRACT CHECK — call this BEFORE executing or composing a skill to see what it takes, returns, requires, and touches: its inputs (vars), exported variables (returns), capability requirements, and effectful footprint (which connectors / shell binaries / write + notify ops it dispatches). Also reports whether it's cleared to run (approval-gate state) + version/lifecycle. The least-privilege checklist for a human approver, and the contract surface for a cold author composing against it. Discover skills with skill_list (its entries already carry this same contract); call skill_preflight for one skill's contract plus version/lifecycle detail, or skill_read for the source body.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          fire_limit: { type: "number", default: 20 },
        },
        required: ["name"],
      },
      handler: async (args) => {
        const name = args["name"] as string;
        const fireLimit = typeof args["fire_limit"] === "number" ? args["fire_limit"] : 20;
        const [metadata, versions, loaded, recent_fires] = await Promise.all([
          this.deps.skillStore.metadata(name),
          this.deps.skillStore.versions(name),
          this.deps.skillStore.load(name).catch(() => null),
          this.deps.traceStore.query({ skill_name: name, limit: fireLimit }),
        ]);
        // v0.9.0 — surface approval-gate state so the dashboard can flag
        // stale-Approved skills (body edited since approval, token no
        // longer verifies). `null` when the source isn't loadable.
        let approval: { gate_ok: boolean; reason?: string } | null = null;
        // v0.21.0 — the contract surface: what the skill TAKES (vars, via the
        // parser's frontmatter), RETURNS (exported vars), REQUIRES (capability
        // clauses), and TOUCHES (effectful footprint). Derived statically from
        // the body. Null when the source isn't loadable.
        let contract: { vars: string[]; returns: string[]; requires: unknown[]; effectful_footprint: ReturnType<typeof extractEffectfulFootprint> } | null = null;
        // v0.23.0 — per-tool input schemas for the connector tools this skill
        // calls (selective). Null when none / no registry / unreachable.
        let connector_tools: Array<Record<string, unknown>> | null = null;
        if (loaded?.source !== undefined) {
          const g = evaluateApprovalGate(loaded.source);
          approval = g.ok ? { gate_ok: true } : { gate_ok: false, reason: g.reason };
          const parsed = parseSkill(loaded.source);
          contract = {
            vars: parsed.vars.map((v) => v.name),
            returns: parsed.returns,
            requires: parsed.requires,
            effectful_footprint: extractEffectfulFootprint(parsed),
          };
          // v0.23.0 — surface the input schema for ONLY the connector tools
          // this skill calls (selective by construction). Warms each connector's
          // tools/list on demand (read-only). Empty when no registry, no
          // qualified `$ conn.tool` ops, or the schemas aren't reachable.
          if (this.deps.registry !== undefined) {
            const refs = extractConnectorToolRefs(parsed);
            const resolved = await Promise.all(
              refs.map((r) => this.fetchToolSchema(`${r.connector}.${r.tool}`, this.deps.registry!)),
            );
            const tools = resolved.filter((t): t is Record<string, unknown> => t !== null);
            if (tools.length > 0) {
              // v0.23.0 — attach each tool's last-observed output shape (if any
              // approved run has recorded it). Only for the tools that passed
              // the allowed_tools filter above, so gated tools stay hidden.
              if (this.deps.traceStore.getObservedShapes !== undefined) {
                const shapes = await this.deps.traceStore.getObservedShapes(
                  tools.map((t) => ({ connector: t["connector"] as string, tool: t["name"] as string })),
                );
                for (const t of tools) {
                  const rec = shapes.get(`${t["connector"] as string}.${t["name"] as string}`);
                  if (rec !== undefined) {
                    t["observed_output_shape"] = rec.shape;
                    t["observed_at_ms"] = rec.observed_at_ms;
                  }
                }
              }
              connector_tools = tools;
            }
          }
        }
        return {
          metadata,
          contract,
          connector_tools,
          approval,
          versions,
          recent_fires,
        };
      },
    });

    this.registerTool({
      name: "skill_read",
      description: "Read a skill's source body. Returns {name, version, status, source}. Symmetric peer to skill_write — when you want the body itself, not the surrounding metadata bag.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          version: { type: "string" },
        },
        required: ["name"],
      },
      handler: async (args) => {
        const name = args["name"] as string;
        const version = typeof args["version"] === "string" ? args["version"] : undefined;
        const loaded = await this.deps.skillStore.load(name, version);
        return {
          name: loaded.name,
          version: loaded.version,
          status: loaded.metadata.status,
          source: loaded.source,
        };
      },
    });

    this.registerTool({
      name: "data_read",
      description: "Read a memory by substrate-assigned id. Returns the PortableData or null if not found. Symmetric peer to skill_read; lets adopters/agents inspect persisted memories outside execute_skill. v0.13.8 — note: there is no `data_write` MCP tool by design; writes are skill-context-only (`$ data_write` op inside a skill body) to preserve intent-tracking.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          store: { type: "string", description: "Named DataStore (default: 'primary')" },
        },
        required: ["id"],
      },
      handler: async (args) => {
        const id = args["id"] as string;
        const storeName = typeof args["store"] === "string" ? args["store"] : "primary";
        if (this.deps.registry === undefined || !this.deps.registry.hasDataStore(storeName)) {
          throw new OpError(
            `\`data_read\` requires a DataStore registered as '${storeName}'; none found in registry.`,
            "data_read",
            `Configure a DataStore in connectors.json substrate.data_store, or register one programmatically via registry.registerDataStore("${storeName}", ...).`,
            id,
          );
        }
        const dataStore = this.deps.registry.getDataStore(storeName);
        return await dataStore.get(id);
      },
    });

    this.registerTool({
      name: "skill_status",
      description: "Transition a skill's lifecycle status: Draft, Approved, Disabled. Approved is the only status that executes and lets triggers fire; Draft is the editing state; Disabled retires a skill without deleting it (re-enable by transitioning back to Approved/Draft). In secured mode you CANNOT promote to Approved here without a valid signature — approve via the dashboard or `skillfile approve` (which signs the body); a bare status flip can't grant approval. Write operation.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          new_state: { type: "string", enum: ["Draft", "Approved", "Disabled"] },
        },
        required: ["name", "new_state"],
      },
      handler: async (args) => {
        const name = args["name"] as string;
        const newState = args["new_state"];
        // v0.13.7 — explicit validation. inputSchema declares the enum but
        // the dispatcher doesn't enforce it, so an undefined/typo'd arg would
        // silently flow to rewriteStatusHeader and corrupt the skill body
        // with literal `# Status: undefined`. Reject at the MCP handler.
        if (!isSkillStatus(newState)) {
          throw new OpError(
            `\`skill_status\` requires \`new_state\` to be one of ${VALID_SKILL_STATUSES.map((s) => `"${s}"`).join(", ")}; got ${JSON.stringify(newState)}.`,
            "skill_status",
            `Pass \`new_state\` as one of: ${VALID_SKILL_STATUSES.join(" | ")}.`,
            name,
          );
        }
        // v0.21.0 — store-agnostic secured-mode closure (red-team 33bf53d3).
        // skill_status cannot GRANT approval in secured mode: promotion to
        // Approved is refused unless the stored body already carries a valid v3
        // signature. The per-store guard (FilesystemSkillStore/SqliteSkillStore)
        // didn't cover custom adopter stores (e.g. AMP-backed), so an agent could
        // flip Draft→Approved with no signature — a forgeable trust-state lie.
        // Enforce HERE, at the ingress, regardless of substrate.
        if (newState === "Approved" && isSecuredMode()) {
          const loaded = await this.deps.skillStore.load(name).catch(() => null);
          if (loaded === null || !evaluateApprovalGate(loaded.source).ok) {
            throw new OpError(
              `cannot promote '${name}' to Approved in secured mode — the skill carries no valid signature. Approve it via the dashboard or \`skillfile approve\` (which signs the body); a status change alone cannot grant approval.`,
              "skill_status",
              `Sign the skill with the operator's key, then it can be Approved.`,
              name,
            );
          }
        }
        const result = await this.deps.skillStore.update_status(name, newState);
        // v0.19.1 — sync declarative triggers on status transition.
        // Approved → register the skill's declared triggers; Draft or
        // Disabled → drop them. Closes Perry F1 + adopter Finding 2:
        // mid-session status changes are live immediately, no restart.
        await this.syncTriggersForSkill(name, newState);
        return result;
      },
    });

    this.registerTool({
      name: "list_triggers",
      description: "List registered triggers — the autonomous-dispatch registry. Optionally filter by skill name or trigger source (cron / event). Read-only. Pairs with register_trigger / set_trigger_enabled / unregister_trigger to manage how Approved skills fire on their own.",
      inputSchema: {
        type: "object",
        properties: {
          skill: { type: "string" },
          source: { type: "string", enum: ["cron", "event"] },
        },
      },
      handler: async (args) => {
        const filter: { skillName?: string; source?: ResolvableTriggerSource } = {};
        if (typeof args["skill"] === "string") filter.skillName = args["skill"];
        if (typeof args["source"] === "string") filter.source = args["source"] as ResolvableTriggerSource;
        return this.deps.scheduler.listTriggers(filter);
      },
    });

    this.registerTool({
      name: "register_trigger",
      description: "Register an autonomous-dispatch trigger for a skill — cron (time-based) or event (HTTP POST /event ingress, named). Only Approved skills fire; the scheduler re-verifies the approval gate at fire time, so registering a trigger never bypasses approval. Skills can also declare triggers inline via `# Triggers:` frontmatter (synced automatically on approval) — use this tool for imperative / dynamic registration. Returns the registration. Write operation.",
      inputSchema: {
        type: "object",
        properties: {
          skill_name: { type: "string" },
          source: { type: "string", enum: ["cron", "event"] },
          name: { type: "string" },
          expires_at: { type: "number" },
        },
        required: ["skill_name", "source", "name"],
      },
      handler: async (args) => {
        const skillName = args["skill_name"] as string;
        const source = args["source"] as ResolvableTriggerSource;
        // v0.19.1 — auto-derive event-trigger params from the named
        // skill's `# Vars:` declaration. Closes Perry F2 (memory
        // `f68eb84d`): declarative wiring already does this for event
        // triggers; imperative register_trigger forgot to. Without it,
        // a POST /event with params for an imperatively-registered
        // event 400s with "unknown params" because registration.params=[].
        // Share the derivation pattern across both paths.
        let params: string[] | undefined;
        if (source === "event") {
          try {
            const loaded = await this.deps.skillStore.load(skillName);
            const parsed = parseSkill(loaded.source);
            params = parsed.vars.map((v) => v.name);
          } catch {
            // Skill not found or unparseable — pass params undefined.
            // The scheduler will register with no declared params;
            // /event POSTs without params still work; POSTs with
            // params hit the strict-validation gate as expected.
          }
        }
        const reg: Omit<TriggerRegistration, "id" | "registeredAt" | "enabled"> = {
          skillName,
          source,
          name: args["name"] as string,
          declarative: false,
          ...(typeof args["expires_at"] === "number" ? { expiresAt: args["expires_at"] } : {}),
          ...(params !== undefined ? { params } : {}),
        };
        return this.deps.scheduler.registerTrigger(reg);
      },
    });

    this.registerTool({
      name: "unregister_trigger",
      description: "Remove a registered trigger by id (see list_triggers for ids). Returns true if removed, false if the id wasn't found. Write operation.",
      inputSchema: {
        type: "object",
        properties: { trigger_id: { type: "string" } },
        required: ["trigger_id"],
      },
      handler: async (args) => {
        const id = args["trigger_id"] as string;
        return { removed: this.deps.scheduler.unregisterTrigger(id) };
      },
    });

    this.registerTool({
      name: "set_trigger_enabled",
      description: "Toggle a trigger's enabled state without unregistering it — disabled triggers stay in the registry but the scheduler skips firing them (vacation / maintenance windows). State persists via the onTriggersChanged hook for imperative triggers. Returns the updated registration, or null if no trigger has that id. Write operation.",
      inputSchema: {
        type: "object",
        properties: {
          trigger_id: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["trigger_id", "enabled"],
      },
      handler: async (args) => {
        const id = args["trigger_id"] as string;
        const enabled = args["enabled"] as boolean;
        const updated = this.deps.scheduler.setTriggerEnabled(id, enabled);
        return updated ?? null;
      },
    });

    this.registerTool({
      name: "health_metrics",
      description: "Aggregate runtime health metrics from trace records. Returns per-skill + per-connector aggregates.",
      inputSchema: {
        type: "object",
        properties: {
          skills: { type: "array", items: { type: "string" } },
          connectors: { type: "array", items: { type: "string" } },
          since_ms: { type: "number" },
          until_ms: { type: "number" },
        },
      },
      handler: async (args): Promise<HealthMetrics> => {
        const filter: { skills?: string[]; connectors?: string[]; since_ms?: number; until_ms?: number } = {};
        if (Array.isArray(args["skills"])) filter.skills = args["skills"] as string[];
        if (Array.isArray(args["connectors"])) filter.connectors = args["connectors"] as string[];
        if (typeof args["since_ms"] === "number") filter.since_ms = args["since_ms"];
        if (typeof args["until_ms"] === "number") filter.until_ms = args["until_ms"];
        return healthMetrics(this.deps.traceStore, filter);
      },
    });

    this.registerTool({
      name: "runtime_capabilities",
      description: "Discover the runtime's wired connectors and shell-execution mode. Read-only. Use to author skills against the actually-available primitives. Per-category filter via `include`. The connector lists are a compact menu (tool NAMES); pull one tool's full argument schema on demand with `tool: \"<connector>.<tool>\"`.",
      inputSchema: {
        type: "object",
        properties: {
          include: {
            type: "array",
            items: {
              type: "string",
              enum: ["localModels", "mcpConnectors", "mcpConnectorClasses", "dataStores", "skillStores", "agentConnectors", "shellExecution", "securedApproval", "runtimeVersion", "runtimeMode", "triggersFilePath"],
            },
            description: "Filter which categories to return. Omit for all.",
          },
          tool: {
            type: "string",
            description: "Selective schema fetch: `\"<connector>.<tool>\"` (or a bare tool name) returns that one tool's full descriptor (name, description, input_schema) under `toolSchema`. The manual for a single tool you're about to call — not in the default menu.",
          },
        },
      },
      handler: async (args) => this.runtimeCapabilities(args),
    });

    // ─── v0.2.3 — over-the-wire authoring lifecycle ────────────────────────

    this.registerTool({
      name: "lint_skill",
      description: "Run static lint against a skill source body or stored skill name. Returns diagnostics across tier-1 (errors that block compile), tier-2 (warnings), tier-3 (advisories). Read-only. The inner-loop affordance while drafting — lint as you iterate, then compile_skill for the full pre-commit check before skill_write.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Skill source body to lint. One of source/name required." },
          name: { type: "string", description: "Name of a skill stored in the SkillStore. One of source/name required." },
        },
      },
      handler: async (args) => this.lintSkill(args),
    });

    this.registerTool({
      name: "compile_skill",
      description: "Compile a skill source body or stored skill name. Returns the rendered artifact + parse/compile errors + resolved variables + topological execution order. Read-only. The pre-commit check after lint_skill passes and before skill_write — confirms the body compiles and shows the execution order without running effects (use execute_skill `mechanical: true` for a no-fire dispatch preview).",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Skill source body to compile. One of source/name required." },
          name: { type: "string", description: "Name of a skill stored in the SkillStore. One of source/name required." },
          inputs: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Optional `# Vars:` overrides keyed by variable name.",
          },
        },
      },
      handler: async (args) => this.compileSkill(args),
    });

    this.registerTool({
      name: "skill_write",
      description: "Write a skill body into the configured SkillStore. Tier-1 lint runs at write time (SkillStore contract) and throws on rejection — run lint_skill / compile_skill first to iterate cleanly. The `# Status:` header is honored: `# Status: Approved` lands Approved in unsecured mode, but in secured mode an unsigned body is forced to Draft (a write can't grant approval). Promote later via skill_status, or the dashboard / `skillfile approve` in secured mode. Returns version + content_hash. Write operation.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name; must match the `# Skill:` header in the source body." },
          source: { type: "string", description: "Skill source body." },
          overwrite: { type: "boolean", description: "When false (default) and a skill with this name already exists, the write is rejected. When true, replaces in place.", default: false },
        },
        required: ["name", "source"],
      },
      handler: async (args, ctx) => this.skillWrite(args, ctx),
    });

    // ─── v0.2.8 — composition + discovery ──────────────────────────────────

    this.registerTool({
      name: "execute_skill",
      description: "Execute a skill end-to-end against the runtime's wired connectors. Two modes: (1) `name` — execute a stored skill; runtime fetches from SkillStore and the v0.9.0 hash-token gate fires (Draft / tampered bodies rejected). (2) `source` — ad-hoc inline execution; the supplied body runs in memory and is discarded; bypasses SkillStore + approval gate (per thread 10746795). Use `name` for production / autonomous dispatch; use `source` for one-off scripting where polluting the store would be wrong. Returns {skill_name, final_vars, transcript, outputs, errors, target_order}. `mechanical: true` previews dispatch without firing $/~/@/?? ops. Recursion-depth-guarded (default 10). Write operation. v0.15.2 — `skill_name` is accepted as a silent back-compat alias for `name`.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of a skill stored in the SkillStore. Exactly one of `name` / `source` is required. (Alias: `skill_name` — accepted for back-compat with the pre-v0.15.2 surface.)" },
          source: { type: "string", description: "Ad-hoc inline skill body. Runs in memory; never persisted; bypasses SkillStore + approval gate. Exactly one of `name` / `source` is required." },
          skill_name: { type: "string", description: "Back-compat alias for `name`. Prefer `name` in new code." },
          inputs: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Optional `# Vars:` overrides keyed by variable name.",
          },
          mechanical: {
            type: "boolean",
            description: "When true, $/~/@/?? ops bind placeholders instead of firing. Recurses through nested execute_skill calls.",
            default: false,
          },
        },
      },
      handler: async (args, ctx) => this.executeSkill(args, ctx),
    });

    this.registerTool({
      name: "help",
      description: "Cold-agent language discovery. `help()` returns a ~500-token quickstart. `help({topic})` returns a deeper section. Topics: ops / frontmatter / examples / connectors / lint-codes / composition. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: ["ops", "frontmatter", "examples", "connectors", "lint-codes", "composition"],
            description: "Optional topic for a deeper section. Omit for the quickstart.",
          },
        },
      },
      handler: async (args) => this.help(args),
    });
  }

  private async executeSkill(args: Record<string, unknown>, callerCtx: McpRequestCtx = {}): Promise<Record<string, unknown>> {
    // v0.15.2 — `name` is the canonical kwarg; `skill_name` is a silent
    // back-compat alias. Aligns the surface with the other skill_* tools
    // (skill_read / skill_preflight / skill_status / skill_write all take
    // `name`). Per Perry signoff (thread 75abc8c0): silent alias — no
    // tier-3 advisory, no deprecation warn. If both are supplied with
    // different values, that's ambiguous; reject so the caller picks one.
    const nameKwarg = args["name"];
    const skillNameKwarg = args["skill_name"];
    const hasNameKwarg = typeof nameKwarg === "string" && nameKwarg !== "";
    const hasSkillNameKwarg = typeof skillNameKwarg === "string" && skillNameKwarg !== "";
    if (hasNameKwarg && hasSkillNameKwarg && nameKwarg !== skillNameKwarg) {
      throw new Error(
        "execute_skill: ambiguous kwargs — `name` and `skill_name` are aliases; supply only one (or matching values).",
      );
    }
    const skillName = hasNameKwarg ? nameKwarg : skillNameKwarg;
    const sourceArg = args["source"];
    const hasName = typeof skillName === "string" && skillName !== "";
    const hasSource = typeof sourceArg === "string" && sourceArg !== "";
    if (hasName === hasSource) {
      throw new Error("execute_skill: exactly one of `name` or `source` is required.");
    }
    const inputs = (args["inputs"] as Record<string, string> | undefined) ?? {};
    const mechanical = args["mechanical"] === true;

    // Build an ExecuteContext for the call. The MCP tool entry is the
    // top-level — recursionDepth starts at 0 and increments inside
    // executeSkillByName / executeSkillFromSource.
    if (this.deps.registry === undefined) {
      throw new Error("execute_skill: runtime registry not configured (McpServerDeps.registry missing).");
    }
    // v0.15.5 — thread `enableUnsafeShell` into the dispatch ctx. Pre-v0.15.5
    // the flag was honored at the lint + compile + runtime_capabilities
    // surfaces, but the `execute_skill` MCP-tool dispatch never read it
    // when constructing its ExecuteContext, so `shell(..., unsafe=true)` ops
    // were always refused via execute_skill regardless of how the runtime
    // was configured. The 5th instance of the discipline-only-contracts
    // class (sibling: skill_status v0.13.7, strict_filters v0.14.0,
    // mutation gate v0.14.x, skill_write declared-but-unwired v0.15.0).
    //
    // v0.16.8 — same class of bug, different field. ctx.agentId never
    // populated at this entry point; runtime threads agentId through to
    // McpDispatchCtx at dispatch time (runtime.ts), but with no source
    // for agentId here, the connector dispatched under runtime identity
    // regardless of who owned the skill. Sibling close: look up the
    // named skill's author from SkillStore.metadata and populate
    // ctx.agentId so the connector dispatch sees it. For source-form
    // execute_skill (no name → no SkillStore lookup), agentId stays
    // undefined — the caller is responsible for supplying it via other
    // ExecuteContext paths if needed.
    let agentId: string | undefined;
    if (hasName && !hasSource) {
      try {
        const meta = await this.deps.skillStore.metadata(skillName as string);
        if (meta.author !== undefined) agentId = meta.author;
      } catch {
        // SkillNotFoundError or other read failure — let downstream
        // executeSkillByName surface the real error. ctx.agentId stays
        // undefined; v0.16.8 ships the plumbing, not the failure mode.
      }
    }
    // v0.18.4 — thread the MCP caller-identity into ctx.callerAgentId so
    // `DeliveryMeta.origin.caller_agent_id` reflects the authenticated
    // caller (NOT the skill owner). Closes Perry's Q5a + the connector-
    // agent adoption finding where execute_skill via /rpc with
    // X-Agent-Id: cc landed caller_agent_id: <skill-author> on the
    // deliver() envelope. Reqs `mcpCallerIdentityHeader` to be
    // configured; absent header / unset config → callerAgentId stays
    // undefined (back-compat with the v0.16.8 owner-only semantics).
    const ctx = {
      registry: this.deps.registry,
      mechanical,
      recursionDepth: 0,
      // v0.23.0 — pass the trace store (NOT a `trace` config) so `$`-op observed
      // output-shape capture works on the MCP execute path. With no trace config
      // the full per-run TraceRecord is still NOT written (traceBuilder stays
      // null); only the lightweight shape cache is updated. Skipped in mechanical
      // preview (no real dispatch occurs).
      ...(!mechanical ? { traceStore: this.deps.traceStore } : {}),
      ...(this.deps.enableUnsafeShell !== undefined ? { enableUnsafeShell: this.deps.enableUnsafeShell } : {}),
      ...(this.deps.shellAllowlist !== undefined ? { shellAllowlist: this.deps.shellAllowlist } : {}),
      ...(this.deps.fsAllowlist !== undefined ? { fsAllowlist: this.deps.fsAllowlist } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(callerCtx?.callerIdentity !== undefined ? { callerAgentId: callerCtx.callerIdentity } : {}),
    } satisfies import("./runtime.js").ExecuteContext;

    try {
      const result = hasSource
        ? await executeSkillFromSource(sourceArg as string, inputs, {
            skillStore: this.deps.skillStore,
            ctx,
          })
        : await executeSkillByName(skillName as string, inputs, {
            skillStore: this.deps.skillStore,
            ctx,
          });
      return {
        skill_name: result.skill_name,
        final_vars: result.final_vars,
        transcript: result.transcript,
        outputs: result.outputs,
        errors: result.errors,
        target_order: result.target_order,
        // v0.9.2 — P1.1 + P1.4 wire-level surface. Cold authors / MCP
        // consumers can inspect `fallbacks[]` and `agent_delivery_receipts[]`
        // alongside errors to distinguish real success from no-op delivery
        // or fallback substitution.
        fallbacks: result.fallbacks,
        agent_delivery_receipts: result.agent_delivery_receipts,
        agent_wake_receipts: result.agent_wake_receipts,
        mechanical,
      };
    } catch (err) {
      // v0.3.1: composition.ts now throws MissingSkillReferenceError (OpError
      // subclass) instead of the legacy SkillNotFoundForCompositionError, so
      // missing-skill failures flow through `# OnError:` chains. The MCP wire
      // shape continues to surface this as `class: "SkillNotFoundError"` for
      // consumer-compatibility — renamed message + structured fields, same
      // top-level class label on the wire. The legacy branch stays as a
      // belt-and-suspenders catch for any path still throwing the old type.
      if (err instanceof MissingSkillReferenceError || err instanceof SkillNotFoundForCompositionError) {
        return {
          skill_name: null,
          final_vars: {},
          transcript: [],
          outputs: {},
          errors: [{ class: "SkillNotFoundError", opKind: "execute_skill", target: "(root)", message: err.message }],
          target_order: [],
          mechanical,
        };
      }
      if (err instanceof RecursionDepthExceededError) {
        return {
          skill_name: skillName,
          final_vars: {},
          transcript: [],
          outputs: {},
          errors: [{ class: "RecursionDepthExceededError", opKind: "execute_skill", target: "(root)", message: err.message, chain: err.chain }],
          target_order: [],
          mechanical,
        };
      }
      if (err instanceof LintFailureError) {
        return {
          skill_name: skillName,
          final_vars: {},
          transcript: [],
          outputs: {},
          errors: [{ class: "LintFailureError", opKind: "execute_skill", target: "(root)", message: err.message }],
          target_order: [],
          mechanical,
        };
      }
      // Unexpected — surface as a structured error rather than throw.
      return {
        skill_name: skillName,
        final_vars: {},
        transcript: [],
        outputs: {},
        errors: [{ class: (err as Error).name, opKind: "execute_skill", target: "(root)", message: (err as Error).message }],
        target_order: [],
        mechanical,
      };
    }
  }

  private async help(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const topic = typeof args["topic"] === "string" ? args["topic"] : null;
    return helpResponse(topic, this.version, this.deps.registry);
  }

  // ─── v0.2.3 authoring-lifecycle handlers ───────────────────────────────────

  private async lintSkill(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = await this.resolveSource(args);
    // v0.4.1 — auto-wire from runtime registry for unknown-connector +
    // disallowed-tool. Closes Perry's v0.4.0 signoff observation
    // a4ae08a6: the MCP lint surface IS the running runtime, so its
    // wired connectors are the natural context for runtime-aware lint
    // unless the caller explicitly overrides.
    const lintResult = await lint(source, {
      skillStore: this.deps.skillStore,
      callSite: "api",
      ...(this.deps.enableUnsafeShell !== undefined ? { enableUnsafeShell: this.deps.enableUnsafeShell } : {}),
      ...(this.deps.shellAllowlist !== undefined ? { shellAllowlist: this.deps.shellAllowlist } : {}),
      ...(this.deps.fsAllowlist !== undefined ? { fsAllowlist: this.deps.fsAllowlist } : {}),
      ...(this.deps.registry !== undefined ? { registry: this.deps.registry } : {}),
    });
    return {
      diagnostics: lintResult.findings.map((f) => ({
        rule: f.rule,
        tier: severityToTier(f.severity),
        severity: f.severity,
        message: f.message,
        block: f.block,
        remediation: f.remediation,
        extras: f.extras,
      })),
      error_count: lintResult.errorCount,
      warning_count: lintResult.warningCount,
      info_count: lintResult.infoCount,
      passes_tier_1: lintResult.errorCount === 0,
      passes_tier_2: lintResult.warningCount === 0,
      passes_tier_3: lintResult.infoCount === 0,
    };
  }

  private async compileSkill(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = await this.resolveSource(args);
    const inputs = (args["inputs"] as Record<string, string> | undefined) ?? undefined;
    try {
      const compiled = await compile(source, {
        skillStore: this.deps.skillStore,
        ...(inputs !== undefined ? { inputs } : {}),
        ...(this.deps.enableUnsafeShell !== undefined ? { enableUnsafeShell: this.deps.enableUnsafeShell } : {}),
      ...(this.deps.shellAllowlist !== undefined ? { shellAllowlist: this.deps.shellAllowlist } : {}),
      ...(this.deps.fsAllowlist !== undefined ? { fsAllowlist: this.deps.fsAllowlist } : {}),
        ...(this.deps.registry !== undefined ? { registry: this.deps.registry } : {}),
      });
      return {
        skill_name: compiled.skillName,
        rendered: compiled.output,
        resolved_variables: compiled.resolvedVariables,
        target_order: compiled.targetOrder,
        triggers: compiled.triggers,
        outputs: compiled.outputs,
        on_error: compiled.onError,
        warnings: compiled.warnings,
        advisories: compiled.advisories,
        errors: [],
      };
    } catch (err) {
      // compile() throws structured errors for parse / lint / dep-cycle / unresolved-var.
      // Surface as `errors` rather than failing the tool call so cold authors get a
      // diagnostic surface to iterate against.
      const message = (err as Error).message;
      if (err instanceof LintFailureError) {
        return {
          skill_name: null,
          rendered: null,
          resolved_variables: {},
          target_order: [],
          triggers: [],
          outputs: [],
          on_error: null,
          warnings: [],
          advisories: [],
          errors: [message],
          lint_findings: err.diagnostics,
        };
      }
      return {
        skill_name: null,
        rendered: null,
        resolved_variables: {},
        target_order: [],
        triggers: [],
        outputs: [],
        on_error: null,
        warnings: [],
        advisories: [],
        errors: [message],
      };
    }
  }

  private async skillWrite(args: Record<string, unknown>, ctx: McpRequestCtx = {}): Promise<Record<string, unknown>> {
    const name = args["name"];
    const source = args["source"];
    if (typeof name !== "string" || name === "") {
      throw new Error("skill_write: `name` is required (non-empty string).");
    }
    if (typeof source !== "string" || source === "") {
      throw new Error("skill_write: `source` is required (non-empty string).");
    }
    const overwrite = args["overwrite"] === true;
    if (!overwrite) {
      try {
        await this.deps.skillStore.metadata(name);
        // metadata() succeeded → skill exists. Refuse without overwrite=true.
        throw new Error(`skill_write: '${name}' already exists. Pass overwrite=true to replace.`);
      } catch (err) {
        // Re-throw the refuse-message; swallow "not found" so we proceed with the write.
        const msg = (err as Error).message;
        if (msg.startsWith("skill_write:")) throw err;
      }
    }
    // v0.16.8 — when `forceAlwaysDraft` is enabled, rewrite the body's
    // `# Status:` header to Draft before persisting so the body and the
    // VersionInfo agree. Same machinery as the in-skill bridge's
    // Draft-by-default discipline (v0.15.0) — both converge on
    // `forceDraftStatus` from skill-store-mcp. Adopters wanting stricter
    // posture (every write requires explicit human promotion regardless
    // of body claim) opt in via the flag at runtime startup. Per Perry's
    // `787b6b95` Option A.
    // v0.21.0 — store-agnostic secured-mode closure (red-team 33bf53d3).
    // skill_write cannot GRANT approval: if the body claims Approved without a
    // valid v3 signature, force Draft — regardless of the SkillStore impl. The
    // per-store guard didn't cover custom adopter stores (AMP-backed), letting an
    // agent write status=Approved with no signature (a forgeable trust-state lie
    // that misleads skill_list / skill_preflight / the dashboard). evaluateApproval
    // -Gate is not-ok for any Draft OR unsigned-Approved body, so a genuine
    // approve-flow write (signed body) is honored; everything else lands Draft.
    let bodyToStore = source;
    if (this.deps.forceAlwaysDraft === true) {
      bodyToStore = forceDraftStatus(source);
    } else if (isSecuredMode() && !evaluateApprovalGate(source).ok) {
      bodyToStore = forceDraftStatus(source);
    }
    // v0.17.0 — thread host-attested caller identity into `store({author})`
    // so MCP-authored skills stamp `SkillMeta.author = <calling agent>`,
    // not the runtime's wiring identity. When ctx.callerIdentity is
    // undefined (no header configured, or header absent on this request),
    // SkillStore.store() falls back to its default author capture (e.g.,
    // `userInfo().username` for FilesystemSkillStore) — preserves v0.16.8
    // behavior for adopters not configured for multi-agent identity.
    const metadata = ctx.callerIdentity !== undefined ? { author: ctx.callerIdentity } : undefined;
    // SkillStore.store() runs tier-1 lint as part of its contract and throws
    // LintFailureError on rejection. Surface that to the caller verbatim.
    const versionInfo = await this.deps.skillStore.store(name, bodyToStore, metadata);
    // v0.19.1 — sync declarative triggers immediately on write. Pre-
    // v0.19.1 triggers only wired at boot via wireDeclarativeTriggers,
    // so a skill authored mid-session wasn't live until restart —
    // contradicting the "POST /event accepts the new event_name now"
    // expectation external systems have. Closes Perry F1 + adopter
    // Finding 2 from memory `d538f7df`.
    await this.syncTriggersForSkill(name, versionInfo.status);
    return {
      name: versionInfo.name,
      version: versionInfo.version,
      content_hash: versionInfo.content_hash,
      status: versionInfo.status,
      changed_at: versionInfo.changed_at,
    };
  }

  /**
   * v0.19.1 — re-derive + re-register the skill's declarative triggers
   * against the scheduler. Called from skill_write + skill_status to
   * close the "registered-only-at-boot" gap surfaced by Perry F1 +
   * adopter Finding 2. Shared helper to avoid drift between the two
   * call sites; also matches the param-derivation logic in
   * wireDeclarativeTriggers (declarative + dynamic paths converge here
   * AND on Scheduler.syncDeclarativeTriggersForSkill).
   *
   * Safely no-ops when the scheduler is unavailable (e.g., test fixtures
   * that skip scheduler wiring); the v0.19.0 trigger machinery requires
   * the scheduler to be present for dispatch anyway.
   */
  private async syncTriggersForSkill(name: string, status: SkillStatus): Promise<void> {
    if (this.deps.scheduler === undefined) return;
    let loaded;
    try {
      loaded = await this.deps.skillStore.load(name);
    } catch {
      // Skill removed between write and sync — drop any prior triggers.
      this.deps.scheduler.syncDeclarativeTriggersForSkill(name, [], [], "Draft");
      return;
    }
    let parsedTriggers: ReadonlyArray<{ source: string; name: string }> = [];
    let parsedVars: string[] = [];
    try {
      const parsed = parseSkill(loaded.source);
      parsedTriggers = parsed.triggers;
      parsedVars = parsed.vars.map((v) => v.name);
    } catch {
      // Parse failure — drop any triggers for safety.
      this.deps.scheduler.syncDeclarativeTriggersForSkill(name, [], [], "Draft");
      return;
    }
    this.deps.scheduler.syncDeclarativeTriggersForSkill(name, parsedTriggers, parsedVars, status);
  }

  /**
   * Resolve {source?, name?} to a source string. One required; if both, source
   * wins (lets clients tweak a stored skill's body without re-storing first).
   */
  private async resolveSource(args: Record<string, unknown>): Promise<string> {
    const source = args["source"];
    const name = args["name"];
    if (typeof source === "string" && source !== "") return source;
    if (typeof name === "string" && name !== "") {
      const loaded = await this.deps.skillStore.load(name);
      return loaded.source;
    }
    throw new Error("Either `source` or `name` is required.");
  }

  private async runtimeCapabilities(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const filter = Array.isArray(args["include"]) ? new Set(args["include"] as string[]) : null;
    const want = (key: string): boolean => filter === null || filter.has(key);
    const out: Record<string, unknown> = {};
    const reg = this.deps.registry;
    if (want("runtimeVersion")) out["runtimeVersion"] = this.version;
    if (want("runtimeMode")) out["runtimeMode"] = this.deps.runtimeMode ?? "dashboard";
    if (want("triggersFilePath")) out["triggersFilePath"] = this.deps.triggersFilePath ?? null;
    if (want("skillStores")) out["skillStores"] = reg ? await Promise.all(reg.listSkillStores().map((e) => describeEntry(e))) : [];
    if (want("dataStores")) out["dataStores"] = reg ? await Promise.all(reg.listDataStores().map((e) => describeEntry(e))) : [];
    if (want("localModels")) out["localModels"] = reg ? await Promise.all(reg.listLocalModels().map((e) => describeEntry(e))) : [];
    if (want("mcpConnectors")) {
      // v0.4.1 — surface `allowed_tools` per connector (or null when allow-all).
      out["mcpConnectors"] = reg
        ? await Promise.all(reg.listMcpConnectors().map(async (e) => ({
            ...(await describeEntry(e)),
            allowed_tools: e.allowedTools ?? null,
          })))
        : [];
    }
    if (want("mcpConnectorClasses")) {
      // v0.4.0 — closed-set of MCP connector classes that can be wired
      // via `connectors.json`. Cold authors check this before writing
      // a `class: "..."` field. Plugin-style runtime-arbitrary class
      // loading is deliberately out of scope; the set grows via
      // CHANGELOG-tracked runtime releases.
      out["mcpConnectorClasses"] = listKnownConnectorClasses();
    }
    if (want("agentConnectors")) out["agentConnectors"] = reg ? await Promise.all(reg.listAgentConnectors().map((e) => describeEntry(e))) : [];
    if (want("securedApproval")) {
      // v1.0 Gate #7 — secured-mode state for the dashboard approval queue.
      // When `enabled`, the runtime cannot grant approval itself (it holds no
      // private key); approval is an out-of-band operator action via
      // `skillfile approve`. The dashboard surfaces the review queue + command
      // rather than an in-page approve button (the server-as-signer model is
      // deliberately off the table — privilege separation keeps the key off the
      // network-facing process). `public_key_present` tells the UI whether a
      // verifier is wired (armed) vs secured-but-unkeyed (misconfiguration).
      out["securedApproval"] = {
        enabled: isSecuredMode(),
        public_key_present: hasApprovalPublicKey(),
      };
    }
    if (want("shellExecution")) {
      // v0.19.12 — accurate allowlist reporting (closes Perry's
      // `7395b8af` discovery-surface bug). Pre-v0.19.12 this surface
      // claimed "any binary on PATH may be invoked" — false since
      // v0.18.8 shipped the default-deny allowlist. The discovery
      // surface must reflect the enforced boundary, not contradict it.
      const allowlist = this.deps.shellAllowlist;
      out["shellExecution"] = {
        mode: "structural-spawn",
        unsafe_enabled: this.deps.enableUnsafeShell === true,
        allowlist: allowlist === undefined
          ? "(unset — default-deny; no shell ops will run)"
          : allowlist,
        description:
          "Safe `shell(command=\"...\")` ops spawn the binary directly without bash. " +
          "Binary execution is gated by an operator-owned allowlist (v0.18.8 default-deny): " +
          "`shellAllowlist` is reported above as the current set of permitted binaries (or " +
          "\"(unset — default-deny)\" when no allowlist is wired, in which case ALL shell " +
          "ops are refused with ShellBinaryNotAllowedError). Configure via " +
          "`SKILLSCRIPT_SHELL_ALLOWLIST` env (comma-separated), `shellAllowlist` field in " +
          "skillscript.config.json, or `bootstrap({shellAllowlist: [...]})` programmatically. " +
          "`shell(command=\"...\", unsafe=true)` ops additionally require `enableUnsafeShell: true` " +
          "(reported above), and bash itself must be on the allowlist (binary-scope is " +
          "independent of unsafe-vs-safe). `shell(argv=[...]) [-> R]` (v0.19.11) is the " +
          "argv form for args-with-spaces — same allowlist gate applies to `argv[0]`. " +
          "Legacy `@ <cmd>` / `@ unsafe <body>` symbol forms parse to the same AST " +
          "(lint surfaces them as deprecated-symbol-op).",
      };
    }
    // v0.23.0 — selective tool-schema fetch. `tool: "connector.tool"` (or a bare
    // tool name, searched across connectors) returns that ONE tool's full
    // descriptor — the on-demand "manual" for a tool the author is about to use,
    // kept out of the default compact menu so the response footprint stays flat.
    // Read-only: warms the connector's tools/list (protocol introspection).
    if (typeof args["tool"] === "string" && args["tool"] !== "" && reg) {
      out["toolSchema"] = await this.fetchToolSchema(args["tool"], reg);
    }
    return out;
  }

  /**
   * v0.23.0 — resolve a single tool's descriptor for the selective
   * `runtime_capabilities({ tool })` fetch. Accepts "connector.tool" (explicit)
   * or a bare tool name (first match across wired connectors). Best-effort:
   * returns null when unresolved or the upstream is unreachable.
   */
  private async fetchToolSchema(
    spec: string,
    reg: NonNullable<McpServerDeps["registry"]>,
  ): Promise<Record<string, unknown> | null> {
    const dot = spec.indexOf(".");
    const wantConn = dot >= 0 ? spec.slice(0, dot) : undefined;
    const wantTool = dot >= 0 ? spec.slice(dot + 1) : spec;
    for (const e of reg.listMcpConnectors()) {
      if (wantConn !== undefined && e.name !== wantConn) continue;
      // Respect the per-connector `allowed_tools` gate — never surface the
      // schema of a tool the operator gated off (undefined = allow-all).
      if (e.allowedTools !== undefined && !e.allowedTools.includes(wantTool)) continue;
      const inst = e.instance as { describeTools?: () => Promise<import("./connectors/types.js").McpToolDescriptor[]> };
      if (typeof inst.describeTools !== "function") continue;
      try {
        const d = (await inst.describeTools()).find((x) => x.name === wantTool);
        if (d !== undefined) {
          return {
            connector: e.name,
            name: d.name,
            ...(d.description !== undefined ? { description: d.description } : {}),
            ...(d.inputSchema !== undefined ? { input_schema: d.inputSchema } : {}),
          };
        }
      } catch {
        // Unreachable upstream — keep scanning other connectors.
      }
    }
    return null;
  }
}

function severityToTier(severity: "error" | "warning" | "info"): 1 | 2 | 3 {
  switch (severity) {
    case "error": return 1;
    case "warning": return 2;
    case "info": return 3;
  }
}

// v0.16.3 — three states for the `manifest` field:
//   1. Working: `manifest: {...}` (probed via instance.manifest())
//   2. Runtime failure: `manifest: null, manifest_error: "<message>"` (manifest() threw)
//   3. Structural absence: `manifest: null, manifest_unsupported: true` (contract has no manifest())
// AgentConnector is the structural-absence case per v0.9.6 audit (no manifest() on the contract);
// the distinction matters so dashboards can differentiate "instance broken, ping operator" from
// "kind doesn't support, by design". Per Perry's `d5bba09f`.
type DescribeEntryResult = {
  name: string;
  implementation: string;
  contract_version: string;
  connector_type: string;
  features: Record<string, boolean>;
  manifest: ManifestInfo | null;
  manifest_error?: string;
  manifest_unsupported?: true;
};

async function describeEntry<C extends { staticCapabilities(): StaticCapabilities }>(
  entry: { name: string; ctor: C; instance?: unknown },
): Promise<DescribeEntryResult> {
  let caps: StaticCapabilities;
  try {
    caps = entry.ctor.staticCapabilities();
  } catch {
    return {
      name: entry.name,
      implementation: (entry.ctor as { name?: string }).name ?? "unknown",
      contract_version: "unknown",
      connector_type: "unknown",
      features: {},
      manifest: null,
      manifest_error: "staticCapabilities() threw",
    };
  }
  const base = {
    name: entry.name,
    implementation: caps.implementation,
    contract_version: caps.contract_version,
    connector_type: caps.connector_type,
    features: caps.features,
  };
  const maybeManifest = (entry.instance as { manifest?: unknown } | undefined)?.manifest;
  if (typeof maybeManifest !== "function") {
    return { ...base, manifest: null, manifest_unsupported: true };
  }
  try {
    const manifest = (await (maybeManifest as () => Promise<ManifestInfo>).call(entry.instance)) as ManifestInfo;
    return { ...base, manifest };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, manifest: null, manifest_error: message };
  }
}

function errorResponse(id: number | string | null, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
