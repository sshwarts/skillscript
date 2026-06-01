import type { SkillStore, SkillStatus, SkillListFilter, StaticCapabilities } from "./connectors/types.js";
import { VALID_SKILL_STATUSES, isSkillStatus } from "./connectors/types.js";
import { buildSkillCatalog } from "./skill-catalog.js";
import type { Scheduler, ResolvableTriggerSource, TriggerRegistration } from "./scheduler.js";
import type { TraceStore } from "./trace.js";
import type { Registry } from "./connectors/registry.js";
import { healthMetrics, type HealthMetrics } from "./metrics.js";
import { lint } from "./lint.js";
import { compile } from "./compile.js";
import { listKnownConnectorClasses } from "./connectors/config.js";
import { LintFailureError, MissingSkillReferenceError, OpError } from "./errors.js";
import {
  executeSkillByName,
  executeSkillFromSource,
  RecursionDepthExceededError,
  SkillNotFoundForCompositionError,
} from "./composition.js";
import { helpResponse } from "./help-content.js";
import { RUNTIME_VERSION } from "./version.js";
import { evaluateApprovalGate } from "./approval.js";

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
 * Surface: tools wrapping existing T6 primitives.
 *
 *   skill_list({filter?})          → SkillCatalog (v0.9.8 — pre-grouped by audience)
 *   skill_metadata({name})         → metadata + version history + recent_fires + approval (no source — see skill_read)
 *   skill_read({name, version?})   → {name, version, status, source} (v0.13.3 — symmetric peer to skill_write)
 *   data_read({id, store?})      → PortableData | null (v0.13.8 — direct lookup; no data_write MCP by design)
 *   skill_status({name, new_state})→ SkillStatus update (write)
 *   list_triggers({filter?})       → TriggerRegistration[]
 *   register_trigger({...})        → TriggerRegistration (write)
 *   unregister_trigger({trigger_id})→ boolean (write)
 *   health_metrics({filter?})      → HealthMetrics
 *   runtime_capabilities({include?})→ wired connectors + shell-exec mode (v0.2.1)
 *   lint_skill({source?|name})     → diagnostics across tiers (v0.2.3)
 *   compile_skill({source?|name, inputs?})→ rendered artifact + errors (v0.2.3)
 *   skill_write({name, source, overwrite?})→ commit to SkillStore (write, v0.2.3)
 *   execute_skill({skill_name, inputs?, mechanical?})→ run + return result (write, v0.2.8)
 *   help({topic?})                 → cold-agent language discovery (read, v0.2.8)
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

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface McpServerDeps {
  skillStore: SkillStore;
  scheduler: Scheduler;
  traceStore: TraceStore;
  /** Optional — required for `runtime_capabilities`. When omitted the tool returns empty arrays. */
  registry?: Registry;
  /** Surfaced via `runtime_capabilities` so cold agents know whether `@ unsafe` is permitted. */
  enableUnsafeShell?: boolean;
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

  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse> {
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
          const result = await tool.handler(args);
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
      description: "Discover skills in the configured SkillStore (v0.9.8). Returns a `SkillCatalog` pre-grouped by audience-derived category: `receives` (skills that push to the calling agent via `# Output: agent:`), `skills` (skills the agent can invoke), `headless` (admin-view only). Category derived from each skill's `# Output:` declarations. Filter by audience / status / trigger_kind / domain_tags / name_prefix (AND-composed). Default: audience=\"agent\", status=\"Approved\".",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: {
              audience: { type: "string", enum: ["agent", "all", "headless"] },
              status: { type: "string", enum: ["Draft", "Approved", "Disabled"] },
              trigger_kind: { type: "string", enum: ["cron", "session", "webhook", "event"] },
              domain_tags: { type: "array", items: { type: "string" } },
              name_prefix: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      handler: async (args) => {
        const filter = (args["filter"] as SkillListFilter | undefined) ?? {};
        return buildSkillCatalog(this.deps.skillStore, filter);
      },
    });

    this.registerTool({
      name: "skill_metadata",
      description: "Get metadata + version history + recent fires + approval-gate state for a specific skill by name. For the source body itself, call skill_read.",
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
        if (loaded?.source !== undefined) {
          const g = evaluateApprovalGate(loaded.source);
          approval = g.ok ? { gate_ok: true } : { gate_ok: false, reason: g.reason };
        }
        return {
          metadata,
          versions,
          recent_fires,
          approval,
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
      description: "Transition a skill's status. Valid states: Draft, Approved, Disabled. Write operation.",
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
        return this.deps.skillStore.update_status(name, newState);
      },
    });

    this.registerTool({
      name: "list_triggers",
      description: "List registered triggers. Optionally filter by skill name or trigger source.",
      inputSchema: {
        type: "object",
        properties: {
          skill: { type: "string" },
          source: { type: "string", enum: ["session", "cron", "event", "agent-event", "file-watch", "sensor"] },
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
      description: "Register a new trigger for a skill. Returns the registration. Write operation.",
      inputSchema: {
        type: "object",
        properties: {
          skill_name: { type: "string" },
          source: { type: "string", enum: ["session", "cron", "event", "agent-event", "file-watch", "sensor"] },
          name: { type: "string" },
          expires_at: { type: "number" },
        },
        required: ["skill_name", "source", "name"],
      },
      handler: async (args) => {
        const reg: Omit<TriggerRegistration, "id" | "registeredAt" | "enabled"> = {
          skillName: args["skill_name"] as string,
          source: args["source"] as ResolvableTriggerSource,
          name: args["name"] as string,
          declarative: false,
          ...(typeof args["expires_at"] === "number" ? { expiresAt: args["expires_at"] } : {}),
        };
        return this.deps.scheduler.registerTrigger(reg);
      },
    });

    this.registerTool({
      name: "unregister_trigger",
      description: "Unregister a trigger by id. Returns boolean (true if removed, false if id not found). Write operation.",
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
      description: "v0.9.0 — toggle a trigger's enabled state. Disabled triggers stay registered but the scheduler skips firing them (vacation / maintenance windows). State persists via the onTriggersChanged hook for imperative triggers. Returns the updated registration, or null if no trigger has that id. Write operation.",
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
      description: "Discover the runtime's wired connectors and shell-execution mode. Read-only. Use to author skills against the actually-available primitives. Per-category filter via `include`.",
      inputSchema: {
        type: "object",
        properties: {
          include: {
            type: "array",
            items: {
              type: "string",
              enum: ["localModels", "mcpConnectors", "mcpConnectorClasses", "dataStores", "skillStores", "agentConnectors", "shellExecution", "runtimeVersion", "runtimeMode", "triggersFilePath"],
            },
            description: "Filter which categories to return. Omit for all.",
          },
        },
      },
      handler: async (args) => this.runtimeCapabilities(args),
    });

    // ─── v0.2.3 — over-the-wire authoring lifecycle ────────────────────────

    this.registerTool({
      name: "lint_skill",
      description: "Run static lint against a skill source body or stored skill name. Returns diagnostics across tier-1 (errors that block compile), tier-2 (warnings), tier-3 (advisories). Read-only. Inner-loop affordance for cold authors iterating on a draft.",
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
      description: "Compile a skill source body or stored skill name. Returns the rendered artifact + parse/compile errors + resolved variables + topological execution order. Read-only. Pre-commit validation affordance.",
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
      description: "Write a skill body into the configured SkillStore. Tier-1 lint runs at write time (SkillStore contract); throws on rejection. Returns version + content_hash. The `# Status:` header in the source body is honored — write with `# Status: Approved` and the skill lands Approved (otherwise defaults to Draft). Promote/demote later via skill_status. Write operation.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name; must match the `# Skill:` header in the source body." },
          source: { type: "string", description: "Skill source body." },
          overwrite: { type: "boolean", description: "When false (default) and a skill with this name already exists, the write is rejected. When true, replaces in place.", default: false },
        },
        required: ["name", "source"],
      },
      handler: async (args) => this.skillWrite(args),
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
      handler: async (args) => this.executeSkill(args),
    });

    this.registerTool({
      name: "help",
      description: "Cold-agent language discovery. `help()` returns a ~500-token quickstart. `help({topic})` returns a deeper section. Topics: ops / frontmatter / examples / connectors / lint-codes. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: ["ops", "frontmatter", "examples", "connectors", "lint-codes"],
            description: "Optional topic for a deeper section. Omit for the quickstart.",
          },
        },
      },
      handler: async (args) => this.help(args),
    });
  }

  private async executeSkill(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // v0.15.2 — `name` is the canonical kwarg; `skill_name` is a silent
    // back-compat alias. Aligns the surface with the other skill_* tools
    // (skill_read / skill_metadata / skill_status / skill_write all take
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
    const ctx = {
      registry: this.deps.registry,
      mechanical,
      recursionDepth: 0,
      ...(this.deps.enableUnsafeShell !== undefined ? { enableUnsafeShell: this.deps.enableUnsafeShell } : {}),
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

  private async skillWrite(args: Record<string, unknown>): Promise<Record<string, unknown>> {
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
    // SkillStore.store() runs tier-1 lint as part of its contract and throws
    // LintFailureError on rejection. Surface that to the caller verbatim.
    const versionInfo = await this.deps.skillStore.store(name, source);
    return {
      name: versionInfo.name,
      version: versionInfo.version,
      content_hash: versionInfo.content_hash,
      status: versionInfo.status,
      changed_at: versionInfo.changed_at,
    };
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
    if (want("skillStores")) out["skillStores"] = reg ? reg.listSkillStores().map((e) => describeEntry(e)) : [];
    if (want("dataStores")) out["dataStores"] = reg ? reg.listDataStores().map((e) => describeEntry(e)) : [];
    if (want("localModels")) out["localModels"] = reg ? reg.listLocalModels().map((e) => describeEntry(e)) : [];
    if (want("mcpConnectors")) {
      // v0.4.1 — surface `allowed_tools` per connector (or null when allow-all).
      out["mcpConnectors"] = reg
        ? reg.listMcpConnectors().map((e) => ({
            ...describeEntry(e),
            allowed_tools: e.allowedTools ?? null,
          }))
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
    if (want("agentConnectors")) out["agentConnectors"] = reg ? reg.listAgentConnectors().map((e) => describeEntry(e)) : [];
    if (want("shellExecution")) {
      // The runtime has no fixed command allowlist — `shell(command=...)` ops
      // are structurally sandboxed via direct spawn (no shell expansion). Bash
      // is only invoked when `shell(command=..., unsafe=true)` is used AND
      // `enableUnsafeShell` is true. This surface reports that mode so cold
      // agents can author accordingly instead of guessing at a list that
      // doesn't exist. Legacy `@ <cmd>` / `@ unsafe <body>` parse to the same
      // AST node via the v0.7.1+ source-form collapse (lint surfaces them
      // as deprecated-symbol-op) — runtime semantics are identical.
      out["shellExecution"] = {
        mode: "structural-spawn",
        unsafe_enabled: this.deps.enableUnsafeShell === true,
        description: "Safe `shell(command=\"...\")` ops spawn the binary directly without bash; any binary on PATH may be invoked. `shell(command=\"...\", unsafe=true)` ops require `enableUnsafeShell: true` on the runtime and are lint-flagged tier-2 every appearance. Legacy `@ <cmd>` / `@ unsafe <body>` symbol forms parse to the same AST and run identically (lint surfaces them as deprecated-symbol-op).",
      };
    }
    return out;
  }
}

function severityToTier(severity: "error" | "warning" | "info"): 1 | 2 | 3 {
  switch (severity) {
    case "error": return 1;
    case "warning": return 2;
    case "info": return 3;
  }
}

function describeEntry<C extends { staticCapabilities(): StaticCapabilities }>(
  entry: { name: string; ctor: C },
): { name: string; implementation: string; contract_version: string; connector_type: string; features: Record<string, boolean> } {
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
    };
  }
  return {
    name: entry.name,
    implementation: caps.implementation,
    contract_version: caps.contract_version,
    connector_type: caps.connector_type,
    features: caps.features,
  };
}

function errorResponse(id: number | string | null, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
