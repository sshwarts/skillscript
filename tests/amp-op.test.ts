import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "../src/parser.js";
import { extractReferences, deleteSkill, ReferenceIndex, ReferentialIntegrityError } from "../src/skill-manager.js";
import { Registry } from "../src/connectors/registry.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";

describe("Parser — & op", () => {
  it("parses bare reference", () => {
    const src = `# Skill: caller
t:
    & voice-guide

default: t
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    const op = p.targets.get("t")!.ops[0]!;
    expect(op.kind).toBe("&");
    expect(op.ampParams).toEqual({ skillName: "voice-guide", args: {} });
    expect(op.outputVar).toBeUndefined();
  });

  it("parses reference with key=value args + output binding", () => {
    const src = `# Skill: caller
t:
    & summarize style=formal max_words=100 -> RESULT

default: t
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    const op = p.targets.get("t")!.ops[0]!;
    expect(op.kind).toBe("&");
    expect(op.ampParams).toEqual({
      skillName: "summarize",
      args: { style: "formal", max_words: "100" },
    });
    expect(op.outputVar).toBe("RESULT");
  });

  it("rejects malformed & (missing skill name)", () => {
    const src = `# Skill: caller
t:
    &

default: t
`;
    const p = parse(src);
    // Bare `&` doesn't match the regex; parser silently drops per existing
    // convention (the leading `&` isn't followed by a space + name).
    expect(p.targets.get("t")!.ops).toHaveLength(0);
  });

  it("walks foreach + if bodies for references", () => {
    const src = `# Skill: caller
t:
    $set ITEMS = [a, b]
    foreach I in $(ITEMS):
        & voice-guide
    if $(MODE) == "formal":
        & formal-tone
    else:
        & casual-tone

default: t
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    const refs = extractReferences(src);
    expect(refs).toEqual(["casual-tone", "formal-tone", "voice-guide"]);
  });
});

describe("Parser — # Type: header", () => {
  it("defaults to procedural when header absent", () => {
    const p = parse(`# Skill: t\nt:\n    ! hi\ndefault: t\n`);
    expect(p.type).toBe("procedural");
  });

  it("parses # Type: data", () => {
    const p = parse(`# Skill: voice-guide\n# Type: data\nt:\n    ! content body\ndefault: t\n`);
    expect(p.type).toBe("data");
  });

  it("parses # Type: procedural explicitly", () => {
    const p = parse(`# Skill: t\n# Type: procedural\nt:\n    ! hi\ndefault: t\n`);
    expect(p.type).toBe("procedural");
  });

  it("rejects unknown # Type: values", () => {
    const p = parse(`# Skill: t\n# Type: bogus\nt:\n    ! hi\ndefault: t\n`);
    expect(p.parseErrors.length).toBeGreaterThan(0);
    expect(p.parseErrors[0]).toMatch(/must be 'procedural' or 'data'/);
  });
});

describe("extractReferences — T3 grammar produces real edges", () => {
  it("returns empty for skill with no & ops", () => {
    expect(extractReferences(`t:\n    ! hi\ndefault: t\n`)).toEqual([]);
  });

  it("returns sorted deduplicated refs", () => {
    const src = `t:
    & beta
    & alpha
    & beta

default: t
`;
    expect(extractReferences(src)).toEqual(["alpha", "beta"]);
  });

  it("walks across all targets, not just the entry target", () => {
    const src = `helper:
    & helper-skill

t:
    & main-skill

default: t
`;
    const refs = extractReferences(src);
    expect(refs.sort()).toEqual(["helper-skill", "main-skill"]);
  });
});

describe("T2 integration — reference index lights up via T3 grammar", () => {
  let dir: string;
  let registry: Registry;
  let index: ReferenceIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skillscript-t3-"));
    registry = new Registry();
    registry.registerSkillStore("primary", new FilesystemSkillStore(dir));
    index = new ReferenceIndex();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("deleteSkill throws ReferentialIntegrityError when a real & reference exists", async () => {
    const VOICE_GUIDE = `# Skill: voice-guide
# Type: data

t:
    ! formal tone, technical accuracy, second-person

default: t
`;
    const SUPPORT = `# Skill: support-response
t:
    & voice-guide
    ! generate response

default: t
`;
    await registry.getSkillStore().store("voice-guide", VOICE_GUIDE);
    await registry.getSkillStore().store("support-response", SUPPORT);
    // Manually populate the index as storeSkill would (we're testing the
    // integrity machinery, not the wiring through storeSkill — that has
    // its own test).
    index.setOutgoing("support-response", extractReferences(SUPPORT));

    // Delete should throw because support-response references voice-guide.
    try {
      await deleteSkill("voice-guide", { registry, index });
      expect.fail("should have thrown ReferentialIntegrityError");
    } catch (err) {
      expect(err).toBeInstanceOf(ReferentialIntegrityError);
      expect((err as ReferentialIntegrityError).referenced_by).toEqual(["support-response"]);
    }

    // Force-delete bypasses the check.
    await deleteSkill("voice-guide", { registry, index, force: true });
  });
});

describe("Runtime — & op rejects unresolved execution", () => {
  it("throws clear error when an & op reaches the runtime", async () => {
    const src = `# Skill: caller
t:
    & voice-guide
    ! after

default: t
`;
    // Bypass lint preflight; this test exercises the runtime guard for
    // when an `&` op slips through to execution (a defense-in-depth path).
    // In normal usage, lint's missing-skillstore-for-data-ref rule catches
    // this earlier — see tests/lint.test.ts.
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: new Registry(),
    });
    // The `&` op should error; the subsequent `!` should not execute
    // because the op chain bails on the error.
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.opKind).toBe("&");
    // v0.3.1: the runtime now throws MissingSkillReferenceError for
    // unresolved `&` ops (was a generic "compile() bypassed" error
    // pre-v0.3.1). New message asks whether it's a forward-ref or typo.
    expect(result.errors[0]!.message).toMatch(/MissingSkillReferenceError|forward-ref|typo|has no skill by that name/i);
    expect(result.errors[0]!.class).toBe("MissingSkillReferenceError");
  });
});

describe("Data-skill inlining — THE LOAD-BEARING DEMO", () => {
  let dir: string;
  let registry: Registry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skillscript-inline-"));
    registry = new Registry();
    registry.registerSkillStore("primary", new FilesystemSkillStore(dir));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * THE CRITICAL MILESTONE Perry called out: author voice-guide (data-typed)
   * + support-response-draft (procedural) where the latter references the
   * former via `&`. Compile support-response-draft and observe voice-guide
   * content inlined into the rendered artifact.
   */
  it("inlines a data-skill's content where a & references it; rendered prompt contains the data content", async () => {
    const VOICE_GUIDE = `# Skill: voice-guide
# Type: data

content:
    ! Always use second-person perspective.
    ! Lead with technical accuracy over marketing tone.
    ! No emoji.

default: content
`;
    const SUPPORT = `# Skill: support-response-draft
# Vars: QUERY=hello

build:
    & voice-guide
    ! Now respond to: $(QUERY)

default: build
`;
    await registry.getSkillStore().store("voice-guide", VOICE_GUIDE);
    await registry.getSkillStore().store("support-response-draft", SUPPORT);

    const compiled = await compile(SUPPORT, { skillStore: registry.getSkillStore() });

    // Content is inlined in the rendered prompt.
    expect(compiled.output).toContain("Always use second-person perspective.");
    expect(compiled.output).toContain("Lead with technical accuracy over marketing tone.");
    expect(compiled.output).toContain("No emoji.");
    // Original `& voice-guide` reference is gone from the output (resolved at compile).
    expect(compiled.output).not.toContain("Invoke skill: voice-guide");

    // Provenance: data-skill recorded with content_hash for staleness detection.
    expect(compiled.dataSkillsInlined).toHaveLength(1);
    expect(compiled.dataSkillsInlined[0]!.name).toBe("voice-guide");
    expect(compiled.dataSkillsInlined[0]!.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("data-skill inlining with output binding produces $set", async () => {
    const VOICE_GUIDE = `# Skill: voice-guide
# Type: data

content:
    ! formal tone

default: content
`;
    const CALLER = `# Skill: caller
t:
    & voice-guide -> GUIDE
    ! using $(GUIDE)

default: t
`;
    await registry.getSkillStore().store("voice-guide", VOICE_GUIDE);

    const compiled = await compile(CALLER, { skillStore: registry.getSkillStore() });

    // The output should show GUIDE bound to the voice-guide content.
    expect(compiled.output).toContain("Bind variable: GUIDE = formal tone");
    expect(compiled.output).toContain("Tell the user: using $(GUIDE)");
  });

  it("procedural-skill & ref stays as runtime invocation (not inlined)", async () => {
    const PROC = `# Skill: summarizer
t:
    ! summarize logic

default: t
`;
    const CALLER = `# Skill: caller
t:
    & summarizer -> RESULT

default: t
`;
    await registry.getSkillStore().store("summarizer", PROC);

    const compiled = await compile(CALLER, { skillStore: registry.getSkillStore() });

    // No data-skill recorded (procedural).
    expect(compiled.dataSkillsInlined).toEqual([]);
    // Rendered output shows the invocation, not inlined content.
    expect(compiled.output).toContain("Invoke skill: summarizer");
    expect(compiled.output).toContain("bind result to $(RESULT)");
  });

  it("recursive data-skill composition: data A references data B; both inline", async () => {
    const TONE = `# Skill: tone
# Type: data

t:
    ! formal voice only

default: t
`;
    const VOICE_GUIDE = `# Skill: voice-guide
# Type: data

t:
    & tone
    ! plus: no emoji

default: t
`;
    const CALLER = `# Skill: caller
t:
    & voice-guide

default: t
`;
    const store = registry.getSkillStore();
    await store.store("tone", TONE);
    await store.store("voice-guide", VOICE_GUIDE);

    const compiled = await compile(CALLER, { skillStore: store });

    expect(compiled.output).toContain("formal voice only");
    expect(compiled.output).toContain("plus: no emoji");
    // Both data-skills recorded for staleness detection.
    expect(compiled.dataSkillsInlined.map((d) => d.name).sort()).toEqual(["tone", "voice-guide"]);
  });

  it("detects skill-dep cycle: a → b → a errors at compile", async () => {
    const A = `# Skill: a
# Type: data

t:
    & b

default: t
`;
    const B = `# Skill: b
# Type: data

t:
    & a

default: t
`;
    const CALLER = `# Skill: caller
t:
    & a

default: t
`;
    const store = registry.getSkillStore();
    await store.store("a", A);
    await store.store("b", B);

    await expect(compile(CALLER, { skillStore: store })).rejects.toThrow(/cycle detected/i);
  });

  it("bare & data-skill splats into N ! ops, one per source ! op (preserves per-rule structure)", async () => {
    // Dogfood-driven: a data-skill with three guidance bullets should
    // inline as three separate `!` ops in the parent, not one joined
    // emission. Agents reading the parent's compiled output see the
    // rules as distinct items.
    const VOICE_GUIDE = `# Skill: voice-guide
# Type: data

t:
    ! rule one
    ! rule two
    ! rule three

default: t
`;
    const CALLER = `# Skill: caller
t:
    & voice-guide
    ! after

default: t
`;
    await registry.getSkillStore().store("voice-guide", VOICE_GUIDE);

    const compiled = await compile(CALLER, { skillStore: registry.getSkillStore() });

    // Three separate "Tell the user: rule N" lines in the rendered output.
    expect(compiled.output).toContain("Tell the user: rule one");
    expect(compiled.output).toContain("Tell the user: rule two");
    expect(compiled.output).toContain("Tell the user: rule three");
    // Not joined with embedded newlines.
    expect(compiled.output).not.toMatch(/Tell the user: rule one\nrule two/);

    // AST inspection: parent's target should now have 4 `!` ops (3 inlined + 1 original).
    const callerTarget = compiled.parsed.targets.get("t")!;
    const bangOps = callerTarget.ops.filter((op) => op.kind === "!");
    expect(bangOps).toHaveLength(4);
    expect(bangOps.map((op) => op.body)).toEqual(["rule one", "rule two", "rule three", "after"]);
  });

  it("inlined data-skill compiled artifact has no & op in the AST", async () => {
    const VOICE_GUIDE = `# Skill: voice-guide
# Type: data

t:
    ! data content

default: t
`;
    const CALLER = `# Skill: caller
t:
    & voice-guide

default: t
`;
    await registry.getSkillStore().store("voice-guide", VOICE_GUIDE);
    const compiled = await compile(CALLER, { skillStore: registry.getSkillStore() });

    // The parsed AST has been mutated by inlining — no & ops should remain.
    const remainingAmpOps = Array.from(compiled.parsed.targets.values())
      .flatMap((t) => t.ops)
      .filter((op) => op.kind === "&");
    expect(remainingAmpOps).toEqual([]);

    // Runtime now succeeds on the inlined AST (no & op to reject).
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry,
    });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toContain("data content");
  });
});
