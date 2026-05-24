import { describe, it, expect } from "vitest";
import { parse, extractSkillFromMarkdown } from "../src/parser.js";
import { compile } from "../src/compile.js";

/**
 * v0.4.2 item 1 — markdown support via fenced code blocks (parser-layer
 * lenient extraction) + strict-target-detection. Closes the cold-author
 * footgun from `fbf10206` end-to-end.
 *
 * Design call (Scott via thread): extraction lives at the parser, NOT
 * the skill store. Skill store stays format-agnostic.
 *
 * Lenient extraction: try to find a ```skillscript or ```skill fenced
 * block; if found, parse contents; otherwise parse the whole source as
 * raw (existing behavior, full backward-compat).
 *
 * Strict-target-detection: target declaration lines must match
 * `<ident>:` shape. Prose like `## Use this:` is silently treated as
 * a comment (not misread as a malformed target).
 */

describe("v0.4.2 — extractSkillFromMarkdown helper", () => {
  it("extracts ```skillscript fenced block", () => {
    const src = `# Some heading

Prose explanation.

\`\`\`skillscript
# Skill: t
# Status: Approved
run:
    ! hi
default: run
\`\`\`

More prose after.`;
    const extracted = extractSkillFromMarkdown(src);
    expect(extracted).not.toBeNull();
    expect(extracted!).toContain("# Skill: t");
    expect(extracted!).toContain("default: run");
  });

  it("extracts ```skill fenced block (alias)", () => {
    const src = `prose\n\n\`\`\`skill\n# Skill: t\ndefault: run\nrun:\n    ! ok\n\`\`\`\n`;
    const extracted = extractSkillFromMarkdown(src);
    expect(extracted).not.toBeNull();
    expect(extracted!).toContain("# Skill: t");
  });

  it("returns null when no fenced block is found", () => {
    const src = `# Skill: t\ndefault: run\nrun:\n    ! ok\n`;
    expect(extractSkillFromMarkdown(src)).toBeNull();
  });

  it("returns first block when multiple fences present (first-block-wins)", () => {
    const src = `intro\n\n\`\`\`skillscript\n# Skill: first\nrun:\n    ! one\ndefault: run\n\`\`\`\n\nmore prose\n\n\`\`\`skillscript\n# Skill: second\n\`\`\`\n`;
    const extracted = extractSkillFromMarkdown(src);
    expect(extracted).not.toBeNull();
    expect(extracted!).toContain("# Skill: first");
    expect(extracted!).not.toContain("# Skill: second");
  });

  it("ignores unrelated fence languages (```bash, ```js, etc.)", () => {
    const src = `prose\n\n\`\`\`bash\necho hello\n\`\`\`\n\nMore prose.\n`;
    expect(extractSkillFromMarkdown(src)).toBeNull();
  });
});

describe("v0.4.2 — parse() with markdown extraction", () => {
  it("parses skill code from inside a fenced block", () => {
    const src = `# Welcome\n\nHere is the skill:\n\n\`\`\`skillscript\n# Skill: t\n# Status: Approved\nrun:\n    ! hello\ndefault: run\n\`\`\`\n\nThanks.\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    expect(r.name).toBe("t");
    expect(r.targets.has("run")).toBe(true);
  });

  it("falls back to raw parsing when no fence is found (backward compat)", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    ! hello\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    expect(r.name).toBe("t");
  });

  it("end-to-end: markdown-wrapped skill compiles cleanly", async () => {
    const src = `# Morning Sweep\n\nThis skill does a thing.\n\n\`\`\`skillscript\n# Skill: morning-sweep\n# Status: Approved\nrun:\n    ! morning\ndefault: run\n\`\`\`\n`;
    const compiled = await compile(src);
    expect(compiled.parsed.name).toBe("morning-sweep");
    expect(compiled.targetOrder).toEqual(["run"]);
  });
});

describe("v0.4.2 — strict-target-detection (prose-lines-not-targets)", () => {
  it("prose line `## Heading:` is treated as comment, not malformed target", () => {
    // Pre-v0.4.2: this would generate cascading `missing-dependency`
    // errors because the prose words after `:` looked like deps.
    const src = `# Skill: t\n# Status: Approved\nrun:\n    ! ok\n## Use this:\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    // Only `run` should be a real target; `## Use this` shouldn't appear.
    expect(r.targets.has("run")).toBe(true);
    expect(r.targets.size).toBe(1);
  });

  it("prose with quotes/punctuation before colon doesn't trigger target dec", () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    ! ok\nUse \`this\`:\nNote (important):\ndefault: run\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    expect(r.targets.size).toBe(1);
  });

  it("valid identifier still parses as target", () => {
    const src = `# Skill: t\n# Status: Approved\nfetch:\n    ! one\nreport: fetch\n    ! two\ndefault: report\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    expect(r.targets.size).toBe(2);
    expect(r.targets.has("fetch")).toBe(true);
    expect(r.targets.has("report")).toBe(true);
  });

  it("regression: hyphenated target names still work (target-name regex matches)", () => {
    const src = `# Skill: t\n# Status: Approved\nmorning-sweep:\n    ! ok\ndefault: morning-sweep\n`;
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    expect(r.targets.has("morning-sweep")).toBe(true);
  });
});

describe("v0.4.2 — original cold-author footgun closes end-to-end", () => {
  it("markdown prose around skill code compiles cleanly (no missing-dep errors)", async () => {
    // This is the exact shape from the v0.4.1 YouTrack proving work
    // that originally surfaced `fbf10206`: prose preamble + worked
    // example with colons + ## Skill heading + skill code.
    const src = `# YouTrack morning sweep

Use this skill to pull recent issues. Configuration:

\`\`\`json
{ "youtrack": { ... } }
\`\`\`

## The skill

\`\`\`skillscript
# Skill: morning
# Status: Approved
fetch:
    ! morning
default: fetch
\`\`\`

That's all.
`;
    const compiled = await compile(src);
    expect(compiled.parsed.name).toBe("morning");
    expect(compiled.warnings).toEqual([]);
    expect(compiled.targetOrder).toEqual(["fetch"]);
  });
});
