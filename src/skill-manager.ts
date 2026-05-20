// Runtime-layer skill management API. User-facing surface for storing and
// deleting skills with referential-integrity guarantees that the connector
// contract intentionally delegates to this layer.
//
// `ReferentialIntegrityError` is a runtime-layer error class — NOT a
// `ConnectorError` subclass. The distinction matters: the executor's
// `else:` / `# OnError:` machinery catches `ConnectorError`s thrown
// inside skill execution and routes them through the recovery chain.
// `ReferentialIntegrityError` is thrown by `deleteSkill()`, which is a
// user-facing management API — not a skill-execution op — so it surfaces
// directly to the caller and bypasses recovery routing.

import { parse } from "./parser.js";
import type { SkillStore } from "./connectors/types.js";
import type { Registry } from "./connectors/registry.js";

/**
 * Thrown by `deleteSkill()` when the target skill is referenced by other
 * skills and `opts.force` is not set. Runtime-layer error, distinct from
 * the `ConnectorError` hierarchy in `src/errors.ts`.
 */
export class ReferentialIntegrityError extends Error {
  constructor(
    public readonly skill_name: string,
    public readonly referenced_by: string[],
  ) {
    super(
      `Cannot delete skill '${skill_name}' — referenced by: ${referenced_by.join(", ")}. ` +
      `Pass { force: true } to delete anyway.`,
    );
    this.name = "ReferentialIntegrityError";
  }
}

export interface DeleteSkillOptions {
  /** Skip the referential-integrity check; substrate may still refuse for its own policy reasons. */
  force?: boolean;
}

/**
 * Runtime reference index. Maps `referencedSkill → set of skills that
 * reference it`. Bidirectional bookkeeping lets storeSkill/delete updates
 * stay O(refs) instead of O(N) scans.
 *
 * **Out-of-band edit tolerance.** If someone edits a `.skill` file directly
 * (bypassing storeSkill), the index goes stale until the runtime restarts
 * or `runtime.invalidateConnector()` triggers a rebuild. Not a correctness
 * issue — the next startup scan re-derives — but operators editing files
 * by hand will see incorrect referential-integrity checks until they
 * either restart or invalidate.
 *
 * The runtime ships an explicit `rebuildIndex()` escape hatch for live
 * recovery without restart.
 */
export class ReferenceIndex {
  /** `name → skills that reference name` (deleteSkill consumes this). */
  private referencedBy = new Map<string, Set<string>>();
  /** `name → skills that name references` (storeSkill bookkeeping). */
  private referencing = new Map<string, Set<string>>();

  /** Skills that reference the given target. Empty array if none. */
  referencesTo(name: string): string[] {
    const set = this.referencedBy.get(name);
    return set ? Array.from(set).sort() : [];
  }

  /** Skills that the given source references. Empty array if none. */
  referencesFrom(name: string): string[] {
    const set = this.referencing.get(name);
    return set ? Array.from(set).sort() : [];
  }

  /** Update edges for one skill — replaces its outgoing edges. Used after storeSkill. */
  setOutgoing(name: string, targets: string[]): void {
    // Drop old outgoing edges from referencedBy.
    const oldTargets = this.referencing.get(name);
    if (oldTargets !== undefined) {
      for (const t of oldTargets) {
        const set = this.referencedBy.get(t);
        if (set !== undefined) {
          set.delete(name);
          if (set.size === 0) this.referencedBy.delete(t);
        }
      }
    }
    if (targets.length === 0) {
      this.referencing.delete(name);
    } else {
      this.referencing.set(name, new Set(targets));
      for (const t of targets) {
        let set = this.referencedBy.get(t);
        if (set === undefined) {
          set = new Set();
          this.referencedBy.set(t, set);
        }
        set.add(name);
      }
    }
  }

  /** Drop all edges originating from `name`. Used after deleteSkill. */
  drop(name: string): void {
    this.setOutgoing(name, []);
  }

  /** Total edge count — for tests + diagnostics. */
  size(): number {
    let n = 0;
    for (const set of this.referencing.values()) n += set.size;
    return n;
  }
}

/**
 * Walk a skill's parsed AST and extract names of skills it references.
 *
 * For T1's grammar this returns empty for every input — the `&` op isn't
 * yet parsed (lands in T3 alongside data-skill inlining). The function
 * shape is ready so the index machinery doesn't need to change when T3
 * adds the op. `# Requires:` clauses in T1 declare variable resolution
 * (user-var: / system-var:) and capability flags, neither of which name
 * other skills.
 */
export function extractReferences(source: string): string[] {
  const _parsed = parse(source);
  // T1: no `&` op, no skill-naming `# Requires:` shape. Scaffold for T3.
  return [];
}

/**
 * Build a fresh reference index from a SkillStore by scanning every skill.
 * Called once at runtime startup; subsequent storeSkill/deleteSkill calls
 * maintain incrementally.
 */
export async function buildReferenceIndex(store: SkillStore): Promise<ReferenceIndex> {
  const index = new ReferenceIndex();
  const metas = await store.query();
  for (const meta of metas) {
    try {
      const source = await store.load(meta.name);
      const refs = extractReferences(source.source);
      if (refs.length > 0) index.setOutgoing(meta.name, refs);
    } catch {
      // Skip unreadable entries; query returned them but load failed.
    }
  }
  return index;
}

/**
 * Store (create or update) a skill, then update the reference index for
 * its outgoing edges. Returns the substrate's `VersionInfo`.
 */
export async function storeSkill(
  name: string,
  source: string,
  options: {
    registry: Registry;
    index: ReferenceIndex;
    metadata?: Parameters<SkillStore["store"]>[2];
    storeName?: string;
  },
): Promise<Awaited<ReturnType<SkillStore["store"]>>> {
  const store = options.registry.getSkillStore(options.storeName);
  const info = await store.store(name, source, options.metadata);
  options.index.setOutgoing(name, extractReferences(source));
  return info;
}

/**
 * Delete a skill. Default behavior: index lookup; if any skill references
 * the target, throw `ReferentialIntegrityError`. With `opts.force`, skip
 * the check and dispatch directly to the substrate (which may still
 * refuse for its own reasons, e.g., a signed-artifact store).
 */
export async function deleteSkill(
  name: string,
  options: {
    registry: Registry;
    index: ReferenceIndex;
    force?: boolean;
    storeName?: string;
  },
): Promise<void> {
  if (options.force !== true) {
    const referencedBy = options.index.referencesTo(name);
    if (referencedBy.length > 0) {
      throw new ReferentialIntegrityError(name, referencedBy);
    }
  }
  const store = options.registry.getSkillStore(options.storeName);
  await store.delete(name);
  options.index.drop(name);
}

/**
 * Invalidate a connector's cached manifest. Triggers a refresh on the
 * next `manifest()` call. Used in dev/hot-reload loops and after operators
 * change connector state out-of-band (new Ollama model loaded, new MCP
 * server wired).
 *
 * Convention reminder: connectors bump their internal `capabilities_version`
 * on schema/structural changes, NOT on every query. This invalidate hook
 * is the explicit escape valve for cases where the version-bump didn't
 * fire (e.g., live model installation that the connector didn't observe).
 */
export function invalidateConnector(name: string, registry: Registry): void {
  // Walk all four kinds; whichever owns the name flushes its cache. We
  // don't ask the caller which kind because operators think in connector
  // names, not connector kinds.
  for (const lookup of [
    () => registry.hasLocalModel(name) ? registry.getLocalModel(name) : null,
    () => registry.hasMemoryStore(name) ? registry.getMemoryStore(name) : null,
    () => registry.hasSkillStore(name) ? registry.getSkillStore(name) : null,
    () => registry.hasMcpConnector(name) ? registry.getMcpConnector(name) : null,
  ]) {
    const instance = lookup();
    if (instance === null) continue;
    const maybe = instance as unknown as { invalidateManifest?: () => void };
    if (typeof maybe.invalidateManifest === "function") {
      maybe.invalidateManifest();
    }
  }
}
