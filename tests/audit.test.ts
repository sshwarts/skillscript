import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile } from "../src/compile.js";
import { audit, formatAuditResult } from "../src/audit.js";
import { Registry } from "../src/connectors/registry.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";

let dir: string;
let registry: Registry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skillscript-audit-"));
  registry = new Registry();
  registry.registerSkillStore("primary", new FilesystemSkillStore(dir));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const VOICE_GUIDE_V1 = `# Skill: voice-guide
# Type: data

t:
    emit(text="formal voice only")
    emit(text="no emoji")

default: t
`;

const VOICE_GUIDE_V2 = `# Skill: voice-guide
# Type: data

t:
    emit(text="formal voice only")
    emit(text="no emoji")
    emit(text="short sentences")

default: t
`;

const SUPPORT = `# Skill: support-response-draft
t:
    inline(skill="voice-guide")

default: t
`;

describe("audit — staleness detection (THE LOAD-BEARING DEMO)", () => {
  /**
   * THE STALENESS-DETECTION MILESTONE Perry flagged: author voice-guide,
   * compile support-response-draft against it, edit voice-guide, run audit
   * on the previously-compiled artifact's provenance, observe the
   * stale-data-skill warning. End-to-end staleness story.
   */
  it("flags stale-data-skill when a data-skill is updated after compile", async () => {
    const store = registry.getSkillStore();
    await store.store("voice-guide", VOICE_GUIDE_V1);

    const compiled = await compile(SUPPORT, { skillStore: store });
    const v1Hash = compiled.dataSkillsInlined[0]!.content_hash;

    // Now update voice-guide.
    await store.store("voice-guide", VOICE_GUIDE_V2);
    const v2Meta = await store.metadata("voice-guide");
    expect(v2Meta.content_hash).not.toBe(v1Hash);

    // Audit the previously-recorded provenance against current state.
    const result = await audit(compiled.provenance, store);
    expect(result.is_stale).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.rule).toBe("stale-data-skill");
    expect(result.findings[0]!.severity).toBe("warning");
    expect(result.findings[0]!.skill_name).toBe("voice-guide");
    expect(result.findings[0]!.recorded_content_hash).toBe(v1Hash);
    expect(result.findings[0]!.current_content_hash).toBe(v2Meta.content_hash);
    expect(result.findings[0]!.message).toMatch(/updated since/);
  });

  it("clean audit when source has not changed", async () => {
    const store = registry.getSkillStore();
    await store.store("voice-guide", VOICE_GUIDE_V1);

    const compiled = await compile(SUPPORT, { skillStore: store });
    const result = await audit(compiled.provenance, store);

    expect(result.is_stale).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("flags missing-data-skill when a referenced data-skill is deleted", async () => {
    const store = registry.getSkillStore();
    await store.store("voice-guide", VOICE_GUIDE_V1);

    const compiled = await compile(SUPPORT, { skillStore: store });

    // Delete voice-guide from the store.
    await store.delete("voice-guide");

    const result = await audit(compiled.provenance, store);
    expect(result.is_stale).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.rule).toBe("missing-data-skill");
    expect(result.findings[0]!.severity).toBe("error");
    expect(result.findings[0]!.skill_name).toBe("voice-guide");
  });

  it("clean audit when source skill had no data-skill refs", async () => {
    const SIMPLE = `# Skill: simple\nt:\n    emit(text="hi")\ndefault: t\n`;
    const compiled = await compile(SIMPLE, { skillStore: registry.getSkillStore() });
    const result = await audit(compiled.provenance, registry.getSkillStore());
    expect(result.is_stale).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("formatAuditResult produces human-readable summary", async () => {
    const store = registry.getSkillStore();
    await store.store("voice-guide", VOICE_GUIDE_V1);
    const compiled = await compile(SUPPORT, { skillStore: store });
    await store.store("voice-guide", VOICE_GUIDE_V2);

    const result = await audit(compiled.provenance, store);
    const formatted = formatAuditResult(result);
    expect(formatted).toContain("support-response-draft");
    expect(formatted).toContain("stale-data-skill");
    expect(formatted).toContain("voice-guide");
  });
});

describe("compile — provenance block", () => {
  it("includes source_skill identity when SkillStore knows the source", async () => {
    const store = registry.getSkillStore();
    const SIMPLE = `# Skill: simple\nt:\n    emit(text="hi")\ndefault: t\n`;
    await store.store("simple", SIMPLE);
    const compiled = await compile(SIMPLE, { skillStore: store });
    expect(compiled.provenance.source_skill.name).toBe("simple");
    expect(compiled.provenance.source_skill.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("provenance includes language_version + compiler_version", async () => {
    // SUPPORT references voice-guide via & — without a SkillStore, the
    // missing-skillstore-for-data-ref lint rule would block. For this
    // test (provenance-shape-only), bypass the preflight.
    const compiled = await compile(SUPPORT, { skipLintPreflight: true });
    expect(compiled.provenance.language_version).toBe("1.0");
    expect(compiled.provenance.compiler_version).toMatch(/^\d/);
    expect(compiled.provenance.compiled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("--inline-provenance flag embeds the block at the bottom of output", async () => {
    const store = registry.getSkillStore();
    await store.store("voice-guide", VOICE_GUIDE_V1);
    const compiled = await compile(SUPPORT, { skillStore: store, inlineProvenance: true });
    expect(compiled.output).toMatch(/## Provenance/);
    expect(compiled.output).toMatch(/```json/);
    expect(compiled.output).toContain('"provenance_version"');
  });

  it("default (no inlineProvenance) leaves output free of provenance markdown", async () => {
    const store = registry.getSkillStore();
    await store.store("voice-guide", VOICE_GUIDE_V1);
    const compiled = await compile(SUPPORT, { skillStore: store });
    expect(compiled.output).not.toMatch(/## Provenance/);
    expect(compiled.output).not.toMatch(/provenance_version/);
  });
});

describe("compile — cycle detection diagnostic shape", () => {
  it("error carries cycle path as an array for agent parsing", async () => {
    const A = `# Skill: a\n# Type: data\nt:\n    inline(skill="b")\ndefault: t\n`;
    const B = `# Skill: b\n# Type: data\nt:\n    inline(skill="a")\ndefault: t\n`;
    const CALLER = `# Skill: caller\nt:\n    inline(skill="a")\ndefault: t\n`;
    const store = registry.getSkillStore();
    await store.store("a", A);
    await store.store("b", B);

    try {
      await compile(CALLER, { skillStore: store });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as Error & { cycle?: string[]; rule?: string };
      expect(e.rule).toBe("skill-dep-cycle");
      expect(Array.isArray(e.cycle)).toBe(true);
      // Path includes the entry through to the revisit.
      expect(e.cycle!).toContain("a");
      expect(e.cycle!).toContain("b");
      expect(e.message).toMatch(/cycle detected/i);
    }
  });
});
