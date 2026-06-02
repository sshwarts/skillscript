import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { LocalModelMcpConnector } from "../src/connectors/local-model-mcp.js";
import type { LocalModel, StaticCapabilities, ManifestInfo } from "../src/connectors/types.js";

// v0.16.2 P0 — `$ llm model="X"` was silently routing to default LocalModel
// across all model= values. Bridge held one LocalModel reference and passed
// `opts.model` as an upstream hint (interpreted by Ollama as a tag), not as
// a skillscript-registry alias. Fix: thread Registry into bridge; resolve
// `model=X` to `registry.getLocalModel(X)` and dispatch THAT instance.
//
// Three-test discipline per Perry: lint (v0.16.3 — `unknown-llm-model`),
// runtime (this file), e2e (also this file via model-distinguishing
// observable — each fake LocalModel returns its own identity tag).

// Identity-returning LocalModel — its response is its own name, so the
// test can distinguish which instance handled the request. This is the
// "model-distinguishing observable" Perry's framing called out — `/api/ps`
// equivalent for the in-process test environment.
class IdentityLocalModel implements LocalModel {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "local_model",
      implementation: "IdentityLocalModel",
      contract_version: "1.0.0",
      features: {},
    };
  }
  constructor(public readonly identity: string) {}
  async run(_prompt: string, _opts?: { maxTokens?: number; model?: string }): Promise<string> {
    return `from:${this.identity}`;
  }
  async manifest(): Promise<ManifestInfo> {
    return { capabilities_version: "1", manifest: { kind: "identity", identity: this.identity } };
  }
}

// Spies through the opts to confirm what the bridge passes to .run().
class SpyLocalModel implements LocalModel {
  public lastOpts: { maxTokens?: number; model?: string } | undefined = undefined;
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "local_model",
      implementation: "SpyLocalModel",
      contract_version: "1.0.0",
      features: {},
    };
  }
  constructor(public readonly identity: string) {}
  async run(_prompt: string, opts?: { maxTokens?: number; model?: string }): Promise<string> {
    this.lastOpts = opts;
    return `from:${this.identity}`;
  }
  async manifest(): Promise<ManifestInfo> {
    return { capabilities_version: "1", manifest: { kind: "spy", identity: this.identity } };
  }
}

describe("LocalModelMcpConnector model= registry resolution (v0.16.2 P0)", () => {
  it("resolves `model=qwen` to registered `qwen` LocalModel when registry threaded", async () => {
    const registry = new Registry();
    const defaultModel = new IdentityLocalModel("gemma");
    const qwenModel = new IdentityLocalModel("qwen");
    registry.registerLocalModel("default", defaultModel);
    registry.registerLocalModel("qwen", qwenModel);
    registry.registerMcpConnector("llm", new LocalModelMcpConnector(defaultModel, registry));

    const src = `# Skill: t
# Status: Approved
t:
    $ llm prompt="ping" model="qwen" -> R
    emit(text="\${R}")
default: t
`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["from:qwen"]);
  });

  it("falls through to default LocalModel when `model=` is unset", async () => {
    const registry = new Registry();
    const defaultModel = new IdentityLocalModel("gemma");
    const qwenModel = new IdentityLocalModel("qwen");
    registry.registerLocalModel("default", defaultModel);
    registry.registerLocalModel("qwen", qwenModel);
    registry.registerMcpConnector("llm", new LocalModelMcpConnector(defaultModel, registry));

    const src = `# Skill: t
# Status: Approved
t:
    $ llm prompt="ping" -> R
    emit(text="\${R}")
default: t
`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    expect(result.emissions).toEqual(["from:gemma"]);
  });

  it("does NOT forward `model=` to resolved LocalModel (it IS the target instance)", async () => {
    const registry = new Registry();
    const defaultSpy = new SpyLocalModel("gemma");
    const qwenSpy = new SpyLocalModel("qwen");
    registry.registerLocalModel("default", defaultSpy);
    registry.registerLocalModel("qwen", qwenSpy);
    registry.registerMcpConnector("llm", new LocalModelMcpConnector(defaultSpy, registry));

    const src = `# Skill: t\n# Status: Approved\nt:\n    $ llm prompt="ping" model="qwen" -> R\n    emit(text="\${R}")\ndefault: t\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    // qwen handled it; opts should NOT carry model=qwen (it's the target, not a hint).
    expect(qwenSpy.lastOpts?.model).toBeUndefined();
    // default was never called.
    expect(defaultSpy.lastOpts).toBeUndefined();
  });

  it("falls back to default + passes `model=` as upstream hint when alias doesn't resolve", async () => {
    const registry = new Registry();
    const defaultSpy = new SpyLocalModel("gemma");
    registry.registerLocalModel("default", defaultSpy);
    registry.registerMcpConnector("llm", new LocalModelMcpConnector(defaultSpy, registry));

    const src = `# Skill: t\n# Status: Approved\nt:\n    $ llm prompt="ping" model="qwen2.5-not-registered" -> R\n    emit(text="\${R}")\ndefault: t\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    // Default handled it; model= forwarded as upstream hint.
    expect(defaultSpy.lastOpts?.model).toBe("qwen2.5-not-registered");
  });

  it("back-compat: bridge constructed without registry passes `model=` as upstream hint", async () => {
    const registry = new Registry();
    const defaultSpy = new SpyLocalModel("gemma");
    registry.registerLocalModel("default", defaultSpy);
    // No registry argument — pre-v0.16.2 construction shape.
    registry.registerMcpConnector("llm", new LocalModelMcpConnector(defaultSpy));

    const src = `# Skill: t\n# Status: Approved\nt:\n    $ llm prompt="ping" model="something" -> R\n    emit(text="\${R}")\ndefault: t\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    expect(defaultSpy.lastOpts?.model).toBe("something");
  });

  it("e2e: model routing with maxTokens passes through correctly", async () => {
    const registry = new Registry();
    const defaultSpy = new SpyLocalModel("gemma");
    const qwenSpy = new SpyLocalModel("qwen");
    registry.registerLocalModel("default", defaultSpy);
    registry.registerLocalModel("qwen", qwenSpy);
    registry.registerMcpConnector("llm", new LocalModelMcpConnector(defaultSpy, registry));

    const src = `# Skill: t\n# Status: Approved\nt:\n    $ llm prompt="ping" model="qwen" maxTokens=128 -> R\n    emit(text="\${R}")\ndefault: t\n`;
    const compiled = await compile(src);
    await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    expect(qwenSpy.lastOpts?.maxTokens).toBe(128);
    expect(qwenSpy.lastOpts?.model).toBeUndefined();
  });
});
