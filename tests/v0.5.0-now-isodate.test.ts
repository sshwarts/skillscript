import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { applyFilter, KNOWN_FILTERS } from "../src/filters.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.5.0 item 6 — $(NOW) ISO-8601 alignment + |isodate filter.
 *
 * R3 minion 2 finding: docs say `$(NOW)` is "ISO-8601 timestamp at op-
 * dispatch time"; pre-v0.5.0 runtime substituted raw epoch ms. Either
 * docs lied or runtime did. Fix: runtime now emits ISO-8601 per docs.
 * Numeric epoch ms/sec available via $(EVENT.fired_at) /
 * $(EVENT.fired_at_unix) — unchanged.
 *
 * `|isodate` filter: converts epoch ms/sec OR ISO string to ISO-8601.
 * Useful for `$(EVENT.fired_at_unix|isodate)` formatting.
 */

async function runSkill(src: string): Promise<{ emissions: string[]; errors: unknown[] }> {
  const home = mkdtempSync(join(tmpdir(), "v050-now-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  const compiled = await compile(src);
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
  return { emissions: result.emissions, errors: result.errors };
}

describe("v0.5.0 item 6 — $(NOW) emits ISO-8601", () => {
  it("$(NOW) substitutes as ISO-8601 string", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="now=$(NOW)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    const out = result.emissions[0]!;
    // Match ISO-8601 with Z suffix: 2026-05-24T19:09:00.000Z
    expect(out).toMatch(/^now=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("EVENT.fired_at remains epoch ms (regression)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="at=$(EVENT.fired_at)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]!).toMatch(/^at=\d{13}$/); // 13-digit epoch ms
  });

  it("EVENT.fired_at_unix remains epoch seconds (regression)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="at=$(EVENT.fired_at_unix)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]!).toMatch(/^at=\d{10}$/); // 10-digit epoch sec
  });
});

describe("v0.5.0 item 6 — |isodate filter", () => {
  it("is in KNOWN_FILTERS", () => {
    expect(KNOWN_FILTERS as readonly string[]).toContain("isodate");
  });

  it("converts epoch ms (13-digit) to ISO-8601", () => {
    // 1779660000000 = 2026-05-24T17:20:00.000Z
    expect(applyFilter("1779660000000", "isodate")).toBe(new Date(1779660000000).toISOString());
  });

  it("converts epoch sec (10-digit) to ISO-8601", () => {
    // 1779660000 = 2026-05-24T17:20:00.000Z
    expect(applyFilter("1779660000", "isodate")).toBe(new Date(1779660000 * 1000).toISOString());
  });

  it("passes ISO-8601 string through unchanged", () => {
    const iso = "2026-05-24T17:20:00.000Z";
    expect(applyFilter(iso, "isodate")).toBe(iso);
  });

  it("throws on non-recognizable input", () => {
    expect(() => applyFilter("not a date", "isodate")).toThrow(/isodate/);
  });

  it("applied in skill: $(EVENT.fired_at_unix|isodate) renders as ISO-8601", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="iso=$(EVENT.fired_at_unix|isodate)")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]!).toMatch(/^iso=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
