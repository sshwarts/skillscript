/**
 * v0.25.0 — secret references (`{{secret.NAME}}`).
 *
 * A skill names a secret with `# Requires: secret.NAME` + a `{{secret.NAME}}`
 * placement marker. The runtime resolves the marker ONLY at a sink (a
 * `shell(...)` op or a `$ connector.tool` dispatch) and injects the value
 * use-only — it never binds to a var, emits, or lands in a trace. Distinct
 * from `${VAR}` readable substitution, which can't reach a secret.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvSecretProvider,
  SecretNotProvisionedError,
  hasSecretMarker,
  extractSecretRefs,
  expandSecretMarkers,
  SECRET_SINK_OP_KINDS,
} from "../src/secrets.js";
import { parse } from "../src/parser.js";
import { lint } from "../src/lint.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { substituteRuntime } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";
import { FilesystemTraceStore } from "../src/trace.js";

const SECRET_VALUE = "s3cr3t-bearer-AbC123";

// ─── resolver unit (src/secrets.ts) ─────────────────────────────────────────

describe("v0.25.0 — marker grammar helpers", () => {
  it("hasSecretMarker detects `{{secret.NAME}}` (whitespace-tolerant), ignores `${VAR}`", () => {
    expect(hasSecretMarker("Authorization: Bearer {{secret.TOKEN}}")).toBe(true);
    expect(hasSecretMarker("{{ secret.TOKEN }}")).toBe(true);
    expect(hasSecretMarker("${TOKEN}")).toBe(false);
    expect(hasSecretMarker("$(TOKEN)")).toBe(false);
    expect(hasSecretMarker("plain text")).toBe(false);
  });

  it("extractSecretRefs returns distinct names", () => {
    expect(extractSecretRefs("{{secret.A}} {{secret.B}} {{secret.A}}").sort()).toEqual(["A", "B"]);
    expect(extractSecretRefs("no markers")).toEqual([]);
  });

  it("SECRET_SINK_OP_KINDS is the shared sink list", () => {
    expect([...SECRET_SINK_OP_KINDS].sort()).toEqual(["$", "shell"]);
  });
});

describe("v0.25.0 — EnvSecretProvider", () => {
  it("resolves SKILLSCRIPT_SECRET_<NAME> from the env", async () => {
    const p = new EnvSecretProvider({ SKILLSCRIPT_SECRET_TOKEN: SECRET_VALUE });
    expect(await p.resolve("TOKEN", {})).toBe(SECRET_VALUE);
  });

  it("fails closed on a missing or empty secret (never returns empty)", async () => {
    const p = new EnvSecretProvider({ SKILLSCRIPT_SECRET_EMPTY: "" });
    await expect(p.resolve("MISSING", {})).rejects.toBeInstanceOf(SecretNotProvisionedError);
    await expect(p.resolve("EMPTY", {})).rejects.toBeInstanceOf(SecretNotProvisionedError);
  });

  it("the prefix scopes reachability — `{{secret.PATH}}` cannot read $PATH", async () => {
    // process.env.PATH exists, but the provider only reads SKILLSCRIPT_SECRET_PATH.
    const p = new EnvSecretProvider({ PATH: "/usr/bin:/bin" });
    await expect(p.resolve("PATH", {})).rejects.toBeInstanceOf(SecretNotProvisionedError);
  });
});

describe("v0.25.0 — expandSecretMarkers", () => {
  const provider = new EnvSecretProvider({ SKILLSCRIPT_SECRET_A: "AAA", SKILLSCRIPT_SECRET_B: "BBB" });

  it("replaces markers with resolved values", async () => {
    expect(await expandSecretMarkers("x {{secret.A}} y {{secret.B}}", provider, {})).toBe("x AAA y BBB");
  });

  it("returns markerless text unchanged (cheap no-op)", async () => {
    expect(await expandSecretMarkers("no markers here", provider, {})).toBe("no markers here");
  });

  it("fails closed when any referenced secret is unprovisioned", async () => {
    await expect(expandSecretMarkers("{{secret.MISSING}}", provider, {})).rejects.toBeInstanceOf(
      SecretNotProvisionedError,
    );
  });
});

describe("v0.25.0 — ${VAR} substitution never touches a secret marker", () => {
  it("substituteRuntime leaves `{{secret.X}}` an inert literal (use-only guarantee)", () => {
    const vars = new Map<string, unknown>([["TOKEN", "readable-value"]]);
    // The marker is NOT a readable ref: it survives substitution verbatim, so
    // a marker that slips onto an emit/$set surface never yields a value.
    expect(substituteRuntime("{{secret.TOKEN}}", vars)).toBe("{{secret.TOKEN}}");
    expect(substituteRuntime("${TOKEN}", vars)).toBe("readable-value");
  });
});

// ─── parser (# Requires: secret.NAME) ────────────────────────────────────────

describe("v0.25.0 — parser recognizes `# Requires: secret.NAME`", () => {
  it("collects secret names into secretRequires", () => {
    const p = parse(["# Skill: s", "# Requires: secret.TOKEN", "", "default: t", "t:", "    emit hi"].join("\n"));
    expect(p.secretRequires).toEqual(["TOKEN"]);
  });

  it("mixes secret + capability tokens on one line", () => {
    const p = parse(
      ["# Skill: s", "# Requires: secret.TOKEN ddg.search", "", "default: t", "t:", "    emit hi"].join("\n"),
    );
    expect(p.secretRequires).toEqual(["TOKEN"]);
    expect(p.requiredCapabilities).toContain("ddg.search");
  });
});

// ─── lint rules ──────────────────────────────────────────────────────────────

function ruleIds(findings: { rule: string }[]): string[] {
  return findings.map((f) => f.rule);
}

describe("v0.25.0 — secret-undeclared lint rule", () => {
  it("fires tier-1 when a marker is used without `# Requires: secret.NAME`", async () => {
    const src = [
      "# Skill: s",
      "# Status: Draft",
      "",
      "default: t",
      "t:",
      '    shell(command="printf %s {{secret.TOKEN}}") -> OUT',
    ].join("\n");
    const r = await lint(src, { shellAllowlist: ["printf"] });
    const f = r.findings.find((x) => x.rule === "secret-undeclared");
    expect(f?.severity).toBe("error");
  });

  it("does not fire when the secret is declared", async () => {
    const src = [
      "# Skill: s",
      "# Requires: secret.TOKEN",
      "# Status: Draft",
      "",
      "default: t",
      "t:",
      '    shell(command="printf %s {{secret.TOKEN}}") -> OUT',
    ].join("\n");
    const r = await lint(src, { shellAllowlist: ["printf"] });
    expect(ruleIds(r.findings)).not.toContain("secret-undeclared");
  });
});

describe("v0.25.0 — secret-use-only lint rule", () => {
  const decl = ["# Skill: s", "# Requires: secret.TOKEN", "# Status: Draft", ""];

  it("allows a marker inside a shell sink", async () => {
    const src = [...decl, "default: t", "t:", '    shell(command="printf %s {{secret.TOKEN}}") -> OUT'].join("\n");
    const r = await lint(src, { shellAllowlist: ["printf"] });
    expect(ruleIds(r.findings)).not.toContain("secret-use-only");
  });

  it("fires tier-1 when a marker appears in emit", async () => {
    const src = [...decl, "default: t", "t:", '    emit(text="{{secret.TOKEN}}")'].join("\n");
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "secret-use-only");
    expect(f?.severity).toBe("error");
  });

  // Adopter finding 24ce83f8 — a marker in a malformed `emit {{secret.X}}`
  // (no parens) parses to no op, so the AST scan missed it; the source-level
  // backstop catches it.
  it("fires tier-1 for a marker in a malformed/dropped op line (bare emit, source backstop)", async () => {
    const src = [...decl, "default: t", "t:", "    emit {{secret.TOKEN}}"].join("\n");
    const r = await lint(src);
    expect(ruleIds(r.findings)).toContain("secret-use-only");
  });

  it("does not double-fire secret-use-only for a proper emit(text=...) marker", async () => {
    const src = [...decl, "default: t", "t:", '    emit(text="{{secret.TOKEN}}")'].join("\n");
    const r = await lint(src);
    expect(r.findings.filter((f) => f.rule === "secret-use-only").length).toBe(1);
  });

  it("fires tier-1 when a marker appears in $set", async () => {
    const src = [...decl, "default: t", "t:", "    $set X = {{secret.TOKEN}}", "    emit done"].join("\n");
    const r = await lint(src);
    expect(ruleIds(r.findings)).toContain("secret-use-only");
  });

  it("fires tier-1 when a marker appears in the body-text output template", async () => {
    const src = ["# Skill: s", "# Requires: secret.TOKEN", "# Status: Draft", "", "Token is {{secret.TOKEN}}"].join(
      "\n",
    );
    const r = await lint(src);
    expect(ruleIds(r.findings)).toContain("secret-use-only");
  });

  it("fires tier-1 when a marker is passed to the `$ execute_skill` built-in (not a real sink)", async () => {
    const src = [...decl, "default: t", "t:", '    $ execute_skill name="child" key={{secret.TOKEN}}'].join("\n");
    const r = await lint(src);
    expect(ruleIds(r.findings)).toContain("secret-use-only");
  });
});

// ─── e2e: resolution at the sink, value never exposed ────────────────────────

const SHELL_SKILL = [
  "# Skill: secret-shell",
  "# Requires: secret.TOKEN",
  "# Status: Draft",
  "",
  "default: run",
  "run:",
  '    shell(command="printf %s {{secret.TOKEN}}") -> OUT',
].join("\n");

describe("v0.25.0 — e2e: shell sink resolves the secret, value stays off readable surfaces", () => {
  it("resolves `{{secret.TOKEN}}` at the shell sink from SKILLSCRIPT_SECRET_TOKEN", async () => {
    const compiled = await compile(SHELL_SKILL);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      effectsAuthorized: true,
      shellAllowlist: ["printf"],
      secretProvider: new EnvSecretProvider({ SKILLSCRIPT_SECRET_TOKEN: SECRET_VALUE }),
    });
    // The sink received the real value (printf echoed it back into OUT).
    expect(result.finalVars["OUT"]).toBe(SECRET_VALUE);
    expect(result.errors).toEqual([]);
  });

  it("records the MARKER form in the trace, never the resolved value", async () => {
    // Use a sink that consumes the secret without echoing it to stdout (the
    // realistic case — a credential header, not a value the skill prints). A
    // skill that deliberately `printf`s its own secret would, of course, put
    // the value in its own output; the use-only guarantee is about the marker.
    const NONECHO = [
      "# Skill: secret-noecho",
      "# Requires: secret.TOKEN",
      "# Status: Draft",
      "",
      "default: run",
      "run:",
      '    shell(command="true {{secret.TOKEN}}") -> OUT',
    ].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "v0.25.0-trace-"));
    try {
      const traceStore = new FilesystemTraceStore(join(dir, "traces"));
      const compiled = await compile(NONECHO);
      await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
        registry: new Registry(),
        effectsAuthorized: true,
        shellAllowlist: ["true"],
        secretProvider: new EnvSecretProvider({ SKILLSCRIPT_SECRET_TOKEN: SECRET_VALUE }),
        trace: { mode: "on" },
        traceStore,
        skillVersion: "test",
      });
      const records = await traceStore.query({ skill_name: "secret-noecho" });
      expect(records.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(records);
      // The op body keeps the marker; the resolved value is nowhere in the trace.
      expect(serialized).toContain("{{secret.TOKEN}}");
      expect(serialized).not.toContain(SECRET_VALUE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the secret is not provisioned", async () => {
    const compiled = await compile(SHELL_SKILL);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      effectsAuthorized: true,
      shellAllowlist: ["printf"],
      secretProvider: new EnvSecretProvider({}), // TOKEN not set
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.errors)).toContain("not provisioned");
    // The marker was never sent to the sink as a literal credential.
    expect(result.finalVars["OUT"]).not.toBe("{{secret.TOKEN}}");
  });

  it("throws (no provider wired) rather than sending a literal marker to a sink", async () => {
    const compiled = await compile(SHELL_SKILL);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      effectsAuthorized: true,
      shellAllowlist: ["printf"],
      // no secretProvider
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.errors)).toContain("no secret provider");
  });
});

// ─── red-team regressions ────────────────────────────────────────────────────

describe("v0.25.0 — red-team regressions (Perry d8a5ad0a)", () => {
  // Bug A fix #3 — lint catches a dynamically-named marker at COMPILE.
  it("lint flags a dynamic/non-literal secret name (secret-dynamic-name, tier-1)", async () => {
    const src = [
      "# Skill: dyn",
      "# Requires: secret.FLAG",
      "# Status: Draft",
      "",
      "default: run",
      "run:",
      '    $set NM = "FLAG"',
      '    shell(command="printf %s {{secret.${NM}}}") -> OUT',
    ].join("\n");
    const r = await lint(src, { shellAllowlist: ["printf"] });
    const f = r.findings.find((x) => x.rule === "secret-dynamic-name");
    expect(f?.severity).toBe("error");
  });

  // Bug A fix #1 — substituteRuntime treats `{{secret.…}}` as OPAQUE: a dynamic
  // interior never gets built into a real marker, so even with lint bypassed the
  // value never resolves (the marker passes through as an inert literal).
  it("opaque marker: a dynamic interior never resolves at runtime (lint bypassed)", async () => {
    const src = [
      "# Skill: dyn-rt",
      "# Requires: secret.FLAG",
      "# Status: Draft",
      "",
      "default: run",
      "run:",
      '    $set NM = "FLAG"',
      '    shell(command="printf %s {{secret.${NM}}}") -> OUT',
    ].join("\n");
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      effectsAuthorized: true,
      shellAllowlist: ["printf"],
      secretProvider: new EnvSecretProvider({ SKILLSCRIPT_SECRET_FLAG: SECRET_VALUE }),
    });
    // The dynamic marker never became a real secret → value never appears.
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  // Edge 1 (Perry must-confirm) — var-smuggled marker text. A marker built
  // piecewise through $set/$append evades the literal-marker lint. Resolution
  // is STRICTLY sink-only, so the smuggled marker reaching an `emit` renders the
  // literal text, never the value.
  it("strictly sink-only: a var-smuggled marker reaching emit renders the literal, never the value", async () => {
    const src = [
      "# Skill: smuggle-emit",
      "# Requires: secret.FLAG",
      "# Status: Draft",
      "",
      "default: run",
      "run:",
      '    $set X = "{{sec"',
      '    $append X "ret.FLAG}}"',
      '    emit(text="smuggled=${X}")',
    ].join("\n");
    // Lint passes (the marker is never a literal in source); compile cleanly.
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      effectsAuthorized: true,
      shellAllowlist: ["printf"],
      secretProvider: new EnvSecretProvider({ SKILLSCRIPT_SECRET_FLAG: SECRET_VALUE }),
    });
    expect(result.emissions.join("\n")).toContain("smuggled={{secret.FLAG}}");
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  // Edge 1 (a) — a var-smuggled UNDECLARED name reaching a sink is refused by
  // the runtime backstop, regardless of how the marker text was assembled.
  it("runtime refuses a var-smuggled UNDECLARED marker at the sink", async () => {
    const src = [
      "# Skill: smuggle-undeclared",
      "# Status: Draft",
      "",
      "default: run",
      "run:",
      '    $set X = "{{sec"',
      '    $append X "ret.FLAG}}"',
      '    shell(command="printf %s ${X}") -> OUT',
      '    emit(text="got=${OUT}")',
    ].join("\n");
    const compiled = await compile(src); // lint can't see the smuggled marker
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      effectsAuthorized: true,
      shellAllowlist: ["printf"],
      secretProvider: new EnvSecretProvider({ SKILLSCRIPT_SECRET_FLAG: SECRET_VALUE }),
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.errors)).toContain("not declared");
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  // Bug A fix #2 — runtime declare-before-spend backstop: a static UNDECLARED
  // marker is refused at the sink even when lint is bypassed.
  it("runtime refuses a static UNDECLARED secret at the sink (lint bypassed)", async () => {
    const src = [
      "# Skill: undeclared-rt",
      "# Status: Draft",
      "",
      "default: run",
      "run:",
      '    shell(command="printf %s {{secret.FLAG}}") -> OUT',
    ].join("\n");
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      effectsAuthorized: true,
      shellAllowlist: ["printf"],
      secretProvider: new EnvSecretProvider({ SKILLSCRIPT_SECRET_FLAG: SECRET_VALUE }),
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.errors)).toContain("not declared");
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("a refused off-allowlist shell op shows the MARKER in its error, never the resolved value", async () => {
    const src = [
      "# Skill: refused-shell",
      "# Requires: secret.TOKEN",
      "# Status: Draft",
      "",
      "default: run",
      "run:",
      '    shell(command="nope {{secret.TOKEN}}") -> OUT',
    ].join("\n");
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      effectsAuthorized: true,
      shellAllowlist: ["printf"], // "nope" is refused
      secretProvider: new EnvSecretProvider({ SKILLSCRIPT_SECRET_TOKEN: SECRET_VALUE }),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("not in the operator's shell allowlist");
    // The error carries the marker, not the resolved credential.
    expect(serialized).not.toContain(SECRET_VALUE);
  });
});

describe("v0.25.0 — e2e: connector sink receives the resolved value", () => {
  it("injects the secret into a `$ conn.tool` arg, use-only", async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const registry = new Registry();
    registry.registerMcpConnector(
      "api",
      new CallbackMcpConnector(async (_tool, args) => {
        receivedArgs = args;
        return { ok: true };
      }),
    );
    const src = [
      "# Skill: secret-connector",
      "# Requires: secret.TOKEN",
      "# Status: Draft",
      "",
      "default: run",
      "run:",
      "    $ api.send authorization={{secret.TOKEN}} -> R",
    ].join("\n");
    const compiled = await compile(src);
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry,
      effectsAuthorized: true,
      secretProvider: new EnvSecretProvider({ SKILLSCRIPT_SECRET_TOKEN: SECRET_VALUE }),
    });
    expect(result.errors).toEqual([]);
    // The connector got the resolved value, not the marker.
    expect(receivedArgs?.["authorization"]).toBe(SECRET_VALUE);
  });
});
