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
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";

/** ctx that runs shell ops, with an already-expired run deadline injected. */
const expiredDeadlineCtx = () => ({
  agentId: "test",
  registry: new Registry(),
  effectsAuthorized: true,
  shellAllowlist: ["true"],
  deadlineMs: Date.now() - 1000, // already past
});

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

describe("Phase 1 — deadline enforcement + uncatchable termination (2a: pre-dispatch)", () => {
  it("an expired deadline fail-fasts the first dispatch op and terminates the run", async () => {
    const parsed = parse(`# Skill: t
default: run
run:
    shell(command="true") -> A
    shell(command="true") -> B
`);
    const r = await execute(parsed, {}, ["run"], expiredDeadlineCtx());
    expect(r.deadlineExceeded).toBe(true);
    expect(r.errors.some((e) => /deadline/i.test(e.message))).toBe(true);
    // B never ran — the run terminated at the first op.
    expect(r.finalVars["B"]).toBeUndefined();
  });

  it("is UNCATCHABLE by op `(fallback:)` — no fallback cascade past the bound", async () => {
    const parsed = parse(`# Skill: t
default: run
run:
    shell(command="true") -> A (fallback: "fa")
    shell(command="true") -> B (fallback: "fb")
`);
    const r = await execute(parsed, {}, ["run"], expiredDeadlineCtx());
    expect(r.deadlineExceeded).toBe(true);
    // The fallbacks did NOT fire — the deadline bypassed them (pre-dispatch),
    // so the run doesn't return a looks-complete result.
    expect(r.fallbacks).toEqual([]);
    expect(r.finalVars["A"]).not.toBe("fa");
    expect(r.finalVars["B"]).toBeUndefined();
  });

  it("is UNCATCHABLE by a target `else:` — the else block does NOT run", async () => {
    const parsed = parse(`# Skill: t
default: run
run:
    shell(command="true") -> A
else:
    shell(command="true") -> RECOVERED
`);
    const r = await execute(parsed, {}, ["run"], expiredDeadlineCtx());
    expect(r.deadlineExceeded).toBe(true);
    // else: is the throw-container for op errors, but a run deadline is NOT
    // recoverable — the else block must not have executed.
    expect(r.finalVars["RECOVERED"]).toBeUndefined();
  });

  it("MID-FLIGHT expiry: an op in flight when the deadline passes throws the uncatchable deadline (not a swallowed per-op timeout)", async () => {
    // deadline ~60ms out; the op sleeps longer, so its clamped timer fires AT
    // the deadline mid-dispatch → RunDeadlineExceeded, bypassing the fallback.
    const parsed = parse(`# Skill: t
default: run
run:
    shell(command="sleep 1") -> A (fallback: "fa")
`);
    const r = await execute(parsed, {}, ["run"], {
      agentId: "test",
      registry: new Registry(),
      effectsAuthorized: true,
      shellAllowlist: ["sleep"],
      deadlineMs: Date.now() + 60,
    });
    expect(r.deadlineExceeded).toBe(true);
    expect(r.fallbacks).toEqual([]); // the (fallback:) did NOT catch the deadline
    expect(r.finalVars["A"]).not.toBe("fa");
  });

  it("no `# Deadline:` and no injected deadline → today's behavior, unchanged", async () => {
    const parsed = parse(`# Skill: t
default: run
run:
    shell(command="true") -> A
`);
    const r = await execute(parsed, {}, ["run"], {
      agentId: "test",
      registry: new Registry(),
      effectsAuthorized: true,
      shellAllowlist: ["true"],
    });
    expect(r.deadlineExceeded).toBeUndefined();
    expect(r.errors).toEqual([]);
  });
});
