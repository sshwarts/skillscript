/**
 * v0.9.0 — skill-approval mechanism.
 *
 * Canonical model (per thread 29b6208e):
 *   - Draft  : authored, lint+compile+view ok, cannot execute
 *   - Approved + valid hash-token : can execute (manual / trigger / composition)
 *
 * Approval token = `vN:<token>` where N picks the scheme:
 *   v0 — reserved, rejected (naked "Approved" fails fast)
 *   v1 — CRC32 (symmetric, recompute-and-compare). Tamper-EVIDENT only —
 *        forgeable by anyone with the algorithm. Legacy / unsecured-mode default.
 *   v2 — reserved for HMAC-SHA256 (never shipped; asymmetric chosen instead)
 *   v3 — Ed25519 signature (ASYMMETRIC). Sign with the operator's private key
 *        (approve-time only); verify with the public key (runtime, non-secret).
 *        The SECURED-MODE credential — unforgeable without the private key.
 *   adopter-extensible past v3 via `registerApprovalFn` (symmetric schemes).
 *
 * v1/v2 are symmetric (token = fn(body)); v3 is asymmetric (sign≠verify).
 * In SECURED MODE the gate verifies v3 ONLY and REJECTS every other version
 * (an accepted-if-present v1 would leave the forgeable path open).
 *
 * Token/signature is computed over the body *excluding* the `# Status:` line,
 * so stamping the token doesn't perturb its own input.
 */

import { sign as edSign, verify as edVerify, generateKeyPairSync } from "node:crypto";

const APPROVAL_FNS: Map<string, (bodyMinusStatus: string) => string> = new Map();
let PREFERRED_VERSION = "v1";

/** The asymmetric (Ed25519) version slot — the secured-mode credential. */
export const ED25519_VERSION = "v3";

// ─── Secured-mode config (process-wide, set at boot; mirrors PREFERRED_VERSION) ──
// When secured mode is ON, the gate accepts v3 signatures ONLY and rejects all
// symmetric (forgeable) schemes. The public key verifies v3; the runtime never
// holds the private key. Set from runtime config in bootstrap.
let SECURED_MODE = false;
let APPROVAL_PUBLIC_KEY_PEM: string | null = null;

export function setSecuredMode(on: boolean): void {
  SECURED_MODE = on;
}
export function isSecuredMode(): boolean {
  return SECURED_MODE;
}
/** Configure the Ed25519 PUBLIC key (PEM) used to verify v3 tokens. The private
 * key is never set here — it lives in the operator's keyfile, read only by the
 * approve flow, never by the runtime. */
export function setApprovalPublicKey(pem: string | null): void {
  APPROVAL_PUBLIC_KEY_PEM = pem;
}
export function hasApprovalPublicKey(): boolean {
  return APPROVAL_PUBLIC_KEY_PEM !== null;
}

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
  // `token` is present for a KEYED approval (verified v3 signature); absent for
  // an UNKEYED unsecured approval (bare `# Status: Approved`, no signature).
  | { ok: true; token?: ApprovalToken }
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
 * Canonical form signed/verified by the asymmetric (v3) scheme.
 *
 * STRUCTURAL whitespace only (per Perry's confirm): normalize line endings to
 * `\n` and exclude the `# Status:` line (where the signature lives — solves the
 * sign-its-own-input chicken-egg). It deliberately does NOT strip or collapse
 * trailing/interior whitespace — that could alter content INSIDE a string-literal
 * value (e.g. `$set X = "a   b"`), letting two distinct bodies canonicalize the
 * same or breaking a legitimate re-sign. Only `\r\n`/`\r` → `\n` is normalized,
 * so a body signed on one platform verifies on another; every real edit still
 * invalidates the signature (re-approval required — tamper-evidence preserved).
 */
export function canonicalizeForSigning(body: string): string {
  const lf = body.replace(/\r\n?/g, "\n");
  return stripStatusLineForHashing(lf);
}

// ─── v3: Ed25519 asymmetric signature ─────────────────────────────────────────

/**
 * Sign a body with the operator's Ed25519 private key (PEM). Returns the
 * `v3:<base64url>` token the dashboard/CLI approve flow stamps. APPROVE-TIME
 * ONLY — the private key never enters the runtime's verification path.
 */
export function signApprovalEd25519(body: string, privateKeyPem: string): ApprovalToken {
  const canonical = canonicalizeForSigning(body);
  const sig = edSign(null, Buffer.from(canonical, "utf8"), privateKeyPem);
  return { version: ED25519_VERSION, token: sig.toString("base64url") };
}

/** Verify a v3 token against the body using the configured public key. */
function verifyEd25519(body: string, tokenB64url: string): boolean {
  if (APPROVAL_PUBLIC_KEY_PEM === null) return false;
  const canonical = canonicalizeForSigning(body);
  let sig: Buffer;
  try {
    sig = Buffer.from(tokenB64url, "base64url");
  } catch {
    return false;
  }
  if (sig.length === 0) return false;
  try {
    return edVerify(null, Buffer.from(canonical, "utf8"), APPROVAL_PUBLIC_KEY_PEM, sig);
  } catch {
    return false;
  }
}

/**
 * Generate a fresh Ed25519 keypair for first-run provisioning. Returns PEM
 * strings: the private key goes to the operator's keyfile (never the runtime),
 * the public key into runtime config.
 */
export function generateApprovalKeypair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
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

  // v3 — asymmetric Ed25519 (the secured-mode credential). Verify the signature
  // with the configured public key; the private key never reaches this path.
  if (parsed.version === ED25519_VERSION) {
    if (verifyEd25519(body, parsed.token)) {
      return { ok: true, token: parsed };
    }
    return {
      ok: false,
      reason: APPROVAL_PUBLIC_KEY_PEM === null
        ? `approval signature cannot be verified — no approval public key is configured`
        : `approval signature is invalid — the body was edited since approval, or signed with a different key; re-approve via the dashboard`,
    };
  }

  // Secured mode accepts v3 ONLY. Every symmetric (forgeable) scheme is
  // REJECTED, not merely superseded — accepting a v1 if present leaves the
  // crc32 forgery path open.
  if (SECURED_MODE) {
    return {
      ok: false,
      reason: `approval token version '${parsed.version}' is not accepted in secured mode — re-approve via the dashboard (a signed approval is required)`,
    };
  }

  // Unsecured / legacy — symmetric recompute-and-compare (v1 crc32, adopter v2+).
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
 * `$ execute_skill` op, compile-time `&` data-skill inline).
 *
 * The Draft-vs-Approved status gate applies in BOTH modes — only an Approved
 * skill runs. The mode decides whether that approval must be KEYED:
 *
 *   • unsecured — approval is UNKEYED. A bare `# Status: Approved` header is
 *     sufficient: a co-located human/agent marked it Approved, with no
 *     signature. (No tamper-evidence — that's the cost of running keyless;
 *     adopters who want tamper-evidence run secured mode.)
 *   • secured — approval must be a valid v3 signature minted by the operator's
 *     key. A bare, unsigned, or legacy (v1) Approved is refused → re-approve
 *     with the key (`skillfile approve` / the dashboard).
 *
 * v1.0 Gate #7 — supersedes the v0.9.0 "stamped v1 token required in both
 * modes" model. v1 hash-stamps are retired: unsecured no longer mints or
 * requires them; secured requires v3. (Pre-1.0, the only v1 skills are our own
 * harness + examples, so there's no install base to preserve — `reapprove`
 * re-blesses any that move into a secured runtime.)
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
    return {
      ok: false,
      reason: SECURED_MODE
        ? `skill status is 'Draft' — this is an intentional safety gate, not an error to work around. A human must review and approve it via the dashboard before it can execute. Preview it with mechanical mode, or keep iterating as a Draft.`
        : `skill status is 'Draft' — approve via dashboard before executing`,
    };
  }
  // Approved. Unsecured: unkeyed approval — the status header alone is enough.
  if (!SECURED_MODE) {
    return { ok: true };
  }
  // Secured: a valid v3 signature is required.
  if (extracted.approvalToken === null) {
    // Deliberately does NOT disclose the token format (an attacker who learns
    // `vN:<token>` gets the exact shape to forge).
    return {
      ok: false,
      reason: `skill is marked Approved but carries no valid approval signature — re-approve via the dashboard`,
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
  return writeApprovedStatusLine(body, computeApprovalToken(body, v));
}

/**
 * Stamp `# Status: Approved v3:<sig>` into a body, signing with the operator's
 * Ed25519 private key. The approve-flow (dashboard/CLI) equivalent of
 * `stampApprovalToken` for the asymmetric scheme — APPROVE-TIME ONLY.
 */
export function stampApprovalEd25519(body: string, privateKeyPem: string): string {
  return writeApprovedStatusLine(body, signApprovalEd25519(body, privateKeyPem));
}

/** Write `# Status: Approved <version>:<token>` into the header block, replacing
 * an existing header `# Status:` line or inserting after `# Skill:`. Shared by
 * both the symmetric and asymmetric stampers. */
function writeApprovedStatusLine(body: string, token: ApprovalToken): string {
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
