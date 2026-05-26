import { describe, it, expect } from "vitest";
import { loadSkillscriptConfig } from "../src/runtime-config.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// v0.7.3 — `skillscript.config.json` canonical config loader. Externalizes
// runtime knobs (skillsDir, traceDir, port, etc.) so adopters declare them
// in one place. Driver: two-instance posture (dev + adopter on same machine
// require independent ports/paths).

function withTempConfig(content: string | object, fn: (path: string) => void, env: Record<string, string> = {}): void {
  const home = mkdtempSync(join(tmpdir(), "v073-cfg-"));
  try {
    const path = join(home, "skillscript.config.json");
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    Object.assign(process.env, env);
    try { fn(path); }
    finally { for (const k of Object.keys(env)) delete process.env[k]; }
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe("v0.7.3 — loadSkillscriptConfig", () => {
  it("returns empty config + no errors when file is missing (graceful)", () => {
    const result = loadSkillscriptConfig({ path: "/nonexistent/skillscript.config.json" });
    expect(result.config).toEqual({});
    expect(result.errors).toEqual([]);
  });

  it("parses a fully-populated config with all knobs set", () => {
    withTempConfig({
      skillsDir: "/var/skills",
      traceDir: "/var/traces",
      memoryDbPath: "/var/memory.db",
      ollamaBaseUrl: "http://ollama.internal:11434",
      pollIntervalSeconds: 60,
      enableUnsafeShell: true,
      mode: "serve",
      triggersFilePath: "/var/triggers.json",
      connectorsConfigPath: "/var/connectors.json",
      dashboard: { port: 8080, host: "0.0.0.0" },
    }, (path) => {
      const result = loadSkillscriptConfig({ path });
      expect(result.errors).toEqual([]);
      expect(result.config).toEqual({
        skillsDir: "/var/skills",
        traceDir: "/var/traces",
        memoryDbPath: "/var/memory.db",
        ollamaBaseUrl: "http://ollama.internal:11434",
        pollIntervalSeconds: 60,
        enableUnsafeShell: true,
        mode: "serve",
        triggersFilePath: "/var/triggers.json",
        connectorsConfigPath: "/var/connectors.json",
        dashboard: { port: 8080, host: "0.0.0.0" },
      });
    });
  });

  it("resolves ${VAR} substitutions against env", () => {
    withTempConfig({
      skillsDir: "${TEST_HOME}/skills",
      dashboard: { host: "${TEST_HOST}" },
    }, (path) => {
      const result = loadSkillscriptConfig({ path, env: { TEST_HOME: "/joe", TEST_HOST: "192.168.1.5" } });
      expect(result.errors).toEqual([]);
      expect(result.config.skillsDir).toBe("/joe/skills");
      expect(result.config.dashboard?.host).toBe("192.168.1.5");
    });
  });

  it("errors on unset ${VAR} references", () => {
    withTempConfig({ skillsDir: "${MISSING_VAR}/skills" }, (path) => {
      const result = loadSkillscriptConfig({ path, env: {} });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/MISSING_VAR.*not set/);
    });
  });

  it("rejects malformed JSON with a clear error", () => {
    withTempConfig("{ not valid json", (path) => {
      const result = loadSkillscriptConfig({ path });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/malformed JSON/);
    });
  });

  it("rejects top-level non-object (array or scalar)", () => {
    withTempConfig("[1, 2, 3]", (path) => {
      const result = loadSkillscriptConfig({ path });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/top-level must be an object/);
    });
  });

  it("validates field types — port must be integer 1-65535", () => {
    withTempConfig({ dashboard: { port: 99999 } }, (path) => {
      const result = loadSkillscriptConfig({ path });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/dashboard.port/);
    });

    withTempConfig({ dashboard: { port: "not-a-number" } }, (path) => {
      const result = loadSkillscriptConfig({ path });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/dashboard.port/);
    });
  });

  it("validates mode must be 'serve' or 'dashboard'", () => {
    withTempConfig({ mode: "headless" }, (path) => {
      const result = loadSkillscriptConfig({ path });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/mode.*must be 'serve' or 'dashboard'/);
    });
  });

  it("tolerates unknown fields (forward-compat with future-version configs)", () => {
    withTempConfig({
      skillsDir: "/x",
      futureField: { something: "new" },
    }, (path) => {
      const result = loadSkillscriptConfig({ path });
      expect(result.errors).toEqual([]);
      expect(result.config.skillsDir).toBe("/x");
      // Unknown field silently dropped — no error, but not in config either.
      expect((result.config as Record<string, unknown>)["futureField"]).toBeUndefined();
    });
  });

  it("partial config only sets specified fields (defaults remain caller's responsibility)", () => {
    withTempConfig({ dashboard: { port: 9090 } }, (path) => {
      const result = loadSkillscriptConfig({ path });
      expect(result.errors).toEqual([]);
      expect(result.config.dashboard?.port).toBe(9090);
      expect(result.config.skillsDir).toBeUndefined();
      expect(result.config.traceDir).toBeUndefined();
    });
  });

  it("two-instance posture: independent configs produce independent paths", () => {
    withTempConfig({
      skillsDir: "/dev/skills",
      dashboard: { port: 7878 },
    }, (devPath) => {
      withTempConfig({
        skillsDir: "/adopter/skills",
        dashboard: { port: 7879 },
      }, (adopterPath) => {
        const dev = loadSkillscriptConfig({ path: devPath });
        const adopter = loadSkillscriptConfig({ path: adopterPath });
        expect(dev.errors).toEqual([]);
        expect(adopter.errors).toEqual([]);
        expect(dev.config.skillsDir).not.toBe(adopter.config.skillsDir);
        expect(dev.config.dashboard?.port).not.toBe(adopter.config.dashboard?.port);
      });
    });
  });
});
