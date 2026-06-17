import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import {
  stampApprovalEd25519,
  generateApprovalKeypair,
  setSecuredMode,
  setApprovalPublicKey,
} from "../src/approval.js";

// Store a genuinely v3-Approved skill: the unsecured store writes a bare
// Approved (stripping any token), so the v3 signature only survives when secured
// mode + the public key are armed for the write (the store then honors the
// matching signature). Toggle back off after — the CLI is a separate process.
async function storeV3Approved(store: FilesystemSkillStore, name: string, src: string, pubPem: string, privPem: string): Promise<void> {
  setApprovalPublicKey(pubPem);
  setSecuredMode(true);
  try {
    await store.store(name, stampApprovalEd25519(src, privPem), { status: "Approved" });
  } finally {
    setSecuredMode(false);
    setApprovalPublicKey(null);
  }
}

/**
 * v1.0 Gate #7 Phase 3 — force-re-approve migration (`skillfile reapprove`).
 *
 * Secured mode rejects any Approved skill lacking a valid v3 signature (a bare
 * Approved minted in unsecured mode can't distinguish a human from an agent).
 * The default is force-re-approve — existing Approved skills are NOT
 * grandfathered. This command sweeps the
 * store, reports the migration set (Approved skills failing the secured gate),
 * and with `--apply` re-signs them in one batch. Dry-run needs only the public
 * key; `--apply` needs the private key (the operator's authorization).
 */

const ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(ROOT, "dist", "cli.js");
const homes: string[] = [];

function makeHome(): { home: string; skillsDir: string; pubFile: string; keyFile: string } {
  const home = mkdtempSync(join(tmpdir(), "reapprove-"));
  homes.push(home);
  const skillsDir = join(home, "skills");
  mkdirSync(skillsDir, { recursive: true });
  const { publicKeyPem, privateKeyPem } = generateApprovalKeypair();
  const pubFile = join(home, "approval.pub");
  const keyFile = join(home, "approval.key");
  writeFileSync(pubFile, publicKeyPem);
  writeFileSync(keyFile, privateKeyPem);
  return { home, skillsDir, pubFile, keyFile };
}

function body(name: string): string {
  return `# Skill: ${name}\n# Status: Approved\nrun:\n    emit("hi from ${name}")\ndefault: run\n`;
}

function runCli(args: string[], home: string, pubFile: string, keyFile?: string) {
  const r = spawnSync("node", [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      SKILLSCRIPT_HOME: home,
      SKILLSCRIPT_APPROVAL_PUBLIC_KEY_FILE: pubFile,
      ...(keyFile ? { SKILLSCRIPT_APPROVAL_KEY_FILE: keyFile } : {}),
    },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

afterEach(() => {
  setSecuredMode(false);
  setApprovalPublicKey(null);
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("skillfile reapprove — force-re-approve migration", () => {
  it("dry-run reports unsigned Approved skills as the migration set; v3 ones as already valid", async () => {
    const { home, skillsDir, pubFile, keyFile } = makeHome();
    const store = new FilesystemSkillStore(skillsDir);
    // legacy: bare Approved minted in unsecured mode (unsigned — needs re-bless)
    await store.store("legacy-a", body("legacy-a"), { status: "Approved" });
    await store.store("legacy-b", body("legacy-b"), { status: "Approved" });
    // already migrated: Approved under a v3 signature
    await storeV3Approved(store, "modern", body("modern"), readFileSync(pubFile, "utf8"), readFileSync(keyFile, "utf8"));

    const r = runCli(["reapprove"], home, pubFile);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Migration set — 2 Approved skills/);
    expect(r.stdout).toContain("legacy-a");
    expect(r.stdout).toContain("legacy-b");
    expect(r.stdout).toMatch(/1 already valid/);
    expect(r.stdout).not.toMatch(/^\s+• modern$/m); // modern is NOT in the set
    expect(r.stdout).toMatch(/Dry run — nothing changed/);
  });

  it("--apply re-blesses the whole migration set, and a re-run is idempotent (nothing left)", async () => {
    const { home, skillsDir, pubFile, keyFile } = makeHome();
    const store = new FilesystemSkillStore(skillsDir);
    await store.store("legacy-a", body("legacy-a"), { status: "Approved" });
    await store.store("legacy-b", body("legacy-b"), { status: "Approved" });

    const apply = runCli(["reapprove", "--apply"], home, pubFile, keyFile);
    expect(apply.code).toBe(0);
    expect(apply.stdout).toMatch(/re-blessed 'legacy-a'/);
    expect(apply.stdout).toMatch(/re-blessed 'legacy-b'/);
    expect(apply.stdout).toMatch(/Done — 2 re-blessed/);

    // Idempotent: the second sweep finds nothing.
    const again = runCli(["reapprove"], home, pubFile, keyFile);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/all carry a valid signature — nothing to migrate/);
  });

  it("--apply refuses without a private key (dry-run classification still works)", async () => {
    const { home, skillsDir, pubFile } = makeHome();
    const store = new FilesystemSkillStore(skillsDir);
    await store.store("legacy-a", body("legacy-a"), { status: "Approved" });
    // No SKILLSCRIPT_APPROVAL_KEY_FILE in env, and point it at a nonexistent path.
    const r = runCli(["reapprove", "--apply"], home, pubFile, join(home, "nope.key"));
    expect(r.code).toBe(66);
    expect(r.stderr).toMatch(/no approval private key/);
  });

  it("a single-skill scope limits the sweep to that skill", async () => {
    const { home, skillsDir, pubFile, keyFile } = makeHome();
    const store = new FilesystemSkillStore(skillsDir);
    await store.store("legacy-a", body("legacy-a"), { status: "Approved" });
    await store.store("legacy-b", body("legacy-b"), { status: "Approved" });

    const r = runCli(["reapprove", "legacy-a", "--apply"], home, pubFile, keyFile);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/re-blessed 'legacy-a'/);
    expect(r.stdout).not.toMatch(/legacy-b/);

    // legacy-b still in the migration set afterward.
    const rest = runCli(["reapprove"], home, pubFile, keyFile);
    expect(rest.stdout).toContain("legacy-b");
    expect(rest.stdout).not.toMatch(/• legacy-a/);
  });
});
