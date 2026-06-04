// v0.17.4 — Minimal `.env` file loader.
//
// Reads `KEY=value` lines from a `.env` file at boot and populates
// `process.env` for entries not already set. Shell-set env vars take
// precedence over file values — the standard dotenv contract.
//
// Hand-rolled rather than pulling the `dotenv` npm dep — the parsing
// surface is small enough and we control what we support. Supported
// shape:
//   KEY=value
//   KEY="value with spaces"
//   KEY='value with spaces'
//   # comment lines starting with #
//   <blank lines>
//
// Not supported (deliberately — keep it tight; adopters can shell-escape
// or move to JSON config for these cases):
//   - Multi-line values
//   - Variable interpolation within values (${OTHER_VAR})
//   - Export prefix (`export KEY=value`)
//   - Inline comments after a value
//
// Per-line malformations log a warning + skip the line, so a typo in
// one entry doesn't sink the whole file.

import { readFileSync, existsSync } from "node:fs";

export interface LoadEnvFileOpts {
  /** Absolute path to the `.env` file. */
  path: string;
  /** Target env map to populate. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Optional logger for parse warnings. Default: silent. */
  log?: (msg: string) => void;
}

export interface LoadEnvFileResult {
  /** Number of key/value pairs successfully loaded. */
  loaded: number;
  /** Number of malformed lines skipped (already counted in warnings). */
  skipped: number;
  /** Number of keys whose value was preserved because the env already had a value. */
  preserved: number;
  /** Per-malformed-line messages (for caller-side logging if desired). */
  warnings: string[];
}

/**
 * Load a `.env` file into the target env map. Missing file → no-op,
 * not an error (the `.env` is optional adopter convenience).
 *
 * Precedence: existing env values WIN. The loader never overwrites a
 * shell-set var. This matches the standard `dotenv` contract and the
 * principle that more-specific surfaces (shell, Docker `-e`, systemd
 * Environment=) override the file convenience layer.
 */
export function loadEnvFile(opts: LoadEnvFileOpts): LoadEnvFileResult {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((): void => undefined);
  const result: LoadEnvFileResult = { loaded: 0, skipped: 0, preserved: 0, warnings: [] };

  if (!existsSync(opts.path)) return result;

  let raw: string;
  try {
    raw = readFileSync(opts.path, "utf8");
  } catch (err) {
    const msg = `.env: failed to read '${opts.path}': ${(err as Error).message}`;
    result.warnings.push(msg);
    log(msg);
    return result;
  }

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) {
      const msg = `.env line ${i + 1}: malformed entry (expected KEY=value): '${line.slice(0, 40)}${line.length > 40 ? "..." : ""}'`;
      result.warnings.push(msg);
      log(msg);
      result.skipped++;
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      const msg = `.env line ${i + 1}: invalid key name '${key}' (must match [A-Za-z_][A-Za-z0-9_]*)`;
      result.warnings.push(msg);
      log(msg);
      result.skipped++;
      continue;
    }
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (env[key] !== undefined) {
      result.preserved++;
      continue;
    }
    env[key] = value;
    result.loaded++;
  }

  return result;
}
