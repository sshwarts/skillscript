import { readFileSync } from "node:fs";

/**
 * Runtime version read from `package.json` once at module load. Single
 * source of truth for the runtime/server/CLI version surface — pre-v0.2.12
 * the version was duplicated in three places (`package.json`,
 * `cli.ts:VERSION`, `mcp-server.ts:McpServer.version` default) and one of
 * the three slipped on v0.2.11 (Bug 20 in Perry's R2 harness).
 *
 * Resolution: `import.meta.url` points at the compiled file under `dist/`
 * at runtime (or under `src/` during a ts-node dev run); `package.json` is
 * always one directory up from there. Same relative path in both layouts.
 */
function resolveRuntimeVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = readFileSync(pkgUrl, "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version !== "") return pkg.version;
  } catch {
    /* fall through — return the "unknown" sentinel below */
  }
  // If package.json is unreachable (bundling edge case, malformed JSON),
  // surface that explicitly rather than reporting a stale hardcoded
  // version. Downstream tools can detect the sentinel.
  return "0.0.0-unresolved";
}

export const RUNTIME_VERSION: string = resolveRuntimeVersion();
