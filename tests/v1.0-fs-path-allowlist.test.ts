import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathUnderAllowedRoot, canonicalizePath } from "../src/safe-path.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";

/**
 * v1.0 Gate #7 — filesystem path allowlist (the third allowlist; mirrors shell).
 * file_read/file_write may only touch paths under an operator-allowed root.
 * DEFAULT-DENY. Canonicalized (realpath) before the check so `..` traversal and
 * symlink evasion can't escape — the classic allowlist bypasses.
 */

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "fsallow-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("isPathUnderAllowedRoot — default-deny + under-root", () => {
  it("default-deny: undefined or empty allowlist refuses everything", () => {
    expect(isPathUnderAllowedRoot("/tmp/x", undefined)).toBe(false);
    expect(isPathUnderAllowedRoot("/tmp/x", [])).toBe(false);
  });
  it("a path under an allowed root is permitted", () => {
    const root = tmp();
    writeFileSync(join(root, "f.txt"), "x");
    expect(isPathUnderAllowedRoot(join(root, "f.txt"), [root])).toBe(true);
    expect(isPathUnderAllowedRoot(root, [root])).toBe(true); // the root itself
  });
  it("a path outside every allowed root is refused", () => {
    const root = tmp();
    expect(isPathUnderAllowedRoot("/etc/passwd", [root])).toBe(false);
  });
});

describe("isPathUnderAllowedRoot — bypass resistance (the security-critical part)", () => {
  it("`..` traversal out of an allowed root is refused (canonicalized first)", () => {
    const root = tmp();
    // /<root>/../../etc/passwd canonicalizes to /etc/passwd — must NOT pass.
    expect(isPathUnderAllowedRoot(join(root, "..", "..", "etc", "passwd"), [root])).toBe(false);
  });
  it("a symlink inside an allowed root pointing OUTSIDE is refused (realpath resolves it)", () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "secret.txt"), "SECRET");
    symlinkSync(outside, join(root, "link")); // root/link -> outside
    // root/link/secret.txt LOOKS under root, but realpath resolves to outside.
    expect(isPathUnderAllowedRoot(join(root, "link", "secret.txt"), [root])).toBe(false);
  });
  it("symlink + `..` cannot escape (the resolve-then-realpath ordering bug, Perry's catch)", () => {
    const root = tmp();
    const outside = tmp();
    symlinkSync(outside, join(root, "link")); // root/link -> outside (a sibling)
    // RAW path (skill paths are raw strings, never join()-normalized — join would
    // lexically collapse `link/..` before we see it). `link` resolves to `outside`,
    // so `link/..` is outside's parent → escape is NOT under root. Must be refused
    // (the old resolve()-first impl allowed it — Perry's catch).
    const rawEscape = join(root, "link") + "/../escape";
    expect(isPathUnderAllowedRoot(rawEscape, [root])).toBe(false);
  });
  it("canonicalizePath resolves a not-yet-existing file under a symlinked parent", () => {
    const root = tmp();
    const outside = tmp();
    symlinkSync(outside, join(root, "link"));
    // A to-be-created file under the symlinked dir resolves to the real (outside) path.
    const canon = canonicalizePath(join(root, "link", "newfile.txt"));
    expect(canon.startsWith(canonicalizePath(outside))).toBe(true);
    expect(canon.startsWith(canonicalizePath(root) + "/")).toBe(false);
  });
});

describe("file_write / file_read enforcement (default-deny end to end)", () => {
  async function run(source: string, fsAllowlist?: string[]) {
    const compiled = await compile(source, { skipLintPreflight: true });
    return execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
      ...(fsAllowlist !== undefined ? { fsAllowlist } : {}),
    });
  }

  it("file_write under an allowed root succeeds; outside is refused", async () => {
    const root = tmp();
    const ok = `# Skill: t
# Status: Approved
run:
    file_write(path="${join(root, "out.txt")}", content="x", approved="a")
default: run
`;
    const r1 = await run(ok, [root]);
    expect(r1.errors).toEqual([]);

    const bad = `# Skill: t
# Status: Approved
run:
    file_write(path="/tmp/fsallow-escape.txt", content="x", approved="a")
default: run
`;
    const r2 = await run(bad, [root]); // /tmp not under <root>
    expect(r2.errors.find((e) => /not under any operator-allowed/i.test(e.message))).toBeDefined();
  });

  it("default-deny: no fsAllowlist refuses file_write entirely", async () => {
    const root = tmp();
    const src = `# Skill: t
# Status: Approved
run:
    file_write(path="${join(root, "out.txt")}", content="x", approved="a")
default: run
`;
    const r = await run(src); // no fsAllowlist
    expect(r.errors.find((e) => /not under any operator-allowed/i.test(e.message))).toBeDefined();
  });
});
