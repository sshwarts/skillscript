/**
 * v1.0 runtime-semantics test battery — Lane (e): regression coverage to
 * hold the v0.19.12 frozen surface.
 *
 * Catalog test — every primitive in the frozen surface table gets at least
 * one execution test (not just compile/lint). Existing 1924-test surface is
 * heavy on parse/compile/lint; this file pins execute-and-assert-output for
 * each output kind + each shell call shape + body-template-as-output + the
 * fallback semantics.
 *
 * Failure here means the freeze cannot hold without code change. The single
 * command `pnpm vitest run tests/v1.0-*` runs this lane alongside the other
 * four (filters, numeric, composition, event-trigger) as the freeze battery.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";

const TEST_SHELL_ALLOWLIST = ["echo", "printf", "true", "false", "cat", "bash"];

async function run(source: string, inputs: Record<string, string> = {}, opts: { enableUnsafeShell?: boolean } = {}) {
  const compiled = await compile(source, { skipLintPreflight: true });
  return execute(compiled.parsed, { ...compiled.resolvedVariables, ...inputs }, compiled.targetOrder, {
    registry: new Registry(),
    shellAllowlist: TEST_SHELL_ALLOWLIST,
    enableUnsafeShell: opts.enableUnsafeShell ?? false,
  });
}

describe("v1.0 freeze — output kinds (five canonical)", () => {
  it("`# Output: text` (default) — bare-only, value flows through outputs.text", async () => {
    const src = `# Skill: t
# Status: Approved
# Output: text
run:
    emit(text="hello")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["hello"]);
    expect(r.outputs?.["text"]).toBe("hello");
  });

  it("`# Output: none` (default) — bare-only, side-effects-only skill runs cleanly", async () => {
    const src = `# Skill: t
# Status: Approved
# Output: none
run:
    emit(text="side-effect-only")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    // none kind doesn't populate outputs.text by convention; emissions still flow to transcript.
    expect(r.emissions).toEqual(["side-effect-only"]);
  });

  it("`# Output: agent: <name>` — agent-bound lifecycle hook target resolves", async () => {
    const src = `# Skill: t
# Status: Approved
# Output: agent: oncall
run:
    emit(text="briefing")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["briefing"]);
  });

  it("`# Output: agent: \\${VAR}` — Level-2 compile-time substitution", async () => {
    const src = `# Skill: t
# Status: Approved
# Vars: TARGET=ops
# Output: agent: \${TARGET}
run:
    emit(text="paged")
default: run
`;
    const r = await run(src, { TARGET: "ops" });
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["paged"]);
  });

  it("`# Output: template: <name>` — playbook lifecycle hook target resolves", async () => {
    const src = `# Skill: t
# Status: Approved
# Output: template: assistant
run:
    emit(text="recipe")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["recipe"]);
  });
});

describe("v1.0 freeze — body-text-as-output template (Pin 4)", () => {
  it("template renders with var interpolation when no target is needed", async () => {
    // Skill with no target body — the prose IS the output.
    const src = `# Skill: t
# Status: Approved
# Vars: WHO=world

Hello, \${WHO}!
`;
    const r = await run(src, { WHO: "perry" });
    expect(r.errors).toEqual([]);
    expect(r.outputs?.["text"]).toBe("Hello, perry!");
  });

  it("template + target body — template becomes canonical output, emit feeds transcript", async () => {
    const src = `# Skill: t
# Status: Approved
# Vars: COUNT=0

The count is \${COUNT}.

run:
    emit(text="transcript-entry")
default: run
`;
    const r = await run(src, { COUNT: "5" });
    expect(r.errors).toEqual([]);
    expect(r.outputs?.["text"]).toBe("The count is 5.");
    // emit() still populates transcript independently of the template output.
    expect(r.emissions).toContain("transcript-entry");
  });
});

describe("v1.0 freeze — shell() call shapes (three forms)", () => {
  it("shell(command=\"...\") — structural spawn, tokenization respects quotes", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    shell(command="echo hello") -> R
    emit(text="\${R|trim}")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["hello"]);
  });

  it("shell(argv=[...]) — explicit argv, each elem one token (no re-split)", async () => {
    const src = `# Skill: t
# Status: Approved
# Vars: MSG="hello world"
run:
    shell(argv=["echo", "\${MSG}"]) -> R
    emit(text="\${R|trim}")
default: run
`;
    const r = await run(src, { MSG: "hello world" });
    expect(r.errors).toEqual([]);
    // argv form keeps the whitespace-containing arg as one token, so echo
    // sees one arg "hello world" not two args "hello" and "world".
    expect(r.emissions).toEqual(["hello world"]);
  });

  it("shell(unsafe=true) — full shell evaluation with pipes/redirects (gated by enableUnsafeShell ctx)", async () => {
    const src = `# Skill: t
# Status: Approved
# Autonomous: true
run:
    shell(command="echo hello | cat", unsafe=true, approved="test") -> R
    emit(text="\${R|trim}")
default: run
`;
    const r = await run(src, {}, { enableUnsafeShell: true });
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["hello"]);
  });
});

describe("v1.0 freeze — (fallback:) op-trailer semantics", () => {
  it("shell() empty-stdout → (fallback: \"...\") fires", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    shell(command="printf \\"\\"") -> R (fallback: "DEFAULT")
    emit(text="\${R}")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["DEFAULT"]);
    expect(r.fallbacks.length).toBeGreaterThan(0);
  });

  it("shell() success with stdout → (fallback:) does NOT fire", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    shell(command="echo actual") -> R (fallback: "DEFAULT")
    emit(text="\${R|trim}")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["actual"]);
    expect(r.fallbacks).toEqual([]);
  });
});
