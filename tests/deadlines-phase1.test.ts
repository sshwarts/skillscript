/**
 * Deadlines & Cancellation — Phase 1 (Perry spec de11dcc5 v3, plan 97ac3c5b).
 *
 * A first-class propagating wall-clock deadline (`# Deadline: N`) that bounds a
 * whole run + everything it composes, terminates via an UNCATCHABLE
 * `RunDeadlineExceeded`, and drives real cancellation (shell SIGKILL today,
 * connector AbortSignal + bounded onAbort as they land). This file grows to
 * house the a–j must-covers from the signed plan; it starts with the parser
 * surface (scope item 1).
 */
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";

const SKILL = (frontmatter: string) =>
  `# Skill: d\n${frontmatter}\n\ndefault: run\nrun:\n    emit(text="hi")\n`;

describe("Phase 1 — `# Deadline:` parsing (scope item 1)", () => {
  it("parses a positive integer (seconds) into parsed.deadline", () => {
    const p = parse(SKILL("# Deadline: 30"));
    expect(p.parseErrors).toEqual([]);
    expect(p.deadline).toBe(30);
  });

  it("defers a `$(VAR)` ref to runtime (stored as the ref string)", () => {
    const p = parse(SKILL("# Deadline: $(BUDGET)"));
    expect(p.parseErrors).toEqual([]);
    expect(p.deadline).toBe("$(BUDGET)");
  });

  it("rejects a non-positive / non-numeric value with a parse error", () => {
    // Same lenient `parseInt` grammar as `# Timeout:` — "1.5" → 1 is accepted
    // (leading-int), so the reject cases are non-positive + non-numeric.
    for (const bad of ["-5", "0", "abc"]) {
      const p = parse(SKILL(`# Deadline: ${bad}`));
      expect(p.deadline).toBeNull();
      expect(p.parseErrors.some((e) => /# Deadline:/.test(e))).toBe(true);
    }
  });

  it("is null when omitted (opt-in — preserves today's per-op behavior)", () => {
    const p = parse(SKILL("# Vars: (none)"));
    expect(p.deadline).toBeNull();
    expect(p.parseErrors).toEqual([]);
  });

  it("is independent of `# Timeout:` (both can be set; distinct fields)", () => {
    const p = parse(SKILL("# Timeout: 5\n# Deadline: 60"));
    expect(p.parseErrors).toEqual([]);
    expect(p.timeout).toBe(5);
    expect(p.deadline).toBe(60);
  });
});
