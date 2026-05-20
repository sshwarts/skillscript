import type { LocalModel, StaticCapabilities, ManifestInfo } from "./types.js";

const CONTRACT_VERSION = "1.0.0";

/**
 * Ollama HTTP client. Wraps `POST /api/generate` with the registered model
 * names from the registry instance. The bundled-default registry wires
 * `default` / `gemma2` to `gemma2:9b` and `qwen` to `qwen2.5:7b`, matching
 * the v1 spec.
 *
 * Configuration:
 *   - `baseUrl` — Ollama endpoint, defaults to `http://localhost:11434`.
 *   - `defaultModelTag` — the Ollama model tag this instance dispatches to
 *     (e.g. `gemma2:9b`).
 *   - `timeoutMs` — per-call timeout. Default 60s. v1 runtime supports
 *     per-op overrides via the `# Timeout:` header (T5 thread).
 */
export interface OllamaConfig {
  baseUrl?: string;
  defaultModelTag: string;
  timeoutMs?: number;
}

export class OllamaLocalModel implements LocalModel {
  static staticCapabilities(): StaticCapabilities {
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
  private manifestCache: { version: string; models: string[] } | null = null;

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
  async manifest(): Promise<ManifestInfo> {
    if (this.manifestCache === null) {
      const models = await this.fetchInstalledModels().catch(() => [] as string[]);
      this.manifestCache = { version: "1", models };
    }
    return {
      capabilities_version: this.manifestCache.version,
      manifest: {
        kind: "ollama",
        base_url: this.baseUrl,
        default_model_tag: this.defaultModelTag,
        models_available: this.manifestCache.models,
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
      if (!resp.ok) return [];
      const data = (await resp.json()) as { models?: Array<{ name?: string }> };
      return (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    } catch {
      return [];
    } finally {
      clearTimeout(t);
    }
  }
}
