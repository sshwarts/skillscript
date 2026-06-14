import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/parser.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";

/**
 * v0.19.12 — Perry's `7395b8af` thread (two findings).
 *
 * Finding 1: runtime_capabilities.shellExecution claimed "any binary on
 * PATH may be invoked" but v0.18.8 default-deny allowlist was actually
 * enforced. Discovery surface contradicted enforcement. Now: surface
 * reports the actual allowlist + accurate description.
 *
 * Finding 2a: `|fallback:` template filter fired only on `undefined` —
 * empty string passed through. Now: empty-aware (string-after-trim,
 * empty-array, null/undefined), matching the $-op trailer semantic.
 *
 * Finding 2b: `(fallback:)` op-trailer on shell() silently no-oped.
 * Now: shell op honors fallback on throw OR empty stdout, matching
 * file_read's precedent.
 */

const APPROVED = "# Status: Approved";

async function callRuntimeCapabilities(server: McpServer, want?: string[]): Promise<Record<string, unknown>> {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "runtime_capabilities",
      arguments: want !== undefined ? { include: want } : {},
    },
  };
  const reply = await server.handle(req);
  const content = (reply.result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("v0.19.12 — runtime_capabilities.shellExecution accuracy", () => {
  it("reports allowlist as array when shellAllowlist is set", async () => {
    const home = mkdtempSync(join(tmpdir(), "v01912-"));
    try {
      const skillStore = new FilesystemSkillStore(join(home, "skills"));
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      const registry = new Registry();
      registry.registerSkillStore("primary", skillStore);
      const server = new McpServer({
        registry,
        skillStore,
        traceStore,
        shellAllowlist: ["curl", "git", "say"],
        enableUnsafeShell: false,
      });
      const caps = await callRuntimeCapabilities(server, ["shellExecution"]);
      const shell = caps["shellExecution"] as Record<string, unknown>;
      expect(shell["mode"]).toBe("structural-spawn");
      expect(shell["unsafe_enabled"]).toBe(false);
      expect(shell["allowlist"]).toEqual(["curl", "git", "say"]);
      // Description must not contain the pre-fix false claim
      expect(shell["description"]).not.toContain("any binary on PATH may be invoked");
      // Description should explain the gate + configuration paths
      expect(shell["description"]).toMatch(/operator-owned allowlist/);
      expect(shell["description"]).toMatch(/SKILLSCRIPT_SHELL_ALLOWLIST/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports default-deny string when shellAllowlist is unset", async () => {
    const home = mkdtempSync(join(tmpdir(), "v01912-"));
    try {
      const skillStore = new FilesystemSkillStore(join(home, "skills"));
      const traceStore = new FilesystemTraceStore(join(home, "traces"));
      const registry = new Registry();
      registry.registerSkillStore("primary", skillStore);
      const server = new McpServer({
        registry,
        skillStore,
        traceStore,
        // shellAllowlist intentionally omitted
      });
      const caps = await callRuntimeCapabilities(server, ["shellExecution"]);
      const shell = caps["shellExecution"] as Record<string, unknown>;
      expect(shell["allowlist"]).toMatch(/default-deny|unset/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("v0.19.12 — `|fallback:` filter is empty-aware", () => {
  const minimalCtx = () => ({
    agentId: "test-agent",
    registry: new Registry(),
    shellAllowlist: ["echo", "true", "printf"],
  });

  it("fires on undefined ref (legacy semantic preserved)", async () => {
    const src = `# Skill: undef
# Vars: (none)

run:
    $set _ = "noop"

Got: \${MISSING|fallback:"default"}.
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], minimalCtx());
    expect(r.outputs.text).toBe("Got: default.");
  });

  it("fires on empty string (the new v0.19.12 behavior)", async () => {
    const src = `# Skill: empty-str
# Vars: (none)

run:
    $set PRS = ""

Got: \${PRS|fallback:"no PRs"}.
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], minimalCtx());
    expect(r.outputs.text).toBe("Got: no PRs.");
  });

  it("fires on whitespace-only string (trimmed empty)", async () => {
    const src = `# Skill: ws-only
# Vars: (none)

run:
    $set PRS = "   \\n  "

Got: \${PRS|fallback:"fallback fired"}.
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], minimalCtx());
    expect(r.outputs.text).toBe("Got: fallback fired.");
  });

  it("does NOT fire on non-empty string (passes value through)", async () => {
    const src = `# Skill: non-empty
# Vars: (none)

run:
    $set PRS = "real value"

Got: \${PRS|fallback:"unused"}.
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], minimalCtx());
    expect(r.outputs.text).toBe("Got: real value.");
  });
});

describe("v0.19.12 — shell op honors (fallback: ...) trailer", () => {
  const ctxWithAllowlist = () => ({
    agentId: "test-agent",
    registry: new Registry(),
    shellAllowlist: ["true", "echo", "printf", "false"],
  });

  it("argv form: fallback fires when binary is not on allowlist (ShellBinaryNotAllowedError)", async () => {
    const src = `# Skill: argv-fallback-throw
# Vars: (none)

run:
    shell(argv=["forbidden-binary", "arg"]) -> R (fallback: "fallback value")
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], ctxWithAllowlist());
    expect(r.errors).toEqual([]);
    expect(r.fallbacks.length).toBe(1);
    expect(r.fallbacks[0]!.value).toBe("fallback value");
    expect(r.fallbacks[0]!.reason).toMatch(/argv failed|allowlist/);
    expect(r.finalVars["R"]).toBe("fallback value");
  });

  it("argv form: fallback fires when stdout is empty", async () => {
    const src = `# Skill: argv-fallback-empty
# Vars: (none)

run:
    shell(argv=["true"]) -> R (fallback: "empty stdout fallback")
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], ctxWithAllowlist());
    expect(r.errors).toEqual([]);
    expect(r.fallbacks.length).toBe(1);
    expect(r.fallbacks[0]!.reason).toMatch(/empty stdout/);
    expect(r.finalVars["R"]).toBe("empty stdout fallback");
  });

  it("command= form: fallback fires on disallowed binary", async () => {
    const src = `# Skill: cmd-fallback-throw
# Vars: (none)

run:
    shell(command="forbidden-binary --version") -> R (fallback: "binary missing")
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], ctxWithAllowlist());
    expect(r.errors).toEqual([]);
    expect(r.fallbacks.length).toBe(1);
    expect(r.finalVars["R"]).toBe("binary missing");
  });

  it("shell with no fallback + disallowed binary still throws (no silent swallow)", async () => {
    const src = `# Skill: no-fallback-throws
# Vars: (none)

run:
    shell(argv=["forbidden-binary", "arg"]) -> R
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], ctxWithAllowlist());
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]!.message).toMatch(/forbidden-binary|allowlist/);
  });

  it("Perry's scenario: gh-like-empty-stdout + fallback binds clean", async () => {
    // Reproduces the canonical `gh pr list` empty-stdout case Perry hit.
    // `true` is the test stand-in for any binary that legitimately produces
    // empty stdout. With fallback, the skill binds cleanly + template
    // renders without UnresolvedVariableError downstream.
    const src = `# Skill: gh-like
# Vars: (none)

PRs: \${PRS}

fetch:
    shell(argv=["true"]) -> PRS (fallback: "No current PRs.")
default: fetch
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["fetch"], ctxWithAllowlist());
    expect(r.errors).toEqual([]);
    expect(r.outputs.text).toBe("PRs: No current PRs.");
  });
});
