import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * T7 adversarial + dogfood pass — distribution polish.
 *
 * Validates that the package as published (via `pnpm pack`) is installable
 * and consumable from a fresh project. The kickoff's "clean-environment
 * dogfood" criterion lives here: pack → install → import all subpath
 * entries → round-trip a skill through parse/compile/lint → exit 0.
 *
 * Sixteen fixtures covering: package.json structure, exports map, tarball
 * contents (inclusions + exclusions), CLI help surface across 13 commands,
 * narrow-core LOC ceiling, example-skill lint, fresh-install import flow.
 *
 * Streak entry: eleven-for-eleven if all pass. Findings filed in dev log §13.
 */

const REPO_ROOT = join(__dirname, "..");
const PACKAGE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Record<string, unknown>;

describe("T7 — package.json polish", () => {
  it("1. version is 0.2.5 (T7 + trigger fix + parser + authoring MCP + D/F + cmp ops)", () => {
    expect(PACKAGE_JSON["version"]).toBe("0.2.5");
  });

  it("2. main + types + bin + engines.node ≥ 22.5 declared", () => {
    expect(PACKAGE_JSON["main"]).toBe("./dist/index.js");
    expect(PACKAGE_JSON["types"]).toBe("./dist/index.d.ts");
    const bin = PACKAGE_JSON["bin"] as Record<string, string>;
    expect(bin["skillfile"]).toBe("./dist/cli.js");
    const engines = PACKAGE_JSON["engines"] as Record<string, string>;
    expect(engines["node"]).toMatch(/^>=22/);
  });

  it("3. exports map covers all 10 public surface entries", () => {
    const exp = PACKAGE_JSON["exports"] as Record<string, unknown>;
    const expectedKeys = [
      ".", "./connectors", "./errors", "./runtime", "./trace",
      "./metrics", "./scheduler", "./mcp-server", "./testing", "./package.json",
    ];
    for (const k of expectedKeys) expect(exp[k], `missing exports['${k}']`).toBeDefined();
  });

  it("4. files list excludes src, tests, scripts, docker", () => {
    const files = PACKAGE_JSON["files"] as string[];
    expect(files).not.toContain("src");
    expect(files).not.toContain("tests");
    expect(files).not.toContain("scripts");
    expect(files).not.toContain("docker");
    expect(files).toContain("dist");
    expect(files).toContain("LICENSE");
    expect(files).toContain("README.md");
  });

  it("5. prepublishOnly runs build + loc-check + test", () => {
    const scripts = PACKAGE_JSON["scripts"] as Record<string, string>;
    expect(scripts["prepublishOnly"]).toMatch(/build/);
    expect(scripts["prepublishOnly"]).toMatch(/loc-check/);
    expect(scripts["prepublishOnly"]).toMatch(/test/);
  });
});

describe("T7 — distributed code surface", () => {
  it("6. no AMP-system identifiers in src/", () => {
    // grep-equivalent: scan for AMP_ or AmpFoo or amp-system-specific tokens.
    // Allowed: comments mentioning '@modelcontextprotocol/sdk' (the official
    // SDK reference) — those reference the standard, not the AMP system.
    const cmd = `grep -rE "\\bAMP_[A-Z]|\\bAmp[A-Z]" ${REPO_ROOT}/src --include="*.ts" || true`;
    const out = execSync(cmd, { encoding: "utf8" });
    expect(out.trim(), `found AMP identifiers: ${out}`).toBe("");
  });

  it("7. narrow-core LOC ceiling holds (< 5000 / 20 files)", () => {
    const out = execSync("node scripts/loc-ceiling.mjs", { cwd: REPO_ROOT, encoding: "utf8" });
    const match = /CORE\s+(\d+) LOC across (\d+) files/.exec(out);
    expect(match).not.toBeNull();
    const [, locStr, filesStr] = match!;
    expect(Number(locStr)).toBeLessThan(5000);
    expect(Number(filesStr)).toBeLessThan(20);
  });

  it("8. connectors barrel re-exports types + Registry + bundled impls", () => {
    const barrel = readFileSync(join(REPO_ROOT, "src/connectors/index.ts"), "utf8");
    expect(barrel).toMatch(/SkillStore/);
    expect(barrel).toMatch(/MemoryStore/);
    expect(barrel).toMatch(/LocalModel/);
    expect(barrel).toMatch(/McpConnector/);
    expect(barrel).toMatch(/Registry/);
    expect(barrel).toMatch(/FilesystemSkillStore/);
    expect(barrel).toMatch(/OllamaLocalModel/);
    expect(barrel).toMatch(/SqliteMemoryStore/);
    expect(barrel).toMatch(/CallbackMcpConnector/);
  });
});

describe("T7 — CLI --help surface", () => {
  const CLI = `node ${join(REPO_ROOT, "dist/cli.js")}`;

  it("9. top-level --help lists all 13 commands (v0.2.1 dropped orphan trigger CLIs)", () => {
    const out = execSync(`${CLI} --help`, { encoding: "utf8" });
    const commands = [
      "init", "run", "compile", "audit", "lint", "list",
      "fires", "diagram", "sign", "verify", "replay", "health",
      "dashboard",
    ];
    for (const cmd of commands) {
      expect(out, `missing command '${cmd}' in usage`).toMatch(new RegExp(`^\\s+${cmd}\\s+`, "m"));
    }
    // Removed in v0.2.1 — verify they're not silently re-added.
    for (const removed of ["register-trigger", "unregister-trigger", "list-triggers"]) {
      expect(out, `removed command '${removed}' reappeared in usage`).not.toMatch(new RegExp(`^\\s+${removed}\\s+`, "m"));
    }
  });

  it("10. each command has per-command --help with description + usage", () => {
    const commands = [
      "init", "run", "compile", "audit", "lint", "list",
      "fires", "diagram", "sign", "verify", "replay", "health",
      "dashboard",
    ];
    for (const cmd of commands) {
      const out = execSync(`${CLI} ${cmd} --help`, { encoding: "utf8" });
      expect(out, `${cmd}: missing title line`).toMatch(new RegExp(`^skillfile ${cmd} — `));
      expect(out, `${cmd}: missing Usage:`).toMatch(/Usage:/);
      expect(out, `${cmd}: missing Examples:`).toMatch(/Examples:/);
    }
  });

  it("11. version flag reports 0.2.5", () => {
    const out = execSync(`${CLI} --version`, { encoding: "utf8" });
    expect(out.trim()).toBe("0.2.5");
  });
});

describe("T7 — examples directory", () => {
  it("12. curated examples (≥ 6 .skill.md files + README + programmatic demo)", () => {
    const examplesDir = join(REPO_ROOT, "examples");
    const cmd = `ls ${examplesDir}/*.skill.md | wc -l`;
    const count = Number(execSync(cmd, { encoding: "utf8" }).trim());
    expect(count).toBeGreaterThanOrEqual(6);
    expect(existsSync(join(examplesDir, "README.md"))).toBe(true);
    expect(existsSync(join(examplesDir, "programmatic-trace-demo.mjs"))).toBe(true);
    expect(existsSync(join(examplesDir, "hello.skill.md"))).toBe(true);
  });

  it("13. all .skill.md examples lint clean", () => {
    const examplesDir = join(REPO_ROOT, "examples");
    const files = execSync(`ls ${examplesDir}/*.skill.md`, { encoding: "utf8" }).trim().split("\n");
    for (const f of files) {
      // Tier-1 errors break compile; lint returns 0 iff there are no errors.
      execSync(`node ${join(REPO_ROOT, "dist/cli.js")} lint ${f}`, { encoding: "utf8" });
    }
  });
});

// Pack + install scenario — heavy fixture: runs `pnpm pack`, installs the
// tarball into a fresh /tmp directory, imports every subpath, round-trips
// a skill through parse/compile/lint. Gated by ENABLE_T7_PACK_DOGFOOD=1
// because pnpm pack pulls in network deps sometimes and we don't want to
// slow `pnpm test` for ordinary runs.
describe.skipIf(process.env["ENABLE_T7_PACK_DOGFOOD"] !== "1")("T7 — pack + install dogfood", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "skillscript-t7-dogfood-"));
    // Pack first
    execSync("pnpm pack --pack-destination " + testDir, { cwd: REPO_ROOT });
    const tarball = execSync(`ls ${testDir}/*.tgz`, { encoding: "utf8" }).trim();
    // Set up a minimal package.json + install
    writeFileSync(join(testDir, "package.json"), JSON.stringify({
      name: "skillscript-t7-dogfood",
      type: "module",
      private: true,
      dependencies: { "skillscript-runtime": `file:${tarball}` },
    }));
    execSync("npm install --silent", { cwd: testDir });
  });

  it("14. tarball contains dist/connectors/index.js (barrel)", () => {
    const tarball = execSync(`ls ${testDir}/*.tgz`, { encoding: "utf8" }).trim();
    const contents = execSync(`tar -tzf ${tarball}`, { encoding: "utf8" });
    expect(contents).toMatch(/package\/dist\/connectors\/index\.js/);
    expect(contents).toMatch(/package\/LICENSE/);
    expect(contents).toMatch(/package\/README\.md/);
    expect(contents).not.toMatch(/package\/tests\//);
    expect(contents).not.toMatch(/package\/src\//);
    expect(contents).not.toMatch(/package\/scripts\//);
  });

  it("15. fresh install resolves all 9 subpath imports", () => {
    const importTest = `
      import { parse, compile, lint } from "skillscript-runtime";
      import { FilesystemSkillStore } from "skillscript-runtime/connectors";
      import { OpError } from "skillscript-runtime/errors";
      import { execute } from "skillscript-runtime/runtime";
      import { FilesystemTraceStore } from "skillscript-runtime/trace";
      import { healthMetrics } from "skillscript-runtime/metrics";
      import { Scheduler } from "skillscript-runtime/scheduler";
      import { McpServer } from "skillscript-runtime/mcp-server";
      import { SkillStoreConformance } from "skillscript-runtime/testing";
      [parse, compile, lint, FilesystemSkillStore, OpError, execute,
       FilesystemTraceStore, healthMetrics, Scheduler, McpServer, SkillStoreConformance]
        .forEach((v, i) => { if (v === undefined) { console.error("FAIL idx " + i); process.exit(1); }});
      console.log("OK");
    `;
    writeFileSync(join(testDir, "test-imports.mjs"), importTest);
    const out = execSync("node test-imports.mjs", { cwd: testDir, encoding: "utf8" });
    expect(out.trim()).toBe("OK");
  });

  it("16. round-trip skill through parse + compile + lint via fresh install", () => {
    const rtTest = `
      import { parse, compile, lint } from "skillscript-runtime";
      const src = "# Skill: t7-dogfood\\n# Status: Draft\\ngreet:\\n    ! hello\\ndefault: greet\\n";
      const parsed = parse(src);
      if (parsed.targets.size !== 1) { console.error("FAIL parse — expected 1 target, got " + parsed.targets.size); process.exit(1); }
      const c = await compile(src);
      if (!c.output.includes("hello")) { console.error("FAIL compile"); process.exit(1); }
      const l = await lint(src);
      if (l.findings.some(f => f.severity === "error")) { console.error("FAIL lint"); process.exit(1); }
      console.log("OK");
    `;
    writeFileSync(join(testDir, "test-roundtrip.mjs"), rtTest);
    const out = execSync("node test-roundtrip.mjs", { cwd: testDir, encoding: "utf8" });
    expect(out.trim()).toBe("OK");
  });
});
