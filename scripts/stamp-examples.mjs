#!/usr/bin/env node
/**
 * v0.9.0 — stamp `# Status: Approved v1:<token>` into every example skill
 * shipped under examples/ and scaffold/examples/. Run after editing a
 * fixture body; idempotent (re-stamping always recomputes the same token
 * for unchanged content).
 *
 * Usage: node scripts/stamp-examples.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Tiny inlined CRC32 mirror of src/approval.ts — avoids importing built
// TS from the dist (which may be stale). Keep in sync with approval.ts.
const TABLE = (() => {
  const t = new Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(s) {
  const bytes = new TextEncoder().encode(s);
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return crc.toString(16).padStart(8, "0");
}

function stripStatusLine(body) {
  return body.split("\n").filter((l) => !/^\s*#\s*Status\s*:/i.test(l)).join("\n");
}

function stampBody(body) {
  const token = crc32(stripStatusLine(body));
  const line = `# Status: Approved v1:${token}`;
  if (/^\s*#\s*Status\s*:/m.test(body)) {
    return body.replace(/^\s*#\s*Status\s*:.*$/m, line);
  }
  if (/^#\s*Skill\s*:/m.test(body)) {
    return body.replace(/^(#\s*Skill\s*:.*?)$/m, `$1\n${line}`);
  }
  return `${line}\n${body}`;
}

const SCAN_DIRS = ["examples", "scaffold/examples"];

let count = 0;
for (const rel of SCAN_DIRS) {
  const abs = join(repoRoot, rel);
  let entries;
  try {
    entries = readdirSync(abs);
  } catch {
    continue;
  }
  for (const name of entries) {
    if (!name.endsWith(".skill.md")) continue;
    const p = join(abs, name);
    const src = readFileSync(p, "utf8");
    if (!/^\s*#\s*Status\s*:\s*Approved\b/m.test(src)) continue;
    const next = stampBody(src);
    if (next !== src) {
      writeFileSync(p, next, "utf8");
      count++;
      console.log(`stamped ${rel}/${name}`);
    }
  }
}
console.log(`done — ${count} file(s) updated`);
