import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { stampApprovalToken } from "../src/approval.js";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(ROOT, "dist", "cli.js");

function runCli(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; code: number } {
  const r = spawnSync("node", [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

describe("skillfile CLI", () => {
  it("prints usage on --help", () => {
    const r = runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage:/);
    expect(r.stdout).toMatch(/Commands:/);
    expect(r.stdout).toMatch(/^\s+init\s+Scaffold/m);
  });

  it("prints per-command help on `skillfile <cmd> --help`", () => {
    const r = runCli(["execute", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/skillfile execute — /);
    expect(r.stdout).toMatch(/Arguments:/);
    expect(r.stdout).toMatch(/Options:/);
    expect(r.stdout).toMatch(/Examples:/);
    expect(r.stdout).toMatch(/--input KEY=value/);
  });

  it("runs hello-world.skill end-to-end with bundled example", () => {
    const r = runCli(["execute", "examples/skillscripts/hello-world.skill.md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Hello, world!/);
  });

  it("threads --input overrides", () => {
    const r = runCli(["execute", "examples/skillscripts/hello-world.skill.md", "--input", "WHO=Scott"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Hello, Scott!/);
  });

  it("compile emits the rendered artifact", () => {
    const r = runCli(["compile", "examples/skillscripts/hello-world.skill.md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/# Skill: hello-world/);
    expect(r.stdout).toMatch(/Tell the user: Hello, world!/);
  });

  it("lint reports no findings on the bundled example", () => {
    const r = runCli(["lint", "examples/skillscripts/hello-world.skill.md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OK: no findings/);
  });

  it("init scaffolds the tree", () => {
    const home = mkdtempSync(resolve(tmpdir(), "skillscript-test-"));
    const r = runCli(["init"], { SKILLSCRIPT_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Initialized/);
    // hello-world.skill should be discoverable after init.
    const r2 = runCli(["execute", "examples/skillscripts/hello-world.skill.md"], { SKILLSCRIPT_HOME: home });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toMatch(/Hello, world!/);
  });

  it("run resolves data-skill references via the SkillStore (regression: cmdRun was skipping inline)", () => {
    // Dogfood-driven: a hand-authored skill with `& cc-voice` reference
    // was failing to execute via `skillfile run` because cmdRun wasn't
    // threading the SkillStore into compile(). The compile path was
    // already passing it; run had to be brought in line.
    const home = mkdtempSync(resolve(tmpdir(), "skillscript-test-"));
    runCli(["init"], { SKILLSCRIPT_HOME: home });
    // Write a data-skill and a caller that references it.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    fs.writeFileSync(path.join(home, "skills", "voice.skill.md"), stampApprovalToken(`# Skill: voice
# Status: Approved
# Type: data

t:
    ! be concise

default: t
`));
    fs.writeFileSync(path.join(home, "skills", "caller.skill.md"), stampApprovalToken(`# Skill: caller
# Status: Approved
t:
    & voice
    ! ok

default: t
`));
    const r = runCli(["execute", "caller"], { SKILLSCRIPT_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/be concise/);
    expect(r.stdout).toMatch(/ok/);
  });

  it("diagram emits mermaid graph for a multi-target skill", () => {
    const home = mkdtempSync(resolve(tmpdir(), "skillscript-test-"));
    runCli(["init"], { SKILLSCRIPT_HOME: home });
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    fs.writeFileSync(path.join(home, "skills", "multi.skill.md"), `# Skill: multi
a:
    ! a

b: a
    ! b

default: b
`);
    const r = runCli(["diagram", "multi"], { SKILLSCRIPT_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/```mermaid/);
    expect(r.stdout).toMatch(/flowchart TD/);
    expect(r.stdout).toMatch(/a --> b/);
  });

  it("sign + verify round-trip on the bundled example", () => {
    const home = mkdtempSync(resolve(tmpdir(), "skillscript-test-"));
    runCli(["init"], { SKILLSCRIPT_HOME: home });
    const signOut = runCli(["sign", "examples/skillscripts/hello-world.skill.md"], { SKILLSCRIPT_HOME: home });
    expect(signOut.code).toBe(0);
    const sig = JSON.parse(signOut.stdout) as { content_hash: string; algorithm: string };
    expect(sig.algorithm).toBe("sha256");
    expect(sig.content_hash).toMatch(/^[a-f0-9]{64}$/);
    const verifyOut = runCli(["verify", "examples/skillscripts/hello-world.skill.md", sig.content_hash], { SKILLSCRIPT_HOME: home });
    expect(verifyOut.code).toBe(0);
    expect(verifyOut.stdout).toMatch(/"verified": true/);
  });

  it("verify fails (exit 1) on tampered signature", () => {
    const home = mkdtempSync(resolve(tmpdir(), "skillscript-test-"));
    runCli(["init"], { SKILLSCRIPT_HOME: home });
    const r = runCli(["verify", "examples/skillscripts/hello-world.skill.md", "deadbeef".repeat(8)], { SKILLSCRIPT_HOME: home });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/"verified": false/);
  });

  it("fires returns empty list when no traces exist", () => {
    const home = mkdtempSync(resolve(tmpdir(), "skillscript-test-"));
    runCli(["init"], { SKILLSCRIPT_HOME: home });
    const r = runCli(["fires", "anything"], { SKILLSCRIPT_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("[]");
  });

  it("health emits empty metrics on empty trace store", () => {
    const home = mkdtempSync(resolve(tmpdir(), "skillscript-test-"));
    runCli(["init"], { SKILLSCRIPT_HOME: home });
    const r = runCli(["health"], { SKILLSCRIPT_HOME: home });
    expect(r.code).toBe(0);
    const m = JSON.parse(r.stdout) as { totalFires: number; perSkill: Record<string, unknown> };
    expect(m.totalFires).toBe(0);
    expect(m.perSkill).toEqual({});
  });
});
