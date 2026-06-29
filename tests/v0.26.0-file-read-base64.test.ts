/**
 * v0.26.0 — `file_read(path, encoding="base64")` (adopter request 7130c3bd).
 *
 * Reads a file's RAW bytes and base64-encodes them, so a binary file (image,
 * PDF) can be inlined into an API payload without utf8 corruption. "utf8"
 * (default) is unchanged; an unknown encoding is refused at runtime and flagged
 * tier-2 (`unknown-file-encoding`) at compile.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { lint } from "../src/lint.js";
import { Registry } from "../src/connectors/registry.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "v0.26.0-fr-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (src: string) => {
  const compiled = await compile(src, { skipLintPreflight: true });
  return execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
    registry: new Registry(),
    effectsAuthorized: true,
    fsAllowlist: [dir],
  });
};

describe("v0.26.0 — file_read encoding=base64", () => {
  it("base64-encodes the RAW bytes of a binary file (single line, no corruption)", async () => {
    // Bytes that are NOT valid utf8 — utf8 decode would corrupt them.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    const path = join(dir, "doc.bin");
    writeFileSync(path, bytes);
    const expected = bytes.toString("base64");
    const src = [
      "# Skill: r", "# Status: Draft", "",
      "default: t", "t:",
      `    file_read(path="${path}", encoding="base64") -> B64`,
    ].join("\n");
    const result = await run(src);
    expect(result.finalVars["B64"]).toBe(expected);
    expect(String(result.finalVars["B64"])).not.toContain("\n"); // single line
    expect(result.errors).toEqual([]);
  });

  it("default (no encoding) reads utf8 text — unchanged", async () => {
    const path = join(dir, "hi.txt");
    writeFileSync(path, "hello world");
    const src = ["# Skill: r", "# Status: Draft", "", "default: t", "t:", `    file_read(path="${path}") -> T`].join("\n");
    const result = await run(src);
    expect(result.finalVars["T"]).toBe("hello world");
  });

  it("refuses an unknown encoding at runtime", async () => {
    const path = join(dir, "hi.txt");
    writeFileSync(path, "x");
    const src = ["# Skill: r", "# Status: Draft", "", "default: t", "t:", `    file_read(path="${path}", encoding="bas64") -> X`].join("\n");
    const result = await run(src);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.errors)).toContain("unknown encoding");
  });

  it("fs allowlist gate still applies to a base64 read", async () => {
    // A path outside the allowlist is refused regardless of encoding.
    const outside = join(tmpdir(), "v0.26.0-outside-" + Math.random().toString(36).slice(2) + ".bin");
    writeFileSync(outside, Buffer.from([1, 2, 3]));
    try {
      const src = ["# Skill: r", "# Status: Draft", "", "default: t", "t:", `    file_read(path="${outside}", encoding="base64") -> B`].join("\n");
      const result = await run(src);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.errors)).toMatch(/allowlist|not allowed/i);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("lint: unknown-file-encoding (tier-2) flags a bad literal but not utf8/base64/${VAR}", async () => {
    const mk = (enc: string) =>
      ["# Skill: r", "# Status: Draft", "", "default: t", "t:", `    file_read(path="/x", encoding=${enc}) -> X`, '    emit(text="ok")'].join("\n");
    const bad = await lint(mk('"bas64"'));
    expect(bad.findings.find((f) => f.rule === "unknown-file-encoding")?.severity).toBe("warning");
    for (const ok of ['"utf8"', '"base64"', "${E}"]) {
      const r = await lint(mk(ok));
      expect(r.findings.map((f) => f.rule)).not.toContain("unknown-file-encoding");
    }
  });
});
