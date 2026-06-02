import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { dedentTripleQuoteBody, processSetValue } from "../src/parser.js";

/**
 * v0.16.6 — Python `textwrap.dedent` pattern applied to triple-quote
 * `"""..."""` literal bodies. Without it, authors writing the body
 * indented inside the call site get that indent literally in the
 * rendered string — bad for prose, bad for prompts.
 *
 * Dedent runs at parse time, BEFORE `${VAR}` substitution per Perry's
 * `98d6b60b` design directive Q1 answer (substituted multi-line values
 * keep their own whitespace; the template looks like the output).
 *
 * Pre-existing triple-quote infrastructure (literal extraction, escape
 * interpretation, multi-line spanning, embedded single quotes) ships from
 * the earlier triple-quote work — this ring adds the dedent semantic.
 */

async function runSkill(src: string): Promise<{ emissions: string[]; errors: unknown[] }> {
  const home = mkdtempSync(join(tmpdir(), "v0166-tq-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  const compiled = await compile(src);
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
  return { emissions: result.emissions, errors: result.errors };
}

describe("v0.16.6 — dedentTripleQuoteBody helper (unit-level)", () => {
  it("single-line body — pass through unchanged", () => {
    expect(dedentTripleQuoteBody("hello")).toBe("hello");
    expect(dedentTripleQuoteBody("hello world")).toBe("hello world");
  });

  it("strips leading whitespace-only line + trailing whitespace-only line", () => {
    expect(dedentTripleQuoteBody("\nbody\n")).toBe("body");
    expect(dedentTripleQuoteBody("\n   \nbody\n   \n")).toBe("   \nbody\n   ");
    // Only ONE leading + ONE trailing blank line stripped — explicit
    // structure stays. Interior blank lines preserved.
  });

  it("strips common leading indent across all non-empty lines", () => {
    const input = "\n    line 1\n    line 2\n    line 3\n";
    expect(dedentTripleQuoteBody(input)).toBe("line 1\nline 2\nline 3");
  });

  it("blank lines inside body do NOT constrain the common-indent calculation", () => {
    // Author writes a block with an interior blank line — that blank line
    // shouldn't force commonIndent to be empty.
    const input = "\n    paragraph 1\n\n    paragraph 2\n    ";
    expect(dedentTripleQuoteBody(input)).toBe("paragraph 1\n\nparagraph 2");
  });

  it("handles tab + space mixed indentation per longest-common-prefix", () => {
    // `\t  line 1` and `\t  line 2` share `\t  ` prefix.
    const input = "\n\t  line 1\n\t  line 2\n";
    expect(dedentTripleQuoteBody(input)).toBe("line 1\nline 2");
  });

  it("lines with NO common prefix → no dedent applied", () => {
    // Mixed-indent lines without a shared prefix.
    const input = "\nline 1\n  line 2\nline 3\n";
    expect(dedentTripleQuoteBody(input)).toBe("line 1\n  line 2\nline 3");
  });

  it("escapes (`\\n`, `\\t`) introduce newlines that ALSO participate in dedent", () => {
    // processSetValue applies escapes then dedent. Verify the integration.
    expect(processSetValue('"""\n    line 1\n    line 2\n    """')).toBe("line 1\nline 2");
  });

  it("empty triple-quote body → empty string after dedent", () => {
    expect(dedentTripleQuoteBody("")).toBe("");
    expect(dedentTripleQuoteBody("\n")).toBe("");
    expect(dedentTripleQuoteBody("\n\n")).toBe("");
  });
});

describe("v0.16.6 — dedent applied in emit(text=\"\"\"...\"\"\")", () => {
  it("indented multi-line body renders without the indent", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "run:",
      '    emit(text="""',
      "    Follow these directions exactly,",
      "    step by step,",
      "    without skipping any steps.",
      '    """)',
      "default: run",
    ].join("\n");
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe(
      "Follow these directions exactly,\nstep by step,\nwithout skipping any steps.",
    );
  });

  it("dedent-then-substitute ordering: ${VAR} interpolated AFTER dedent (per Q1)", async () => {
    // The template's leading indent is stripped first. Then ${NAME}
    // substitutes its value (which itself has no leading indent and stays
    // verbatim).
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "# Vars: NAME=World",
      "run:",
      '    emit(text="""',
      "    Hello, ${NAME}!",
      "    Welcome here.",
      '    """)',
      "default: run",
    ].join("\n");
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe("Hello, World!\nWelcome here.");
  });

  it("multi-line ${VAR} preserves its own whitespace when interpolated post-dedent", async () => {
    // BLOCK is a multi-line value set via $set with an embedded \n escape.
    // The template's dedent doesn't re-dedent the substituted lines.
    const src = `# Skill: t
# Status: Approved
run:
    $set BLOCK = "line A\\nline B"
    emit(text="""
    Header.
    \${BLOCK}
    Footer.
    """)
default: run
`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    // BLOCK's own newlines stay; the template's leading indent stripped.
    expect(result.emissions[0]).toBe("Header.\nline A\nline B\nFooter.");
  });
});

describe("v0.16.6 — backward-compat: single-line triple-quote unchanged", () => {
  it("`emit(text=\"\"\"single line\"\"\")` renders as-is (no dedent on single line)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="""just a single line""")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.emissions[0]).toBe("just a single line");
  });

  it("multi-line WITHOUT leading indent — body renders verbatim", async () => {
    const src = [
      "# Skill: t",
      "# Status: Approved",
      "run:",
      '    emit(text="""line 1',
      "line 2",
      'line 3""")',
      "default: run",
    ].join("\n");
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    // First line continues the open delimiter; no leading newline; no
    // trailing newline; no common indent (lines 2-3 have no prefix).
    expect(result.emissions[0]).toBe("line 1\nline 2\nline 3");
  });
});
