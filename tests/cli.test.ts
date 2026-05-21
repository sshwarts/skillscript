import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

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
    expect(r.stdout).toMatch(/skillfile init/);
  });

  it("runs hello.skill end-to-end with bundled example", () => {
    const r = runCli(["run", "examples/hello.skill.md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Hello, world!/);
  });

  it("threads --input overrides", () => {
    const r = runCli(["run", "examples/hello.skill.md", "--input", "WHO=Scott"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Hello, Scott!/);
  });

  it("compile emits the rendered artifact", () => {
    const r = runCli(["compile", "examples/hello.skill.md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/# Skill: hello/);
    expect(r.stdout).toMatch(/Tell the user: Hello, world!/);
  });

  it("lint reports no findings on the bundled example", () => {
    const r = runCli(["lint", "examples/hello.skill.md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OK: no findings/);
  });

  it("init scaffolds the tree", () => {
    const home = mkdtempSync(resolve(tmpdir(), "skillscript-test-"));
    const r = runCli(["init"], { SKILLSCRIPT_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Initialized/);
    // hello.skill should be discoverable after init.
    const r2 = runCli(["run", "examples/hello.skill.md"], { SKILLSCRIPT_HOME: home });
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
    fs.writeFileSync(path.join(home, "skills", "voice.skill.md"), `# Skill: voice
# Type: data

t:
    ! be concise

default: t
`);
    fs.writeFileSync(path.join(home, "skills", "caller.skill.md"), `# Skill: caller
t:
    & voice
    ! ok

default: t
`);
    const r = runCli(["run", "caller"], { SKILLSCRIPT_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/be concise/);
    expect(r.stdout).toMatch(/ok/);
  });
});
