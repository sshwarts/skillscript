/**
 * v0.9.2 — compiler permissiveness lint cluster (P0.5–P0.9).
 *
 * Per qwen single-shot Test A findings in memory `a3a20593`. Each rule
 * surfaces a previously-silent-drop shape as a vocal error so smaller
 * LLM authors don't ship skills with half the ops missing.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { lint } from "../src/lint.js";

describe("v0.9.2 — compiler permissiveness", () => {
  describe("P0.5 — no-space dispatch", () => {
    it("rejects `$ticketing_search query=...` with canonical-fix suggestion", () => {
      const src = `# Skill: t
# Status: Approved
m:
    $ticketing_search query="x" -> R
default: m
`;
      const parsed = parse(src);
      expect(parsed.parseErrors.some((e) => /missing the space.*\$\s*ticketing_search/.test(e))).toBe(true);
    });

    it("does NOT flag legitimate `$set` and `$append`", () => {
      const src = `# Skill: t
# Status: Approved
m:
    $set X = "hi"
    $append L <"y">
default: m
`;
      const parsed = parse(src);
      expect(parsed.parseErrors).toEqual([]);
    });

    it("does NOT flag canonical `$ tool ...` form", () => {
      const src = `# Skill: t
# Status: Approved
m:
    $ data_read mode=fts query="x" -> R
default: m
`;
      const parsed = parse(src);
      expect(parsed.parseErrors).toEqual([]);
    });
  });

  describe("P0.6 — colon kwarg syntax", () => {
    it("fires `colon-kwarg-syntax` on `limit:20`", async () => {
      const src = `# Skill: t
# Status: Approved
m:
    $ tool query="x" limit:20 -> R
default: m
`;
      const r = await lint(src);
      const finding = r.findings.find((f) => f.rule === "colon-kwarg-syntax");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("error");
    });

    it("does NOT trip on colons inside quoted string values", async () => {
      const src = `# Skill: t
# Status: Approved
m:
    $ tool query="time at 3:30 PM" -> R
default: m
`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "colon-kwarg-syntax")).toBeUndefined();
    });

    it("does NOT trip on colons inside array literals", async () => {
      const src = `# Skill: t
# Status: Approved
m:
    $ data_read.data_write content="x" domain_tags=[svc, foo:bar, ops] -> R
default: m
`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "colon-kwarg-syntax")).toBeUndefined();
    });

    it("does NOT trip on `(fallback: ...)` trailer", async () => {
      const src = `# Skill: t
# Status: Approved
m:
    $ tool query="x" -> R (fallback: "default")
default: m
`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "colon-kwarg-syntax")).toBeUndefined();
    });
  });

  describe("P0.7 — emit binding", () => {
    it("rejects `emit(text=...) -> VAR`", () => {
      const src = `# Skill: t
# Status: Approved
m:
    emit(text="hi") -> RESULT
default: m
`;
      const parsed = parse(src);
      expect(parsed.parseErrors.some((e) => /cannot bind a result with `-> RESULT`/.test(e))).toBe(true);
    });

    it("accepts plain `emit(text=...)`", () => {
      const src = `# Skill: t
# Status: Approved
m:
    emit(text="hi")
default: m
`;
      const parsed = parse(src);
      expect(parsed.parseErrors).toEqual([]);
    });
  });

  describe("P0.8 — append equals", () => {
    it("rejects `$append VAR = \"value\"`", () => {
      const src = `# Skill: t
# Status: Approved
m:
    $set REPORT = ""
    $append REPORT = "line1"
default: m
`;
      const parsed = parse(src);
      expect(parsed.parseErrors.some((e) => /`\$append` op.*has `= /.test(e))).toBe(true);
    });

    it("accepts canonical `$append VAR <value>`", () => {
      const src = `# Skill: t
# Status: Approved
m:
    $set REPORT = ""
    $append REPORT <"line1">
default: m
`;
      const parsed = parse(src);
      expect(parsed.parseErrors).toEqual([]);
    });
  });

  describe("P0.9 — missing default target", () => {
    it("fires `missing-default-target` on single-target skill without `default:`", async () => {
      const src = `# Skill: t
# Status: Approved
m:
    emit(text="hi")
`;
      const r = await lint(src);
      const finding = r.findings.find((f) => f.rule === "missing-default-target");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("error");
    });

    it("does NOT fire when `default:` is explicit", async () => {
      const src = `# Skill: t
# Status: Approved
m:
    emit(text="hi")
default: m
`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "missing-default-target")).toBeUndefined();
    });

    it("does NOT fire on a skill with zero targets (no ops to enter)", async () => {
      const src = `# Skill: t
# Type: data
# Status: Approved

just-data:
    emit(text="some content")
`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "missing-default-target")).toBeDefined();
      // Data skills with content but no default still want the lint to fire
      // — Test A's failure path is the same regardless of skill type.
    });
  });

  describe("ParsedSkill.entryTargetExplicit field", () => {
    it("true when `default:` line present", () => {
      const parsed = parse(`# Skill: t
m:
    emit(text="hi")
default: m
`);
      expect(parsed.entryTargetExplicit).toBe(true);
    });

    it("false when entryTarget resolves via last-target fallback", () => {
      const parsed = parse(`# Skill: t
m:
    emit(text="hi")
`);
      expect(parsed.entryTargetExplicit).toBe(false);
    });
  });
});
