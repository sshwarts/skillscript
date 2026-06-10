import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { execute } from "../src/runtime.js";
import { lint } from "../src/lint.js";
import { Registry } from "../src/connectors/registry.js";

/**
 * v0.19.11 — `shell(argv=[...])` explicit token-list dispatch.
 *
 * Closes Perry's `adc87d52` cold-author-safety finding: the safe path
 * for args-with-spaces was previously an obscure file-roundtrip trick;
 * the discoverable path (unsafe=true) had the injection surface — an
 * inverted safety gradient. argv form makes the safe path first-class.
 *
 * Coverage:
 *   1. Parser — argv parses as JSON array of strings
 *   2. Parser — mutex enforcement (argv + command, argv + unsafe)
 *   3. Parser — malformed argv (non-JSON, non-string elements, empty)
 *   4. Runtime — argv binary spawn with per-element substitution
 *   5. Runtime — argv preserves spaces in substituted values
 *   6. Runtime — argv binary allowlist applies to argv[0]
 *   7. Lint — shell-quoted-var-in-command fires on the foot-gun
 *   8. Lint — does NOT fire on argv mode / unsafe mode / literal quotes
 */

const APPROVED = "# Status: Approved";

describe("v0.19.11 — parser: argv form", () => {
  it("argv literal parses as string[] on the op", () => {
    const src = `# Skill: argv-basic
# Vars: (none)

run:
    shell(argv=["say", "-v", "Jamie", "hello"]) -> R
default: run
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    const op = p.targets.get("run")!.ops[0]!;
    expect(op.kind).toBe("shell");
    expect(op.argv).toEqual(["say", "-v", "Jamie", "hello"]);
    expect(op.body).toBe("");
    expect(op.outputVar).toBe("R");
  });

  it("argv + command both set → parse error (mutex)", () => {
    const src = `# Skill: mutex1
# Vars: (none)

run:
    shell(argv=["say"], command="echo hi") -> R
default: run
`;
    const p = parse(src);
    expect(p.parseErrors.some((e) => e.includes("mutually exclusive"))).toBe(true);
  });

  it("argv + unsafe=true → parse error (no shell to opt into)", () => {
    const src = `# Skill: mutex2
# Vars: (none)

run:
    shell(argv=["say"], unsafe=true) -> R
default: run
`;
    const p = parse(src);
    expect(p.parseErrors.some((e) => e.includes("does not compose with") && e.includes("unsafe"))).toBe(true);
  });

  it("malformed argv (non-JSON) → parse error", () => {
    const src = `# Skill: bad
# Vars: (none)

run:
    shell(argv=not-an-array) -> R
default: run
`;
    const p = parse(src);
    expect(p.parseErrors.some((e) => e.includes("isn't valid JSON"))).toBe(true);
  });

  it("argv with non-string element → parse error", () => {
    const src = `# Skill: bad2
# Vars: (none)

run:
    shell(argv=["bin", 42]) -> R
default: run
`;
    const p = parse(src);
    expect(p.parseErrors.some((e) => e.includes("array of strings"))).toBe(true);
  });

  it("argv=[] (empty) → parse error (need at least the binary)", () => {
    const src = `# Skill: empty
# Vars: (none)

run:
    shell(argv=[]) -> R
default: run
`;
    const p = parse(src);
    expect(p.parseErrors.some((e) => e.includes("at least one element"))).toBe(true);
  });
});

describe("v0.19.11 — runtime: argv dispatch", () => {
  const minimalCtx = () => ({
    agentId: "test-agent",
    registry: new Registry(),
    shellAllowlist: ["echo", "printf", "true", "false"],
  });

  it("argv spawns binary with literal token list", async () => {
    const src = `# Skill: argv-run
# Vars: (none)

run:
    shell(argv=["echo", "hello", "world"]) -> R
default: run
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], minimalCtx());
    expect(r.errors).toEqual([]);
    expect(r.finalVars["R"]).toBe("hello world");
  });

  it("argv substitution preserves spaces in the value (the safety win)", async () => {
    const src = `# Skill: argv-spaces
# Vars: GREETING="hello world from skill"

run:
    shell(argv=["echo", "\${GREETING}"]) -> R
default: run
`;
    const parsed = parse(src);
    const r = await execute(parsed, { GREETING: "hello world from skill" }, ["run"], minimalCtx());
    expect(r.errors).toEqual([]);
    // Critical assertion: the value lands as ONE arg, not split on spaces.
    expect(r.finalVars["R"]).toBe("hello world from skill");
  });

  it("argv substitution preserves value with embedded quote characters", async () => {
    const src = `# Skill: argv-quotes
# Vars: (none)

run:
    $set TRICKY = "Jamie's cat"
    shell(argv=["echo", "\${TRICKY}"]) -> R
default: run
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], minimalCtx());
    expect(r.errors).toEqual([]);
    // The single quote inside the value doesn't break argv mode (no
    // tokenizer involved). The structural command= path would mishandle this.
    expect(r.finalVars["R"]).toBe("Jamie's cat");
  });

  it("argv[0] enforces the shell allowlist (binary-scope gate intact)", async () => {
    const src = `# Skill: argv-denied
# Vars: (none)

run:
    shell(argv=["forbidden-binary", "arg"]) -> R
default: run
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], minimalCtx());
    // Runtime collects errors into errors[] rather than throwing —
    // the allowlist violation surfaces there.
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]!.message).toMatch(/forbidden-binary|allowlist|allowed/);
  });
});

describe("v0.19.11 — lint: shell-quoted-var-in-command", () => {
  it("fires on `'${VAR}'` inside structural shell command", async () => {
    const src = `${APPROVED}
# Skill: footgun
# Vars: TEXT="hello"

run:
    shell(command="echo '\${TEXT}'") -> R
default: run
`;
    const r = await lint(src, { shellAllowlist: ["echo"] });
    const f = r.findings.find((x) => x.rule === "shell-quoted-var-in-command");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.message).toMatch(/argv=/);
  });

  it('fires on `"${VAR}"` inside structural shell command', async () => {
    const src = `${APPROVED}
# Skill: footgun2
# Vars: TEXT="hello"

run:
    shell(command="echo \\"\${TEXT}\\"") -> R
default: run
`;
    const r = await lint(src, { shellAllowlist: ["echo"] });
    expect(r.findings.find((x) => x.rule === "shell-quoted-var-in-command")).toBeDefined();
  });

  it("does NOT fire on argv form (the safe alternative)", async () => {
    const src = `${APPROVED}
# Skill: argv-safe
# Vars: TEXT="hello"

run:
    shell(argv=["echo", "\${TEXT}"]) -> R
default: run
`;
    const r = await lint(src, { shellAllowlist: ["echo"] });
    expect(r.findings.find((x) => x.rule === "shell-quoted-var-in-command")).toBeUndefined();
  });

  it("does NOT fire on unsafe mode (bash handles quoting)", async () => {
    const src = `${APPROVED}
# Skill: unsafe-bash
# Vars: TEXT="hello"

run:
    shell(command="echo '\${TEXT}'", unsafe=true) -> R
default: run
`;
    const r = await lint(src, { shellAllowlist: ["bash"], enableUnsafeShell: true });
    expect(r.findings.find((x) => x.rule === "shell-quoted-var-in-command")).toBeUndefined();
  });

  it("does NOT fire on literal-quoted args without ${VAR} inside", async () => {
    const src = `${APPROVED}
# Skill: literal
# Vars: (none)

run:
    shell(command="echo 'hello world'") -> R
default: run
`;
    const r = await lint(src, { shellAllowlist: ["echo"] });
    expect(r.findings.find((x) => x.rule === "shell-quoted-var-in-command")).toBeUndefined();
  });
});
