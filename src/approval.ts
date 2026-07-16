/**
 * Skill-approval mechanism (v1.0 Gate #7).
 *
 * Canonical model:
 *   - Draft / Disabled : cannot execute (lint + compile + view still ok).
 *   - Approved         : executes. The runtime MODE decides whether that
 *     approval must be cryptographically KEYED:
 *       • unsecured — UNKEYED. A bare `# Status: Approved` is sufficient; no
 *         token, no signature. (No tamper-evidence — that's the keyless cost.)
 *       • secured   — KEYED. The body must carry a valid `v3:<sig>` Ed25519
 *         signature (sign with the operator's private key at approve-time;
 *         verify with the public key at runtime — the private key never reaches
 *         the runtime). Unforgeable without the private key.
 *
 * Only v3 exists. The legacy symmetric hash-token scheme (v1 CRC32 + the
 * per-version `registerApprovalFn` registry) is retired — pre-1.0 it had no
 * install base, and unsecured mode no longer uses tokens at all.
 *
 * The signature is computed over the body *excluding* its `# Status:` line, so
 * stamping the token doesn't perturb its own input.
 */

import { sign as edSign, verify as edVerify, generateKeyPairSync } from "node:crypto";

/** The asymmetric (Ed25519) version slot — the only approval credential. */
export const ED25519_VERSION = "v3";

// ─── Secured-mode config (process-wide, set at boot) ─────────────────────────
// When secured mode is ON, the gate requires a valid v3 signature for an
// Approved skill to execute effectfully. The public key verifies v3; the
// runtime never holds the private key. Set from runtime config in bootstrap.
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
  const noStatus = stripStatusLineForHashing(lf);
  // Also exclude the `# Tags:` line. Tags are pure classification metadata —
  // they can't change what a skill DOES and are never an authz input — so a
  // tag edit must be approval-neutral (the operator's signature stays valid,
  // no drop-to-Draft). Same carve-out rationale as the `# Status:` line above.
  // Both sign and verify run through here, so the exclusion is symmetric;
  // every behavioral edit still invalidates the signature.
  return noStatus
    .split("\n")
    .filter((line) => !/^\s*#\s*Tags\s*:/i.test(line))
    .join("\n");
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
 * Verify a stored token against the current body. Called in secured mode at
 * every execution entry point. Only a v3 Ed25519 signature is accepted; an
 * invalid signature (edited body, wrong key) or any other version is refused.
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

  // Only v3 is accepted. Any other version (a retired v1, or a forged scheme)
  // is refused — re-approve with the operator's key.
  return {
    ok: false,
    reason: `approval token version '${parsed.version}' is not accepted — a v3 signed approval is required; re-approve via the dashboard`,
  };
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
 * Stamp `# Status: Approved v3:<sig>` into a body, signing with the operator's
 * Ed25519 private key — APPROVE-TIME ONLY (dashboard / `skillfile approve`).
 *
 * Only the HEADER-BLOCK `# Status:` line is rewritten (lines from the start
 * until the first blank or non-`#` line), so `# Status:` text inside a string
 * literal (e.g. a parent that writes a child via `$ skill_write source="..."`)
 * is left untouched.
 */
export function stampApprovalEd25519(body: string, privateKeyPem: string): string {
  return writeApprovedStatusLine(body, signApprovalEd25519(body, privateKeyPem));
}

/** Write `# Status: Approved <version>:<token>` into the header block, replacing
 * an existing header `# Status:` line or inserting after `# Skill:`. */
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

