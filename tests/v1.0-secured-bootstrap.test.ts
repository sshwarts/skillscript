import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import {
  isSecuredMode,
  setSecuredMode,
  setApprovalPublicKey,
  stampApprovalEd25519,
  evaluateApprovalGate,
} from "../src/approval.js";

/**
 * v1.0 Gate #7 — Phase 1c: bootstrap arms the boundary + provisions the keypair.
 * securedMode=true → ensure keypair (first-run provisioning, private 0600 OUTSIDE
 * the agent dir), load the public key for verification, set secured mode. The
 * runtime loads only the public key. Default OFF (flip-to-on ships post-migration).
 */

const homes: string[] = [];
function fresh() {
  const home = mkdtempSync(join(tmpdir(), "secboot-"));
  homes.push(home);
  return {
    skillsDir: join(home, "skills"),
    traceDir: join(home, "traces"),
    keyFile: join(home, "keys", "approval.key"),
    pubFile: join(home, "keys", "approval.pub"),
  };
}

afterEach(() => {
  setSecuredMode(false);
  setApprovalPublicKey(null);
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("Gate #7 Phase 1c — bootstrap secured-mode wiring + provisioning", () => {
  it("securedMode=true arms the boundary and provisions a keypair (private 0600)", () => {
    const p = fresh();
    bootstrap({ skillsDir: p.skillsDir, traceDir: p.traceDir, securedMode: true, approvalKeyFile: p.keyFile, approvalPublicKeyFile: p.pubFile });
    expect(isSecuredMode()).toBe(true);
    expect(existsSync(p.keyFile)).toBe(true);
    expect(existsSync(p.pubFile)).toBe(true);
    expect(statSync(p.keyFile).mode & 0o777).toBe(0o600);
  });

  it("loads the provisioned PUBLIC key — a sig made with the provisioned private key verifies", () => {
    const p = fresh();
    bootstrap({ skillsDir: p.skillsDir, traceDir: p.traceDir, securedMode: true, approvalKeyFile: p.keyFile, approvalPublicKeyFile: p.pubFile });
    const priv = readFileSync(p.keyFile, "utf8");
    const body = "# Skill: t\n# Status: Draft\nrun:\n    emit(text=\"hi\")\ndefault: run\n";
    const signed = stampApprovalEd25519(body, priv);
    expect(evaluateApprovalGate(signed).ok).toBe(true);
  });

  it("reuses an existing keypair on a second bootstrap (no regen)", () => {
    const p = fresh();
    bootstrap({ skillsDir: p.skillsDir, traceDir: p.traceDir, securedMode: true, approvalKeyFile: p.keyFile, approvalPublicKeyFile: p.pubFile });
    const firstPriv = readFileSync(p.keyFile, "utf8");
    bootstrap({ skillsDir: p.skillsDir, traceDir: p.traceDir, securedMode: true, approvalKeyFile: p.keyFile, approvalPublicKeyFile: p.pubFile });
    expect(readFileSync(p.keyFile, "utf8")).toBe(firstPriv);
  });

  it("securedMode=false leaves the boundary disarmed", () => {
    const p = fresh();
    bootstrap({ skillsDir: p.skillsDir, traceDir: p.traceDir, securedMode: false });
    expect(isSecuredMode()).toBe(false);
    expect(existsSync(p.keyFile)).toBe(false);
  });
});
