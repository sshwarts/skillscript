import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { compile } from "../src/compile.js";

/**
 * v0.39.0 — `# OnError:` header removed.
 *
 * Ratified 2026-07-09, deferred, then lost for ten minor versions (Perry thread
 * e4544e8d / board card 6ceeea9f). The header parsed AND validated its target,
 * but was NEVER wired to runtime error handling — a skill carrying it had no
 * recovery at all despite appearances (silent false promise), and a bad target
 * even failed compile for a feature that did nothing.
 *
 * Removal makes `# OnError:` a hard tier-1 parse error pointing at `else:` /
 * `(fallback:)`, so the latent "no error handling" surfaces at compile instead
 * of hiding. `${ERROR_CONTEXT}` is unaffected — it belongs to `else:`.
 */

const withOnError = (target = "some-handler"): string =>
  `# Skill: t\n# Status: Draft\n# OnError: ${target}\nrun:\n    emit(text="body")\ndefault: run\n`;

describe("v0.39.0 — # OnError: removed (hard parse error)", () => {
  it("parse() records a parseError naming the removal + the alternatives", () => {
    const p = parse(withOnError("any-skill"));
    const e = p.parseErrors.find((m) => m.includes("# OnError:"));
    expect(e).toBeDefined();
    expect(e).toMatch(/no longer a supported header/i);
    expect(e).toMatch(/else:/);
    expect(e).toMatch(/fallback:/);
  });

  it("the diagnostic fires regardless of the named target (the header is gone, not just its target validation)", () => {
    // Previously `# OnError: <existing>` compiled clean and `<missing>` failed on
    // the target lookup. Now the header itself is rejected either way.
    for (const target of ["known-child", "definitely-missing-skill", ""]) {
      const p = parse(`# Skill: t\n# Status: Draft\n# OnError: ${target}\nrun:\n    emit(text="b")\ndefault: run\n`);
      expect(p.parseErrors.some((m) => m.includes("# OnError:"))).toBe(true);
    }
  });

  it("no longer exposes an onError field on the parsed skill", () => {
    const p = parse(withOnError()) as unknown as Record<string, unknown>;
    expect("onError" in p).toBe(false);
  });

  it("the diagnostic is pure-parse — no SkillStore needed (old validation required one)", () => {
    const p = parse(withOnError()); // no skillStore anywhere in sight
    expect(p.parseErrors.some((m) => m.includes("# OnError:"))).toBe(true);
  });

  it("compile() rejects a skill carrying # OnError: (tier-1 — blocks)", async () => {
    await expect(compile(withOnError("existing-or-not"))).rejects.toThrow();
  });

  it("a skill WITHOUT # OnError: still compiles clean (control — removal is surgical)", async () => {
    const clean = `# Skill: t\n# Status: Draft\nrun:\n    emit(text="body")\ndefault: run\n`;
    await expect(compile(clean)).resolves.toBeDefined();
  });
});
