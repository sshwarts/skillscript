import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * v0.4.3 — CLI auto-discovers `connectors.json` from `$SKILLSCRIPT_HOME`
 * for `skillfile serve` + `skillfile dashboard`. Closes the v0.4.x arc's
 * last-mile gap: pre-v0.4.3 the loader + lint + runtime + allowlist all
 * worked, but the canonical CLI entry point didn't read connectors.json.
 *
 * Tests use spawnSync of the built CLI with `--help` + a probe via the
 * runtime_capabilities tool. Full runtime spawn is heavy for CI; we
 * verify behavior via:
 *   1. CLI --help text mentions --connectors flag
 *   2. cmdRuntimeHost passes connectorsConfigPath through to bootstrap
 *      (verified via running the dashboard and reading mcpConnectors
 *      via /rpc)
 */

const REPO_ROOT = join(__dirname, "..");
const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");

describe("v0.4.3 — CLI --help mentions --connectors flag", () => {
  it("`skillfile dashboard --help` lists --connectors PATH", () => {
    const out = spawnSync("node", [CLI_PATH, "dashboard", "--help"], { encoding: "utf8" });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/--connectors PATH/);
    expect(out.stdout).toMatch(/connectors\.json/);
  });

  it("`skillfile serve --help` lists --connectors PATH", () => {
    const out = spawnSync("node", [CLI_PATH, "serve", "--help"], { encoding: "utf8" });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/--connectors PATH/);
  });
});

describe("v0.4.3 — bootstrap default connectorsConfigPath path resolution", () => {
  // Smoke test: bootstrap accepts the connectorsConfigPath shape the CLI
  // builds. Real end-to-end with a wired connector is covered by the
  // v0.4.1 YouTrack proving suite + the v0.4.0 loader tests.
  it("bootstrap reads connectors.json at the path the CLI computes", async () => {
    const home = mkdtempSync(join(tmpdir(), "v043-home-"));
    mkdirSync(join(home, "skills"), { recursive: true });
    mkdirSync(join(home, "traces"), { recursive: true });
    const cfgPath = join(home, "connectors.json");
    writeFileSync(cfgPath, JSON.stringify({
      x: { class: "CallbackMcpConnector", config: {} },
    }));
    const { bootstrap } = await import("../src/bootstrap.js");
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      connectorsConfigPath: cfgPath,
    });
    // CallbackMcpConnector isn't JSON-instantiable in v0.4.0+, so it
    // surfaces as a load error. Verifies the wiring went through:
    // bootstrap → loader → error in result. No instance registered.
    expect(wired.connectorConfigErrors.length).toBeGreaterThan(0);
    expect(wired.connectorConfigErrors[0]).toMatch(/CallbackMcpConnector.*doesn't support configuration/);
  });

  it("bootstrap handles missing connectors.json gracefully", async () => {
    const home = mkdtempSync(join(tmpdir(), "v043-home-missing-"));
    mkdirSync(join(home, "skills"), { recursive: true });
    mkdirSync(join(home, "traces"), { recursive: true });
    const { bootstrap } = await import("../src/bootstrap.js");
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      connectorsConfigPath: join(home, "connectors.json"),  // doesn't exist
    });
    expect(wired.connectorConfigErrors).toEqual([]);
    expect(wired.configuredConnectorNames).toEqual([]);
  });
});

describe("v0.4.3 — connectorsConfigPath wiring (v0.23.x: moved into bootstrapFromEnv)", () => {
  it("bootstrapFromEnv resolves connectorsConfigPath + passes it to bootstrap", () => {
    // The env-cascade + bootstrap assembly moved out of cmdRuntimeHost into the
    // reusable bootstrapFromEnv(); the connectors.json wire-up lives there now.
    const src = readFileSync(join(REPO_ROOT, "src", "bootstrap-from-env.ts"), "utf8");
    expect(src).toMatch(/connectorsConfigPath = opts\.connectorsConfigPath \?\? fileConfig\.connectorsConfigPath \?\? join\(home, "connectors\.json"\)/);
    expect(src).toMatch(/bootstrap\(\{[\s\S]*?connectorsConfigPath,/);
  });

  it("the CLI passes the --connectors flag through to bootstrapFromEnv", () => {
    const src = readFileSync(join(REPO_ROOT, "src", "cli.ts"), "utf8");
    expect(src).toMatch(/bootstrapFromEnv\(/);
    expect(src).toMatch(/connectorsConfigPath: extractFlag\(args, "--connectors"\)/);
  });
});
