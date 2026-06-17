import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import {
  stampApprovalEd25519,
  generateApprovalKeypair,
  setSecuredMode,
  setApprovalPublicKey,
} from "../src/approval.js";

/**
 * v1.0 Gate #7 — the CLI `execute` path must honor secured mode. Before the fix
 * it resolved `securedMode` from env but never armed it, so an unapproved skill
 * ran its effects via the CLI — a side door around the boundary. The guarantee
 * is "an unapproved skill cannot execute in any effectful way, regardless of
 * method"; the CLI is a method. These spawn the real built CLI and assert on a
 * filesystem side effect (the skill writes a marker file or it doesn't).
 */

const ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(ROOT, "dist", "cli.js");
const homes: string[] = [];

function setup() {
  const home = mkdtempSync(join(tmpdir(), "cli-secured-"));
  homes.push(home);
  const skillsDir = join(home, "skills");
  const ws = join(home, "ws");
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(ws, { recursive: true });
  const { publicKeyPem, privateKeyPem } = generateApprovalKeypair();
  const pubFile = join(home, "approval.pub");
  const keyFile = join(home, "approval.key");
  writeFileSync(pubFile, publicKeyPem);
  writeFileSync(keyFile, privateKeyPem);
  const marker = join(ws, "EFFECT.txt");
  return { home, skillsDir, ws, pubFile, keyFile, privateKeyPem, publicKeyPem, marker };
}

function effectBody(marker: string): string {
  return `# Skill: effect-probe\n# Status: Approved\nrun:\n    file_write(path="${marker}", content="fired", approved="x")\ndefault: run\n`;
}

function runExecute(home: string, ws: string, pubFile: string, keyFile: string, secured: boolean) {
  const r = spawnSync("node", [CLI, "execute", "effect-probe"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      SKILLSCRIPT_HOME: home,
      SKILLSCRIPT_FS_ALLOWLIST: ws,
      SKILLSCRIPT_APPROVAL_PUBLIC_KEY_FILE: pubFile,
      SKILLSCRIPT_APPROVAL_KEY_FILE: keyFile,
      ...(secured ? { SKILLSCRIPT_SECURED_MODE: "true" } : {}),
    },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

afterEach(() => {
  setSecuredMode(false);
  setApprovalPublicKey(null);
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("skillfile execute — secured mode is enforced on the CLI path", () => {
  it("SECURED + unapproved (v1) skill: effect refused, no file written", async () => {
    const { home, skillsDir, ws, pubFile, keyFile, marker } = setup();
    // unsecured store write → lands Approved under a v1 stamp (the pre-secured artifact)
    await new FilesystemSkillStore(skillsDir).store("effect-probe", effectBody(marker), { status: "Approved" });

    const r = runExecute(home, ws, pubFile, keyFile, true);
    expect(r.stderr + r.stdout).toMatch(/SecuredModeEffectError/);
    expect(existsSync(marker), "effect must NOT have fired").toBe(false);
  });

  it("SECURED + v3-approved skill: effect fires", async () => {
    const { home, skillsDir, ws, pubFile, keyFile, privateKeyPem, publicKeyPem, marker } = setup();
    const store = new FilesystemSkillStore(skillsDir);
    // Arm secured + key so the store honors the v3 signature on write.
    setApprovalPublicKey(publicKeyPem);
    setSecuredMode(true);
    try {
      await store.store("effect-probe", stampApprovalEd25519(effectBody(marker), privateKeyPem), { status: "Approved" });
    } finally {
      setSecuredMode(false);
      setApprovalPublicKey(null);
    }

    const r = runExecute(home, ws, pubFile, keyFile, true);
    expect(existsSync(marker), "approved effect must fire").toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("fired");
  });

  it("UNSECURED: effect fires (no regression)", async () => {
    const { home, skillsDir, ws, pubFile, keyFile, marker } = setup();
    await new FilesystemSkillStore(skillsDir).store("effect-probe", effectBody(marker), { status: "Approved" });

    const r = runExecute(home, ws, pubFile, keyFile, false);
    expect(existsSync(marker), "unsecured effect must fire").toBe(true);
  });
});
