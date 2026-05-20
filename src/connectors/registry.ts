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

export class Registry {
  private skillStores = new Map<string, Entry<SkillStore, SkillStoreClass>>();
  private memoryStores = new Map<string, Entry<MemoryStore, MemoryStoreClass>>();
  private localModels = new Map<string, Entry<LocalModel, LocalModelClass>>();
  private mcpConnectors = new Map<string, Entry<McpConnector, McpConnectorClass>>();

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

  registerMcpConnector(name: string, instance: McpConnector): void {
    this.mcpConnectors.set(name, { instance, ctor: ctorOf(instance) as McpConnectorClass });
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

  // ─── List distinct classes per kind ─────────────────────────────────────

  listSkillStoreClasses(): SkillStoreClass[] { return distinct(this.skillStores); }
  listMemoryStoreClasses(): MemoryStoreClass[] { return distinct(this.memoryStores); }
  listLocalModelClasses(): LocalModelClass[] { return distinct(this.localModels); }
  listMcpConnectorClasses(): McpConnectorClass[] { return distinct(this.mcpConnectors); }

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
    ];
  }

  // ─── Existence checks ───────────────────────────────────────────────────

  hasSkillStore(name = "primary"): boolean { return this.skillStores.has(name); }
  hasMemoryStore(name = "primary"): boolean { return this.memoryStores.has(name); }
  hasLocalModel(name = "default"): boolean { return this.localModels.has(name); }
  hasMcpConnector(name = "primary"): boolean { return this.mcpConnectors.has(name); }
}

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
