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

import { join, resolve, sep, dirname, basename } from "node:path";
import { realpathSync } from "node:fs";
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

// ─── v1.0 Gate #7 — filesystem path allowlist (the third allowlist) ────────────
//
// Mirrors the shell-binary allowlist: operator-owned, DEFAULT-DENY, gates
// file_read/file_write at the runtime. Independent of the approval gate
// (approval = WHO may run effects; this = WHAT paths a file op may touch — even
// an approved skill can't read /etc or the operator's keyfile).

/**
 * Canonicalize a path to its real absolute form: resolve to absolute, then
 * `realpath` the longest EXISTING ancestor (following symlinks) and re-append any
 * not-yet-existing tail. This is the security-critical step — it defeats both
 * `..` traversal (`allowed/../../etc/x`) AND symlink evasion (a symlink inside an
 * allowed dir pointing out, or a symlinked ancestor of a to-be-created file),
 * the classic allowlist bypasses. For a file that doesn't exist yet, the parent
 * chain is still realpath'd so a symlinked parent can't escape the check.
 *
 * NOTE on TOCTOU: this returns the resolved real path at call time; a symlink
 * swapped between this check and the actual open is a residual (full TOCTOU
 * safety needs fd-based / O_NOFOLLOW opens). Checking the resolved real path is
 * the standard mitigation and what we ship for 1.0.
 */
export function canonicalizePath(target: string): string {
  const abs = resolve(target);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // reached filesystem root; nothing resolvable
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Is `target` within one of the operator's allowed filesystem roots? DEFAULT-DENY:
 * an undefined or empty allowlist returns false (no file op permitted), mirroring
 * the shell binary allowlist's default-deny. Both the target and each root are
 * canonicalized (realpath) before comparison, so `..` and symlinks can't evade.
 */
export function isPathUnderAllowedRoot(target: string, allowedRoots: string[] | undefined): boolean {
  if (allowedRoots === undefined || allowedRoots.length === 0) return false;
  const canonTarget = canonicalizePath(target);
  for (const root of allowedRoots) {
    const canonRoot = canonicalizePath(root);
    if (canonTarget === canonRoot || canonTarget.startsWith(canonRoot + sep)) return true;
  }
  return false;
}
