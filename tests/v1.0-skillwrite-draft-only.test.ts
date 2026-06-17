import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import {
  setSecuredMode,
  setApprovalPublicKey,
  generateApprovalKeypair,
  stampApprovalEd25519,
} from "../src/approval.js";

/**
 * v1.0 Gate #7 — Phase 1c: skill_write cannot self-approve in secured mode.
 *
 * The store has no private key, so it cannot mint approval. An Approved write is
 * honored ONLY if the body already carries a valid v3 signature (the approve
 * flow). An agent declaring `# Status: Approved` is forced to Draft. This closes
 * the auto-stamp self-approval vector.
 */

const keys = generateApprovalKeypair();
const homes: string[] = [];
function freshStore(): FilesystemSkillStore {
  const home = mkdtempSync(join(tmpdir(), "draftonly-"));
  homes.push(home);
  return new FilesystemSkillStore(home);
}
const DRAFT = `# Skill: t
# Status: Draft
run:
    emit(text="hi")
default: run
`;

afterEach(() => {
  setSecuredMode(false);
  setApprovalPublicKey(null);
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("skill_write self-approval closure (secured mode)", () => {
  it("an agent-declared `# Status: Approved` (no signature) is forced to Draft", async () => {
    setApprovalPublicKey(keys.publicKeyPem);
    setSecuredMode(true);
    const store = freshStore();
    const info = await store.store("t", DRAFT.replace("Draft", "Approved"));
    expect(info.status).toBe("Draft");
  });

  it("a body carrying a valid v3 signature lands Approved (the approve flow path)", async () => {
    setApprovalPublicKey(keys.publicKeyPem);
    setSecuredMode(true);
    const store = freshStore();
    const signed = stampApprovalEd25519(DRAFT, keys.privateKeyPem); // # Status: Approved v3:<sig>
    const info = await store.store("t", signed);
    expect(info.status).toBe("Approved");
  });

  it("a v3 signature from a DIFFERENT key is NOT honored — forced to Draft", async () => {
    setApprovalPublicKey(keys.publicKeyPem); // store trusts THIS key
    setSecuredMode(true);
    const store = freshStore();
    const other = generateApprovalKeypair();
    const signedWithOther = stampApprovalEd25519(DRAFT, other.privateKeyPem);
    const info = await store.store("t", signedWithOther);
    expect(info.status).toBe("Draft");
  });

  it("unsecured mode preserves the v0.9.1 v1 auto-stamp (Approved)", async () => {
    setSecuredMode(false);
    const store = freshStore();
    const info = await store.store("t", DRAFT.replace("Draft", "Approved"));
    expect(info.status).toBe("Approved");
  });
});
