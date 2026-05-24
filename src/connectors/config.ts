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

import { readFileSync } from "node:fs";
import { CallbackMcpConnector } from "./mcp.js";
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

export const KNOWN_CONNECTOR_CLASSES: ReadonlyMap<string, ConnectorClassEntry> = new Map([
  ["CallbackMcpConnector", { ctor: CallbackMcpConnector }],
]);

/** Listable for error messages + runtime_capabilities discovery. */
export function listKnownConnectorClasses(): string[] {
  return [...KNOWN_CONNECTOR_CLASSES.keys()];
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

    let resolvedConfig: Record<string, unknown>;
    try {
      resolvedConfig = resolveConfigEnv(rawConfig, env) as Record<string, unknown>;
    } catch (err) {
      errors.push(`connectors.json: entry '${name}': ${(err as Error).message}`);
      continue;
    }

    const classEntry = KNOWN_CONNECTOR_CLASSES.get(className);
    if (classEntry === undefined) {
      errors.push(`connectors.json: entry '${name}' references unknown connector class '${className}'. Known classes: ${listKnownConnectorClasses().join(", ")}.`);
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

    connectors.push({ name, className, config: resolvedConfig, instance });
  }

  return { connectors, errors };
}
