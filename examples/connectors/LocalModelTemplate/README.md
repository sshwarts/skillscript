# LocalModelTemplate — fork-me skeleton

A skeleton `LocalModel` implementation for adopters writing their own. Not runnable; every method throws a `TODO` error. Copy this directory, rename, fill in the substrate-specific work.

**Use this when you want LocalModel inference backed by:**
- An OpenAI-compat HTTP endpoint (vLLM, TGI, SGLang, llama.cpp server)
- A hosted LLM API (OpenAI, Anthropic, Cohere — though most adopters wire those via `RemoteMcpConnector` + the provider's MCP server instead)
- A custom transport (gRPC, WebSocket, in-process inference)
- A multi-model gateway

The bundled `OllamaLocalModel` (in `src/connectors/local-model.ts`) is Ollama-specific. Fork from here when that doesn't fit.

## The two legs

```
LocalModel (choose which connector)
   ├── OllamaLocalModel (bundled, Ollama HTTP — src/connectors/local-model.ts)
   └── Your fork from this template
```

LocalModel is the narrowest contract — just 2 methods + staticCapabilities. Most of the work in a fork is substrate-specific (auth, wire format, response parsing), not contract conformance.

## Forking workflow

```bash
cp -r examples/connectors/LocalModelTemplate examples/connectors/MyLocalModel
```

1. **Rename the class.** Convention: `<Substrate>LocalModel` (e.g., `OpenAICompatLocalModel`, `AnthropicLocalModel`, `VllmLocalModel`).
2. **Define your config interface.** Edit `LocalModelTemplateConfig` to declare what your substrate needs (endpoint URL, API key, default model, timeout, etc.).
3. **Implement `run()`** — translate `(prompt, opts)` to your substrate's wire format; dispatch; parse the response text.
4. **Implement `manifest()`** — return substrate metadata (kind, endpoint, default model, available models when introspectable).
5. **Update `staticCapabilities()`** to declare what your impl supports.
6. **Wire from your adopter bootstrap:**

   ```typescript
   import { Registry } from "skillscript-runtime";
   import { MyLocalModel } from "./MyLocalModel.js";

   const registry = new Registry();
   registry.registerLocalModel("default", new MyLocalModel({ /* config */ }));
   ```

   The auto-wired `$ llm` MCP bridge wraps your impl transparently — once registered, `$ llm prompt="..."` dispatches through your fork without additional wiring.

7. **Validate via the conformance suite:**

   ```typescript
   import { describe, it } from "vitest";
   import { LocalModelConformance } from "skillscript-runtime/testing";
   import { MyLocalModel } from "./MyLocalModel.js";

   describe("MyLocalModel conformance", () => {
     const tests = LocalModelConformance.buildTests({
       build: () => new MyLocalModel({ /* test config */ }),
       ctor: MyLocalModel,
     });
     for (const t of tests) it(`[${t.category}] ${t.name}`, t.run);
   });
   ```

## Reference implementation

The bundled `OllamaLocalModel` at `src/connectors/local-model.ts` is the canonical reference (164 LOC):

- Ollama HTTP API (`POST /api/generate`, `GET /api/tags`)
- AbortController timeout pattern
- Manifest caches successful introspection but NOT failures (retries on next call)
- Deduped stderr warning for fetch errors
- Surfaces `fetch_error` in manifest when `/api/tags` introspection fails

The error-handling patterns (don't silently cache failures; surface in manifest; dedupe-log) apply to any LocalModel substrate that introspects.

## Contract surface (2 methods)

LocalModel is the narrowest contract surface in skillscript:

| Method | What it does | When called |
|---|---|---|
| `run(prompt, opts)` | Dispatch a prompt; return response text | Every `$ llm prompt="..." -> R` op (via the LocalModelMcpConnector bridge) |
| `manifest()` | Substrate metadata for discovery | At startup + on-demand from MCP clients |

Plus `staticCapabilities()` (required static).

### `run()` semantics

- **`prompt`** — already-substituted prompt body. Template substitution (`${VAR}` resolution) happens before your impl is called; you get the final string.
- **`opts.maxTokens`** — optional output length cap. Honor if `supports_max_tokens: true`.
- **`opts.model`** — optional per-call model override. Useful for adopters with multi-model gateways. Honor if your substrate supports it.
- **Return** — the response text directly. NOT wrapped in an envelope. The bridge passes this through to skill source as `$(R)`.

On dispatch failure: **throw**. The runtime's op-level `(fallback: ...)` machinery catches throws cleanly. Don't return error envelopes silently — that's the silent-recovery footgun pattern.

### `manifest()` semantics

Surface enough substrate metadata for adopters running `runtime_capabilities` to understand what's wired. Curated fields per `LocalModelManifest`:

- `kind` — substrate flavor tag (`"openai-compat"`, `"vllm"`, `"anthropic"`, etc.)
- `default_model` — configured default model name
- `endpoint` — URL your impl connects to (helps debugging)
- `models_available` — list when introspectable
- `fetch_error` — set when introspection failed; don't silently cache empty array

Plus `[key: string]: unknown` for substrate extensions.

## A note on declarative wiring

Unlike `McpConnector` (which has `registerConnectorClass()` for adopter-extensible declarative wiring via `connectors.json`), `LocalModel` is intrinsically *singleton* per deployment — one default per runtime. There's no equivalent class registry.

Adopters wire their custom LocalModel **programmatically** from their bootstrap:

```typescript
registry.registerLocalModel("default", new MyLocalModel({ /* config */ }));
```

Declarative custom-LocalModel via `connectors.json` `substrate.local_model: {type: "custom", module, export, config}` form is **deferred** until async-bootstrap support lands. Same limitation applies to `SkillStore` and `MemoryStore` custom forms — sync `bootstrap()` can't `await import()`. Not LocalModel-specific.

## Wiring against the dashboard / MCP

Runtime hosts (MCP server + web dashboard) honor whichever LocalModel impl you register. To make your fork visible through `skillfile dashboard`:

- Write a custom bootstrap that constructs the runtime with your LocalModel
- Or register via `registry.registerLocalModel("default", new MyLocalModel(...))` before `bootstrap()` returns

The auto-wired `$ llm` MCP bridge picks up your registration automatically — skills writing `$ llm prompt="..." -> R` get your impl without additional config.

## Further reading

- **[`../../../docs/configuration.md`](../../../docs/configuration.md)** — substrate selection via `connectors.json`
- **[`../../../docs/adopter-playbook.md`](../../../docs/adopter-playbook.md)** — programmatic-bootstrap patterns
- **`src/connectors/types.ts`** — authoritative `LocalModel` interface + `LocalModelManifest` curated fields
- **`src/connectors/local-model.ts`** — `OllamaLocalModel` reference impl
- **`src/connectors/local-model-mcp.ts`** — the `LocalModelMcpConnector` bridge that wraps your impl as `$ llm`
- **`src/testing/conformance.ts`** — the per-contract conformance test suites
