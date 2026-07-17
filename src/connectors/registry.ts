import type {
  SkillStore,
  SkillStoreClass,
  DataStore,
  DataStoreClass,
  LocalModel,
  LocalModelClass,
  McpConnector,
  McpConnectorClass,
  StaticCapabilities,
} from "./types.js";
import type { AgentConnector, AgentConnectorClass } from "./agent.js";
import { NoOpAgentConnector } from "./agent-noop.js";

/**
 * Per-kind registry — maps a connector name to an instance + its class.
 *
 * Two access paths per kind:
 *   - `get*` returns the instance for runtime dispatch (`$`/`>`/`~` ops).
 *   - `get*Class` / `list*Classes` returns the constructor for the linter
 *     to call `Ctor.staticCapabilities()` offline, without instantiating.
 *
 * Implementation choice (flagged for the dev log): single-arg
 * `register(name, instance)` derives the class via `instance.constructor`,
 * cast to the class shape. Operators wire instances as before; the class
 * tracking is implicit. The cast lies for impls that don't actually
 * expose `staticCapabilities()`; ContractConformance catches that. The
 * alternative — two-arg `register(name, instance, ctor)` — is more
 * verbose at call sites for negligible safety gain.
 *
 * Three-layer resolution applies at dispatch sites: per-call override >
 * skill-declared > primary default. The `primary` name is the fallback
 * when callers don't specify (matches the parser's bare-name handling).
 */
interface Entry<I, C> {
  instance: I;
  ctor: C;
}

/**
 * Extended entry shape for MCP connectors with v0.4.1's `allowed_tools`
 * allowlist. Stored alongside the instance + ctor so both lint (compile-
 * time `disallowed-tool` check) and runtime (dispatch-time defense-in-
 * depth) consult the same source. `allowedTools === undefined` means
 * "no allowlist configured → allow all" (backward-compat with v0.4.0).
 * `allowedTools === []` means "explicitly empty → allow none" (staging
 * disable pattern).
 */
interface McpEntry extends Entry<McpConnector, McpConnectorClass> {
  allowedTools?: string[];
}

export class Registry {
  private skillStores = new Map<string, Entry<SkillStore, SkillStoreClass>>();
  private dataStores = new Map<string, Entry<DataStore, DataStoreClass>>();
  private localModels = new Map<string, Entry<LocalModel, LocalModelClass>>();
  private mcpConnectors = new Map<string, McpEntry>();
  private agentConnectors = new Map<string, Entry<AgentConnector, AgentConnectorClass>>();

  // ─── Register ───────────────────────────────────────────────────────────

  registerSkillStore(name: string, instance: SkillStore): void {
    this.skillStores.set(name, { instance, ctor: ctorOf(instance) as SkillStoreClass });
  }

  registerDataStore(name: string, instance: DataStore): void {
    this.dataStores.set(name, { instance, ctor: ctorOf(instance) as DataStoreClass });
  }

  registerLocalModel(name: string, instance: LocalModel): void {
    this.localModels.set(name, { instance, ctor: ctorOf(instance) as LocalModelClass });
  }

  registerMcpConnector(name: string, instance: McpConnector, allowedTools?: string[]): void {
    // Leak-prevention (deadline/cancellation contract, Perry spec de11dcc5): a
    // connector whose effect can outlive the call MUST provide a bounded cleanup
    // hook, or the deadline can't stop its effect. Refuse the wiring loudly at
    // registration rather than let a skill's `# Deadline:` silently fail to
    // bound a robot/actuator/job connector.
    if (instance.effectBoundary === "outlives-call" && typeof instance.onAbort !== "function") {
      throw new Error(
        `Connector '${name}' declares effectBoundary "outlives-call" but implements no onAbort(budgetMs) ` +
          `cleanup hook. An outlives-call effect (actuator / async job / open stream / lease) can't be stopped ` +
          `by aborting the call, so a run deadline could not bound it. Implement onAbort() to stop the effect ` +
          `within its budget, or declare effectBoundary "call-bounded" if the effect is fully bounded by call().`,
      );
    }
    this.mcpConnectors.set(name, {
      instance,
      ctor: ctorOf(instance) as McpConnectorClass,
      ...(allowedTools !== undefined ? { allowedTools: [...allowedTools] } : {}),
    });
  }

  /**
   * Returns the per-connector allowlist or `undefined` if no allowlist is
   * configured (allow-all semantics, v0.4.0 backward-compat). v0.4.1
   * `disallowed-tool` lint + runtime defense-in-depth consult this.
   */
  getMcpConnectorAllowedTools(name: string): string[] | undefined {
    return this.mcpConnectors.get(name)?.allowedTools;
  }

  /** True iff `toolName` is permitted by `name`'s allowlist (or no allowlist is configured). */
  isToolAllowed(name: string, toolName: string): boolean {
    const allowed = this.getMcpConnectorAllowedTools(name);
    if (allowed === undefined) return true;
    return allowed.includes(toolName);
  }

  /**
   * v0.9.1 — return the class constructor for a wired MCP connector, or
   * undefined when not wired. Used by `validateQualifiedDispatch` to read
   * the class-level `staticTools()` surface and validate qualified
   * dispatch shapes against the connector's declared tool set.
   */
  getMcpConnectorCtor(name: string): McpConnectorClass | undefined {
    return this.mcpConnectors.get(name)?.ctor;
  }

  /**
   * Register an AgentConnector instance. Invokes `instance.health_check()`
   * and throws on `false` — wiring failures surface at boot, not at first
   * skill-fire (v0.9.6 audit Q6). Adopters wanting soft dev-mode behavior
   * wrap their AgentConnector with a retry / always-healthy shim; the
   * contract stays clean.
   */
  async registerAgentConnector(name: string, instance: AgentConnector): Promise<void> {
    const healthy = await instance.health_check();
    if (!healthy) {
      throw new Error(
        `AgentConnector '${name}' (${(ctorOf(instance) as { name?: string }).name ?? "<unknown class>"}) health_check() returned false at registration. ` +
        `Substrate is unreachable or misconfigured; runtime refuses to start with an unhealthy AgentConnector. ` +
        `Fix the substrate or wrap your connector with a retry/always-healthy shim for dev mode.`,
      );
    }
    this.agentConnectors.set(name, { instance, ctor: ctorOf(instance) as AgentConnectorClass });
  }

  // ─── Get instance (runtime dispatch) ────────────────────────────────────

  getSkillStore(name = "primary"): SkillStore {
    return must(this.skillStores, name, "SkillStore").instance;
  }
  getDataStore(name = "primary"): DataStore {
    return must(this.dataStores, name, "DataStore").instance;
  }
  getLocalModel(name = "default"): LocalModel {
    return must(this.localModels, name, "LocalModel").instance;
  }
  getMcpConnector(name = "primary"): McpConnector {
    return must(this.mcpConnectors, name, "McpConnector").instance;
  }
  /**
   * Returns the registered AgentConnector. Throws when missing — symmetric
   * with `getSkillStore` / `getMcpConnector` / etc. v0.13.0 — was silent
   * NoOp fallback; that pattern hid wiring gaps until prod (skills with
   * `# Output: agent:` ran "successfully" in dev with no real delivery).
   * Callers that want graceful-no-op behavior use
   * `getAgentConnectorOrDefault()` explicitly.
   */
  getAgentConnector(name = "primary"): AgentConnector {
    return must(this.agentConnectors, name, "AgentConnector").instance;
  }

  /**
   * Returns the registered AgentConnector, or `NoOpAgentConnector` when none
   * is wired. Use this when you genuinely want the no-op default (test rigs,
   * runtime dispatch paths that pair the return with a separate
   * `hasAgentConnector()` check to record `delivery_skipped`). v0.13.0 —
   * explicit opt-in replaces the silent fallback of pre-v0.13
   * `getAgentConnector()`.
   */
  getAgentConnectorOrDefault(name = "primary"): AgentConnector {
    const entry = this.agentConnectors.get(name);
    return entry !== undefined ? entry.instance : DEFAULT_AGENT_CONNECTOR;
  }

  // ─── Get class (linter offline lookup) ──────────────────────────────────

  getSkillStoreClass(name = "primary"): SkillStoreClass {
    return must(this.skillStores, name, "SkillStore").ctor;
  }
  getDataStoreClass(name = "primary"): DataStoreClass {
    return must(this.dataStores, name, "DataStore").ctor;
  }
  getLocalModelClass(name = "default"): LocalModelClass {
    return must(this.localModels, name, "LocalModel").ctor;
  }
  getMcpConnectorClass(name = "primary"): McpConnectorClass {
    return must(this.mcpConnectors, name, "McpConnector").ctor;
  }
  /**
   * Returns the registered AgentConnector class. Throws when missing —
   * symmetric with the other `get*Class` methods. v0.13.0 — was silent
   * fallback to `NoOpAgentConnector` via `as unknown as` cast; the cast
   * masked any interface drift.
   */
  getAgentConnectorClass(name = "primary"): AgentConnectorClass {
    return must(this.agentConnectors, name, "AgentConnector").ctor;
  }

  /**
   * Returns the registered AgentConnector class, or `NoOpAgentConnector`
   * when none is wired. Direct typing — no `unknown` cast. If
   * `NoOpAgentConnector` ever drifts from `AgentConnectorClass`, the
   * compiler tells us here.
   */
  getAgentConnectorClassOrDefault(name = "primary"): AgentConnectorClass {
    const entry = this.agentConnectors.get(name);
    return entry !== undefined ? entry.ctor : NoOpAgentConnector;
  }

  // ─── List distinct classes per kind ─────────────────────────────────────

  listSkillStoreClasses(): SkillStoreClass[] { return distinct(this.skillStores); }
  listDataStoreClasses(): DataStoreClass[] { return distinct(this.dataStores); }
  listLocalModelClasses(): LocalModelClass[] { return distinct(this.localModels); }
  listMcpConnectorClasses(): McpConnectorClass[] { return distinct(this.mcpConnectors); }
  listAgentConnectorClasses(): AgentConnectorClass[] { return distinct(this.agentConnectors); }

  // ─── Enumerate registered instances by name ──────────────────────────────
  // Discovery surface for runtime_capabilities (MCP tool, v0.2.1) — pairs
  // the registered name with the per-instance ctor for staticCapabilities()
  // calls. Excludes the implicit NoOp agent-connector fallback.

  listSkillStores(): Array<{ name: string; instance: SkillStore; ctor: SkillStoreClass }> { return entries(this.skillStores); }
  listDataStores(): Array<{ name: string; instance: DataStore; ctor: DataStoreClass }> { return entries(this.dataStores); }
  listLocalModels(): Array<{ name: string; instance: LocalModel; ctor: LocalModelClass }> { return entries(this.localModels); }
  listMcpConnectors(): Array<{ name: string; instance: McpConnector; ctor: McpConnectorClass; allowedTools?: string[] }> {
    const out: Array<{ name: string; instance: McpConnector; ctor: McpConnectorClass; allowedTools?: string[] }> = [];
    for (const [name, entry] of this.mcpConnectors) {
      out.push({
        name,
        instance: entry.instance,
        ctor: entry.ctor,
        ...(entry.allowedTools !== undefined ? { allowedTools: entry.allowedTools } : {}),
      });
    }
    return out;
  }
  listAgentConnectors(): Array<{ name: string; instance: AgentConnector; ctor: AgentConnectorClass }> { return entries(this.agentConnectors); }

  /**
   * v0.23.x — best-effort teardown of connectors that hold external resources
   * (stdio child processes, network sessions). Called on runtime shutdown so a
   * stdio-bridged connector child (e.g. RemoteMcpConnector's spawned MCP server)
   * is reaped rather than orphaned to a dead parent. Duck-typed: any mcp/agent
   * connector exposing `dispose()` is disposed; errors are swallowed (teardown
   * must never throw). Stores are in-process (no orphanable child) and excluded.
   */
  async disposeAll(): Promise<void> {
    const instances: unknown[] = [
      ...this.listMcpConnectors().map((e) => e.instance),
      ...this.listAgentConnectors().map((e) => e.instance),
    ];
    await Promise.all(instances.map(async (inst) => {
      const d = inst as { dispose?: () => Promise<void> | void };
      if (typeof d.dispose === "function") {
        try { await d.dispose(); } catch { /* best-effort teardown */ }
      }
    }));
  }

  // ─── Aggregate view for the linter ──────────────────────────────────────

  /**
   * Static capabilities for every registered connector class, deduplicated
   * by class identity. The linter's primary input — it builds the combined
   * feature set from this and validates skill `# Requires:` clauses
   * without ever calling `manifest()` or constructing additional instances.
   */
  getAllStaticCapabilities(): StaticCapabilities[] {
    return [
      ...this.listSkillStoreClasses().map((c) => c.staticCapabilities()),
      ...this.listDataStoreClasses().map((c) => c.staticCapabilities()),
      ...this.listLocalModelClasses().map((c) => c.staticCapabilities()),
      ...this.listMcpConnectorClasses().map((c) => c.staticCapabilities()),
      ...this.listAgentConnectorClasses().map((c) => c.staticCapabilities()),
    ];
  }

  // ─── Existence checks ───────────────────────────────────────────────────

  hasSkillStore(name = "primary"): boolean { return this.skillStores.has(name); }
  hasDataStore(name = "primary"): boolean { return this.dataStores.has(name); }
  hasLocalModel(name = "default"): boolean { return this.localModels.has(name); }
  hasMcpConnector(name = "primary"): boolean { return this.mcpConnectors.has(name); }
  hasAgentConnector(name = "primary"): boolean { return this.agentConnectors.has(name); }
}

const DEFAULT_AGENT_CONNECTOR: AgentConnector = new NoOpAgentConnector();

function ctorOf(instance: object): unknown {
  return instance.constructor;
}

function must<I, C>(map: Map<string, Entry<I, C>>, name: string, kind: string): Entry<I, C> {
  const entry = map.get(name);
  if (entry === undefined) {
    throw new Error(
      `${kind} '${name}' not registered. Registered: ${Array.from(map.keys()).join(", ") || "(none)"}.`,
    );
  }
  return entry;
}

function distinct<I, C>(map: Map<string, Entry<I, C>>): C[] {
  const seen = new Set<C>();
  for (const entry of map.values()) seen.add(entry.ctor);
  return Array.from(seen);
}

function entries<I, C>(map: Map<string, Entry<I, C>>): Array<{ name: string; instance: I; ctor: C }> {
  return Array.from(map.entries()).map(([name, e]) => ({ name, instance: e.instance, ctor: e.ctor }));
}
