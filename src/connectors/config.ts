// v0.4.0 — `connectors.json` loader. Reads + validates the per-host
// connector configuration file at runtime startup and wires the
// declared instances into the Registry.
//
// Spec: ERD §3 + Perry's v0.4.0 kickoff (b3f6c5ed) + amendment (58a9d3d3).
//
// Surface shape (matches Claude Desktop's `mcp.json` convention so authors
// don't carry two mental models):
//
//   {
//     "youtrack": {
//       "class": "RemoteMcpConnector",
//       "config": {
//         "command": "npx",
//         "args": ["mcp-remote", "https://...", "--header", "Authorization:${AUTH_HEADER}"],
//         "env": { "AUTH_HEADER": "Bearer ${YOUTRACK_TOKEN}" }
//       }
//     }
//   }
//
// **Credential discipline (v0.4.0 hard requirement, Perry's amendment):**
// `connectors.json` is secret-bearing. Default `.gitignore` excludes it;
// `connectors.json.example` ships at repo root as the template. See README.

import { readFileSync, existsSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { CallbackMcpConnector } from "./mcp.js";
import { RemoteMcpConnector } from "./mcp-remote.js";
import { LocalModelMcpConnector } from "./local-model-mcp.js";
import { MemoryStoreMcpConnector } from "./memory-store-mcp.js";
import type { McpConnector, McpConnectorClass } from "./types.js";

/**
 * Closed-set class registry. v0.4.0 ships with `CallbackMcpConnector`
 * registered for type-tracking + the lookup mechanism — but without a
 * `fromConfig` factory, since `CallbackMcpConnector` requires a dispatch
 * *function* that can't be expressed in JSON. Wire `CallbackMcpConnector`
 * via embedder code (see `bootstrap.ts`); use `connectors.json` for
 * classes whose configuration IS expressible as JSON (v0.4.1's
 * `RemoteMcpConnector` will be the first such class).
 *
 * Plugin-style runtime-arbitrary class loading is explicitly out of
 * scope (security surface + discoverability + API maturity per Perry
 * 8f723b6a). Future plugin-style support would need its own design pass
 * with explicit sandbox/whitelist framing.
 */
export interface ConnectorClassEntry {
  ctor: McpConnectorClass;
  /**
   * Factory that constructs an instance from the JSON `config` block.
   * Omit when the class can't be instantiated from JSON (e.g.
   * `CallbackMcpConnector` requires a dispatch function). Loader emits
   * a clear error if `connectors.json` references such a class.
   */
  fromConfig?: (config: Record<string, unknown>) => McpConnector;
}

export const KNOWN_CONNECTOR_CLASSES: ReadonlyMap<string, ConnectorClassEntry> = new Map<string, ConnectorClassEntry>([
  ["CallbackMcpConnector", { ctor: CallbackMcpConnector }],
  [
    "RemoteMcpConnector",
    {
      ctor: RemoteMcpConnector,
      fromConfig: (config: Record<string, unknown>) => RemoteMcpConnector.fromConfig(config),
    },
  ],
  // v0.7.2 — bridge classes registered for discoverability via
  // `runtime_capabilities({include:["mcpConnectorClasses"]})`. Like
  // `CallbackMcpConnector`, these are NOT JSON-config-wired (they need
  // a runtime LocalModel/MemoryStore instance, not just config). Bootstrap
  // auto-wires them via embedder code; adopters override by re-registering
  // under the same instance name.
  ["LocalModelMcpConnector", { ctor: LocalModelMcpConnector }],
  ["MemoryStoreMcpConnector", { ctor: MemoryStoreMcpConnector }],
]);

// v0.7.3 — adopter-registered connector classes. Mutable, separate from
// the bundled closed set so adopters don't edit `KNOWN_CONNECTOR_CLASSES`
// directly (which is merge-conflict bait every release that adds a bundled
// class). Public surface: `registerConnectorClass` / `unregisterConnectorClass`.
// Lookup in `loadConnectorsConfig` reads the union of both maps.
const adopterConnectorClasses = new Map<string, ConnectorClassEntry>();

/**
 * Register a custom `McpConnector` class so `connectors.json` entries can
 * reference it by name. Call from adopter bootstrap BEFORE `loadConnectorsConfig`
 * runs. Names override the bundled set on collision (adopter wins) — useful
 * for swapping a bundled class with a hardened variant.
 *
 * Throws if `name` is empty. Idempotent re-registration with the same entry
 * is allowed (lets bootstrap be re-runnable in tests / hot-reload paths).
 */
export function registerConnectorClass(name: string, entry: ConnectorClassEntry): void {
  if (name === "") throw new Error("registerConnectorClass: name must be non-empty");
  adopterConnectorClasses.set(name, entry);
}

/**
 * Remove an adopter-registered class. No-op if `name` isn't in the adopter
 * map (the bundled closed set is never affected by this call).
 */
export function unregisterConnectorClass(name: string): void {
  adopterConnectorClasses.delete(name);
}

/**
 * Lookup that respects the union: adopter overrides take precedence over
 * the bundled set. Returns `undefined` if neither map carries `name`.
 */
export function getConnectorClass(name: string): ConnectorClassEntry | undefined {
  return adopterConnectorClasses.get(name) ?? KNOWN_CONNECTOR_CLASSES.get(name);
}

/** Listable for error messages + runtime_capabilities discovery. Returns the union. */
export function listKnownConnectorClasses(): string[] {
  const names = new Set<string>([...KNOWN_CONNECTOR_CLASSES.keys(), ...adopterConnectorClasses.keys()]);
  return [...names];
}

/**
 * One configured connector instance. The `config` block is preserved
 * verbatim (with `${ENV}` substitutions resolved) so v0.4.1+ schema
 * additions like `allowed_tools` flow through without loader changes.
 */
export interface ConfiguredConnector {
  name: string;
  className: string;
  config: Record<string, unknown>;
  /** Constructed instance when the class declares a `fromConfig`. `undefined` otherwise (lint catches this as `unknown-connector-class`). */
  instance: McpConnector | undefined;
  /**
   * v0.4.1 — per-connector tool allowlist. `undefined` means "no
   * allowlist configured → allow all" (backward-compat with v0.4.0).
   * Empty array means "explicitly empty → allow none." Listed array
   * means "exactly these, nothing else." Lint + runtime both consult.
   */
  allowedTools?: string[];
}

export interface LoadConnectorsConfigResult {
  /** Configured connectors keyed by name. */
  connectors: ConfiguredConnector[];
  /** Hard errors from parsing/validation/instantiation. Surfaced at startup. */
  errors: string[];
}

export interface LoadConnectorsConfigOpts {
  /** Path to `connectors.json`. Missing file → graceful empty result. */
  path: string;
  /** Process env for `${VAR}` resolution. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * v0.4.1 — credential-discipline backstop. Walk up from `connectors.json`'s
 * dir looking for `.git/`. If found, check whether any `.gitignore` between
 * the file and the git root excludes `connectors.json`. Returns a warning
 * string when the file appears to be in a git repo BUT not gitignored.
 * `null` means either (a) not in a git repo, or (b) gitignored cleanly.
 *
 * Heuristic — not a full gitignore parser. Recognizes the canonical
 * exclusion patterns: `connectors.json`, `/connectors.json`, `*.json`
 * (broad), and anchored ancestor-dir matches. False negatives (warning
 * fires on a gitignored file) are possible with exotic gitignore shapes;
 * those are operator-fixable. False positives (warning suppressed on a
 * tracked file) are the worse outcome and the heuristic biases against.
 */
export function detectGitignoreRisk(configPath: string): string | null {
  let dir = dirname(resolve(configPath));
  const filename = basename(configPath);
  const gitignorePaths: string[] = [];
  let gitRoot: string | null = null;
  // Walk up looking for .git/ and collecting any .gitignore files along the way.
  while (true) {
    if (existsSync(`${dir}/.git`)) {
      gitRoot = dir;
      const rootGitignore = `${dir}/.gitignore`;
      if (existsSync(rootGitignore)) gitignorePaths.push(rootGitignore);
      break;
    }
    const localGitignore = `${dir}/.gitignore`;
    if (existsSync(localGitignore)) gitignorePaths.push(localGitignore);
    const parent = dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  if (gitRoot === null) return null; // not in a git repo
  // Scan all collected .gitignore files for any line that would exclude
  // the connectors.json filename. Patterns recognized: bare name, anchored
  // `/<name>`, anchored to subdir, or wildcard `*.json` (rare but valid).
  const patterns = [filename, `/${filename}`];
  for (const giPath of gitignorePaths) {
    let raw: string;
    try { raw = readFileSync(giPath, "utf8"); } catch { continue; }
    const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
    for (const line of lines) {
      if (patterns.includes(line)) return null; // explicitly ignored
      // Wildcard match: `*.json` or `*` — broad, assume covers the file.
      if (line === "*" || line === "*.json") return null;
    }
  }
  // In a git repo, but no .gitignore entry seems to cover connectors.json.
  // Warn (informational; not blocking).
  return `connectors.json appears to be in a git-tracked directory (${gitRoot}) without a .gitignore entry. Credentials in this file may end up committed. Add '/connectors.json' to your .gitignore — or use the bundled \`connectors.json.example\` template + \${ENV} substitution pattern instead.`;
}

/**
 * Resolve `${NAME}` patterns in a string against the provided env.
 * Missing var → throws (clear error rather than silent empty string).
 * Used by the loader on every string value in the `config` block.
 */
export function resolveEnvSubstitution(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const v = env[name];
    if (v === undefined) {
      throw new Error(`Environment variable '\${${name}}' referenced in connectors.json is not set.`);
    }
    return v;
  });
}

/** Walk a config tree and resolve `${NAME}` substitutions on every string leaf. */
function resolveConfigEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return resolveEnvSubstitution(value, env);
  if (Array.isArray(value)) return value.map((v) => resolveConfigEnv(v, env));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveConfigEnv(v, env);
    return out;
  }
  return value;
}

/**
 * Read + parse `connectors.json` at the given path. Validate the top-
 * level shape. Resolve `${VAR}` substitutions. Instantiate each entry
 * via the closed-set class registry's `fromConfig` factory (when
 * present; entries pointing at classes without one get a clear error
 * and a `null` instance, surfaced via `errors`).
 *
 * Missing file → returns `{connectors: [], errors: []}` (graceful: not
 * every deployment uses external connectors). Malformed JSON or
 * structural errors → returned in `errors[]` for the bootstrap caller
 * to log and refuse to start, or for the lint surface to consume.
 */
export function loadConnectorsConfig(opts: LoadConnectorsConfigOpts): LoadConnectorsConfigResult {
  const env = opts.env ?? process.env;

  let raw: string;
  try {
    raw = readFileSync(opts.path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { connectors: [], errors: [] };
    return { connectors: [], errors: [`connectors.json: failed to read '${opts.path}': ${(err as Error).message}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { connectors: [], errors: [`connectors.json: malformed JSON in '${opts.path}': ${(err as Error).message}`] };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { connectors: [], errors: [`connectors.json: top-level must be an object mapping connector names to {class, config}. Got: ${Array.isArray(parsed) ? "array" : typeof parsed}.`] };
  }

  const connectors: ConfiguredConnector[] = [];
  const errors: string[] = [];

  for (const [name, entry] of Object.entries(parsed)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`connectors.json: entry '${name}' must be an object with {class, config}. Got: ${Array.isArray(entry) ? "array" : entry === null ? "null" : typeof entry}.`);
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const className = obj["class"];
    if (typeof className !== "string" || className === "") {
      errors.push(`connectors.json: entry '${name}' is missing required string field 'class'.`);
      continue;
    }
    const rawConfig = obj["config"] ?? {};
    if (rawConfig === null || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      errors.push(`connectors.json: entry '${name}' field 'config' must be an object. Got: ${Array.isArray(rawConfig) ? "array" : typeof rawConfig}.`);
      continue;
    }

    // v0.4.1 env-block-as-scope: resolve `config.env` against process.env
    // FIRST, then merge into the substitution scope for the rest of the
    // config. Lets authors compose values like:
    //   env: { AUTH_HEADER: "Bearer ${YOUTRACK_TOKEN}" }
    //   args: ["--header", "Authorization:${AUTH_HEADER}"]
    // Matches Claude Desktop's `mcp.json` convention.
    let resolvedConfig: Record<string, unknown>;
    try {
      const cfgObj = rawConfig as Record<string, unknown>;
      const rawEnv = cfgObj["env"];
      let resolvedEnv: Record<string, string> | undefined;
      let scopedEnv: NodeJS.ProcessEnv = env;
      if (rawEnv !== undefined) {
        if (rawEnv === null || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
          errors.push(`connectors.json: entry '${name}' field 'config.env' must be an object of string values.`);
          continue;
        }
        resolvedEnv = {};
        for (const [k, v] of Object.entries(rawEnv)) {
          if (typeof v !== "string") {
            errors.push(`connectors.json: entry '${name}': config.env['${k}'] must be a string (got ${typeof v}).`);
            resolvedEnv = undefined;
            break;
          }
          resolvedEnv[k] = resolveEnvSubstitution(v, env);
        }
        if (resolvedEnv === undefined) continue;
        scopedEnv = { ...env, ...resolvedEnv };
      }
      // Resolve the rest of the config using the scoped env (process.env
      // plus the just-resolved env block). The env block itself goes in
      // pre-resolved to skip a redundant second pass.
      const restConfig: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cfgObj)) {
        if (k === "env") {
          if (resolvedEnv !== undefined) restConfig["env"] = resolvedEnv;
          continue;
        }
        restConfig[k] = resolveConfigEnv(v, scopedEnv);
      }
      resolvedConfig = restConfig;
    } catch (err) {
      errors.push(`connectors.json: entry '${name}': ${(err as Error).message}`);
      continue;
    }

    const classEntry = getConnectorClass(className);
    if (classEntry === undefined) {
      errors.push(`connectors.json: entry '${name}' references unknown connector class '${className}'. Known classes: ${listKnownConnectorClasses().join(", ")}. To register a custom class, call \`registerConnectorClass(name, entry)\` from your bootstrap code before \`loadConnectorsConfig\` runs.`);
      continue;
    }

    let instance: McpConnector | undefined;
    if (classEntry.fromConfig !== undefined) {
      try {
        instance = classEntry.fromConfig(resolvedConfig);
      } catch (err) {
        errors.push(`connectors.json: entry '${name}' failed to instantiate '${className}': ${(err as Error).message}`);
        continue;
      }
    } else {
      // No fromConfig means the class can't be JSON-instantiated. v0.4.0
      // ships with CallbackMcpConnector in this state — wire it via
      // embedder code. v0.4.1 adds RemoteMcpConnector with a fromConfig.
      errors.push(`connectors.json: entry '${name}' uses class '${className}' which doesn't support configuration via connectors.json. Wire this connector via embedder code instead, or use a JSON-instantiable class.`);
      continue;
    }

    // v0.4.1 — `allowed_tools` allowlist. Optional. Undefined = allow-all;
    // [] = allow-none (staging disable); listed = exactly-these.
    let allowedTools: string[] | undefined;
    const rawAllowed = obj["allowed_tools"];
    if (rawAllowed !== undefined) {
      if (!Array.isArray(rawAllowed) || !rawAllowed.every((t) => typeof t === "string")) {
        errors.push(`connectors.json: entry '${name}' field 'allowed_tools' must be an array of strings (got ${Array.isArray(rawAllowed) ? "array with non-string element" : typeof rawAllowed}).`);
        continue;
      }
      allowedTools = rawAllowed as string[];
    }

    connectors.push({
      name,
      className,
      config: resolvedConfig,
      instance,
      ...(allowedTools !== undefined ? { allowedTools } : {}),
    });
  }

  return { connectors, errors };
}
