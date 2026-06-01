/**
 * v0.9.0 — skill-approval mechanism.
 *
 * Canonical model (per thread 29b6208e):
 *   - Draft  : authored, lint+compile+view ok, cannot execute
 *   - Approved + valid hash-token : can execute (manual / trigger / composition)
 *
 * Approval token = `vN:<hex>` where N picks the hash function:
 *   v0 — reserved, rejected (naked "Approved" fails fast)
 *   v1 — CRC32 (bundled default; discipline-barrier strength)
 *   v2 — reserved for HMAC-SHA256
 *   v3 — reserved for Ed25519 signature
 *   adopter-extensible past v3 via `registerApprovalFn`
 *
 * Token is computed over the body *excluding* the `# Status:` line, so
 * stamping the token doesn't perturb its own input.
 */

const APPROVAL_FNS: Map<string, (bodyMinusStatus: string) => string> = new Map();
let PREFERRED_VERSION = "v1";

/**
 * Set the version used by `stampApprovalToken(body)` when no explicit
 * version is passed. Adopter bootstraps that register `v2` HMAC (or
 * stronger) call this to make the dashboard's approval flow stamp with
 * the upgraded function. Default stays `v1` (bundled CRC32).
 */
export function setPreferredApprovalVersion(version: string): void {
  if (version === "v0") {
    throw new Error(`approval version 'v0' is reserved`);
  }
  if (!APPROVAL_FNS.has(version)) {
    throw new Error(
      `approval version '${version}' is not registered; call registerApprovalFn first`,
    );
  }
  PREFERRED_VERSION = version;
}

export function getPreferredApprovalVersion(): string {
  return PREFERRED_VERSION;
}

export interface ApprovalToken {
  version: string;
  token: string;
}

export type ApprovalVerification =
  | { ok: true; token: ApprovalToken }
  | { ok: false; reason: string };

/**
 * Register an approval function for a version slot. Adopter-extension API;
 * intended for substituting cryptographic strength (HMAC, Ed25519) without
 * touching language internals. `v0` is reserved and cannot be registered.
 */
export function registerApprovalFn(version: string, fn: (body: string) => string): void {
  if (version === "v0") {
    throw new Error(`approval version 'v0' is reserved and cannot be registered`);
  }
  if (!/^v\d+$/.test(version)) {
    throw new Error(`approval version must match /^v\\d+$/ (got '${version}')`);
  }
  APPROVAL_FNS.set(version, fn);
}

export function getApprovalFn(version: string): ((body: string) => string) | null {
  return APPROVAL_FNS.get(version) ?? null;
}

export function registeredApprovalVersions(): string[] {
  return [...APPROVAL_FNS.keys()].sort();
}

/**
 * Strip the `# Status:` header line from a skill body. The hash input is the
 * body MINUS this line — renaming or re-versioning a skill doesn't invalidate
 * approval, only body edits do. Per spec point 3 in 29b6208e.
 */
export function stripStatusLineForHashing(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^\s*#\s*Status\s*:/i.test(line))
    .join("\n");
}

/**
 * Parse a token string of the form `vN:<token>` into its parts. Returns
 * null on shape mismatch — caller surfaces a clear error to the operator.
 */
export function parseApprovalToken(raw: string): ApprovalToken | null {
  const m = /^(v\d+):([A-Za-z0-9_-]+)$/.exec(raw.trim());
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { version: m[1], token: m[2] };
}

/**
 * Compute the canonical approval token for a body at a given version. The
 * dashboard calls this when stamping `# Status: Approved <token>`.
 */
export function computeApprovalToken(body: string, version: string = "v1"): ApprovalToken {
  if (version === "v0") {
    throw new Error(`approval version 'v0' is reserved`);
  }
  const fn = APPROVAL_FNS.get(version);
  if (!fn) {
    throw new Error(
      `approval version '${version}' is not registered (available: ${registeredApprovalVersions().join(", ") || "none"})`,
    );
  }
  return { version, token: fn(stripStatusLineForHashing(body)) };
}

/**
 * Verify a stored token against the current body. Called by runtime at every
 * execution entry point. A mismatch means the body was edited since approval,
 * so the human-approval gate must run again.
 */
export function verifyApprovalToken(body: string, rawToken: string): ApprovalVerification {
  const parsed = parseApprovalToken(rawToken);
  if (!parsed) {
    return {
      ok: false,
      reason: `approval token has invalid shape — expected 'vN:<token>', got '${rawToken}'`,
    };
  }
  if (parsed.version === "v0") {
    return { ok: false, reason: `approval version 'v0' is reserved` };
  }
  const fn = APPROVAL_FNS.get(parsed.version);
  if (!fn) {
    return {
      ok: false,
      reason: `approval version '${parsed.version}' is not registered (available: ${registeredApprovalVersions().join(", ") || "none"})`,
    };
  }
  const expected = fn(stripStatusLineForHashing(body));
  if (expected !== parsed.token) {
    return {
      ok: false,
      reason: `approval token mismatch — skill body has been edited since approval; re-approve via dashboard`,
    };
  }
  return { ok: true, token: parsed };
}

/**
 * Extract the status + (optional) approval token from a skill body's
 * `# Status:` header. Mirrors the parser's split-on-whitespace logic so
 * SkillStore can read status without re-parsing the whole skill.
 *
 * Returns:
 *   - `null` if no `# Status:` header is present or the value is unparseable
 *   - `{ status, approvalToken: null }` for Draft/Disabled or naked Approved
 *   - `{ status: "Approved", approvalToken: "vN:..." }` when stamped
 */
export function extractStatusFromBody(body: string): { status: "Draft" | "Approved" | "Disabled"; approvalToken: string | null } | null {
  const m = /^\s*#\s*Status\s*:\s*(.+?)\s*$/m.exec(body);
  if (!m) return null;
  const raw = (m[1] ?? "").trim();
  const parts = raw.split(/\s+/);
  const statusRaw = (parts[0] ?? "").toLowerCase();
  const tokenRaw = parts.slice(1).join(" ").trim();
  let status: "Draft" | "Approved" | "Disabled";
  if (statusRaw === "draft") status = "Draft";
  else if (statusRaw === "approved") status = "Approved";
  else if (statusRaw === "disabled") status = "Disabled";
  else return null;
  return { status, approvalToken: tokenRaw.length > 0 ? tokenRaw : null };
}

/**
 * Universal execution-time gate. Called at every dispatch entry point
 * (scheduler.dispatchSkill, MCP execute_skill handler, in-skill
 * `$ execute_skill` op, compile-time `&` data-skill inline). Returns ok
 * iff status is Approved AND the body's stamped token re-computes correctly.
 *
 * v0.9.0 — supersedes the v0.8.x "status === Approved" check; that check
 * remains the first gate, but a stamped + verified token is now required.
 */
export function evaluateApprovalGate(body: string): ApprovalVerification {
  const extracted = extractStatusFromBody(body);
  if (extracted === null) {
    return { ok: false, reason: `skill has no \`# Status:\` header — defaults to Draft, execution refused` };
  }
  if (extracted.status === "Disabled") {
    return { ok: false, reason: `skill status is 'Disabled' — execution refused` };
  }
  if (extracted.status === "Draft") {
    return { ok: false, reason: `skill status is 'Draft' — approve via dashboard before executing` };
  }
  if (extracted.approvalToken === null) {
    return {
      ok: false,
      reason: `skill is Approved but missing approval token — re-approve via dashboard to stamp '# Status: Approved v1:<token>'`,
    };
  }
  return verifyApprovalToken(body, extracted.approvalToken);
}

/**
 * Stamp `# Status: Approved <token>` into a skill body. Called by the
 * dashboard's approval flow + by test helpers that need to produce a
 * runnable fixture body programmatically. The function recomputes the
 * token over the body MINUS its `# Status:` line so the stamp is
 * idempotent regardless of the body's current header state.
 *
 * v0.15.0 — only replaces a `# Status:` line in the HEADER BLOCK (lines
 * from start until the first blank line or first non-`#`-comment line).
 * Pre-v0.15.0 the unbounded `/^# Status:/m` regex matched any line in
 * the body — including `# Status:` text inside string literals (e.g.
 * a parent skill that writes a child via `$ skill_write source="...# Status: Approved..."`).
 * Bug surfaced by the skill-store-roundtrip demo (cold-adopter probe,
 * 2026-06-01): the stamper mutated the inner string content + skipped
 * stamping the parent.
 */
export function stampApprovalToken(body: string, version?: string): string {
  const v = version ?? PREFERRED_VERSION;
  const token = computeApprovalToken(body, v);
  const line = `# Status: Approved ${token.version}:${token.token}`;
  const headerStatusLine = findHeaderStatusLine(body);
  if (headerStatusLine !== null) {
    const lines = body.split("\n");
    lines[headerStatusLine] = line;
    return lines.join("\n");
  }
  if (/^#\s*Skill\s*:/m.test(body)) {
    return body.replace(/^(#\s*Skill\s*:.*?)$/m, `$1\n${line}`);
  }
  return `${line}\n${body}`;
}

/**
 * Find the line index of the `# Status:` header in the body's HEADER
 * BLOCK, or null if none exists. The header block is the contiguous
 * `#`-comment lines at the top of the body, terminated by the first
 * blank line or the first non-`#`-prefixed line. Skill-content inside
 * string literals (e.g. `source="""# Status: ..."""`) lives below the
 * header block, so this scan stops short and leaves it untouched.
 */
function findHeaderStatusLine(body: string): number | null {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    // Blank line or non-`#`-comment terminates the header block.
    if (trimmed === "" || !trimmed.startsWith("#")) return null;
    if (/^#\s*Status\s*:/.test(trimmed)) return i;
  }
  return null;
}

// ─── v1: CRC32 reference impl ─────────────────────────────────────────────────

const CRC32_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const idx = (crc ^ (bytes[i] ?? 0)) & 0xff;
    crc = (CRC32_TABLE[idx] ?? 0) ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return crc.toString(16).padStart(8, "0");
}

registerApprovalFn("v1", crc32Utf8);
