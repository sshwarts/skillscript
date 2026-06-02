import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";
import { Registry } from "../src/connectors/registry.js";
import type { LocalModel, ManifestInfo, StaticCapabilities } from "../src/connectors/types.js";

/**
 * v0.16.4 — `unknown-llm-model` lint.
 *
 * Tier-2 warning: `$ llm model="X"` where X matches neither any registered
 * LocalModel alias nor any model in any registered LocalModel's
 * `manifest().models_available`. Sharpened by the v0.16.3 manifest exposure —
 * the lint now has substrate-aware source of truth (not just alias names).
 *
 * Three-test discipline applied per `feedback_three_test_discipline_per_dispatch_shape`:
 *   - lint test (this file): malformed model values flagged across alias/
 *     manifest sources, including the variable-substitution skip case
 *   - runtime test (existing `tests/local-model-mcp-model-routing.test.ts`):
 *     happy-path routing dispatches to the right substrate
 *   - e2e (existing `tests/v0.16.3-manifest-exposure.test.ts`): manifest
 *     payload surfaces the data the lint keys on
 */

class IdentityLocalModel implements LocalModel {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "local_model",
      implementation: "IdentityLocalModel",
      contract_version: "1.0.0",
      features: {},
    };
  }
  constructor(
    private readonly modelTag: string,
    private readonly availableModels?: string[],
  ) {}
  async run(): Promise<string> { return ""; }
  async manifest(): Promise<ManifestInfo<"local_model">> {
    return {
      capabilities_version: "1",
      manifest: {
        kind: "identity",
        default_model: this.modelTag,
        endpoint: "test://identity",
        ...(this.availableModels !== undefined ? { models_available: this.availableModels } : {}),
      },
    };
  }
}

const llmSkill = (modelValue: string): string => `# Skill: probe
# Status: Draft
t:
    $ llm prompt="hi" model=${modelValue}
default: t
`;

describe("v0.16.4 — unknown-llm-model lint", () => {
  it("fires when model='X' matches no alias and no models_available entry", async () => {
    const registry = new Registry();
    registry.registerLocalModel("qwen", new IdentityLocalModel("qwen2.5:7b", ["qwen2.5:7b"]));

    const result = await lint(llmSkill('"bogus-model"'), { registry });
    const finding = result.findings.find((f) => f.rule === "unknown-llm-model");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain("bogus-model");
    expect(finding!.message).toContain("qwen");
    expect(finding!.extras?.["referenced_model"]).toBe("bogus-model");
  });

  it("clean when model='X' matches a registered alias name", async () => {
    const registry = new Registry();
    registry.registerLocalModel("qwen", new IdentityLocalModel("qwen2.5:7b", ["qwen2.5:7b"]));

    const result = await lint(llmSkill('"qwen"'), { registry });
    const finding = result.findings.find((f) => f.rule === "unknown-llm-model");
    expect(finding).toBeUndefined();
  });

  it("clean when model='X' matches an underlying models_available entry (substrate-aware)", async () => {
    const registry = new Registry();
    // Manifest exposes `qwen2.5:7b` as available even though it's not an alias.
    // Author can write `model="qwen2.5:7b"` directly and the lint trusts the
    // substrate's reported model surface.
    registry.registerLocalModel("primary", new IdentityLocalModel("gpt-4o", ["gpt-4o", "qwen2.5:7b", "gemma2:9b"]));

    const result = await lint(llmSkill('"qwen2.5:7b"'), { registry });
    const finding = result.findings.find((f) => f.rule === "unknown-llm-model");
    expect(finding).toBeUndefined();
  });

  it("clean when model value is a variable substitution (not a static literal)", async () => {
    const registry = new Registry();
    registry.registerLocalModel("primary", new IdentityLocalModel("gpt-4o"));

    const result = await lint(llmSkill('"${MODEL_TAG}"'), { registry });
    const finding = result.findings.find((f) => f.rule === "unknown-llm-model");
    expect(finding).toBeUndefined();
  });

  it("silent when no registry is supplied (caller doesn't know what's wired)", async () => {
    const result = await lint(llmSkill('"any-model-at-all"'));
    const finding = result.findings.find((f) => f.rule === "unknown-llm-model");
    expect(finding).toBeUndefined();
  });

  it("silent when registry has no LocalModels registered (but supplied) — known set is empty + lint reports it honestly", async () => {
    const registry = new Registry();
    // No LocalModels registered. Lint surfaces the situation but doesn't crash.
    const result = await lint(llmSkill('"x"'), { registry });
    const finding = result.findings.find((f) => f.rule === "unknown-llm-model");
    expect(finding).toBeDefined();
    expect(finding!.message).toContain("no LocalModels registered");
  });

  it("explicit localModelAliases override skips manifest probe (faster path for caller-supplied data)", async () => {
    const result = await lint(llmSkill('"alpha"'), {
      localModelAliases: ["alpha", "beta"],
      localModelsAvailable: ["alpha-7b", "beta-13b"],
    });
    const finding = result.findings.find((f) => f.rule === "unknown-llm-model");
    expect(finding).toBeUndefined();
  });

  it("degrades gracefully when an instance's manifest() throws — falls back to alias-only validation", async () => {
    class ThrowingManifestLocalModel implements LocalModel {
      static staticCapabilities(): StaticCapabilities {
        return {
          connector_type: "local_model",
          implementation: "ThrowingManifestLocalModel",
          contract_version: "1.0.0",
          features: {},
        };
      }
      async run(): Promise<string> { return ""; }
      async manifest(): Promise<ManifestInfo<"local_model">> {
        throw new Error("substrate unreachable at lint time");
      }
    }
    const registry = new Registry();
    registry.registerLocalModel("broken", new ThrowingManifestLocalModel());

    // Alias 'broken' still resolves (sync from listLocalModels()); models_available
    // probe silently degrades. `model="broken"` is clean.
    const ok = await lint(llmSkill('"broken"'), { registry });
    expect(ok.findings.find((f) => f.rule === "unknown-llm-model")).toBeUndefined();

    // Typo'd `model="brokn"` still fires — the lint isn't disabled by the
    // manifest-probe failure.
    const fail = await lint(llmSkill('"brokn"'), { registry });
    const finding = fail.findings.find((f) => f.rule === "unknown-llm-model");
    expect(finding).toBeDefined();
    expect(finding!.extras?.["referenced_model"]).toBe("brokn");
  });

  it("does not fire on non-llm $ ops (rule scoped to op.mcpConnector === 'llm')", async () => {
    const registry = new Registry();
    registry.registerLocalModel("qwen", new IdentityLocalModel("qwen2.5:7b"));

    const source = `# Skill: probe
# Status: Draft
t:
    $ amp.amp_query_memories query="x" model="bogus"
default: t
`;
    const result = await lint(source, { registry });
    const finding = result.findings.find((f) => f.rule === "unknown-llm-model");
    expect(finding).toBeUndefined();
  });

  it("dedupes findings — repeated identical model= typos in the same target produce one finding", async () => {
    const registry = new Registry();
    registry.registerLocalModel("qwen", new IdentityLocalModel("qwen2.5:7b"));

    const source = `# Skill: probe
# Status: Draft
t:
    $ llm prompt="a" model="typo"
    $ llm prompt="b" model="typo"
    $ llm prompt="c" model="typo"
default: t
`;
    const result = await lint(source, { registry });
    const findings = result.findings.filter((f) => f.rule === "unknown-llm-model");
    expect(findings.length).toBe(1);
  });
});

