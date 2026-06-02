/**
 * SkillStoreTemplate — fork-me skeleton for writing your own SkillStore impl.
 *
 * This is NOT a runnable connector. Every method throws a "TODO" error. The
 * purpose is to surface the SkillStore contract surface in a copy-and-customize
 * shape so adopters writing Postgres-, MySQL-, MongoDB-, AMP-, or
 * vector-DB-backed SkillStores have a starting skeleton.
 *
 * Forking workflow:
 *   1. Copy this directory into your codebase (`cp -r examples/connectors/SkillStoreTemplate examples/connectors/MyDatabaseSkillStore`)
 *   2. Rename the class — typically `<Substrate>SkillStore` (e.g., `PostgresSkillStore`)
 *   3. Implement each method against your substrate's API
 *   4. Update `staticCapabilities()` to declare what your impl actually supports
 *   5. Register from your adopter bootstrap:
 *        `registry.registerSkillStore("primary", new MyDatabaseSkillStore({ ... }))`
 *   6. Validate via the conformance suite:
 *        `SkillStoreConformance.buildTests({ build: () => new MyDatabaseSkillStore(...), ctor: MyDatabaseSkillStore })`
 *
 * See `src/connectors/sqlite-skill-store.ts` for a working reference
 * implementation against SQLite + `node:sqlite`. See `src/connectors/skill-store.ts`
 * for the bundled filesystem default. The full contract spec lives in
 * `src/connectors/types.ts` (`SkillStore` interface, lines 192-208) and
 * `docs/sqlite-skill-store.md` for schema + semantics depth.
 *
 * Runtime hosts (MCP server + web dashboard) honor whichever SkillStore impl
 * you register via the registry, so once your fork passes the conformance
 * suite the entire skillscript surface (skill_write / skill_list /
 * execute_skill / etc.) reads + writes against your substrate.
 *
 * **`SkillStoreMcpConnector` bridge auto-wires against your impl.**
 * The runtime's `defaultRegistry` wraps your registered SkillStore in a
 * `SkillStoreMcpConnector` instance and registers it under the connector
 * names `skill_read` + `skill_write`, so `$ skill_read` / `$ skill_write` from
 * inside an executing skill dispatches through your `load()` / `store()`
 * methods. This is the Lisp-shape primitive — skills can program skills —
 * and works against any `SkillStore` impl that passes the conformance suite.
 *
 * Your impl doesn't need to do anything special to participate. Two things
 * worth knowing:
 *   - **In-skill writes arrive Draft-stamped.** The bridge layer applies a
 *     `# Status: Draft` override to the body before calling your `store()`.
 *     This is the trust boundary — autonomously-generated skill bodies
 *     (e.g., `$ llm prompt="generate a skill"` → `$ skill_write`) shouldn't
 *     bypass human review by landing Approved + immediately executable.
 *     See `src/connectors/skill-store-mcp.ts` header for the threat-model
 *     rationale. Outside-MCP `skill_write` (cold-author agents authoring
 *     directly via the wire surface) keeps the existing "body declares
 *     status, you auto-stamp via store()" path — that's the path your
 *     `store()` honor-the-body-Status logic addresses.
 *   - **Substrate-level lint runs at `store()` entry.** If you mirror
 *     `FilesystemSkillStore` / `SqliteSkillStore`, you'll run tier-1 lint
 *     on the body before persisting + throw `LintFailureError` on rejection.
 *     The bridge propagates that error through `$ skill_write` so authors
 *     see lint-rejection-on-write, not silent persistence of malformed bodies.
 */

import type {
  SkillStore,
  SkillSource,
  SkillMeta,
  SkillStatus,
  SkillFilter,
  VersionInfo,
  SkillStoreCapabilities,
  ManifestInfo,
} from "skillscript-runtime/connectors";

/** Replace with your substrate's connection config (host, dbName, credentials, etc.). */
export interface SkillStoreTemplateConfig {
  // TODO — declare the fields your substrate needs to connect.
  // Examples:
  //   postgresUrl?: string;
  //   pineconeApiKey?: string;
  //   ampVault?: string;
  exampleConfigField?: string;
}

export class SkillStoreTemplate implements SkillStore {
  /**
   * Declare what your impl supports. The runtime + lint consult these flags
   * before exercising features. Set conservatively — overclaiming triggers
   * cryptic downstream failures; underclaiming hides usable features.
   */
  static staticCapabilities(): SkillStoreCapabilities {
    return {
      connector_type: "skill_store",
      implementation: "SkillStoreTemplate", // ← rename to your class name
      contract_version: "1.0.0",
      features: {
        // TODO — set each flag based on what your substrate can actually do.
        supports_writes: false,               // can you persist new skills?
        supports_versioning: false,           // can you return historical bytes via load(name, version)?
        supports_tag_filter: false,           // can query() filter by tag?
        supports_audit_trail: false,          // does update_status populate previous_status?
        supports_atomic_status_transitions: false, // can UPDATE + INSERT versions be transactional?
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: SkillStoreTemplateConfig) {
    // TODO — establish your substrate connection. For SQL: open the database
    // + run schema migrations. For HTTP: store the base URL + auth headers.
    // For AMP/Pinecone: cache the SDK client.
    throw new Error("SkillStoreTemplate is a fork-me skeleton; replace with your impl.");
  }

  /**
   * Capability snapshot for `runtime_capabilities` discovery. Return free-form
   * substrate-specific metadata (kind, version, supported modes, etc.).
   */
  async manifest(): Promise<ManifestInfo<"skill_store">> {
    // TODO — return a snapshot of your substrate's capabilities.
    throw new Error("TODO: manifest() — return substrate-specific capability snapshot.");
  }

  /**
   * Read the skill body bytes + metadata. If `version` is supplied, return
   * historical bytes (or throw `VersionNotFoundError` if the version is
   * unknown). If the skill doesn't exist at all, throw `SkillNotFoundError`.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async load(_name: string, _version?: string): Promise<SkillSource> {
    // TODO — fetch the skill record from your substrate.
    //   - Return SkillSource { name, version, content_hash, source, metadata }
    //   - Throw SkillNotFoundError if name doesn't exist
    //   - Throw VersionNotFoundError if version is supplied but unknown
    throw new Error("TODO: load() — fetch skill source by name (+ optional version).");
  }

  /**
   * List skill metadata. Apply the filter where your substrate supports it;
   * fall back to client-side filtering for unsupported fields. Empty result
   * is fine; never throw "not found" — return [].
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async query(_filter?: SkillFilter): Promise<SkillMeta[]> {
    // TODO — query your substrate for skill metadata.
    //   - Apply filter.status / filter.tag / filter.author / etc. as supported
    //   - Honor filter.limit + filter.offset
    //   - Never throw on no matches; return []
    throw new Error("TODO: query() — return SkillMeta[] honoring the filter.");
  }

  /**
   * Read skill metadata without the body bytes. Equivalent to `load()` but
   * skips the `source` field — useful for listings + introspection where
   * the body isn't needed.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async metadata(_name: string): Promise<SkillMeta> {
    // TODO — return SkillMeta for `name`. Throw SkillNotFoundError if missing.
    throw new Error("TODO: metadata() — return SkillMeta without body bytes.");
  }

  /**
   * Return version history (chronological). Each entry has `version` +
   * `content_hash` + `status` + `changed_at` + optional `previous_status`
   * (audit trail). Throws `SkillNotFoundError` if the skill doesn't exist.
   *
   * If your substrate doesn't track versions, return a single-element array
   * with the current state (and set `supports_versioning: false`).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async versions(_name: string): Promise<VersionInfo[]> {
    // TODO — return version chain. SQL substrates: SELECT FROM skill_versions
    // ORDER BY changed_at. DataStore-style: query memories with the right tag.
    throw new Error("TODO: versions() — return VersionInfo[] chronologically.");
  }

  /**
   * Persist a skill (create or update). Compute content_hash from the source;
   * append a new version row; update the current-version pointer. Returns
   * `VersionInfo` for the new version.
   *
   * For atomicity, wrap your substrate writes in a transaction (or equivalent)
   * so the version row is never created without the current-version pointer
   * updating, and vice versa.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async store(_name: string, _source: string, _metadata?: Partial<SkillMeta>): Promise<VersionInfo> {
    // TODO — persist the skill source bytes + metadata.
    //   - Compute content_hash (SHA-256 of source) + version (short hash)
    //   - Auto-stamp approval token if body declares Approved (see
    //     src/approval.ts → stampApprovalToken / extractStatusFromBody)
    //   - Write to your substrate atomically
    //   - Return VersionInfo
    throw new Error("TODO: store() — persist skill source + metadata.");
  }

  /**
   * Hard-delete the skill (substrate-only — referential integrity is the
   * runtime's concern). Whether to cascade version history is your substrate
   * choice; the bundled SqliteSkillStore cascades (rationale in
   * `docs/sqlite-skill-store.md`).
   *
   * Throws `SkillNotFoundError` if `name` doesn't exist (so adopters get a
   * clear error rather than a silent no-op).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async delete(_name: string): Promise<void> {
    // TODO — remove the skill from your substrate. Decide cascade vs preserve
    // history per your compliance needs. Throw SkillNotFoundError if missing.
    throw new Error("TODO: delete() — remove skill (+ optionally history).");
  }

  /**
   * Transition a skill's status (Draft / Approved / Disabled). Updates the
   * current state + appends a `skill_versions` row with `previous_status`
   * populated (audit trail). Wrap in a transaction for atomicity.
   *
   * Approved transitions should stamp the approval token (see
   * `src/approval.ts`); transitions away from Approved should strip it.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async update_status(_name: string, _status: SkillStatus): Promise<VersionInfo> {
    // TODO — atomically update status + append audit row.
    //   - Load current status (for previous_status field)
    //   - Apply stampApprovalToken if status=Approved
    //   - Strip token if transitioning to Draft/Disabled
    //   - UPDATE skills SET status, INSERT skill_versions (transaction)
    //   - Return VersionInfo with previous_status populated
    throw new Error("TODO: update_status() — atomic status transition + audit row.");
  }
}
