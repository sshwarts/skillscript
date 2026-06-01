import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "../src/mcp-server.js";
import { bootstrap } from "../src/bootstrap.js";

// v0.15.5 — regression test for the `enableUnsafeShell` ctx-threading bug
// (Perry thread adf47c0b). Pre-v0.15.5 `mcp-server.ts` built the
// execute_skill ExecuteContext with {registry, mechanical, recursionDepth}
// and never read `enableUnsafeShell` from McpServerDeps, so adopters who
// configured the runtime with `enableUnsafeShell: true` still had their
// `shell(unsafe=true)` ops refused when dispatched via execute_skill.
//
// Lint passed, compile passed, runtime_capabilities reported the flag —
// only the execute_skill dispatch path silently dropped it. Fifth instance
// of the discipline-only-contracts class.
//
// The test exercises the FULL execute_skill MCP path end-to-end (not just
// the lint/compile surfaces) — that's the gap pre-v0.15.5 patches missed.

describe("v0.15.5 — enableUnsafeShell is threaded into execute_skill ctx", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0155-unsafe-shell-ctx-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function buildServer(enableUnsafeShell: boolean): McpServer {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    return new McpServer({
      skillStore: wired.skillStore,
      registry: wired.registry,
      enableUnsafeShell,
    });
  }

  it("`shell(unsafe=true)` via execute_skill SUCCEEDS when enableUnsafeShell: true", async () => {
    const server = buildServer(true);
    await server.listTools().find((t) => t.name === "skill_write")!.handler({
      name: "needs-unsafe-shell",
      source: "# Skill: needs-unsafe-shell\n# Status: Approved\n# Autonomous: true\nrun:\n    shell(command=\"echo hello | tr 'a-z' 'A-Z'\", unsafe=true, approved=\"test\") -> R\n    emit(text=\"got: ${R|trim}\")\ndefault: run\n",
    });
    const result = await server.listTools().find((t) => t.name === "execute_skill")!.handler({
      name: "needs-unsafe-shell",
    }) as { transcript: string[]; errors: unknown[] };
    expect(result.errors).toEqual([]);
    expect(result.transcript.join("\n")).toMatch(/got: HELLO/);
  });

  it("`shell(unsafe=true)` via execute_skill REFUSES when enableUnsafeShell: false (defense-in-depth preserved)", async () => {
    const server = buildServer(false);
    await server.listTools().find((t) => t.name === "skill_write")!.handler({
      name: "needs-unsafe-shell-2",
      source: "# Skill: needs-unsafe-shell-2\n# Status: Approved\n# Autonomous: true\nrun:\n    shell(command=\"echo hello | cat\", unsafe=true, approved=\"test\") -> R\ndefault: run\n",
    });
    const result = await server.listTools().find((t) => t.name === "execute_skill")!.handler({
      name: "needs-unsafe-shell-2",
    }) as { errors: Array<{ class: string }> };
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.class).toBe("UnsafeShellDisabledError");
  });

  it("`shell(unsafe=true)` via execute_skill REFUSES when enableUnsafeShell unset (default-false posture preserved)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const server = new McpServer({
      skillStore: wired.skillStore,
      registry: wired.registry,
    });
    await server.listTools().find((t) => t.name === "skill_write")!.handler({
      name: "needs-unsafe-shell-3",
      source: "# Skill: needs-unsafe-shell-3\n# Status: Approved\n# Autonomous: true\nrun:\n    shell(command=\"echo hi | cat\", unsafe=true, approved=\"test\") -> R\ndefault: run\n",
    });
    const result = await server.listTools().find((t) => t.name === "execute_skill")!.handler({
      name: "needs-unsafe-shell-3",
    }) as { errors: Array<{ class: string }> };
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.class).toBe("UnsafeShellDisabledError");
  });
});
