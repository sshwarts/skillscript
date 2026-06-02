// Path-traversal-safe path joining.
//
// Used at filesystem boundaries (TraceStore.write/query/get, and any
// adopter-facing surface that interpolates an untrusted string into a
// disk path) so attacker-controlled inputs — skill names from header
// declarations, traceIds from MCP/CLI args, etc. — can't escape the
// configured base directory via `..` traversal or absolute-path
// injection.
//
// Replaces the prior whitelist-substitution `sanitize()` pattern which
// left literal `.` / `..` intact (the substitution `[^A-Za-z0-9._-]`
// excluded slashes but allowed the bare-dot traversal vector).

import { join } from "node:path";
import { InvalidPathError } from "./errors.js";

/**
 * Join `base` with `parts` after validating each part:
 *   - non-empty
 *   - not an all-dots sequence (`.`, `..`, `...`, etc.)
 *   - no path separators (`/`, `\`) or null bytes
 *
 * Throws `InvalidPathError` on any violation. Callers that want graceful
 * behavior (skip-on-bad-input rather than throw) should catch the error
 * and decide policy.
 */
export function safePathJoin(base: string, ...parts: string[]): string {
  for (const part of parts) {
    validatePathComponent(part);
  }
  return join(base, ...parts);
}

/**
 * Validate a single path component against the safePathJoin rules.
 * Throws `InvalidPathError` on violation. Exposed separately for callers
 * that need to validate untrusted input before string-concatenating
 * (e.g., `${traceId}.json`) since the validation must happen on the
 * raw component, before extension append.
 */
export function validatePathComponent(part: string): void {
  if (part === "") {
    throw new InvalidPathError(part, "empty path component");
  }
  if (/^\.+$/.test(part)) {
    throw new InvalidPathError(part, "all-dots path component (path-traversal vector)");
  }
  if (part.includes("/") || part.includes("\\") || part.includes("\0")) {
    throw new InvalidPathError(part, "path separator or null byte in component");
  }
}
