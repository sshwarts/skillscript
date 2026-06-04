import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "../src/dotenv-loader.js";

/**
 * v0.17.4 — `.env` file loader.
 *
 * Drop a `.env` next to `skillscript.config.json` and posture switches
 * like `SKILLSCRIPT_FORCE_ALWAYS_DRAFT=true` get picked up at CLI
 * startup. Shell-set vars take precedence (standard dotenv contract).
 */

describe("v0.17.4 — dotenv loader", () => {
  let home: string;
  let envPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0174-dotenv-"));
    envPath = join(home, ".env");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("loads simple KEY=value lines into the target env map", () => {
    writeFileSync(envPath, "FOO=bar\nBAZ=qux\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile({ path: envPath, env });
    expect(env["FOO"]).toBe("bar");
    expect(env["BAZ"]).toBe("qux");
    expect(result.loaded).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.preserved).toBe(0);
  });

  it("strips matched surrounding double quotes", () => {
    writeFileSync(envPath, `MSG="hello world"\n`);
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile({ path: envPath, env });
    expect(env["MSG"]).toBe("hello world");
  });

  it("strips matched surrounding single quotes", () => {
    writeFileSync(envPath, `MSG='hello world'\n`);
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile({ path: envPath, env });
    expect(env["MSG"]).toBe("hello world");
  });

  it("ignores comment lines starting with #", () => {
    writeFileSync(envPath, "# this is a comment\nFOO=bar\n# another\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile({ path: envPath, env });
    expect(env["FOO"]).toBe("bar");
    expect(result.loaded).toBe(1);
  });

  it("ignores blank lines", () => {
    writeFileSync(envPath, "\n\nFOO=bar\n\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile({ path: envPath, env });
    expect(env["FOO"]).toBe("bar");
    expect(result.loaded).toBe(1);
  });

  it("preserves existing env values — shell-set wins over .env file", () => {
    writeFileSync(envPath, "FOO=from-file\nNEW=value\n");
    const env: NodeJS.ProcessEnv = { FOO: "from-shell" };
    const result = loadEnvFile({ path: envPath, env });
    expect(env["FOO"]).toBe("from-shell");
    expect(env["NEW"]).toBe("value");
    expect(result.preserved).toBe(1);
    expect(result.loaded).toBe(1);
  });

  it("skips malformed lines + reports warnings", () => {
    writeFileSync(envPath, "FOO=bar\nNOEQUALS\nKEY WITH SPACES=value\nVALID=ok\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile({ path: envPath, env });
    expect(env["FOO"]).toBe("bar");
    expect(env["VALID"]).toBe("ok");
    expect(result.loaded).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.warnings).toHaveLength(2);
  });

  it("rejects invalid key names (must match identifier regex)", () => {
    writeFileSync(envPath, "1INVALID=nope\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile({ path: envPath, env });
    expect(env["1INVALID"]).toBeUndefined();
    expect(result.skipped).toBe(1);
    expect(result.warnings[0]).toMatch(/invalid key name/);
  });

  it("missing file is graceful — no-op, no error", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile({ path: join(home, "nonexistent.env"), env });
    expect(env).toEqual({});
    expect(result.loaded).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("handles values with embedded equals signs (splits on first = only)", () => {
    writeFileSync(envPath, "URL=https://example.com/path?key=value\n");
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile({ path: envPath, env });
    expect(env["URL"]).toBe("https://example.com/path?key=value");
  });

  it("handles bare values without quotes", () => {
    writeFileSync(envPath, "SIMPLE=just-text\n");
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile({ path: envPath, env });
    expect(env["SIMPLE"]).toBe("just-text");
  });

  it("strips quotes around empty string", () => {
    writeFileSync(envPath, `EMPTY=""\n`);
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile({ path: envPath, env });
    expect(env["EMPTY"]).toBe("");
  });

  it("trims whitespace around the value", () => {
    writeFileSync(envPath, "FOO=  spaced  \n");
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile({ path: envPath, env });
    expect(env["FOO"]).toBe("spaced");
  });

  it("collects multiple warnings + reports counts correctly", () => {
    writeFileSync(envPath, "BAD1\n2BAD=x\nOK=value\nBAD3=y\n=novalue\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile({ path: envPath, env });
    // BAD1 (no =), 2BAD (invalid key), BAD3 (ok actually), =novalue (eq at 0)
    expect(env["OK"]).toBe("value");
    expect(env["BAD3"]).toBe("y");
    expect(result.loaded).toBe(2);
    expect(result.skipped).toBe(3);
  });
});
