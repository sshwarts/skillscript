import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";

/**
 * v0.18.9 — bootstrap() shell-allowlist env-fallback. Closes adopter CR
 * `f2549ddf` + Perry signoff `42de3d72`:
 *
 * Pre-v0.18.9 asymmetry — `SKILLSCRIPT_SHELL_ALLOWLIST` was honored on
 * the CLI path (via `cli.ts` cascade) but ignored on the programmatic
 * bootstrap path (runtime read `deps.shellAllowlist`, not `process.env`).
 * Programmatic adopters with `.env` set hit silent default-deny.
 *
 * Perry's REQUIRED guard (security-load-bearing):
 *   - opts.shellAllowlist === undefined → env fallback
 *   - opts.shellAllowlist === [] → AUTHORITATIVE (explicit deny-all wins)
 *   - opts.shellAllowlist === [<list>] → AUTHORITATIVE (explicit list wins)
 *
 * Critical: do NOT collapse "undefined" and "empty array" into one
 * falsy check — that would let a stray env var silently widen an
 * intentional `shellAllowlist: []` lockdown.
 */

describe("v0.18.9 bootstrap env-fallback for SKILLSCRIPT_SHELL_ALLOWLIST", () => {
  let home: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0189-env-"));
    savedEnv = process.env["SKILLSCRIPT_SHELL_ALLOWLIST"];
    delete process.env["SKILLSCRIPT_SHELL_ALLOWLIST"];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env["SKILLSCRIPT_SHELL_ALLOWLIST"];
    else process.env["SKILLSCRIPT_SHELL_ALLOWLIST"] = savedEnv;
    rmSync(home, { recursive: true, force: true });
  });

  it("unset env + opts.shellAllowlist === undefined → default-deny (undefined)", () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const sched = wired.scheduler as unknown as { shellAllowlist: string[] | undefined };
    expect(sched.shellAllowlist).toBeUndefined();
  });

  it("env set + opts undefined → env value populates allowlist (the CR fix)", () => {
    process.env["SKILLSCRIPT_SHELL_ALLOWLIST"] = "curl,git,jq";
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const sched = wired.scheduler as unknown as { shellAllowlist: string[] | undefined };
    expect(sched.shellAllowlist).toEqual(["curl", "git", "jq"]);
  });

  it("env set with whitespace → trimmed + empties dropped", () => {
    process.env["SKILLSCRIPT_SHELL_ALLOWLIST"] = "  curl , , git ,jq , ";
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const sched = wired.scheduler as unknown as { shellAllowlist: string[] | undefined };
    expect(sched.shellAllowlist).toEqual(["curl", "git", "jq"]);
  });

  it("env set as empty string → empty list (parses to [], NOT undefined)", () => {
    process.env["SKILLSCRIPT_SHELL_ALLOWLIST"] = "";
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const sched = wired.scheduler as unknown as { shellAllowlist: string[] | undefined };
    // Empty env value parses to [] which is still env-supplied (operator
    // explicitly set the empty list; same posture as no value at all,
    // refuses everything). Distinct from unset env (also undefined →
    // default-deny). The behavioral end-state is identical (refuse all),
    // but the intent differs and observability would show the difference.
    expect(sched.shellAllowlist).toEqual([]);
  });
});

describe("v0.18.9 Perry's required guard — explicit opts win over env", () => {
  let home: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0189-guard-"));
    savedEnv = process.env["SKILLSCRIPT_SHELL_ALLOWLIST"];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env["SKILLSCRIPT_SHELL_ALLOWLIST"];
    else process.env["SKILLSCRIPT_SHELL_ALLOWLIST"] = savedEnv;
    rmSync(home, { recursive: true, force: true });
  });

  it("explicit shellAllowlist: [] resists env override (deny-all lockdown is authoritative)", () => {
    process.env["SKILLSCRIPT_SHELL_ALLOWLIST"] = "curl,git,jq";
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      shellAllowlist: [], // explicit deny-all
    });
    const sched = wired.scheduler as unknown as { shellAllowlist: string[] | undefined };
    // SECURITY-LOAD-BEARING: env's "curl,git,jq" must NOT widen the
    // adopter's explicit []. If this assertion ever fails, an env var
    // would silently override an adopter's intentional lockdown.
    expect(sched.shellAllowlist).toEqual([]);
  });

  it("explicit shellAllowlist: [<list>] resists env override", () => {
    process.env["SKILLSCRIPT_SHELL_ALLOWLIST"] = "curl,git,jq,bash,ssh,kubectl";
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      shellAllowlist: ["echo", "true"], // explicit narrow list
    });
    const sched = wired.scheduler as unknown as { shellAllowlist: string[] | undefined };
    // Adopter's narrow list wins; env's wider list does NOT widen.
    expect(sched.shellAllowlist).toEqual(["echo", "true"]);
  });

  it("explicit undefined (omitted opt) → env fallback fires", () => {
    process.env["SKILLSCRIPT_SHELL_ALLOWLIST"] = "curl";
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      // shellAllowlist deliberately omitted → undefined → env fallback fires
    });
    const sched = wired.scheduler as unknown as { shellAllowlist: string[] | undefined };
    expect(sched.shellAllowlist).toEqual(["curl"]);
  });
});

describe("v0.18.9 error message names all three wiring paths (CR (c))", () => {
  it("ShellBinaryNotAllowedError.remediation cites env, config, and bootstrap opt", async () => {
    // Direct import to assert error-message shape without firing a full
    // skill execution. The message MUST list all three wiring paths so
    // the remediation is actionable for ALL adopter shapes (CLI, config,
    // programmatic).
    const { ShellBinaryNotAllowedError } = await import("../src/errors.js");
    const err = new ShellBinaryNotAllowedError("curl", ["echo"], "fetch");
    expect(err.remediation).toMatch(/SKILLSCRIPT_SHELL_ALLOWLIST/);
    expect(err.remediation).toMatch(/skillscript\.config\.json/);
    expect(err.remediation).toMatch(/bootstrap\(\{ shellAllowlist/);
    expect(err.remediation).toMatch(/skillfile shell-audit/);
    // Names the offending binary too
    expect(err.remediation).toMatch(/curl/);
  });
});
