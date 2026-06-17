import { describe, it, expect, afterEach } from "vitest";
import {
  generateApprovalKeypair,
  signApprovalEd25519,
  stampApprovalEd25519,
  verifyApprovalToken,
  evaluateApprovalGate,
  canonicalizeForSigning,
  setSecuredMode,
  setApprovalPublicKey,
  stampApprovalToken,
  ED25519_VERSION,
} from "../src/approval.js";

/**
 * v1.0 Gate #7 — Phase 1a: the v3 Ed25519 asymmetric approval credential.
 *
 * Sign with the operator's private key (approve-time only); verify with the
 * public key (runtime, non-secret). In secured mode the gate accepts v3 ONLY
 * and REJECTS every symmetric (forgeable) scheme. Canonicalization is structural
 * whitespace only — never touches content inside string-literal values.
 */

const SKILL = `# Skill: t
# Status: Draft

run:
    $set MSG = "hello   world"
    emit(text="\${MSG}")
default: run
`;

// Module config is process-wide; reset after every test so cases don't leak.
afterEach(() => {
  setSecuredMode(false);
  setApprovalPublicKey(null);
});

describe("v3 Ed25519 — sign / verify roundtrip", () => {
  it("a body signed with the private key verifies with the public key", () => {
    const { publicKeyPem, privateKeyPem } = generateApprovalKeypair();
    setApprovalPublicKey(publicKeyPem);
    const stamped = stampApprovalEd25519(SKILL, privateKeyPem);
    const token = `${ED25519_VERSION}:${signApprovalEd25519(SKILL, privateKeyPem).token}`;
    const v = verifyApprovalToken(stamped, token);
    expect(v.ok).toBe(true);
  });

  it("evaluateApprovalGate passes a properly v3-signed + stamped body", () => {
    const { publicKeyPem, privateKeyPem } = generateApprovalKeypair();
    setApprovalPublicKey(publicKeyPem);
    setSecuredMode(true);
    const stamped = stampApprovalEd25519(SKILL, privateKeyPem);
    expect(evaluateApprovalGate(stamped).ok).toBe(true);
  });
});

describe("v3 — tamper-evidence + forgery resistance", () => {
  it("editing the body after signing invalidates the signature", () => {
    const { publicKeyPem, privateKeyPem } = generateApprovalKeypair();
    setApprovalPublicKey(publicKeyPem);
    const stamped = stampApprovalEd25519(SKILL, privateKeyPem);
    const tampered = stamped.replace('hello   world', 'malicious');
    expect(evaluateApprovalGate(tampered).ok).toBe(false);
  });

  it("a signature from a DIFFERENT private key does not verify", () => {
    const a = generateApprovalKeypair();
    const b = generateApprovalKeypair();
    setApprovalPublicKey(a.publicKeyPem); // runtime trusts key A
    const stampedWithB = stampApprovalEd25519(SKILL, b.privateKeyPem); // attacker signs with B
    expect(evaluateApprovalGate(stampedWithB).ok).toBe(false);
  });

  it("v3 verification fails gracefully when no public key is configured", () => {
    const { privateKeyPem } = generateApprovalKeypair();
    setApprovalPublicKey(null);
    const stamped = stampApprovalEd25519(SKILL, privateKeyPem);
    const r = evaluateApprovalGate(stamped);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no approval public key/i);
  });
});

describe("secured mode — rejects every non-v3 (forgeable) scheme", () => {
  it("a valid v1/crc32 token is REJECTED in secured mode (not merely superseded)", () => {
    const { publicKeyPem } = generateApprovalKeypair();
    setApprovalPublicKey(publicKeyPem);
    setSecuredMode(true);
    const v1Stamped = stampApprovalToken(SKILL, "v1"); // a perfectly valid crc32 stamp
    const r = evaluateApprovalGate(v1Stamped);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not accepted in secured mode/i);
  });

  it("the same v1 token IS accepted when secured mode is OFF (legacy preserved)", () => {
    const v1Stamped = stampApprovalToken(SKILL, "v1");
    expect(evaluateApprovalGate(v1Stamped).ok).toBe(true);
  });
});

describe("mode-aware messaging", () => {
  it("secured-mode Draft refusal uses the closed-loop copy (safety gate, human review)", () => {
    setApprovalPublicKey(generateApprovalKeypair().publicKeyPem);
    setSecuredMode(true);
    const r = evaluateApprovalGate(SKILL); // Draft
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/intentional safety gate/i);
      expect(r.reason).toMatch(/human must review/i);
    }
  });

  it("missing-token message does NOT leak the token format", () => {
    const naked = SKILL.replace("# Status: Draft", "# Status: Approved");
    const r = evaluateApprovalGate(naked);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toMatch(/v1:/);
      expect(r.reason).not.toMatch(/vN:/);
    }
  });
});

describe("canonicalization — structural whitespace only", () => {
  it("normalizes CRLF/CR to LF so a body signed on one platform verifies on another", () => {
    const { publicKeyPem, privateKeyPem } = generateApprovalKeypair();
    setApprovalPublicKey(publicKeyPem);
    const stamped = stampApprovalEd25519(SKILL, privateKeyPem);
    const crlf = stamped.replace(/\n/g, "\r\n"); // same body, different line endings
    expect(evaluateApprovalGate(crlf).ok).toBe(true);
  });

  it("preserves interior whitespace inside string values (canonical form is content-faithful)", () => {
    // The two bodies differ ONLY by interior string whitespace → must NOT
    // canonicalize the same (else a re-sign or a distinct skill could collide).
    const a = canonicalizeForSigning(`# Skill: t\nrun:\n    $set X = "a   b"\ndefault: run\n`);
    const b = canonicalizeForSigning(`# Skill: t\nrun:\n    $set X = "a b"\ndefault: run\n`);
    expect(a).not.toBe(b);
  });

  it("excludes the # Status: line so stamping doesn't perturb its own input", () => {
    const withDraft = canonicalizeForSigning("# Skill: t\n# Status: Draft\nrun:\n    emit(text=\"hi\")\ndefault: run\n");
    const withApproved = canonicalizeForSigning("# Skill: t\n# Status: Approved v3:abc\nrun:\n    emit(text=\"hi\")\ndefault: run\n");
    expect(withDraft).toBe(withApproved);
  });
});
