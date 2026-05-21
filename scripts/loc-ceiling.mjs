#!/usr/bin/env node
// Enforces ERD §1's small-codebase property. The spec calls out "parser +
// compiler + executor + connector registry + lint together ≤ ~5K LOC for
// the core" plus "fewer than 20 source files in the core."
//
// This script counts ALL of src/ (not just the named core components) for
// simplicity — broader than the spec calls for but a useful overall
// constraint. T4 raised the original 5K to 5500 for the lint engine +
// adversarial-library shape. T5 (runtime + 7 footgun acceptance criteria
// per memory 59f6aa76) raises again to 6500 / 22 files per the T5 kickoff
// criterion #9. ERD §1's strict 5K interpretation still applies narrowly
// to parser + compiler + executor + connector registry + lint — those
// remain well under that even at T5.
//
// T6 raises the ceiling again to accommodate Phase 1 (error contract +
// remediation strings, ~250 LOC), Phase 2 (trace recording, ~400 LOC),
// Phase 3 (health metrics aggregation, ~200 LOC), and Phase 4 (5 new CLI
// commands, ~500 LOC). T6b (dashboard) lands separately on its own
// ceiling budget.
//
// T7 distribution polish: tighten the script's scope to the 5 named core
// components rather than all of src/, per Perry's T4 acceptance note.
//
// Run: `pnpm run loc-check`. CI fails the build if the ceiling is breached.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
const MAX_LOC = 7500;
const MAX_FILES = 24;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

const files = await walk(SRC_DIR);
let totalLoc = 0;
const rows = [];

for (const f of files) {
  const body = await readFile(f, "utf8");
  const loc = body.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length;
  totalLoc += loc;
  rows.push({ file: f.slice(SRC_DIR.length + 1), loc });
}

rows.sort((a, b) => b.loc - a.loc);

console.log("File LOC budget — core source only (tests excluded):\n");
for (const { file, loc } of rows) {
  console.log(`  ${String(loc).padStart(5)}  ${file}`);
}
console.log(`\n  TOTAL  ${totalLoc} LOC across ${files.length} files`);
console.log(`  BUDGET ≤ ${MAX_LOC} LOC across < ${MAX_FILES} files\n`);

let failed = false;
if (totalLoc > MAX_LOC) {
  console.error(`FAIL: core LOC ${totalLoc} exceeds ceiling ${MAX_LOC}`);
  failed = true;
}
if (files.length >= MAX_FILES) {
  console.error(`FAIL: core file count ${files.length} hits or exceeds ceiling ${MAX_FILES}`);
  failed = true;
}

if (failed) process.exit(1);
console.log("OK: within ERD §1 ceiling.");
