#!/usr/bin/env node
// v0.15.0 — stamps every `.skill.md` in `examples/skillscripts/` with a
// valid `# Status: Approved v1:<token>` header, computed via the runtime's
// own `stampApprovalToken`. Idempotent: bodies already correctly stamped
// pass through unchanged.
//
// Run after editing any bundled skill body. The CI guard in
// `tests/dogfood-t7.test.ts` (case #14) catches drift on every `pnpm test`.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stampApprovalToken } from "../dist/approval.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLSCRIPTS_DIR = join(ROOT, "examples", "skillscripts");

const files = readdirSync(SKILLSCRIPTS_DIR).filter((f) => f.endsWith(".skill.md"));

let stamped = 0;
for (const file of files) {
  const path = join(SKILLSCRIPTS_DIR, file);
  const body = readFileSync(path, "utf8");
  const next = stampApprovalToken(body);
  if (next !== body) {
    writeFileSync(path, next, "utf8");
    stamped++;
    process.stdout.write(`stamped examples/skillscripts/${file}\n`);
  } else {
    process.stdout.write(`unchanged examples/skillscripts/${file}\n`);
  }
}
process.stdout.write(`${stamped}/${files.length} stamped\n`);
