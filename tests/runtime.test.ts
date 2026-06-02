import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";
import { LocalModelMcpConnector } from "../src/connectors/local-model-mcp.js";
import type { LocalModel, StaticCapabilities, ManifestInfo } from "../src/connectors/types.js";

class SlowLocalModel implements LocalModel {
  static staticCapabilities(): StaticCapabilities {
    return { connector_type: "local_model", implementation: "SlowTestModel", contract_version: "1.0.0", features: {} };
  }
  constructor(private readonly delayMs: number) {}
  async run(_prompt: string): Promise<string> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return "ok";
  }
  async manifest(): Promise<ManifestInfo> {
    return { capabilities_version: "1", manifest: {} };
  }
}

function wireSlowLlmRegistry(delayMs: number): Registry {
  const localModel = new SlowLocalModel(delayMs);
  const registry = new Registry();
  registry.registerLocalModel("default", localModel);
  registry.registerMcpConnector("llm", new LocalModelMcpConnector(localModel));
  return registry;
}

async function run(source: string, inputs: Record<string, string> = {}, registry = new Registry()) {
  // Tests in this file exercise runtime behavior directly; bypass the
  // tier-1 lint preflight so test sources that intentionally violate
  // (out-of-scope vars, etc.) reach the runtime layer being tested.
  const compiled = await compile(source, { skipLintPreflight: true });
  return execute(compiled.parsed, { ...compiled.resolvedVariables, ...inputs }, compiled.targetOrder, { registry });
}

describe("runtime", () => {
  it("executes a simple skill end-to-end", async () => {
    const src = `# Skill: hello
# Vars: WHO=world

greet:
    emit(text="Hello, $(WHO)!")

default: greet
`;
    const result = await run(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["Hello, world!"]);
    expect(result.outputs["text"]).toBeDefined();
  });

  it("threads $set into substitutions", async () => {
    const src = `t:
    $set X = hello
    emit(text="$(X) world")

default: t
`;
    const result = await run(src);
    expect(result.emissions).toEqual(["hello world"]);
  });

  it("iterates foreach over bracket-list var", async () => {
    const src = `t:
    $set ITEMS = [a, b, c]
    foreach I in $(ITEMS):
        emit(text="item $(I)")

default: t
`;
    const result = await run(src);
    expect(result.emissions).toEqual(["item a", "item b", "item c"]);
  });

  it("foreach scope is loop-local", async () => {
    const src = `t:
    $set ITEMS = [x]
    foreach I in $(ITEMS):
        $set Y = inside
    emit(text="$(I)")

default: t
`;
    const result = await run(src);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toMatch(/Unresolved variable reference/);
  });

  it("evaluates if/elif/else", async () => {
    const src = `t:
    $set MODE = slow
    if $(MODE) == "fast":
        emit(text="fast path")
    elif $(MODE) == "slow":
        emit(text="slow path")
    else:
        emit(text="default")

default: t
`;
    const result = await run(src);
    expect(result.emissions).toEqual(["slow path"]);
  });

  it("executes `@` ops via structured-spawn sandbox", async () => {
    const src = `t:
    shell(command="echo hello")

default: t
`;
    const result = await run(src);
    expect(result.errors).toEqual([]);
    expect(result.finalVars["t.output"]).toBe("hello");
  });

  it("`@` op binds stdout to -> VAR", async () => {
    const src = `t:
    shell(command="echo skillscript") -> OUT
    emit(text="got $(OUT)")

default: t
`;
    const result = await run(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["got skillscript"]);
  });

  it("`@` op non-zero exit surfaces stderr in op-error", async () => {
    const src = `t:
    shell(command="false")

default: t
`;
    const result = await run(src);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.opKind).toBe("shell");
    expect(result.errors[0]!.message).toMatch(/exited with code/);
  });

  it("`@ unsafe` refused when enableUnsafeShell is false (default)", async () => {
    const src = `t:
    shell(command="echo \"should fail\"", unsafe=true)

default: t
`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toMatch(/enable_unsafe_shell.*false/);
  });

  it("`@ unsafe` runs via bash when enableUnsafeShell is true", async () => {
    const src = `t:
    shell(command="echo \"shell features: $$(echo hi)\"", unsafe=true)

default: t
`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      enableUnsafeShell: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.finalVars["t.output"]).toBe("shell features: hi");
  });

  it("`@` op timeout fires when child hangs", async () => {
    const src = `# Skill: t
# Timeout: 1
t:
    shell(command="sleep 5")

default: t
`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.opKind).toBe("shell");
    expect(result.errors[0]!.message).toMatch(/timed out after 1000ms/);
  });

  it("surfaces inner-tool isError:true as op error (c580de5)", async () => {
    // Error-propagation contract: when an inner MCP tool returns
    // {isError:true}, the runtime throws an op error rather than silently
    // binding the error text to the output var. Without this, skills mask
    // failures and continue.
    const registry = new Registry();
    registry.registerMcpConnector("backend", new CallbackMcpConnector(async () => ({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    })));
    const src = `t:
    $ backend.failing_tool arg=x

default: t
`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.opKind).toBe("$");
    expect(result.errors[0]!.message).toMatch(/isError:.*boom/);
  });

  it("unwraps CallToolResult content[0].text", async () => {
    const registry = new Registry();
    registry.registerMcpConnector("backend", new CallbackMcpConnector(async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, count: 3 }) }],
    })));
    const src = `t:
    $ backend.some_tool -> RESULT
    emit(text="$(RESULT.count)")

default: t
`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["3"]);
  });

  it("legacy `??` ask form is rejected with parse error (v0.16.0)", async () => {
    const src = `t:
    ?? "confirm" -> R

default: t
`;
    await expect(compile(src, { skipLintPreflight: true })).rejects.toThrow(/Legacy `\?\?`/);
  });

  it("`# Timeout:` skill header fires on slow `$ llm` op", async () => {
    const src = `# Skill: t
# Timeout: 1

t:
    $ llm prompt="hi" -> R

default: t
`;
    const registry = wireSlowLlmRegistry(3000);
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry,
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.opKind).toBe("$");
    expect(result.errors[0]!.message).toMatch(/timed out after 1000ms/);
  });

  it("per-op `timeout` kwarg overrides skill header", async () => {
    const src = `# Skill: t
# Timeout: 30

t:
    $ llm prompt="hi" timeout=1 -> R

default: t
`;
    const registry = wireSlowLlmRegistry(3000);
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry,
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toMatch(/timed out after 1000ms/);
  });

  it("`# Timeout: $(SECS)` substitution resolves at runtime (lesson ab6c19db)", async () => {
    const src = `# Skill: t
# Vars: TIMEOUT_SECS=1
# Timeout: $(TIMEOUT_SECS)

t:
    $ llm prompt="hi" -> R

default: t
`;
    const registry = wireSlowLlmRegistry(3000);
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry,
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toMatch(/timed out after 1000ms/);
  });

  it("absoluteTimeoutMs ctx override fires when no skill/op timeout present", async () => {
    const src = `t:
    $ llm prompt="hi" -> R

default: t
`;
    const registry = wireSlowLlmRegistry(3000);
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry,
      absoluteTimeoutMs: 500,
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toMatch(/timed out after 500ms/);
  });

  it("missing `llm` connector surfaces clean error", async () => {
    const src = `t:
    $ llm prompt="hi" -> R

default: t
`;
    const result = await run(src);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.opKind).toBe("$");
    expect(result.errors[0]!.class).toBe("ConnectorNotFoundError");
  });

  it("foreach over empty array → zero iterations, downstream OK", async () => {
    const src = `t:
    $set ITEMS = []
    foreach I in $(ITEMS):
        emit(text="item $(I)")
    emit(text="after loop")

default: t
`;
    const result = await run(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["after loop"]);
  });

  it("conditional false path → else branch fires, true body doesn't", async () => {
    const src = `t:
    $set MODE = no
    if $(MODE) == "yes":
        emit(text="ran-true")
    else:
        emit(text="ran-else")

default: t
`;
    const result = await run(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions).toEqual(["ran-else"]);
  });

  it("multiple skills with overlapping execution run independently (concurrency)", async () => {
    const src1 = `# Skill: a
a:
    $set X = first
    emit(text="a-emission")

default: a
`;
    const src2 = `# Skill: b
b:
    $set X = second
    emit(text="b-emission")

default: b
`;
    const [r1, r2] = await Promise.all([run(src1), run(src2)]);
    expect(r1.emissions).toEqual(["a-emission"]);
    expect(r2.emissions).toEqual(["b-emission"]);
    // No shared mutable state — each execution has its own vars Map.
    expect(r1.finalVars["X"]).toBe("first");
    expect(r2.finalVars["X"]).toBe("second");
  });

  it("ConnectorNotFoundError fires when McpConnector named explicitly isn't registered + carries remediation", async () => {
    const src = `t:
    $ unknown.some_tool key=value -> R

default: t
`;
    const result = await run(src);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.class).toBe("ConnectorNotFoundError");
    expect(result.errors[0]!.opKind).toBe("$");
    expect(result.errors[0]!.remediation).toMatch(/registry\.register/);
    expect(result.errors[0]!.remediation).toMatch(/spelling/);
  });

  it("OpTimeoutError fires + carries remediation for slow `$ llm` op", async () => {
    const src = `# Skill: t
# Timeout: 1
t:
    $ llm prompt="hi" -> R

default: t
`;
    const registry = wireSlowLlmRegistry(3000);
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry,
    });
    expect(result.errors[0]!.class).toBe("OpTimeoutError");
    expect(result.errors[0]!.remediation).toMatch(/timeoutSeconds|# Timeout:/);
  });

  it("UnsafeShellDisabledError fires when `@ unsafe` runs without enableUnsafeShell + carries remediation", async () => {
    const src = `t:
    shell(command="echo \"should fail\"", unsafe=true)

default: t
`;
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
    });
    expect(result.errors[0]!.class).toBe("UnsafeShellDisabledError");
    expect(result.errors[0]!.remediation).toMatch(/enableUnsafeShell = true|structured-spawn sandbox/);
  });

  it("ExecutionError shape locked: class + remediation + opKind + target + message", async () => {
    const src = `t:
    $ nonexistent.tool -> R

default: t
`;
    const result = await run(src);
    const err = result.errors[0]!;
    expect(typeof err.class).toBe("string");
    expect(typeof err.opKind).toBe("string");
    expect(typeof err.target).toBe("string");
    expect(typeof err.message).toBe("string");
    expect(typeof err.remediation).toBe("string");
  });

  it("mechanical mode skips $/~/> dispatch", async () => {
    const src = `t:
    $ would_dispatch x=1
    emit(text="after")

default: t
`;
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      mechanical: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toMatch(/Would call tool.*mechanical/);
  });
});
