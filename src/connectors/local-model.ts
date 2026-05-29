import type { LocalModel, LocalModelCapabilities, ManifestInfo } from "./types.js";
import { messageOf } from "../errors.js";

const CONTRACT_VERSION = "1.0.0";

/**
 * Ollama HTTP client. Bundled reference implementation of `LocalModel` —
 * wraps `POST /api/generate` against a running Ollama instance.
 *
 * Wired via `substrate.local_model: "ollama"` (or `{type: "ollama", config: {...}}`)
 * in `connectors.json`. Default is no LocalModel wired; adopters opt in.
 *
 * Configuration:
 *   - `baseUrl` — Ollama endpoint. Default `http://localhost:11434` (Ollama
 *     convention). Can be set via the `OLLAMA_BASE_URL` env var or
 *     `substrate.local_model.config.baseUrl` in `connectors.json`.
 *   - `defaultModelTag` — the Ollama model tag this instance dispatches to
 *     (e.g. `gemma2:9b`, `llama3.1:8b`, `qwen2.5:7b`). **Required** — must
 *     be a model already pulled on the Ollama instance. v0.13.1 made this
 *     required after observing silent defaults could target a model the
 *     adopter hadn't pulled.
 *   - `timeoutMs` — per-call timeout. Default 60s. Per-op overrides via the
 *     `# Timeout:` header.
 *
 * Adopters wanting OpenAI-compat, Anthropic-compat, vLLM, TGI, or any other
 * LocalModel substrate fork `examples/connectors/LocalModelTemplate/` and
 * register their impl programmatically (substrate `custom` form via
 * `connectors.json` is deferred until async-bootstrap support lands).
 */
export interface OllamaConfig {
  baseUrl?: string;
  defaultModelTag: string;
  timeoutMs?: number;
}

export class OllamaLocalModel implements LocalModel {
  static staticCapabilities(): LocalModelCapabilities {
    return {
      connector_type: "local_model",
      implementation: "OllamaLocalModel",
      contract_version: CONTRACT_VERSION,
      features: {
        supports_max_tokens: true,
        supports_timeout: true,
        supports_streaming: false,
        supports_embedding: false,
      },
    };
  }

  private readonly baseUrl: string;
  private readonly defaultModelTag: string;
  private readonly timeoutMs: number;
  /**
   * v0.13.0 — manifest cache now distinguishes success from failure.
   * On success: `{ version, models, fetchError: null }`. On failure:
   * `{ version, models: [], fetchError: <message> }` — and we DO NOT cache
   * the failure (next `manifest()` call retries the fetch). Closes the
   * silent-empty-array footgun from the prior `.catch(() => [])` pattern.
   */
  private manifestCache: { version: string; models: string[]; fetchError: null } | null = null;
  private lastFetchErrorLogged: string | null = null;

  constructor(config: OllamaConfig) {
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
    this.defaultModelTag = config.defaultModelTag;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async run(prompt: string, opts: { maxTokens?: number; model?: string }): Promise<string> {
    // `model` here is the registered name (e.g. `default`, `gemma2`, `qwen`)
    // — but Ollama needs the underlying model tag. The registry resolves
    // the name to this instance before calling us, so we use our own
    // `defaultModelTag`. The `model` param is informational here.
    const body: Record<string, unknown> = {
      model: this.defaultModelTag,
      prompt,
      stream: false,
    };
    if (opts.maxTokens !== undefined) {
      body["options"] = { num_predict: opts.maxTokens };
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Ollama HTTP ${resp.status}: ${text || resp.statusText}`);
      }
      const data = (await resp.json()) as { response?: string };
      return data.response ?? "";
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        throw new Error(`Ollama call timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Runtime manifest. Queries `/api/tags` for the live model list. Cached
   * until `invalidateManifest()` (or in the future, a `runtime.invalidateConnector()`
   * call) flushes it. Authors don't add new models often enough to justify
   * polling on every dispatch.
   */
  async manifest(): Promise<ManifestInfo<"local_model">> {
    let models: string[];
    let fetchError: string | null = null;
    if (this.manifestCache !== null) {
      // Successful fetch was cached; reuse until `invalidateManifest()`.
      models = this.manifestCache.models;
    } else {
      // No cached success — try to fetch. On failure, surface the error in
      // the manifest (don't cache) so adopters see WHY the model list is
      // empty + the next call retries.
      try {
        models = await this.fetchInstalledModels();
        this.manifestCache = { version: "1", models, fetchError: null };
      } catch (err) {
        models = [];
        fetchError = messageOf(err);
        // v0.13.0 — log once per unique error so live ops + dev sees it,
        // but don't spam on every dashboard refresh. Deduped by message.
        if (fetchError !== this.lastFetchErrorLogged) {
          process.stderr.write(
            `[OllamaLocalModel] manifest fetch failed against ${this.baseUrl}/api/tags: ${fetchError}\n`,
          );
          this.lastFetchErrorLogged = fetchError;
        }
      }
    }
    return {
      capabilities_version: "1",
      manifest: {
        kind: "ollama",
        endpoint: this.baseUrl,
        default_model: this.defaultModelTag,
        models_available: models,
        ...(fetchError !== null ? { fetch_error: fetchError } : {}),
      },
    };
  }

  invalidateManifest(): void {
    this.manifestCache = null;
  }

  private async fetchInstalledModels(): Promise<string[]> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5_000);
    try {
      const resp = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      if (!resp.ok) {
        // v0.13.0 — was `return []` (silent). Now throws so manifest() can
        // surface the HTTP failure in `fetch_error` instead of caching an
        // empty model list and pretending Ollama replied successfully.
        throw new Error(`HTTP ${resp.status} ${resp.statusText} from ${this.baseUrl}/api/tags`);
      }
      const data = (await resp.json()) as { models?: Array<{ name?: string }> };
      return (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    } finally {
      clearTimeout(t);
    }
  }
}
