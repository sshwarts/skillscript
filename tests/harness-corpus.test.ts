import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { compile } from "../src/compile.js";
import type { BootstrapResult } from "../src/bootstrap.js";
import { HARNESS_MANIFEST } from "./fixtures/harness/manifest.js";

/**
 * Wild-and-crazy harness corpus regression test. 66 cold-author skills
 * produced by 6 sub-agents authoring against v0.2.9 (memory `b6176e02`).
 * Promoted to permanent fixtures per Perry's call (memory `c04c1ac3`).
 *
 * Asserts each skill's compile outcome matches its classified expectation:
 *   - `pass` skills compile clean
 *   - `needs-inputs` skills compile clean WHEN their declared inputs are provided
 *   - `needs-fallback-skill` skills compile clean when a stub fallback skill
 *      is stored under the declared `# OnError:` name (exercises Bug 11 —
 *      forward-reference deferred resolution gap; v0.3.0 candidate)
 *   - `intentional-failure` skills (FR manifestos using hypothetical block-
 *      introducers like `parallel:` / `@@`) fail with the expected error
 *      pattern
 *
 * Future changes to the parser, lint engine, or render path will run
 * against this corpus automatically. A new bug surfacing on any skill is
 * a real regression — fix it.
 */

const SKILLS_DIR = join(__dirname, "fixtures", "harness", "skills");

let home: string;
let wired: BootstrapResult;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "harness-corpus-"));
  wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });

  // Load every skill from the corpus into the SkillStore. This resolves
  // `&` data-skill references AND lets `# OnError:` fallback skills be
  // found at compile time (for the ones we stub below).
  const files = readdirSync(SKILLS_DIR).sort();
  for (const file of files) {
    const src = readFileSync(join(SKILLS_DIR, file), "utf8");
    const m = src.match(/^# Skill: (.+)$/m);
    if (m === null) continue;
    const name = m[1]!.trim();
    try { await wired.skillStore.store(name, src); } catch { /* duplicate name; the second wins */ }
  }

  // Stub minimal fallback skills for the `needs-fallback-skill` entries.
  // Cold authors declared `# OnError: <name>` for fallbacks they didn't
  // write. v0.3.0 candidate (Bug 11) would defer this resolution.
  for (const entry of HARNESS_MANIFEST) {
    if (entry.classification.kind !== "needs-fallback-skill") continue;
    const fb = entry.classification.fallbackName;
    const stub = `# Skill: ${fb}\n# Description: stub fallback skill for harness regression test\n# Status: Approved\nfb:\n    ! fallback fired\ndefault: fb\n`;
    try { await wired.skillStore.store(fb, stub); } catch { /* already stubbed */ }
  }
});

afterAll(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
});

describe("Wild-and-crazy harness corpus (66 cold-author skills)", () => {
  it("manifest covers every skill file (no orphans, no missing)", () => {
    const onDisk = new Set(readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".skill.md")));
    const manifested = new Set(HARNESS_MANIFEST.map((e) => e.file));
    expect(onDisk.size).toBe(manifested.size);
    for (const f of onDisk) expect(manifested.has(f), `${f} on disk but not in manifest`).toBe(true);
    for (const f of manifested) expect(onDisk.has(f), `${f} in manifest but not on disk`).toBe(true);
  });

  for (const entry of HARNESS_MANIFEST) {
    const c = entry.classification;
    it(`${entry.file}: ${c.kind}`, async () => {
      const src = readFileSync(join(SKILLS_DIR, entry.file), "utf8");
      if (c.kind === "pass") {
        await expect(compile(src, { skillStore: wired.skillStore })).resolves.toBeDefined();
        return;
      }
      if (c.kind === "needs-inputs") {
        await expect(compile(src, { skillStore: wired.skillStore, inputs: c.inputs })).resolves.toBeDefined();
        return;
      }
      if (c.kind === "needs-fallback-skill") {
        // Stub was wired in beforeAll — should compile clean now. Some
        // entries also need inputs (the skill declares required vars on
        // top of the fallback reference).
        const opts = c.inputs !== undefined
          ? { skillStore: wired.skillStore, inputs: c.inputs }
          : { skillStore: wired.skillStore };
        await expect(compile(src, opts)).resolves.toBeDefined();
        return;
      }
      // intentional-failure: must throw, error matches the pattern.
      try {
        await compile(src, { skillStore: wired.skillStore });
        expect.fail(`Expected compile() to fail for ${entry.file} (${c.reason}) but it succeeded`);
      } catch (err) {
        expect((err as Error).message, c.reason).toMatch(c.errorPattern);
      }
    });
  }
});
