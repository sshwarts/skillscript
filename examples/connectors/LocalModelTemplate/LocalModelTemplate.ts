/**
 * LocalModelTemplate — fork-me skeleton for writing your own LocalModel impl.
 *
 * This is NOT a runnable connector. Every method throws a "TODO" error.
 * Adopters writing OpenAI-compat / Anthropic-compat / vLLM / TGI / SGLang /
 * hosted-LLM / any-other LocalModel substrate fork this directory.
 *
 * The bundled `OllamaLocalModel` (in `src/connectors/local-model.ts`) is
 * Ollama-specific. When that doesn't fit, fork from here.
 *
 * Forking workflow:
 *   1. Copy this directory: `cp -r examples/connectors/LocalModelTemplate examples/connectors/MyLocalModel`
 *   2. Rename the class — typically `<Substrate>LocalModel` (e.g., `OpenAICompatLocalModel`, `AnthropicLocalModel`, `VllmLocalModel`)
 *   3. Implement `run()` against your transport
 *   4. Implement `manifest()` returning substrate metadata
 *   5. Update `staticCapabilities()` to declare what your impl supports
 *   6. Register from your adopter bootstrap:
 *        `registry.registerLocalModel("default", new MyLocalModel({ ... }))`
 *   7. Validate via the conformance suite:
 *        `LocalModelConformance.buildTests({ build: () => new MyLocalModel(...), ctor: MyLocalModel })`
 *
 * See `src/connectors/local-model.ts` (`OllamaLocalModel`) for a working
 * reference implementation against the Ollama HTTP API. The full contract
 * spec lives in `src/connectors/types.ts` (`LocalModel` interface).
 *
 * Runtime hosts (MCP server + web dashboard) honor whichever LocalModel impl
 * you register. The auto-wired `$ llm` MCP bridge wraps your impl
 * transparently — once registered, `$ llm prompt="..."` dispatches through
 * your fork without any additional wiring.
 *
 * **Note on declarative wiring**: LocalModel is intrinsically *singleton* per
 * deployment (one default per runtime), unlike McpConnector which is
 * multi-instance. There's no `registerLocalModelClass()` equivalent of
 * `registerConnectorClass()` — adopters wire their LocalModel
 * programmatically via `registry.registerLocalModel()` from their bootstrap.
 * Declarative custom-LocalModel via `connectors.json` substrate `{type:
 * "custom", module, export, config}` form is deferred until async-bootstrap
 * support lands (cross-cutting limitation across all three substrate slots).
 */

import type {
  LocalModel,
  LocalModelCapabilities,
  ManifestInfo,
} from "../../../src/connectors/types.js";

/** Replace with your substrate's connection config (endpoint, auth, model selection, etc.). */
export interface LocalModelTemplateConfig {
  // TODO — declare the fields your substrate needs to connect.
  // Examples:
  //   endpoint?: string;           // OpenAI-compat / vLLM / TGI URL
  //   apiKey?: string;             // hosted services
  //   defaultModel?: string;       // model name / tag
  //   timeoutMs?: number;
  exampleConfigField?: string;
}

export class LocalModelTemplate implements LocalModel {
  /**
   * Declare what your impl supports. The runtime + lint consult these flags.
   * Set conservatively — overclaiming triggers cryptic downstream failures;
   * underclaiming hides usable features.
   */
  static staticCapabilities(): LocalModelCapabilities {
    return {
      connector_type: "local_model",
      implementation: "LocalModelTemplate", // ← rename to your class name
      contract_version: "1.0.0",
      features: {
        // TODO — set each flag based on what your substrate can actually do.
        supports_max_tokens: false,  // can opts.maxTokens cap output?
        supports_timeout: false,     // do you honor a per-call timeout?
        supports_streaming: false,   // does your run() stream tokens? (v1 contract is non-streaming — flag for forward-compat)
        supports_embedding: false,   // does your substrate also expose embeddings?
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: LocalModelTemplateConfig) {
    // TODO — establish your substrate connection. For HTTP: store base URL
    // + auth headers + default model. For SDK: cache the client instance.
    throw new Error("LocalModelTemplate is a fork-me skeleton; replace with your impl.");
  }

  /**
   * Dispatch a prompt and return the model's response text.
   *
   * `prompt` — the substituted prompt body (template substitution already
   * resolved by the runtime; you get the final string).
   *
   * `opts`:
   *   - `maxTokens` — optional cap on output length. Honor if `supports_max_tokens: true`.
   *   - `model` — optional override of the configured default. Honor if your
   *     substrate supports multiple models per instance.
   *
   * Return the response text directly (not wrapped in an envelope). The
   * `LocalModelMcpConnector` bridge exposes this as `$ llm prompt="..." -> R`
   * where R binds to your string return value.
   *
   * On dispatch failure: throw. Don't return error envelopes silently — the
   * runtime's op-level `(fallback: ...)` machinery catches throws cleanly.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_prompt: string, _opts: { maxTokens?: number; model?: string }): Promise<string> {
    // TODO — dispatch via your transport.
    //   - Map prompt + opts to your substrate's wire format (chat completion / completion / etc.)
    //   - Apply your per-call timeout
    //   - Parse the response; extract the text
    //   - Throw on dispatch failure (don't return error envelope silently)
    throw new Error("TODO: run() — dispatch prompt + return response text.");
  }

  /**
   * Capability snapshot for `runtime_capabilities` discovery. Return free-form
   * substrate-specific metadata.
   *
   * Per `LocalModelManifest` in `src/connectors/types.ts`, known curated fields:
   *   - `kind`: string tag for substrate flavor ("openai-compat", "vllm", etc.)
   *   - `default_model`: configured default model name
   *   - `endpoint`: URL the impl connects to
   *   - `models_available`: list when introspectable (e.g., `/v1/models` for OpenAI-compat)
   *   - `fetch_error`: set when introspection failed (don't silently cache empty array)
   * Plus `[key: string]: unknown` for substrate extensions.
   *
   * The bundled `OllamaLocalModel.manifest()` returns:
   *   { capabilities_version: "1", manifest: { kind: "ollama",
   *     endpoint: "...", default_model: "gemma2:9b", models_available: [...] } }
   */
  async manifest(): Promise<ManifestInfo<"local_model">> {
    // TODO — return a snapshot of your substrate's metadata.
    //   - kind: identify the substrate
    //   - endpoint: where you connect
    //   - default_model: what model you'll dispatch to
    //   - models_available: list if you can introspect; surface fetch_error if introspection fails
    throw new Error("TODO: manifest() — return substrate metadata snapshot.");
  }
}
