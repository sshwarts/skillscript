// v0.15.0 — `SkillStoreMcpConnector`. Bridge class that exposes a registered
// `SkillStore` instance as an `McpConnector`, so `$ skill_write`, `$ skill_read`,
// and `$ skill_delete` work as in-skill dispatch from within an executing
// skill. Parallel structure to `DataStoreMcpConnector` — same bridge-instance-
// registered-under-multiple-names pattern; the runtime's name-match dispatch
// (v0.7.2) resolves bare `$ skill_<verb>` calls here.
//
// Motivation: closes the substrate-symmetry asymmetry where DataStore writes
// were in-skill dispatchable (via `DataStoreMcpConnector` wiring at bootstrap
// time) but SkillStore writes weren't — SkillStore mutators existed only on
// the outside MCP wire surface. With this bridge, the Lisp-shape claim —
// skills can program skills — becomes a usable in-skill capability:
//   foreach TPL in ${TEMPLATES.items}:
//     $ skill_write name=${TPL.name} source=${TPL.body}
//
// Trust model (v0.15.0): in-skill `$ skill_write` requires `# Autonomous: true`
// (or `??` / `approved=...`) per the broadened mutation gate. The wrapped
// `SkillStore.store()` auto-stamps `# Status: Approved` bodies, so an
// Autonomous parent that writes an Approved child produces a runnable child.
// Same trust as `$ data_write`: the Autonomous header is the contract; humans
// review the parent skill, the parent commits to whatever substrate it writes.
//
// Bundled surface (intentionally narrow — see Perry's threat-model push-back
// in thread f2a85892):
//
//   $ skill_write name="..." source="..." [overwrite=true] -> R
//   $ skill_read name="..." [version="..."] -> R
//
// Explicitly NOT in this bridge (v0.15.0 scope):
//   - `skill_delete` — destructive, no use case articulated yet.
//   - `skill_update_status` — the gate-bypassing op (promotes Draft →
//     Approved). Allowing it in-skill would let an Autonomous parent both
//     write Draft AND promote Approved in the same fire, defeating the
//     Draft-default trust boundary below.
//   - `skill_list` / `skill_metadata` — reads are doable but cold-author UX
//     is better via `skill_read` + introspection of the returned body.
//
// **Trust boundary — Draft-default for in-skill writes (v0.15.0).** Different
// threat model from `$ data_write`: a bad data_write produces one bad row
// (bounded blast radius); a bad skill_write produces an executable artifact
// that fires arbitrarily many times in arbitrary contexts (unbounded blast
// radius). The bridge forces `# Status: Draft` regardless of what the body
// declares. To make the written skill runnable, an authorized agent
// (human via dashboard, or MCP-direct) reviews + promotes via the
// outside-MCP `skill_status` tool. The Lisp-shape primitive (skill-writes-
// skill) is preserved; only immediate-loop execution is gated.
//
// MCP-wire `skill_write` (outside agents authoring directly) keeps the
// existing behavior — body's `# Status:` declaration is honored, auto-stamped
// by FilesystemSkillStore.store(). The new trust boundary is specifically
// "dispatched from inside an executing skill," because that's the surface
// where parent-author review doesn't transitively cover child content.
//
// Wiring: auto-registered at bootstrap as connector instance "skill_read" +
// "skill_write" pointing at the substrate's SkillStore. Adopters override by
// re-registering the names with their own bridge or a different McpConnector.

import type {
  McpConnector,
  McpDispatchCtx,
  McpConnectorCapabilities,
  ManifestInfo,
  SkillStore,
} from "./types.js";

const CONTRACT_VERSION = "1.0.0";

export class SkillStoreMcpConnector implements McpConnector {
  static staticCapabilities(): McpConnectorCapabilities {
    return {
      connector_type: "mcp_connector",
      implementation: "SkillStoreMcpConnector",
      contract_version: CONTRACT_VERSION,
      features: {
        supports_identity_propagation: false,
        supports_streaming_responses: false,
        supports_batch: false,
      },
    };
  }

  /**
   * Two canonical tools (v0.15.0). Bare-form `$ skill_<verb>` name-matches
   * against the registered connector instance; the toolName argument here
   * distinguishes which substrate method to invoke.
   */
  static staticTools(): string[] {
    return ["skill_read", "skill_write"];
  }

  constructor(private readonly skillStore: SkillStore) {}

  async call(
    toolName: string,
    args: Record<string, unknown>,
    _ctxOverrides?: McpDispatchCtx,
  ): Promise<unknown> {
    if (toolName === "skill_write") return this.dispatchWrite(args);
    return this.dispatchRead(args);
  }

  private async dispatchRead(args: Record<string, unknown>): Promise<unknown> {
    const name = typeof args["name"] === "string" ? args["name"] : "";
    if (name === "") {
      throw new Error("SkillStoreMcpConnector: `name` kwarg is required and must be a non-empty string.");
    }
    const version = typeof args["version"] === "string" && args["version"] !== "" ? args["version"] : undefined;
    const skill = await this.skillStore.load(name, version);
    return {
      name: skill.name,
      version: skill.version,
      content_hash: skill.content_hash,
      source: skill.source,
      status: skill.metadata.status,
    };
  }

  private async dispatchWrite(args: Record<string, unknown>): Promise<unknown> {
    const name = typeof args["name"] === "string" ? args["name"] : "";
    const source = typeof args["source"] === "string" ? args["source"] : "";
    if (name === "") {
      throw new Error("SkillStoreMcpConnector: `name` kwarg is required for skill_write and must be a non-empty string.");
    }
    if (source === "") {
      throw new Error("SkillStoreMcpConnector: `source` kwarg is required for skill_write and must be a non-empty string.");
    }
    // overwrite parity with MCP wire `skill_write({overwrite})`: when false
    // and a skill with this name already exists, the substrate's `store()`
    // throws StorageConflictError. The bridge surfaces that through.
    const overwrite = args["overwrite"] === true;
    if (!overwrite) {
      try {
        await this.skillStore.metadata(name);
        throw new Error(`SkillStoreMcpConnector: skill '${name}' already exists. Pass overwrite=true to replace.`);
      } catch (err) {
        const e = err as { name?: string; message?: string };
        // SkillNotFoundError is the green path (no clash); any other error rethrows.
        if (e.name !== "SkillNotFoundError" && !(e.message ?? "").startsWith("Skill not found:")) {
          throw err;
        }
      }
    }
    // v0.15.0 trust boundary — in-skill writes force `# Status: Draft`
    // regardless of body declaration. Threat-model rationale documented in
    // the file header. Stamp by replacing any existing `# Status:` line
    // (or inserting after `# Skill:` / at body top if absent). Outside-MCP
    // skill_write bypasses this bridge and keeps the dashboard auto-stamp
    // path; only in-skill dispatch sees the override.
    const draftedBody = forceDraftStatus(source);
    const info = await this.skillStore.store(name, draftedBody);
    return {
      name: info.name,
      version: info.version,
      content_hash: info.content_hash,
      status: info.status,
    };
  }

  async manifest(): Promise<ManifestInfo<"mcp_connector">> {
    const ssManifest = await this.skillStore.manifest();
    return {
      capabilities_version: "1",
      manifest: {
        kind: "skill-store-bridge",
        wraps: ssManifest.manifest ?? {},
      },
    };
  }
}

/**
 * v0.15.0 — replace any `# Status:` line in the body with `# Status: Draft`.
 * If no `# Status:` line is present, insert one after `# Skill:` (or at
 * body top as fallback). Mirrors the `rewriteStatusHeader` shape used by
 * FilesystemSkillStore.update_status but lives here so the bridge can apply
 * the Draft-only policy without coupling to substrate internals.
 *
 * Why this is here (not in FilesystemSkillStore.store): the Draft-only
 * gate is a property of the in-skill dispatch surface, not of the
 * substrate. Outside-MCP writes (dashboard, MCP-direct agents) should
 * keep the existing "body declares status" behavior. The override lives
 * at the bridge — the boundary between in-skill dispatch and substrate.
 */
function forceDraftStatus(body: string): string {
  const draftLine = "# Status: Draft";
  const statusRe = /^#\s*Status\s*:.*$/m;
  if (statusRe.test(body)) {
    return body.replace(statusRe, draftLine);
  }
  const skillRe = /^(#\s*Skill\s*:.*?)$/m;
  if (skillRe.test(body)) {
    return body.replace(skillRe, `$1\n${draftLine}`);
  }
  return `${draftLine}\n${body}`;
}
