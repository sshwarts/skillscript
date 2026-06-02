import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";

const HELLO = `# Skill: hello
# Description: greeting
# Vars: WHO=world

greet:
    emit(text="Hello, $(WHO)!")

default: greet
`;

describe("compile", () => {
  it("resolves declared default vars", async () => {
    const result = await compile(HELLO);
    expect(result.skillName).toBe("hello");
    expect(result.resolvedVariables).toEqual({ WHO: "world" });
    expect(result.targetOrder).toEqual(["greet"]);
    expect(result.output).toContain("Tell the user: Hello, world!");
  });

  it("caller input overrides declared default", async () => {
    const result = await compile(HELLO, { inputs: { WHO: "Scott" } });
    expect(result.resolvedVariables["WHO"]).toBe("Scott");
    expect(result.output).toContain("Hello, Scott!");
  });

  it("missing required input fails compile", async () => {
    const src = `# Skill: req
# Vars: NAME

t:
    emit(text="hi $(NAME)")

default: t
`;
    await expect(compile(src)).rejects.toThrow(/Missing required variables: NAME/);
  });

  it("renders prose format", async () => {
    const result = await compile(HELLO, { format: "prose" });
    expect(result.format).toBe("prose");
    expect(result.output).toContain("# hello");
    expect(result.output).toContain("Reports back to the user");
  });

  it("warns on orphan targets", async () => {
    const src = `a:
    emit(text="a")

orphan:
    emit(text="never reached")

default: a
`;
    const result = await compile(src);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/orphan/);
  });

  it("rejects skills with parse errors via lint preflight", async () => {
    const src = `t:
    if $(A) && $(B):
        emit(text="both")

default: t
`;
    // Lint preflight catches parse errors via the `parse-error` rule
    // (and the more specific `invalid-conditional-syntax` rule). Throws
    // LintFailureError, not the legacy generic error.
    await expect(compile(src)).rejects.toThrow(/Tier-1 lint failure/);
  });
});
