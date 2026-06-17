import { describe, it, expect, afterEach } from "vitest";
import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSkillByName, executeSkillFromSource } from "../src/composition.js";
import { Registry } from "../src/connectors/registry.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import {
  setSecuredMode,
  setApprovalPublicKey,
  generateApprovalKeypair,
  stampApprovalEd25519,
} from "../src/approval.js";
import { ApprovalRejectedError } from "../src/errors.js";

/**
 * v1.0 Gate #7 — Phase 1b end-to-end through the real composition paths.
 * Secured mode ON: an approved (v3-signed) skill runs with effects; a Draft is
 * hard-refused by-name; an unsigned source body runs but effects are refused;
 * a signed source body runs with effects. Boundary OFF preserves free-run.
 */

const PROBE = "/tmp/secgate-e2e.txt";
const BODY = `# Skill: t
# Status: Draft
# Output: text
run:
    emit(text="ran")
    file_write(path="${PROBE}", content="x", approved="audit")
default: run
`;

const keys = generateApprovalKeypair();
const SIGNED = stampApprovalEd25519(BODY, keys.privateKeyPem); // # Status: Approved v3:<sig>

const homes: string[] = [];
/** Real store with `body` on disk under skill name "t". The store would
 * auto-stamp a v3 body back to v1 (the Phase 1c gap), so for the signed body we
 * store a Draft then overwrite the file on disk with the real v3 signature. */
async function storeOnDisk(body: string): Promise<FilesystemSkillStore> {
  const home = mkdtempSync(join(tmpdir(), "secgate-"));
  homes.push(home);
  const store = new FilesystemSkillStore(home);
  await store.store("t", BODY); // lands Draft (no auto-stamp surprise)
  writeFileSync(join(home, "t.skill.md"), body);
  return store;
}
function ctx() {
  return { registry: new Registry(), shellAllowlist: [] as string[], enableUnsafeShell: false };
}
const refused = (errs: { message: string }[]) =>
  errs.find((e) => /secured mode requires an approved/i.test(e.message));

afterEach(() => {
  setSecuredMode(false);
  setApprovalPublicKey(null);
  rmSync(PROBE, { force: true });
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("Gate #7 e2e — secured mode through the real paths", () => {
  it("by-name: an Approved v3-signed skill RUNS with effects authorized", async () => {
    setApprovalPublicKey(keys.publicKeyPem);
    setSecuredMode(true);
    const store = await storeOnDisk(SIGNED);
    const r = await executeSkillByName("t", {}, { ctx: ctx(), skillStore: store });
    expect(refused(r.errors)).toBeUndefined();
    expect(r.transcript).toContain("ran");
  });

  it("by-name: a Draft skill is hard-REFUSED (never executes)", async () => {
    setApprovalPublicKey(keys.publicKeyPem);
    setSecuredMode(true);
    const store = await storeOnDisk(BODY);
    await expect(
      executeSkillByName("t", {}, { ctx: ctx(), skillStore: store }),
    ).rejects.toThrow(ApprovalRejectedError);
  });

  it("source-mode: an UNSIGNED body runs but effects are REFUSED", async () => {
    setApprovalPublicKey(keys.publicKeyPem);
    setSecuredMode(true);
    const r = await executeSkillFromSource(BODY, {}, { ctx: ctx() });
    expect(r.transcript).toContain("ran"); // emit (non-effectful) still fired
    expect(refused(r.errors)).toBeDefined(); // file_write refused at the choke
  });

  it("source-mode: a SIGNED body runs WITH effects (operator approved exactly this body)", async () => {
    setApprovalPublicKey(keys.publicKeyPem);
    setSecuredMode(true);
    const r = await executeSkillFromSource(SIGNED, {}, { ctx: ctx() });
    expect(refused(r.errors)).toBeUndefined();
  });

  it("boundary OFF: unsigned source runs effects freely (zero behavior change)", async () => {
    setSecuredMode(false);
    const r = await executeSkillFromSource(BODY, {}, { ctx: ctx() });
    expect(refused(r.errors)).toBeUndefined();
  });
});
