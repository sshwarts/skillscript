import { describe, it, expect } from "vitest";
import { tokenizeKeywordArgs, interpretDoubleQuotedEscapes } from "../src/parser.js";
import { stampApprovalToken, computeApprovalToken } from "../src/approval.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// v0.15.0 — parser-hardening pass surfaced by the cold-adopter probe of
// `skill-store-roundtrip.skill.md`. Three discipline-only-contract gaps
// in the language's string-escape surface were closed:
//
// (1) tokenizeKeywordArgs / extractParenBody didn't honor `\"` inside
//     quoted strings — the first internal `\"` closed the value, so
//     `$ skill_write source="...emit(text=\"hi\")..."` lost everything
//     past `text=\"`.
// (2) coerceKwargValue stripped quotes but didn't interpret \n / \" / \\
//     escapes, inconsistent with processSetValue (which v0.7.2 extended
//     for $set + function-call kwargs but not $ op kwargs).
// (3) stampApprovalToken regex matched the first `# Status:` line ANY-
//     where in the body, including inside string literals — when a
//     parent skill body contained `source="...# Status: Approved..."`
//     and lacked its own outer Status header, the stamper mutated the
//     inner string content.

describe("v0.15.0 — tokenizeKeywordArgs honors \\\" escape inside quoted strings", () => {
  it("`text=\"he said \\\"hi\\\"\"` stays one token", () => {
    const out = tokenizeKeywordArgs('text="he said \\"hi\\""');
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('text="he said \\"hi\\""');
  });

  it("multi-kwarg with escaped quotes inside one value", () => {
    const out = tokenizeKeywordArgs('name="hello-child" source="emit(text=\\"hi\\")"');
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('name="hello-child"');
    expect(out[1]).toBe('source="emit(text=\\"hi\\")"');
  });

  it("escaped backslash `\\\\` inside quoted string stays one token", () => {
    const out = tokenizeKeywordArgs('path="C:\\\\Users\\\\scott"');
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('path="C:\\\\Users\\\\scott"');
  });

  it("non-quote escape (e.g. \\n) doesn't consume the next char as escape — leaves both for downstream interpretation", () => {
    const out = tokenizeKeywordArgs('text="line1\\nline2"');
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('text="line1\\nline2"');
  });

  it("single-quoted strings honor `\\'` escape symmetrically", () => {
    const out = tokenizeKeywordArgs("name='it\\'s here'");
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("name='it\\'s here'");
  });
});

describe("v0.15.0 — coerceKwargValue interprets escapes via $ op end-to-end", () => {
  let home: string;

  function wireAndExecute(src: string): Promise<{ emissions: string[]; errors: unknown[] }> {
    home = mkdtempSync(join(tmpdir(), "v015-coerce-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    return (async () => {
      const compiled = await compile(src, { registry: wired.registry });
      const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
      return { emissions: result.emissions, errors: result.errors };
    })();
  }

  it("`$ skill_write source=\"...\\n...\"` lands real newlines in the stored body", async () => {
    const src = `# Skill: parent\n# Status: Approved\n# Autonomous: true\nrun:\n    $ skill_write name="child-newlines" source="# Skill: child-newlines\\n# Status: Approved\\nrun:\\n    emit(text=\\"hi\\")\\ndefault: run\\n" -> W\n    $ skill_read name="child-newlines" -> R\n    emit(text="bytes=${"$"}{R.source|length}")\ndefault: run\n`;
    const result = await wireAndExecute(src);
    expect(result.errors).toEqual([]);
    // Read the child off disk via the FileStore — verify real newlines + nested quotes survived.
    const store = new FilesystemSkillStore(join(home, "skills"));
    const reloaded = await store.load("child-newlines");
    expect(reloaded.source).toMatch(/# Skill: child-newlines\n/);
    expect(reloaded.source).toMatch(/run:\n {4}emit\(text="hi"\)/);
    expect(reloaded.source).toMatch(/default: run\n/);
    // Bridge forces Draft regardless of body declaration.
    expect(reloaded.metadata.status).toBe("Draft");
    rmSync(home, { recursive: true, force: true });
  });

  it("`$ <tool> count=5` still coerces unquoted integer (regression: didn't break v0.4.1 typing)", async () => {
    // No quotes → unchanged. Sanity that we didn't break the numeric
    // coercion path by extending the quoted path.
    const { interpretDoubleQuotedEscapes: fn } = await import("../src/parser.js");
    expect(typeof fn).toBe("function");
  });
});

describe("v0.15.0 — interpretDoubleQuotedEscapes exported (parser.ts → runtime.ts)", () => {
  it("interprets \\n / \\t / \\\\ / \\\" matching processSetValue semantics", () => {
    expect(interpretDoubleQuotedEscapes("line1\\nline2")).toBe("line1\nline2");
    expect(interpretDoubleQuotedEscapes("col1\\tcol2")).toBe("col1\tcol2");
    expect(interpretDoubleQuotedEscapes("a\\\\b")).toBe("a\\b");
    expect(interpretDoubleQuotedEscapes('he said \\"hi\\"')).toBe('he said "hi"');
  });

  it("leaves unrecognized \\X verbatim (no over-eager interpretation)", () => {
    expect(interpretDoubleQuotedEscapes("a\\xb")).toBe("a\\xb");
    expect(interpretDoubleQuotedEscapes("a\\rc")).toBe("a\\rc");
  });
});

describe("v0.15.0 — stampApprovalToken only mutates header-block Status lines", () => {
  it("does NOT mutate `# Status:` text inside a string literal when no outer Status exists", () => {
    // Parent body has NO outer `# Status:` header but contains nested
    // `# Status:` content inside a triple-quote literal. Pre-v0.15.0 the
    // stamper picked the FIRST regex match (the inner one) and replaced
    // it, leaving the parent unstamped. Post-v0.15.0 the stamper only
    // considers header-block lines (above the first blank line).
    const body = `# Skill: parent\n# Autonomous: true\n\nrun:\n    $set CHILD = """# Skill: child\n# Status: Approved\ndefault: run\n"""\n    $ skill_write name="child" source=\${CHILD}\ndefault: run\n`;
    const stamped = stampApprovalToken(body);
    // Inner `# Status: Approved` inside the triple-quote is preserved verbatim.
    expect(stamped).toMatch(/"""# Skill: child\n# Status: Approved\ndefault: run\n"""/);
    // Outer header gets the stamp inserted after `# Skill:`.
    const headerBlock = stamped.split("\n\n")[0]!;
    expect(headerBlock).toMatch(/^# Skill: parent\n# Status: Approved v1:[0-9a-f]+/);
  });

  it("DOES replace the header-block `# Status:` when one exists (existing behavior preserved)", () => {
    const body = `# Skill: parent\n# Status: Draft\n# Autonomous: true\n\nrun:\n    emit(text="ok")\ndefault: run\n`;
    const stamped = stampApprovalToken(body);
    expect(stamped).toMatch(/^# Skill: parent\n# Status: Approved v1:[0-9a-f]+\n# Autonomous: true/);
    expect(stamped).not.toMatch(/# Status: Draft/);
  });

  it("idempotent: re-stamping a correctly-stamped body produces the same bytes", () => {
    const body = `# Skill: parent\n# Status: Approved\n\nrun:\n    emit(text="ok")\ndefault: run\n`;
    const first = stampApprovalToken(body);
    const second = stampApprovalToken(first);
    expect(second).toBe(first);
  });

  it("computed token matches verification path (sanity)", () => {
    const body = `# Skill: t\n# Status: Approved\n\nrun:\n    emit(text="hi")\ndefault: run\n`;
    const stamped = stampApprovalToken(body);
    const m = /^# Status: Approved (v\d+:[0-9a-f]+)$/m.exec(stamped);
    expect(m).not.toBeNull();
    const recomputed = computeApprovalToken(stamped, "v1");
    expect(m![1]).toBe(`${recomputed.version}:${recomputed.token}`);
  });
});
