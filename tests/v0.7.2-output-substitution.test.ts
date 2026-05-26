import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";

// v0.7.2 — ${VAR} substitution in # Output: target slot, resolved against
// compile-time inputs only (caller inputs + # Vars: defaults + # Requires:
// cascade). Runtime-bound refs (from $ op outputs) pass through verbatim —
// deferred per Scott's scoping decision.

describe("v0.7.2 — ${VAR} substitution in # Output: target slot", () => {
  it("resolves against caller-passed inputs", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Vars: TARGET_AGENT",
      "# Output: prompt-context: ${TARGET_AGENT}",
      "run:",
      "    emit(text=\"hi\")",
      "default: run",
      "",
    ].join("\n");
    const result = await compile(src, { inputs: { TARGET_AGENT: "oncall" } });
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]!.target).toBe("oncall");
    expect(result.outputs[0]!.kind).toBe("prompt-context");
  });

  it("resolves against # Vars: defaults", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Vars: TARGET_AGENT=oncall-default",
      "# Output: prompt-context: ${TARGET_AGENT}",
      "run:",
      "    emit(text=\"hi\")",
      "default: run",
      "",
    ].join("\n");
    const result = await compile(src);
    expect(result.outputs[0]!.target).toBe("oncall-default");
  });

  it("caller inputs override Vars defaults", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Vars: TARGET_AGENT=fallback-default",
      "# Output: prompt-context: ${TARGET_AGENT}",
      "run:",
      "    emit(text=\"hi\")",
      "default: run",
      "",
    ].join("\n");
    const result = await compile(src, { inputs: { TARGET_AGENT: "specific-agent" } });
    expect(result.outputs[0]!.target).toBe("specific-agent");
  });

  it("works for file: kind", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Vars: DATE=2026-05-25",
      "# Output: file: /var/reports/sweep-${DATE}.md",
      "run:",
      "    emit(text=\"hi\")",
      "default: run",
      "",
    ].join("\n");
    const result = await compile(src);
    expect(result.outputs[0]!.target).toBe("/var/reports/sweep-2026-05-25.md");
    expect(result.outputs[0]!.kind).toBe("file");
  });

  it("works for template: kind (v0.7.3: slack + card dropped from OutputKind)", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Vars: AGENT=oncall-tmpl",
      "# Output: template: ${AGENT}",
      "run:",
      "    emit(text=\"hi\")",
      "default: run",
      "",
    ].join("\n");
    const result = await compile(src);
    expect(result.outputs[0]!.target).toBe("oncall-tmpl");
    expect(result.outputs[0]!.kind).toBe("template");
  });

  it("legacy $(VAR) form also resolves (grace period)", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Vars: TARGET_AGENT=legacy-user",
      "# Output: prompt-context: $(TARGET_AGENT)",
      "run:",
      "    emit(text=\"hi\")",
      "default: run",
      "",
    ].join("\n");
    const result = await compile(src);
    expect(result.outputs[0]!.target).toBe("legacy-user");
  });

  it("unresolved ${VAR} passes through verbatim (runtime-bound refs deferred)", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Output: prompt-context: ${UNDEFINED_VAR}",
      "run:",
      "    emit(text=\"hi\")",
      "default: run",
      "",
    ].join("\n");
    const result = await compile(src);
    // Pass-through is the substitute() behavior for unresolved refs.
    // Documents the runtime-bound-refs-deferred decision: delivery layer
    // sees the literal template and fails clearly.
    expect(result.outputs[0]!.target).toBe("${UNDEFINED_VAR}");
  });

  it("default text output (no target) is unaffected", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "run:",
      "    emit(text=\"hi\")",
      "default: run",
      "",
    ].join("\n");
    const result = await compile(src);
    expect(result.outputs[0]!.kind).toBe("text");
    expect(result.outputs[0]!.target).toBeUndefined();
  });

  it("multiple # Output: declarations each get substituted", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Vars: A=alice, B=bob",
      "# Output: prompt-context: ${A}, file: /tmp/${B}.log",
      "run:",
      "    emit(text=\"hi\")",
      "default: run",
      "",
    ].join("\n");
    const result = await compile(src);
    expect(result.outputs).toHaveLength(2);
    const promptContext = result.outputs.find((o) => o.kind === "prompt-context");
    const file = result.outputs.find((o) => o.kind === "file");
    expect(promptContext?.target).toBe("alice");
    expect(file?.target).toBe("/tmp/bob.log");
  });
});
