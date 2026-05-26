// Onboarding scaffold: OpenAI-API-backed LocalModel. v0.7.3.
//
// HTTP client to OpenAI's Chat Completions endpoint. Implements the
// `LocalModel.run(prompt, opts)` typed contract so the v0.7.2 bridge
// (`LocalModelMcpConnector`) surfaces it as canonical `$ llm prompt=...`
// for skills.
//
// **Prompt-vs-messaging caveat.** `LocalModel.run()` takes a single
// `prompt` string; Chat Completions expects a list of messages with roles.
// This adapter wraps the prompt as a single `user` message. Skills that
// need multi-turn or system-prompt isolation should treat this as a
// limitation of the v0.7.x contract and pair the LLM dispatch with `$set`
// + accumulation in the skill body for now. v0.8.x is a likely venue
// for a richer message-shaped LocalModel contract.

import type {
  LocalModel,
  ManifestInfo,
  StaticCapabilities,
} from "skillscript-runtime/connectors";

export interface OpenAILocalModelConfig {
  /** API key. Honor `process.env["OPENAI_API_KEY"]` when undefined. */
  apiKey?: string;
  /** Default model. Override per-call via `opts.model`. */
  defaultModel?: string;
  /** Override the base URL (for Azure OpenAI, OpenAI-compatible servers, etc.). */
  baseUrl?: string;
  /** Request timeout ms. Default 60000. */
  timeoutMs?: number;
}

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  error?: { message?: string };
}

export class OpenAILocalModel implements LocalModel {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "local_model",
      implementation: "OpenAILocalModel",
      contract_version: "1.0.0",
      features: {
        supports_streaming: false,
        supports_token_count: false,
      },
    };
  }

  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: OpenAILocalModelConfig = {}) {
    const apiKey = config.apiKey ?? process.env["OPENAI_API_KEY"];
    if (apiKey === undefined || apiKey === "") {
      throw new Error("OpenAILocalModel: OPENAI_API_KEY env var or apiKey config field required.");
    }
    this.apiKey = apiKey;
    this.defaultModel = config.defaultModel ?? "gpt-4o-mini";
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.timeoutMs = config.timeoutMs ?? 60000;
  }

  async run(prompt: string, opts: { maxTokens?: number; model?: string }): Promise<string> {
    const model = opts.model ?? this.defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: prompt }],
    };
    if (opts.maxTokens !== undefined) body["max_tokens"] = opts.maxTokens;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`OpenAILocalModel: HTTP ${resp.status} — ${text.slice(0, 200)}`);
      }
      const json = await resp.json() as ChatCompletionsResponse;
      if (json.error !== undefined) {
        throw new Error(`OpenAILocalModel: API error — ${json.error.message ?? "unknown"}`);
      }
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("OpenAILocalModel: response missing choices[0].message.content");
      }
      return content;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async manifest(): Promise<ManifestInfo> {
    return {
      capabilities_version: "1",
      manifest: {
        kind: "openai-local-model",
        base_url: this.baseUrl,
        default_model: this.defaultModel,
      },
    };
  }
}
