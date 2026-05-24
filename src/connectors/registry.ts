import type {
  SkillStore,
  SkillStoreClass,
  MemoryStore,
  MemoryStoreClass,
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
  private memoryStores = new Map<string, Entry<MemoryStore, MemoryStoreClass>>();
  private localModels = new Map<string, Entry<LocalModel, LocalModelClass>>();
  private mcpConnectors = new Map<string, McpEntry>();
  private agentConnectors = new Map<string, Entry<AgentConnector, AgentConnectorClass>>();

  // ─── Register ───────────────────────────────────────────────────────────

  registerSkillStore(name: string, instance: SkillStore): void {
    this.skillStores.set(name, { instance, ctor: ctorOf(instance) as SkillStoreClass });
  }

  registerMemoryStore(name: string, instance: MemoryStore): void {
    this.memoryStores.set(name, { instance, ctor: ctorOf(instance) as MemoryStoreClass });
  }

  registerLocalModel(name: string, instance: LocalModel): void {
    this.localModels.set(name, { instance, ctor: ctorOf(instance) as LocalModelClass });
  }

  registerMcpConnector(name: string, instance: McpConnector, allowedTools?: string[]): void {
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

  registerAgentConnector(name: string, instance: AgentConnector): void {
    this.agentConnectors.set(name, { instance, ctor: ctorOf(instance) as AgentConnectorClass });
  }

  // ─── Get instance (runtime dispatch) ────────────────────────────────────

  getSkillStore(name = "primary"): SkillStore {
    return must(this.skillStores, name, "SkillStore").instance;
  }
  getMemoryStore(name = "primary"): MemoryStore {
    return must(this.memoryStores, name, "MemoryStore").instance;
  }
  getLocalModel(name = "default"): LocalModel {
    return must(this.localModels, name, "LocalModel").instance;
  }
  getMcpConnector(name = "primary"): McpConnector {
    return must(this.mcpConnectors, name, "McpConnector").instance;
  }
  /**
   * Returns the registered AgentConnector or a transparent `NoOpAgentConnector`
   * when none is wired. Unlike the other `get*` methods, this never throws —
   * the no-op fallback lets `# Output: prompt-context:` dispatch resolve
   * cleanly in test/dev environments without an explicit substrate setup.
   * Adopters wire a real impl for production via `registerAgentConnector`.
   */
  getAgentConnector(name = "primary"): AgentConnector {
    const entry = this.agentConnectors.get(name);
    if (entry !== undefined) return entry.instance;
    return DEFAULT_AGENT_CONNECTOR;
  }

  // ─── Get class (linter offline lookup) ──────────────────────────────────

  getSkillStoreClass(name = "primary"): SkillStoreClass {
    return must(this.skillStores, name, "SkillStore").ctor;
  }
  getMemoryStoreClass(name = "primary"): MemoryStoreClass {
    return must(this.memoryStores, name, "MemoryStore").ctor;
  }
  getLocalModelClass(name = "default"): LocalModelClass {
    return must(this.localModels, name, "LocalModel").ctor;
  }
  getMcpConnectorClass(name = "primary"): McpConnectorClass {
    return must(this.mcpConnectors, name, "McpConnector").ctor;
  }
  getAgentConnectorClass(name = "primary"): AgentConnectorClass {
    const entry = this.agentConnectors.get(name);
    if (entry !== undefined) return entry.ctor;
    return NoOpAgentConnector as unknown as AgentConnectorClass;
  }

  // ─── List distinct classes per kind ─────────────────────────────────────

  listSkillStoreClasses(): SkillStoreClass[] { return distinct(this.skillStores); }
  listMemoryStoreClasses(): MemoryStoreClass[] { return distinct(this.memoryStores); }
  listLocalModelClasses(): LocalModelClass[] { return distinct(this.localModels); }
  listMcpConnectorClasses(): McpConnectorClass[] { return distinct(this.mcpConnectors); }
  listAgentConnectorClasses(): AgentConnectorClass[] { return distinct(this.agentConnectors); }

  // ─── Enumerate registered instances by name ──────────────────────────────
  // Discovery surface for runtime_capabilities (MCP tool, v0.2.1) — pairs
  // the registered name with the per-instance ctor for staticCapabilities()
  // calls. Excludes the implicit NoOp agent-connector fallback.

  listSkillStores(): Array<{ name: string; instance: SkillStore; ctor: SkillStoreClass }> { return entries(this.skillStores); }
  listMemoryStores(): Array<{ name: string; instance: MemoryStore; ctor: MemoryStoreClass }> { return entries(this.memoryStores); }
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
      ...this.listMemoryStoreClasses().map((c) => c.staticCapabilities()),
      ...this.listLocalModelClasses().map((c) => c.staticCapabilities()),
      ...this.listMcpConnectorClasses().map((c) => c.staticCapabilities()),
      ...this.listAgentConnectorClasses().map((c) => c.staticCapabilities()),
    ];
  }

  // ─── Existence checks ───────────────────────────────────────────────────

  hasSkillStore(name = "primary"): boolean { return this.skillStores.has(name); }
  hasMemoryStore(name = "primary"): boolean { return this.memoryStores.has(name); }
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
