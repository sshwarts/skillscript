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

import { parse, type SkillOp } from "./parser.js";
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

  /**
   * Replace this index's edges with another's. Used by
   * `invalidateConnector()` when rebuilding from disk — the caller passes
   * the long-lived index, we rebuild a fresh one off the store, then
   * atomically swap the edges.
   */
  replaceAll(other: ReferenceIndex): void {
    this.referencedBy.clear();
    this.referencing.clear();
    for (const [name, targets] of other.referencing) {
      this.setOutgoing(name, Array.from(targets));
    }
  }
}

/**
 * Walk a skill's parsed AST and extract names of skills it references via
 * the `&` op. Returns a deduplicated, sorted list. Includes references to
 * both data-skills (which inline at compile time) and procedural skills
 * (which compile to runtime invocations) — the integrity check should fire
 * for either, since deleting any referenced skill breaks the source.
 *
 * Walks foreach + if bodies recursively. T3+ grammar; T1 returns empty.
 */
export function extractReferences(source: string): string[] {
  const parsed = parse(source);
  const refs = new Set<string>();
  for (const target of parsed.targets.values()) {
    collectAmpRefs(target.ops, refs);
    if (target.elseBlock !== undefined) collectAmpRefs(target.elseBlock, refs);
  }
  return Array.from(refs).sort();
}

function collectAmpRefs(ops: SkillOp[], out: Set<string>): void {
  for (const op of ops) {
    if (op.kind === "inline" && op.ampParams !== undefined) {
      out.add(op.ampParams.skillName);
    }
    if (op.foreachBody !== undefined) collectAmpRefs(op.foreachBody, out);
    if (op.ifBranches !== undefined) {
      for (const branch of op.ifBranches) collectAmpRefs(branch.body, out);
    }
    if (op.ifElseBody !== undefined) collectAmpRefs(op.ifElseBody, out);
  }
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
 * Invalidate a connector's cached state. **"Refresh everything dependent
 * on this connector."** Type-aware behavior:
 *
 *   - Any connector kind: calls `instance.invalidateManifest()` if defined.
 *     Triggers a refresh on the next `manifest()` call.
 *   - SkillStore (when an `index` is passed in `options`): also rebuilds
 *     the reference index by re-scanning the store. The recovery path for
 *     stale reference state after operators edit `.skill` files directly
 *     without going through `storeSkill()`.
 *
 * Used in dev/hot-reload loops and after operators change connector state
 * out-of-band (new Ollama model loaded, new MCP server wired, manual
 * .skill file edit).
 *
 * Convention reminder: connectors bump their internal `capabilities_version`
 * on schema/structural changes, NOT on every query. This invalidate hook
 * is the explicit escape valve for cases where the version-bump didn't
 * fire (e.g., live model installation that the connector didn't observe,
 * or out-of-band .skill file edits the runtime didn't mediate).
 *
 * Returns `Promise<void>` because the SkillStore reference-index rebuild
 * is async. Non-SkillStore invalidations complete synchronously but the
 * surface is uniform.
 */
export async function invalidateConnector(
  name: string,
  registry: Registry,
  options: { index?: ReferenceIndex } = {},
): Promise<void> {
  let matchedSkillStore: SkillStore | null = null;
  for (const lookup of [
    () => registry.hasLocalModel(name) ? registry.getLocalModel(name) : null,
    () => registry.hasDataStore(name) ? registry.getDataStore(name) : null,
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
  // Reference-index rebuild for SkillStore invalidations. Out-of-band
  // .skill file edits (vim, direct disk writes) leave the in-memory
  // reference index stale — incremental updates only fire through
  // storeSkill(). A SkillStore invalidate is the explicit recovery.
  if (registry.hasSkillStore(name)) {
    matchedSkillStore = registry.getSkillStore(name);
    if (options.index !== undefined) {
      const fresh = await buildReferenceIndex(matchedSkillStore);
      // Replace this index's edges with the rebuilt set. We do it by
      // walking known edges + clearing them, then applying the fresh
      // edges — cheaper than mutating private state from outside.
      options.index.replaceAll(fresh);
    }
  }
}
