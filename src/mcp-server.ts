import type { SkillStore, SkillStatus } from "./connectors/types.js";
import type { Scheduler, ResolvableTriggerSource, TriggerRegistration } from "./scheduler.js";
import type { TraceStore } from "./trace.js";
import { healthMetrics, type HealthMetrics } from "./metrics.js";

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
 * Surface: seven tools wrapping existing T6 primitives.
 *
 *   skill_list({filter?})          → SkillMeta[]
 *   skill_metadata({name})         → metadata + version history
 *   skill_status({name, new_state})→ SkillStatus update (write)
 *   list_triggers({filter?})       → TriggerRegistration[]
 *   register_trigger({...})        → TriggerRegistration (write)
 *   unregister_trigger({trigger_id})→ boolean (write)
 *   health_metrics({filter?})      → HealthMetrics
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
  serverVersion?: string;
}

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "skillscript-runtime";

export class McpServer {
  private readonly tools: Map<string, McpTool> = new Map();
  private readonly version: string;

  constructor(private readonly deps: McpServerDeps) {
    this.version = deps.serverVersion ?? "0.2.0";
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
      description: "List skills in the configured SkillStore. Optionally filter by status (Draft/Approved/Disabled).",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["Draft", "Approved", "Disabled"] },
            },
            additionalProperties: true,
          },
        },
      },
      handler: async (args) => {
        const filter = args["filter"] as { status?: SkillStatus } | undefined;
        return this.deps.skillStore.query(filter ?? {});
      },
    });

    this.registerTool({
      name: "skill_metadata",
      description: "Get metadata + version history + source body + recent fires for a specific skill by name.",
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
        return {
          metadata,
          versions,
          source: loaded?.source ?? null,
          recent_fires,
        };
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
        const newState = args["new_state"] as SkillStatus;
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
        const reg: Omit<TriggerRegistration, "id" | "registeredAt"> = {
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
  }
}

function errorResponse(id: number | string | null, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
