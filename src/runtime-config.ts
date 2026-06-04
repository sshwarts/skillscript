// v0.7.3 — canonical `skillscript.config.json` loader. Externalizes the
// runtime knobs that today are scattered across constructor args + CLI flags
// + env vars. One file, one shape, one substitution convention.
//
// Driver: Joe-Programmer two-instance posture. Running dev-skillscript and an
// adopter-wiring instance on the same machine requires independent ports,
// data dirs, db paths, etc. Scattered knobs make that hard; a declarative
// config makes it a copy-and-tweak operation.
//
// **Surface shape** — matches `connectors.json`'s `${ENV}` substitution
// convention so authors only learn one syntax. Missing file → empty config
// (gracefully merges into defaults). Malformed JSON / unresolved ${VAR} →
// structured errors via the result; caller decides whether to abort.
//
// **Apply contract.** This file does NOT instantiate the runtime; it only
// parses + validates. Callers spread the result into `BootstrapOpts` (or the
// CLI's flag-handling) explicitly. Keeps the boundary clean — config-loader
// has no runtime imports, runtime has no config-file dependency.

import { readFileSync } from "node:fs";
import { resolveEnvSubstitution } from "./connectors/config.js";

/**
 * Canonical config shape. Every field optional; defaults come from the
 * runtime's existing argument-default logic. Adopters declare only what
 * they want to override.
 */
export interface SkillscriptConfig {
  /** Absolute or relative path; relative resolves against `cwd`. */
  skillsDir?: string;
  /** Absolute or relative path; trace records written here. */
  traceDir?: string;
  /** SQLite memory store db path. Absent → no DataStore wired. */
  dataDbPath?: string;
  /** Scheduler poll interval. Default 30s. */
  pollIntervalSeconds?: number;
  /** When true, `shell(unsafe=true)` ops are permitted. Default false. */
  enableUnsafeShell?: boolean;
  /**
   * v0.17.4 — when true, outside-MCP `skill_write` forces every write
   * to land Draft regardless of body declaration. Closes the
   * agent-self-approval path for adopters wanting an explicit human
   * approval gate. Default `false` (v0.9.1 self-approval preserved).
   *
   * Env-var override: `SKILLSCRIPT_FORCE_ALWAYS_DRAFT=true` takes
   * precedence over this config field (the CLI applies the cascade).
   */
  forceAlwaysDraft?: boolean;
  /** Runtime mode label surfaced via `runtime_capabilities`. */
  mode?: "serve" | "dashboard";
  /** Imperative-trigger persistence file path. */
  triggersFilePath?: string;
  /** Path to `connectors.json`. */
  connectorsConfigPath?: string;
  /** Dashboard / HTTP server config. */
  dashboard?: {
    /** TCP port. Default 7878. */
    port?: number;
    /** Bind address. Default "127.0.0.1". */
    host?: string;
    /**
     * v0.17.0 — inbound HTTP header name for host-attested caller identity
     * (e.g., `"X-Agent-Id"`). When set, the runtime reads this header on
     * every `/rpc` request, threads the value into `McpRequestCtx.callerIdentity`,
     * and `skill_write` uses it as `SkillMeta.author`. Unset → existing
     * v0.16.8 behavior (author = runtime's writer identity). Multi-agent
     * hosts (NanoClaw-style) configure this; single-user / single-tenant
     * adopters leave it unset.
     */
    mcpCallerIdentityHeader?: string;
  };
}

export interface LoadSkillscriptConfigOpts {
  /** Path to `skillscript.config.json`. Missing file → graceful empty result. */
  path: string;
  /** Process env for `${VAR}` resolution. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface LoadSkillscriptConfigResult {
  config: SkillscriptConfig;
  /** Hard errors from parsing / validation / env resolution. */
  errors: string[];
}

/**
 * Read + parse `skillscript.config.json` at the given path. Resolves
 * `${VAR}` substitutions on every string leaf. Missing file → empty
 * config + no errors (graceful: not every deployment uses an external
 * config file). Malformed JSON or unset ${VAR} → returned in `errors[]`
 * for the caller to log and decide on.
 *
 * Validation is structural-only: field types are checked when present
 * (e.g., `port` must be a number); unknown fields are tolerated so
 * future-version configs don't fail-loud on older runtimes.
 */
export function loadSkillscriptConfig(opts: LoadSkillscriptConfigOpts): LoadSkillscriptConfigResult {
  const env = opts.env ?? process.env;
  let raw: string;
  try {
    raw = readFileSync(opts.path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { config: {}, errors: [] };
    return { config: {}, errors: [`skillscript.config.json: failed to read '${opts.path}': ${(err as Error).message}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { config: {}, errors: [`skillscript.config.json: malformed JSON in '${opts.path}': ${(err as Error).message}`] };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { config: {}, errors: [`skillscript.config.json: top-level must be an object. Got: ${Array.isArray(parsed) ? "array" : typeof parsed}.`] };
  }

  const errors: string[] = [];
  const resolved = resolveSubstitutions(parsed as Record<string, unknown>, env, errors);
  if (errors.length > 0) return { config: {}, errors };

  const config: SkillscriptConfig = {};
  const obj = resolved as Record<string, unknown>;

  const stringFields = ["skillsDir", "traceDir", "dataDbPath", "triggersFilePath", "connectorsConfigPath"] as const;
  for (const field of stringFields) {
    if (obj[field] === undefined) continue;
    if (typeof obj[field] !== "string") {
      errors.push(`skillscript.config.json: field '${field}' must be a string (got ${typeof obj[field]}).`);
      continue;
    }
    (config as Record<string, unknown>)[field] = obj[field];
  }

  if (obj["pollIntervalSeconds"] !== undefined) {
    if (typeof obj["pollIntervalSeconds"] !== "number" || obj["pollIntervalSeconds"] <= 0) {
      errors.push(`skillscript.config.json: field 'pollIntervalSeconds' must be a positive number.`);
    } else {
      config.pollIntervalSeconds = obj["pollIntervalSeconds"];
    }
  }

  if (obj["enableUnsafeShell"] !== undefined) {
    if (typeof obj["enableUnsafeShell"] !== "boolean") {
      errors.push(`skillscript.config.json: field 'enableUnsafeShell' must be a boolean.`);
    } else {
      config.enableUnsafeShell = obj["enableUnsafeShell"];
    }
  }

  if (obj["forceAlwaysDraft"] !== undefined) {
    if (typeof obj["forceAlwaysDraft"] !== "boolean") {
      errors.push(`skillscript.config.json: field 'forceAlwaysDraft' must be a boolean.`);
    } else {
      config.forceAlwaysDraft = obj["forceAlwaysDraft"];
    }
  }

  if (obj["mode"] !== undefined) {
    if (obj["mode"] !== "serve" && obj["mode"] !== "dashboard") {
      errors.push(`skillscript.config.json: field 'mode' must be 'serve' or 'dashboard' (got '${String(obj["mode"])}').`);
    } else {
      config.mode = obj["mode"];
    }
  }

  if (obj["dashboard"] !== undefined) {
    if (obj["dashboard"] === null || typeof obj["dashboard"] !== "object" || Array.isArray(obj["dashboard"])) {
      errors.push(`skillscript.config.json: field 'dashboard' must be an object.`);
    } else {
      const dash = obj["dashboard"] as Record<string, unknown>;
      const dashboard: { port?: number; host?: string; mcpCallerIdentityHeader?: string } = {};
      if (dash["port"] !== undefined) {
        if (typeof dash["port"] !== "number" || !Number.isInteger(dash["port"]) || dash["port"] < 1 || dash["port"] > 65535) {
          errors.push(`skillscript.config.json: field 'dashboard.port' must be an integer 1-65535.`);
        } else {
          dashboard.port = dash["port"];
        }
      }
      if (dash["host"] !== undefined) {
        if (typeof dash["host"] !== "string") {
          errors.push(`skillscript.config.json: field 'dashboard.host' must be a string.`);
        } else {
          dashboard.host = dash["host"];
        }
      }
      if (dash["mcpCallerIdentityHeader"] !== undefined) {
        if (typeof dash["mcpCallerIdentityHeader"] !== "string" || dash["mcpCallerIdentityHeader"] === "") {
          errors.push(`skillscript.config.json: field 'dashboard.mcpCallerIdentityHeader' must be a non-empty string.`);
        } else {
          dashboard.mcpCallerIdentityHeader = dash["mcpCallerIdentityHeader"];
        }
      }
      if (dashboard.port !== undefined || dashboard.host !== undefined || dashboard.mcpCallerIdentityHeader !== undefined) {
        config.dashboard = dashboard;
      }
    }
  }

  return { config, errors };
}

/** Recursively resolve `${VAR}` substitutions on every string leaf. */
function resolveSubstitutions(value: unknown, env: NodeJS.ProcessEnv, errors: string[]): unknown {
  if (typeof value === "string") {
    try { return resolveEnvSubstitution(value, env); }
    catch (err) { errors.push(`skillscript.config.json: ${(err as Error).message}`); return value; }
  }
  if (Array.isArray(value)) return value.map((v) => resolveSubstitutions(v, env, errors));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveSubstitutions(v, env, errors);
    return out;
  }
  return value;
}
