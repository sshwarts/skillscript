import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../src/parser.js";
import { execute } from "../src/runtime.js";
import { compile } from "../src/compile.js";
import { lint } from "../src/lint.js";
import { Registry } from "../src/connectors/registry.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * v0.19.4 — body-text-as-output template ring (memory `c7ddfc50`).
 *
 * Coverage:
 *   1. Parser — outputTemplate extraction with Pin 4 disambiguation
 *   2. Pin 4 — content-after-colon stays template; bare `word:` ambiguous
 *   3. Migration — existing deps-form skills still parse as targets
 *   4. Runtime — template renders + populates canonical output
 *   5. Complementary channels — emit() feeds transcript when template present
 *   6. # Output: kind × template-present matrix
 *   7. Lint — unset-template-var (tier-1)
 *   8. Lint — template-looks-like-target (tier-2)
 *   9. Lint — body-template-detected (tier-3)
 *  10. Lint — emit-with-template (tier-3)
 *  11. e2e — compile + execute + dispatch through canonical output
 */

const APPROVED = "# Status: Approved";

// ────────────────────────────────────────────────────────────────────────
// 1. Parser — outputTemplate extraction
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.4 parser — outputTemplate extraction", () => {
  it("extracts a single-line interpolating template", () => {
    const src = `# Skill: hello
# Vars: WHO=world

Hello, \${WHO}!

greet:
    emit(text="ignored")
default: greet
`;
    const p = parse(src);
    expect(p.outputTemplate).toBe("Hello, ${WHO}!");
    expect(p.parseErrors).toEqual([]);
  });

  it("preserves internal blanks; trims leading + trailing blanks", () => {
    const src = `# Skill: multi
# Vars: A="x", B="y"

\${A} first.

\${B} second.

run:
    emit(text="t")
default: run
`;
    const p = parse(src);
    expect(p.outputTemplate).toBe("${A} first.\n\n${B} second.");
  });

  it("returns null when no body text is present (legacy emit-only path)", () => {
    const src = `# Skill: emit-only
# Vars: NAME=world

run:
    emit(text="Hello, \${NAME}!")
default: run
`;
    const p = parse(src);
    expect(p.outputTemplate).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2. Pin 4 disambiguation — content-after-colon stays template
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.4 parser — Pin 4 disambiguation", () => {
  it("content-after-colon (no op-block) stays template, not target", () => {
    const src = `# Skill: foo

Summary: today is hot.
Temp: \${T}

run:
    $set T = "85"
default: run
`;
    const p = parse(src);
    expect(p.outputTemplate).toBe("Summary: today is hot.\nTemp: ${T}");
    expect([...p.targets.keys()]).toEqual(["run"]);
  });

  it("bare `word:` alone in template region records ambiguity for lint", () => {
    const src = `# Skill: foo

Note:
Temp: \${T}

run:
    $set T = "85"
default: run
`;
    const p = parse(src);
    expect(p.outputTemplate).toContain("Note:");
    expect(p.templateAmbiguousLines).toEqual([3]);
  });

  it("bare `name:` followed by indented op-block IS a target", () => {
    const src = `# Skill: foo

fetch:
    shell(command="ls") -> RAW
default: fetch
`;
    const p = parse(src);
    expect(p.outputTemplate).toBeNull();
    expect([...p.targets.keys()]).toEqual(["fetch"]);
  });

  it("default: declaration exits template region without itself being template", () => {
    const src = `# Skill: foo

Body text.

default: run

run:
    emit(text="ok")
`;
    const p = parse(src);
    expect(p.outputTemplate).toBe("Body text.");
    expect(p.entryTarget).toBe("run");
  });
});

// ────────────────────────────────────────────────────────────────────────
// 3. Migration — existing deps-form skills still parse as targets
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.4 parser — migration safety", () => {
  it("`target: dep` form preserved when followed by indented op-block (lookahead)", () => {
    const src = `# Skill: morning

fetch_me:
    $ youtrack.get_current_user -> ME
fetch_issues: fetch_me
    $ youtrack.search_issues query="for: me" -> RAW
default: fetch_issues
`;
    const p = parse(src);
    expect(p.outputTemplate).toBeNull();
    expect([...p.targets.keys()]).toEqual(["fetch_me", "fetch_issues"]);
    expect(p.targets.get("fetch_issues")?.deps).toEqual(["fetch_me"]);
  });

  it("`needs:` keyword form preserved", () => {
    const src = `# Skill: needs-form

a:
    $set A = "1"
b: needs: a
    $set B = "2"
default: b
`;
    const p = parse(src);
    expect(p.outputTemplate).toBeNull();
    expect(p.targets.get("b")?.deps).toEqual(["a"]);
  });

  it("top-level if/elif still raises a parse error (template guard didn't swallow)", () => {
    const src = `if $(X):
    emit(text="oops")

default: foo
`;
    const p = parse(src);
    expect(p.parseErrors[0]).toMatch(/only valid inside a target body/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 4. Runtime — template renders + populates canonical output
// ────────────────────────────────────────────────────────────────────────

const minimalCtx = () => ({
  agentId: "test-agent",
  registry: new Registry(),
});

describe("v0.19.4 runtime — template render to canonical output", () => {
  it("populates outputs.text with rendered template (default text kind)", async () => {
    const src = `# Skill: render
# Vars: NAME=world

Hello, \${NAME}!

greet:
    $set _ = "noop"
default: greet
`;
    const parsed = parse(src);
    const result = await execute(parsed, { NAME: "Scott" }, ["greet"], minimalCtx());
    expect(result.outputs.text).toBe("Hello, Scott!");
  });

  it("renders multi-line template with internal blanks", async () => {
    const src = `# Skill: ml
# Vars: A="foo", B="bar"

\${A} first.

\${B} second.

run:
    $set _ = "noop"
default: run
`;
    const parsed = parse(src);
    const result = await execute(parsed, {}, ["run"], minimalCtx());
    expect(result.outputs.text).toBe("foo first.\n\nbar second.");
  });

  it("renders template using $set-bound vars from compute block", async () => {
    const src = `# Skill: setbound
# Vars: ()

Bound: \${X}, derived: \${Y}.

run:
    $set X = "alpha"
    $set Y = "beta"
default: run
`;
    const parsed = parse(src);
    const result = await execute(parsed, {}, ["run"], minimalCtx());
    expect(result.outputs.text).toBe("Bound: alpha, derived: beta.");
  });

  it("preserves legacy emissions-array semantics when no template authored", async () => {
    // Legacy: outputs.text for default text-kind with no template +
    // no lastBoundVar falls to emissions.slice() — an ARRAY, not a
    // joined string. v0.19.4 preserves this exactly to avoid breaking
    // any existing consumer; template overrides this path only when
    // a template is authored.
    const src = `# Skill: legacy
# Vars: ()

run:
    emit(text="line one")
    emit(text="line two")
default: run
`;
    const parsed = parse(src);
    expect(parsed.outputTemplate).toBeNull();
    const result = await execute(parsed, {}, ["run"], minimalCtx());
    expect(result.outputs.text).toEqual(["line one", "line two"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 5. Complementary channels — emit() feeds transcript when template present
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.4 runtime — complementary channels", () => {
  it("template owns canonical output; emit() entries feed transcript only", async () => {
    const src = `# Skill: chan
# Vars: ()

Canonical: \${OUT}.

run:
    $set OUT = "final"
    emit(text="debug step 1")
    emit(text="debug step 2")
default: run
`;
    const parsed = parse(src);
    const result = await execute(parsed, {}, ["run"], minimalCtx());
    expect(result.outputs.text).toBe("Canonical: final.");
    // Transcript (emissions) continues to populate independently.
    expect(result.emissions).toEqual(["debug step 1", "debug step 2"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 6. # Output: kind × template-present matrix
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.4 runtime — # Output: kind × template matrix", () => {
  const mkSrc = (outputDecl: string) => `# Skill: matrix
# Vars: NAME=Anon
${outputDecl}

Hello, \${NAME}.

run:
    $set _ = "noop"
default: run
`;

  it("kind=text (default) populates outputs.text with template", async () => {
    const parsed = parse(mkSrc(""));
    const r = await execute(parsed, { NAME: "X" }, ["run"], minimalCtx());
    expect(r.outputs.text).toBe("Hello, X.");
  });

  it("kind=agent: <name> populates outputs['agent:<name>'] with template", async () => {
    const parsed = parse(mkSrc("# Output: agent: receiver"));
    const r = await execute(parsed, { NAME: "X" }, ["run"], minimalCtx());
    expect(r.outputs["agent:receiver"]).toBe("Hello, X.");
  });

  it("kind=template: <name> populates outputs['template:<name>'] with template", async () => {
    const parsed = parse(mkSrc("# Output: template: receiver"));
    const r = await execute(parsed, { NAME: "X" }, ["run"], minimalCtx());
    expect(r.outputs["template:receiver"]).toBe("Hello, X.");
  });

  it("kind=file: <path> populates outputs['file:<path>'] with template", async () => {
    const parsed = parse(mkSrc("# Output: file: /tmp/out.txt"));
    const r = await execute(parsed, { NAME: "X" }, ["run"], minimalCtx());
    expect(r.outputs["file:/tmp/out.txt"]).toBe("Hello, X.");
  });

  it("kind=none still populated by template (consumer ignores by convention)", async () => {
    const parsed = parse(mkSrc("# Output: none"));
    const r = await execute(parsed, { NAME: "X" }, ["run"], minimalCtx());
    expect(r.outputs.none).toBe("Hello, X.");
  });
});

// ────────────────────────────────────────────────────────────────────────
// 7. Lint — unset-template-var (tier-1)
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.4 lint — unset-template-var", () => {
  it("fires when template references undeclared var", async () => {
    const src = `${APPROVED}
# Skill: unset
# Vars: KNOWN=ok

Known: \${KNOWN}. Mystery: \${MYSTERY}.

run:
    $set _ = "noop"
default: run
`;
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "unset-template-var");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.message).toContain("MYSTERY");
  });

  it("does not fire for vars set via $set / -> binding", async () => {
    const src = `${APPROVED}
# Skill: setbound
# Vars: ()

Bound: \${X}, derived: \${Y}.

run:
    $set X = "1"
    $set Y = "2"
default: run
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "unset-template-var")).toBeUndefined();
  });

  it("does not fire for ambient refs (NOW, USER, ...)", async () => {
    const src = `${APPROVED}
# Skill: ambient
# Vars: ()

Ran at \${NOW} by \${USER}.

run:
    $set _ = "noop"
default: run
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "unset-template-var")).toBeUndefined();
  });

  it("dotted refs check the base var", async () => {
    const src = `${APPROVED}
# Skill: dotted
# Vars: ()

Result: \${R.field}.

run:
    $ execute_skill name="other" -> R
default: run
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "unset-template-var")).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// 8. Lint — template-looks-like-target (tier-2)
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.4 lint — template-looks-like-target", () => {
  it("fires on bare `<word>:` alone in template region", async () => {
    const src = `${APPROVED}
# Skill: ambig
# Vars: T="hot"

Note:
Temp: \${T}

run:
    $set _ = "noop"
default: run
`;
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "template-looks-like-target");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect((f!.extras as { line: number }).line).toBeGreaterThan(0);
  });

  it("does not fire when bare word: is followed by indented op-block (real target)", async () => {
    const src = `${APPROVED}
# Skill: clean
# Vars: ()

run:
    emit(text="ok")
default: run
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "template-looks-like-target")).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// 9. Lint — body-template-detected (tier-3)
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.4 lint — body-template-detected", () => {
  it("fires when template has no interpolations AND no text-consuming # Output:", async () => {
    const src = `${APPROVED}
# Skill: prose-by-accident
# Vars: ()

This is informal documentation, not output.

run:
    emit(text="real output")
default: run
`;
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "body-template-detected");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
  });

  it("does not fire when template has \${...} interpolations", async () => {
    const src = `${APPROVED}
# Skill: real-template
# Vars: NAME=world

Hello, \${NAME}.

run:
    $set _ = "noop"
default: run
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "body-template-detected")).toBeUndefined();
  });

  it("does not fire when skill declares # Output: text/agent/template/file", async () => {
    const src = `${APPROVED}
# Skill: explicit
# Vars: ()
# Output: text

Plain text confirms intent.

run:
    $set _ = "noop"
default: run
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "body-template-detected")).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// 10. Lint — emit-with-template (tier-3)
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.4 lint — emit-with-template", () => {
  it("fires when template AND emit() both present (silent channel-shift)", async () => {
    const src = `${APPROVED}
# Skill: mixed
# Vars: ()

Canonical: \${OUT}.

run:
    $set OUT = "final"
    emit(text="trace step 1")
default: run
`;
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "emit-with-template");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
  });

  it("does not fire when only template, no emit()", async () => {
    const src = `${APPROVED}
# Skill: template-only
# Vars: ()

Canonical: \${OUT}.

run:
    $set OUT = "final"
default: run
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "emit-with-template")).toBeUndefined();
  });

  it("does not fire when only emit(), no template", async () => {
    const src = `${APPROVED}
# Skill: emit-only
# Vars: ()

run:
    emit(text="hello")
default: run
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "emit-with-template")).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// 11. Cross-consumer interactions — surfaces I initially missed
// ────────────────────────────────────────────────────────────────────────
//
// New-field audit: ParsedSkill.outputTemplate is read by three more
// consumers besides runtime, each surfaced by the bundled-corpus migration
// rather than the dense new-surface tests above. These tests pin them
// so they don't regress.

describe("v0.19.4 — compile renderer surfaces template", () => {
  it("renderPrompt includes a 'Tell the user:' section with rendered template", async () => {
    const src = `${APPROVED}
# Skill: rendered-prompt
# Vars: WHO=world

Hello, \${WHO}!

run:
    $set _ = "noop"
default: run
`;
    const r = await compile(src);
    expect(r.output).toMatch(/Tell the user:[\s\S]*?Hello, world!/);
  });

  it("renderProse includes a '**Tells the user:**' line with rendered template", async () => {
    const src = `${APPROVED}
# Skill: rendered-prose
# Vars: WHO=world

Hello, \${WHO}!

run:
    $set _ = "noop"
default: run
`;
    const r = await compile(src, { format: "prose" });
    expect(r.output).toMatch(/Tells the user:.*Hello, world!/);
  });
});

describe("v0.19.4 — output-agent-target-no-emit recognizes template", () => {
  it("does NOT fire when skill has body template (template populates delivery)", async () => {
    const src = `${APPROVED}
# Skill: template-feeds-agent
# Vars: BRIEF=hello

# Output: agent: receiver

\${BRIEF}

run:
    $set _ = "noop"
default: run
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "output-agent-target-no-emit")).toBeUndefined();
  });

  it("still fires when skill has neither template nor emit on agent-bound output", async () => {
    const src = `${APPROVED}
# Skill: agent-no-content
# Vars: ()

# Output: agent: receiver

run:
    $set _ = "noop"
default: run
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "output-agent-target-no-emit")).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// 11b. Template-only skills (v0.19.5 hotfix — Perry's 9d0a5e7d)
// ────────────────────────────────────────────────────────────────────────
//
// Template-only skill = body template + `# Vars:` inputs + NO compute
// block. The original c7ddfc50 design said "strip the compute block →
// still a valid skill that emits the template." v0.19.4 shipped with
// three sites rejecting this: no-targets lint, compile.ts zero-targets
// guard, and compile.ts no-entry-target guard. Perry's dogfood caught
// it. These tests pin the template-only shape end-to-end.

describe("v0.19.5 — template-only skills (no compute block) are valid", () => {
  const minimalCtx = () => ({
    agentId: "test-agent",
    registry: new Registry(),
  });

  it("parser accepts template-only skill (targets.size === 0, outputTemplate set)", () => {
    const src = `# Skill: hello
# Vars: WHO=world

Hello, \${WHO}!
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    expect(p.targets.size).toBe(0);
    expect(p.outputTemplate).toBe("Hello, ${WHO}!");
  });

  it("no-targets lint does NOT fire when a template is present", async () => {
    const src = `${APPROVED}
# Skill: template-only
# Vars: WHO=world

Hello, \${WHO}!
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "no-targets")).toBeUndefined();
  });

  it("no-targets lint STILL fires when neither template nor target present", async () => {
    const src = `${APPROVED}
# Skill: empty
# Vars: ()
`;
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "no-targets");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
  });

  it("compile accepts template-only skill (no targets, no entry)", async () => {
    const src = `${APPROVED}
# Skill: template-only-compile
# Vars: WHO=world

Hello, \${WHO}!
`;
    const r = await compile(src, { inputs: { WHO: "Scott" } });
    expect(r.parsed.targets.size).toBe(0);
    expect(r.targetOrder).toEqual([]);
    expect(r.output).toMatch(/Tell the user:[\s\S]*?Hello, Scott!/);
  });

  it("runtime executes template-only skill end-to-end", async () => {
    const src = `# Skill: template-only-run
# Vars: WHO=world

Hello, \${WHO}!
`;
    const parsed = parse(src);
    const r = await execute(parsed, { WHO: "Perry" }, [], minimalCtx());
    expect(r.outputs.text).toBe("Hello, Perry!");
    expect(r.errors).toEqual([]);
  });

  it("bundled hello-world.skill.md is template-only after migration", () => {
    const src = readFileSync(
      join(REPO_ROOT, "examples", "skillscripts", "hello-world.skill.md"),
      "utf-8",
    );
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    expect(p.targets.size).toBe(0);
    expect(p.outputTemplate).toContain("Hello, ${WHO}!");
  });
});

// ────────────────────────────────────────────────────────────────────────
// 12. e2e — compile + execute + canonical output reaches caller
// ────────────────────────────────────────────────────────────────────────

describe("v0.19.4 e2e — compile + execute", () => {
  it("compile + execute renders template all the way to outputs.text", async () => {
    const src = `${APPROVED}
# Skill: e2e
# Vars: WHO=world

Hello, \${WHO}!

greet:
    $set _ = "noop"
default: greet
`;
    const compiled = await compile(src, { inputs: { WHO: "Perry" } });
    const r = await execute(compiled.parsed, { WHO: "Perry" }, compiled.targetOrder, minimalCtx());
    expect(r.outputs.text).toBe("Hello, Perry!");
    expect(r.errors).toEqual([]);
  });

  it("lint preflight blocks compile when template references undeclared var", async () => {
    const src = `${APPROVED}
# Skill: bad
# Vars: ()

Hello, \${MYSTERY}!

run:
    $set _ = "noop"
default: run
`;
    await expect(compile(src)).rejects.toThrow(/unset-template-var|MYSTERY/i);
  });
});
