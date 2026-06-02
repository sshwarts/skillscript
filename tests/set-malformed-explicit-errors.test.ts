import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";

// Sub-charter 4a: closes audit finding #6. Pre-v0.16 `$set` malformed
// shapes silently dropped (SET_OP_REGEX miss → fall-through `continue`
// → no op added, no error). Downstream lint blamed `undeclared-var` on
// the symptom. Now: explicit parse-error per malformed shape with
// remediation pointing at the canonical form.

describe("$set malformed → explicit parse-error (audit finding #6)", () => {
  it("fires on `$set FOO` (no `=`)", () => {
    const src = `# Skill: t\nt:\n    $set FOO\ndefault: t\n`;
    const p = parse(src);
    const err = p.parseErrors.find((e) => e.includes("Malformed `$set`"));
    expect(err).toBeDefined();
    expect(err).toMatch(/no `=`/);
  });

  it("fires on bare `$set` (no var name)", () => {
    const src = `# Skill: t\nt:\n    $set\ndefault: t\n`;
    const p = parse(src);
    const err = p.parseErrors.find((e) => e.includes("Malformed `$set`"));
    expect(err).toBeDefined();
    expect(err).toMatch(/missing variable name/);
  });

  it("fires on `$set 1FOO = ...` (numeric-leading ident)", () => {
    const src = `# Skill: t\nt:\n    $set 1FOO = "x"\ndefault: t\n`;
    const p = parse(src);
    const err = p.parseErrors.find((e) => e.includes("Malformed `$set`"));
    expect(err).toBeDefined();
    expect(err).toMatch(/starts with a digit/);
  });

  it("fires on `$set FOO.field = ...` (dotted target)", () => {
    const src = `# Skill: t\nt:\n    $set FOO.field = "x"\ndefault: t\n`;
    const p = parse(src);
    const err = p.parseErrors.find((e) => e.includes("Malformed `$set`"));
    expect(err).toBeDefined();
    expect(err).toMatch(/dotted target/);
  });

  it("does NOT fire on canonical `$set FOO = \"value\"`", () => {
    const src = `# Skill: t\nt:\n    $set FOO = "value"\ndefault: t\n`;
    const p = parse(src);
    expect(p.parseErrors.find((e) => e.includes("Malformed `$set`"))).toBeUndefined();
    const op = p.targets.get("t")!.ops[0]!;
    expect(op.kind).toBe("$set");
    expect(op.setName).toBe("FOO");
  });

  it("op is no longer silently added on malformed shape (regression guard)", () => {
    const src = `# Skill: t\nt:\n    $set BARE_NO_EQUALS\n    emit(text="\${BARE_NO_EQUALS}")\ndefault: t\n`;
    const p = parse(src);
    // Pre-fix: $set op silently dropped, only the emit op landed.
    // After fix: parse-error fires; op count = 1 (just the emit).
    const ops = p.targets.get("t")!.ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("emit");
    expect(p.parseErrors.some((e) => /Malformed `\$set`/.test(e))).toBe(true);
  });
});
