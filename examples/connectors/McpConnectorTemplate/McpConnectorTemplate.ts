/**
 * McpConnectorTemplate — fork-me skeleton for writing your own McpConnector impl.
 *
 * This is NOT a runnable connector. Every method throws a "TODO" error. The
 * purpose is to surface the McpConnector contract surface in a copy-and-customize
 * shape for the exotic cases the four bundled impls don't cover.
 *
 * **When to fork from this template** (vs. using a bundled impl):
 *   - `RemoteMcpConnector` — covers the common case: spawn a child process,
 *     bridge stdio (LSP or newline framing). YouTrack, GitHub, Linear, most
 *     remote MCPs all wire through this. Use it for ANY external MCP server
 *     reachable via stdio bridging — JSON-configurable via `connectors.json`.
 *   - `CallbackMcpConnector` — wraps a JS function as McpConnector. For test
 *     rigs + embedder-wired transports where the dispatch is local code.
 *   - `LocalModelMcpConnector` — bridges a registered LocalModel as
 *     `$ llm prompt=...` MCP dispatch. Auto-wired when LocalModel substrate
 *     is configured.
 *   - `DataStoreMcpConnector` — bridges a registered DataStore as
 *     `$ data_read mode=...` MCP dispatch. Auto-wired when DataStore substrate
 *     is configured.
 *   - `SkillStoreMcpConnector` — bridges a registered SkillStore as
 *     `$ skill_write` / `$ skill_read` MCP dispatch. Makes the Lisp-shape
 *     primitive (skills program skills) work from inside an executing skill.
 *     Auto-wired against `substrate.skill_store`. In-skill writes are forced
 *     to `# Status: Draft` at the bridge per the trust boundary — see
 *     `src/connectors/skill-store-mcp.ts` header for the threat-model rationale.
 *
 * Fork from this template when none of those fit — e.g.:
 *   - Direct HTTP MCP (JSON-RPC over HTTP, no child process)
 *   - WebSocket MCP
 *   - In-process MCP (call methods directly without IPC)
 *   - Custom protocol that doesn't match stdio framing
 *   - Cross-thread / worker-pool dispatch
 *
 * Forking workflow:
 *   1. Copy this directory: `cp -r examples/connectors/McpConnectorTemplate examples/connectors/MyMcpConnector`
 *   2. Rename the class — typically `<Transport>McpConnector` (e.g., `HttpMcpConnector`, `WebSocketMcpConnector`)
 *   3. Implement `call()` against your transport
 *   4. Implement `manifest()` returning transport metadata
 *   5. Update `staticCapabilities()` to declare what your impl supports
 *   6. (Optional) Implement `staticTools()` — returns the closed-set list of
 *      tools your connector exposes so lint can validate `$ name.tool` references
 *   7. Register from your adopter bootstrap:
 *        `registry.registerMcpConnector("mytool", new MyMcpConnector({ ... }))`
 *   8. (Optional) For `connectors.json` JSON-instantiability, add a static
 *      `fromConfig(config)` factory + register via `registerConnectorClass()`:
 *        ```typescript
 *        import { registerConnectorClass } from "skillscript-runtime/connectors";
 *        registerConnectorClass("MyMcpConnector", {
 *          ctor: MyMcpConnector,
 *          fromConfig: (cfg) => MyMcpConnector.fromConfig(cfg),
 *        });
 *        ```
 *
 * See `src/connectors/mcp-remote.ts` (`RemoteMcpConnector`) for the most
 * comprehensive reference impl — stdio framing, child process lifecycle,
 * `fromConfig` factory, timeout discipline. See `src/connectors/mcp.ts`
 * (`CallbackMcpConnector`) for the minimal reference impl.
 *
 * Runtime hosts (MCP server + web dashboard) honor whichever McpConnector
 * instances your registry has — bare `$ <name>` or qualified `$ <name>.<tool>`
 * dispatches route through whatever's registered.
 */

import type {
  McpConnector,
  McpDispatchCtx,
  McpConnectorCapabilities,
  ManifestInfo,
} from "skillscript-runtime/connectors";

/** Replace with your transport's connection config (URL, auth, timeouts, etc.). */
export interface McpConnectorTemplateConfig {
  // TODO — declare the fields your transport needs to connect.
  // Examples:
  //   httpEndpoint?: string;
  //   wsUrl?: string;
  //   authToken?: string;
  //   timeoutMs?: number;
  exampleConfigField?: string;
}

export class McpConnectorTemplate implements McpConnector {
  /**
   * Declare what your impl supports. The runtime + lint consult these flags.
   * Conservative defaults shown; flip to true once your impl actually supports
   * each capability.
   */
  static staticCapabilities(): McpConnectorCapabilities {
    return {
      connector_type: "mcp_connector",
      implementation: "McpConnectorTemplate", // ← rename to your class name
      contract_version: "1.0.0",
      features: {
        // TODO — set each flag based on what your transport can actually do.
        //
        // `supports_identity_propagation: true` is a structural claim that
        // distinct `ctx.agentId` values reach the upstream AND yield distinct
        // observable substrate scopes. When you flip it true, your adopter
        // conformance fixture MUST supply both Level 1 + Level 2 probes via
        // `flagProbes`:
        //   `mcpConnectors.<your-connector-name>.supports_identity_propagation.level1`
        //   `mcpConnectors.<your-connector-name>.supports_identity_propagation.level2`
        // Level 1 = identity reaches transport (substrate-independent).
        // Level 2 = distinct ctx.agentId → distinct observable substrate scope
        // (substrate-coupled; identity-pinned mock or live substrate).
        // The `RuntimeCapabilitiesConformance` suite auto-fails if missing.
        supports_identity_propagation: false,  // can ctx.agentId thread end-to-end?
        supports_streaming_responses: false,   // can `call()` return an async iterable?
        supports_batch: false,                 // can the upstream batch multiple tool calls?
      },
    };
  }

  /**
   * (Optional) Declare the closed-set tool surface for lint validation.
   *
   * Return:
   *   - `string[]` — the canonical tool names your connector exposes;
   *     `$ name.tool` references are validated against this list at lint time
   *   - `null` — surface varies at runtime (e.g., `RemoteMcpConnector` wraps
   *     an arbitrary upstream MCP server); lint emits a tier-3 advisory
   *     instead of green-lighting
   *
   * Omit this method entirely and behavior is the same as `null`.
   */
  // static staticTools(): string[] | null {
  //   return ["my_tool_a", "my_tool_b"];
  // }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: McpConnectorTemplateConfig) {
    // TODO — establish your transport. For HTTP: store base URL + auth headers.
    // For WebSocket: open the connection (or defer to first dispatch).
    // For in-process: cache references to the dispatch targets.
    throw new Error("McpConnectorTemplate is a fork-me skeleton; replace with your impl.");
  }

  /**
   * (Optional, for `connectors.json` JSON-instantiability)
   *
   * Factory that constructs an instance from a JSON `config` block.
   * Used by `loadConnectorsConfig()` when adopters declare your class in
   * `connectors.json`:
   *
   *   { "mytool": { "class": "MyMcpConnector", "config": { ... } } }
   *
   * Validates the config shape; throws a clear error on missing/wrong fields.
   *
   * Adopters register the class via:
   *   ```
   *   import { registerConnectorClass } from "skillscript-runtime/connectors";
   *   registerConnectorClass("MyMcpConnector", {
   *     ctor: MyMcpConnector,
   *     fromConfig: (cfg) => MyMcpConnector.fromConfig(cfg),
   *   });
   *   ```
   * BEFORE `loadConnectorsConfig` runs in their bootstrap.
   *
   * Omit `fromConfig` if your connector can't be configured via JSON (e.g.,
   * it needs a runtime instance the way `CallbackMcpConnector` needs a
   * dispatch function). Adopters then wire it via embedder code only.
   */
  // static fromConfig(_config: Record<string, unknown>): McpConnectorTemplate {
  //   // TODO — validate config + construct.
  //   throw new Error("TODO: fromConfig() — validate JSON config + instantiate.");
  // }

  /**
   * Dispatch a tool call to your transport.
   *
   * `toolName` — the tool the caller wants (`$ youtrack.search_issues` →
   * `toolName = "search_issues"`; bare `$ youtrack args` → `toolName` = the
   * unqualified op name).
   *
   * `args` — the kwargs from the skill source (`$ youtrack.search_issues
   * query="..." limit=10` → `{ query: "...", limit: 10 }`).
   *
   * `ctxOverrides` — optional identity overrides threaded through dispatch
   * (`agentId`, `isAdmin`). Bundled connectors that honor identity propagation
   * forward these to the upstream substrate.
   *
   * Return whatever the upstream MCP returns. Skills that bind via `-> R`
   * get the raw result; skills that descend into it (`$(R.field)`) get
   * tier-3 advisory if your impl's return shape isn't statically discoverable.
   *
   * On dispatch failure, throw — the runtime's op-level `(fallback: ...)`
   * machinery surfaces it cleanly. Don't return error envelopes silently;
   * the contract surfaces inner-tool errors via throw.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async call(
    _toolName: string,
    _args: Record<string, unknown>,
    _ctxOverrides?: McpDispatchCtx,
  ): Promise<unknown> {
    // TODO — dispatch via your transport.
    //   - Map toolName + args to your transport's wire format
    //   - Apply ctxOverrides if you support identity propagation
    //   - Apply your transport-specific timeout
    //   - Throw on dispatch failure (don't return an error envelope silently)
    //   - Return the raw response from upstream
    throw new Error("TODO: call() — dispatch tool call via your transport.");
  }

  /**
   * Capability snapshot for `runtime_capabilities` discovery. Return free-form
   * transport-specific metadata.
   *
   * The bundled `RemoteMcpConnector.manifest()` returns:
   *   { capabilities_version: "1", manifest: { kind: "remote-mcp",
   *       command: "...", framing: "lsp", tools_available: [...] } }
   */
  async manifest(): Promise<ManifestInfo<"mcp_connector">> {
    // TODO — return a snapshot of your transport's metadata.
    throw new Error("TODO: manifest() — return transport-specific capability snapshot.");
  }
}
