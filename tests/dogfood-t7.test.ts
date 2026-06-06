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
 * contents (inclusions + exclusions), CLI help surface across 14 commands,
 * narrow-core LOC ceiling, example-skill lint, fresh-install import flow.
 *
 * Streak entry: eleven-for-eleven if all pass. Findings filed in dev log §13.
 */

const REPO_ROOT = join(__dirname, "..");
const PACKAGE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Record<string, unknown>;

describe("T7 — package.json polish", () => {
  it("1. version is 0.18.8 (BREAKING — default-deny shell binary allowlist: SKILLSCRIPT_SHELL_ALLOWLIST env + config + lint shell-binary-not-allowed + runtime ShellBinaryNotAllowedError + skillfile shell-audit pre-upgrade migration helper + trace blocked_reason)", () => {
    expect(PACKAGE_JSON["version"]).toBe("0.18.8");
  });

  it("2. main + types + bin + engines.node ≥ 22.5 declared", () => {
    expect(PACKAGE_JSON["main"]).toBe("./dist/index.js");
    expect(PACKAGE_JSON["types"]).toBe("./dist/index.d.ts");
    const bin = PACKAGE_JSON["bin"] as Record<string, string>;
    expect(bin["skillfile"]).toBe("./dist/cli.js");
    const engines = PACKAGE_JSON["engines"] as Record<string, string>;
    expect(engines["node"]).toMatch(/^>=22/);
  });

  it("3. exports map covers all 11 public surface entries (v0.15.3 added ./dashboard for adopter DashboardServer mount)", () => {
    const exp = PACKAGE_JSON["exports"] as Record<string, unknown>;
    const expectedKeys = [
      ".", "./connectors", "./errors", "./runtime", "./trace",
      "./metrics", "./scheduler", "./mcp-server", "./dashboard", "./testing", "./package.json",
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

  it("7. narrow-core LOC ceiling holds (< 11100 / 23 files; ..., v0.7.0 → 7150, v0.7.1 → 7250, v0.7.2 → 7550, v0.8.0 → 8200, v0.9.4 → 8300, v0.9.6 → 8550, v0.9.8 → 8650, v0.10 → 9300, v0.13 → 9550, v0.14.1 → 9700, v0.15.0 → 9900, v0.16.x → 10400, v0.17.4 → 10500, v0.18.2 → 10600, v0.18.5 → 10800, v0.18.8 → 11100)", () => {
    const out = execSync("node scripts/loc-ceiling.mjs", { cwd: REPO_ROOT, encoding: "utf8" });
    const match = /CORE\s+(\d+) LOC across (\d+) files/.exec(out);
    expect(match).not.toBeNull();
    const [, locStr, filesStr] = match!;
    expect(Number(locStr)).toBeLessThan(11100);
    expect(Number(filesStr)).toBeLessThan(23);
  });

  it("8. connectors barrel re-exports types + Registry + bundled impls", () => {
    const barrel = readFileSync(join(REPO_ROOT, "src/connectors/index.ts"), "utf8");
    expect(barrel).toMatch(/SkillStore/);
    expect(barrel).toMatch(/DataStore/);
    expect(barrel).toMatch(/LocalModel/);
    expect(barrel).toMatch(/McpConnector/);
    expect(barrel).toMatch(/Registry/);
    expect(barrel).toMatch(/FilesystemSkillStore/);
    expect(barrel).toMatch(/OllamaLocalModel/);
    expect(barrel).toMatch(/SqliteDataStore/);
    expect(barrel).toMatch(/CallbackMcpConnector/);
    // v0.15.0 — SkillStore-as-bridge.
    expect(barrel).toMatch(/SkillStoreMcpConnector/);
  });
});

describe("T7 — CLI --help surface", () => {
  const CLI = `node ${join(REPO_ROOT, "dist/cli.js")}`;

  it("9. top-level --help lists all 14 commands (v0.2.7 added serve; v0.2.11 renamed run → execute)", () => {
    const out = execSync(`${CLI} --help`, { encoding: "utf8" });
    const commands = [
      // `run` is intentionally absent from the top-level listing in v0.2.11 —
      // it's a deprecated alias for `execute` and still dispatchable, but no
      // longer advertised in the usage surface (per memory `2e999f9e`).
      "init", "execute", "compile", "audit", "lint", "list",
      "fires", "diagram", "sign", "verify", "replay", "health",
      "serve", "dashboard",
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
      // v0.2.12 dropped the `run` deprecated alias (shipped in v0.2.11 with a
      // stderr deprecation notice; one-release window per the CLI symmetry
      // memory `2e999f9e`).
      "init", "execute", "compile", "audit", "lint", "list",
      "fires", "diagram", "sign", "verify", "replay", "health",
      "serve", "dashboard",
    ];
    for (const cmd of commands) {
      const out = execSync(`${CLI} ${cmd} --help`, { encoding: "utf8" });
      expect(out, `${cmd}: missing title line`).toMatch(new RegExp(`^skillfile ${cmd} — `));
      expect(out, `${cmd}: missing Usage:`).toMatch(/Usage:/);
      expect(out, `${cmd}: missing Examples:`).toMatch(/Examples:/);
    }
  });

  it("11. version flag reports the package.json version (single-sourced as of v0.2.12)", () => {
    const out = execSync(`${CLI} --version`, { encoding: "utf8" });
    const pkgVersion = JSON.parse(execSync(`cat ${join(REPO_ROOT, "package.json")}`, { encoding: "utf8" }))["version"];
    expect(out.trim()).toBe(pkgVersion);
  });

  it("11b. mcp-server runtime_capabilities.runtimeVersion matches package.json (v0.2.12 Bug 20 regression)", async () => {
    const { McpServer } = await import("../src/mcp-server.js");
    const pkgVersion = JSON.parse(execSync(`cat ${join(REPO_ROOT, "package.json")}`, { encoding: "utf8" }))["version"];
    const srv = new McpServer({ skillStore: { metadata: async () => { throw new Error("stub"); } } as never });
    const tool = srv.listTools().find((t) => t.name === "runtime_capabilities");
    expect(tool).toBeDefined();
    const caps = await tool!.handler({}) as { runtimeVersion: string };
    expect(caps.runtimeVersion).toBe(pkgVersion);
  });
});

describe("T7 — examples directory", () => {
  it("12. curated examples (≥ 6 .skill.md files in skillscripts/ + README + programmatic demo)", () => {
    const examplesDir = join(REPO_ROOT, "examples");
    const skillscriptsDir = join(examplesDir, "skillscripts");
    const cmd = `ls ${skillscriptsDir}/*.skill.md | wc -l`;
    const count = Number(execSync(cmd, { encoding: "utf8" }).trim());
    expect(count).toBeGreaterThanOrEqual(6);
    expect(existsSync(join(examplesDir, "README.md"))).toBe(true);
    expect(existsSync(join(examplesDir, "programmatic-trace-demo.mjs"))).toBe(true);
    expect(existsSync(join(skillscriptsDir, "hello-world.skill.md"))).toBe(true);
    expect(existsSync(join(skillscriptsDir, "skill-store-roundtrip.skill.md"))).toBe(true);
    expect(existsSync(join(skillscriptsDir, "data-store-roundtrip.skill.md"))).toBe(true);
  });

  it("13. all .skill.md examples lint clean", () => {
    const skillscriptsDir = join(REPO_ROOT, "examples", "skillscripts");
    const files = execSync(`ls ${skillscriptsDir}/*.skill.md`, { encoding: "utf8" }).trim().split("\n");
    for (const f of files) {
      // Tier-1 errors break compile; lint returns 0 iff there are no errors.
      execSync(`node ${join(REPO_ROOT, "dist/cli.js")} lint ${f}`, { encoding: "utf8" });
    }
  });

  it("14. every bundled .skill.md has a valid `# Status: Approved v1:<token>` stamp matching its body (v0.15.0 structural guard)", async () => {
    // v0.15.0 — bundled skills ship pre-stamped (so adopters can `cp` them
    // into `$SKILLSCRIPT_HOME/skills/` and execute_skill({name}) immediately
    // without a skill_write round-trip). Token = computeApprovalToken(body, "v1")
    // = CRC32 over body-minus-status-line. If anyone edits a body without
    // re-running `node scripts/stamp-bundled-skills.mjs`, this guard catches
    // the drift on every `pnpm test`. Run the script to fix; do NOT modify
    // the token by hand. Sibling structural-guard to #1 (hardcoded version)
    // and #7 (LOC ceiling).
    const { computeApprovalToken, extractStatusFromBody } = await import("../src/approval.js");
    const skillscriptsDir = join(REPO_ROOT, "examples", "skillscripts");
    const files = execSync(`ls ${skillscriptsDir}/*.skill.md`, { encoding: "utf8" }).trim().split("\n");
    for (const f of files) {
      const body = readFileSync(f, "utf8");
      const extracted = extractStatusFromBody(body);
      expect(extracted, `bundled skill ${f} missing # Status: header`).not.toBeNull();
      // Bundled skills must ship Approved + stamped. Draft / Disabled
      // entries are author-internal state, not shippable.
      expect(extracted!.status, `bundled skill ${f} must be Approved (got ${extracted!.status})`).toBe("Approved");
      expect(extracted!.approvalToken, `bundled skill ${f} must carry a v1:<token> stamp`).not.toBeNull();
      const { version, token } = computeApprovalToken(body, "v1");
      expect(extracted!.approvalToken, `bundled skill ${f} stamp drift — run \`node scripts/stamp-bundled-skills.mjs\``).toBe(`${version}:${token}`);
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

  it("14. tarball contains dist/connectors/index.js (barrel) + adopter-facing docs", () => {
    const tarball = execSync(`ls ${testDir}/*.tgz`, { encoding: "utf8" }).trim();
    const contents = execSync(`tar -tzf ${tarball}`, { encoding: "utf8" });
    expect(contents).toMatch(/package\/dist\/connectors\/index\.js/);
    expect(contents).toMatch(/package\/LICENSE/);
    expect(contents).toMatch(/package\/README\.md/);
    // v0.13.3 — the 5 user-facing docs ship so README links resolve in the package.
    // ARCHITECTURE.md + docs/ERD.md are internal-only and stay out of the tarball.
    expect(contents).toMatch(/package\/docs\/configuration\.md/);
    expect(contents).toMatch(/package\/docs\/adopter-playbook\.md/);
    expect(contents).toMatch(/package\/docs\/connector-contract-reference\.md/);
    expect(contents).toMatch(/package\/docs\/language-reference\.md/);
    expect(contents).toMatch(/package\/docs\/sqlite-skill-store\.md/);
    expect(contents).not.toMatch(/package\/docs\/ERD\.md/);
    expect(contents).not.toMatch(/package\/ARCHITECTURE\.md/);
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
      const src = "# Skill: t7-dogfood\\n# Status: Draft\\ngreet:\\n    emit(text=\"hello\")\\ndefault: greet\\n";
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

  // v0.13.8 — Perry caught a missing tool in the README MCP-surface table
  // (set_trigger_enabled was real since v0.9.0 but never listed). Same class
  // of doc-vs-code drift the check-published-paths.mjs link-guard doesn't
  // catch (it validates path resolution, not table-content-vs-runtime).
  // This assertion closes the class structurally: every tool the README
  // claims exists must exist in the runtime, and every runtime tool must be
  // claimed somewhere in the README's MCP-surface table.
  it("17. README MCP-surface table matches runtime tools/list (no doc drift)", () => {
    const readmePath = join(REPO_ROOT, "README.md");
    const readme = readFileSync(readmePath, "utf8");

    // Find the MCP-surface section — anchored on the "N tools over MCP" intro
    // sentence + the table that follows it.
    const sectionMatch = readme.match(
      /exposes \d+ tools over MCP[\s\S]*?\| Discovery \| `[^|]+`[^|\n]*\|/m,
    );
    if (sectionMatch === null) {
      throw new Error(
        "Couldn't find README MCP-surface table — anchor sentence ('exposes N tools over MCP') or Discovery row may have moved",
      );
    }
    const section = sectionMatch[0];

    // Extract every backtick-quoted lowercase-with-underscores identifier
    // from the table. These are the tools the README claims exist.
    const documented = new Set<string>();
    const toolRe = /`([a-z][a-z_]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = toolRe.exec(section)) !== null) {
      documented.add(m[1]!);
    }
    // Strip non-tool tokens that appear in row headers or prose (none today,
    // but defensive — `/rpc` would be filtered out by the lowercase-only
    // regex above already).

    // Spawn a fresh-install McpServer + dump tools/list. Same surface as the
    // running runtime.
    const dumpScript = `
      import { McpServer } from "skillscript-runtime";
      import { FilesystemSkillStore, NoOpAgentConnector } from "skillscript-runtime/connectors";
      import { mkdtempSync, rmSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      const home = mkdtempSync(join(tmpdir(), "t7-tools-list-"));
      // Minimal deps — McpServer registers all built-in tools regardless of
      // whether the scheduler / trace store / etc. are real.
      const stub = {};
      const server = new McpServer({
        skillStore: new FilesystemSkillStore(home),
        scheduler: { getTriggers: () => [], registerTrigger: () => null, unregisterTrigger: () => false, setTriggerEnabled: () => null },
        traceStore: { query: () => [] },
        registry: { listSkillStores: () => [], listDataStores: () => [], listLocalModels: () => [], listMcpConnectors: () => [], listMcpConnectorClasses: () => [], listAgentConnectors: () => [] },
        runtimeMode: "serve",
      });
      console.log(JSON.stringify(server.listTools().map(t => t.name).sort()));
      rmSync(home, { recursive: true, force: true });
    `;
    writeFileSync(join(testDir, "test-tools-list.mjs"), dumpScript);
    const out = execSync("node test-tools-list.mjs", { cwd: testDir, encoding: "utf8" });
    const runtime = new Set<string>(JSON.parse(out.trim()) as string[]);

    // Symmetric set diff — both directions matter.
    const onlyDocumented = [...documented].filter((t) => !runtime.has(t));
    const onlyRuntime = [...runtime].filter((t) => !documented.has(t));
    expect(onlyDocumented, `README documents tools the runtime doesn't expose: ${onlyDocumented.join(", ")}`).toEqual([]);
    expect(onlyRuntime, `Runtime exposes tools the README doesn't document: ${onlyRuntime.join(", ")}`).toEqual([]);
  });
});
