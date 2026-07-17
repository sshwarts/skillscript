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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/parser.js";
import { execute } from "../src/runtime.js";
import { lint } from "../src/lint.js";
import { bootstrap } from "../src/bootstrap.js";
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

describe("Phase 1 — execute_skill tree propagation (the confirmed original hole)", () => {
  it("a child's deadline propagates to the ROOT — a deep gather can't outlive the root's shared deadline", async () => {
    const home = mkdtempSync(join(tmpdir(), "dl-tree-"));
    try {
      const wired = bootstrap({
        skillsDir: join(home, "skills"),
        traceDir: join(home, "traces"),
        shellAllowlist: ["sleep"],
      });
      // Child sleeps far longer than the root deadline. If the child got a FRESH
      // budget (the old hole), its sleep would run to its own per-op default; the
      // shared-instant propagation must cut it at the root's remaining instead.
      await wired.skillStore.store("child",
        "# Skill: child\n# Status: Approved\n\ndefault: run\nrun:\n    shell(command=\"sleep 5\") -> C\n");
      const parent = parse(
        "# Skill: parent\n# Status: Approved\n\ndefault: run\nrun:\n    $ execute_skill name=\"child\" -> R\n");

      const start = Date.now();
      const r = await execute(parent, {}, ["run"], {
        agentId: "test",
        registry: wired.registry,
        effectsAuthorized: true,
        shellAllowlist: ["sleep"],
        deadlineMs: Date.now() + 300,
      });
      const elapsed = Date.now() - start;

      expect(r.deadlineExceeded).toBe(true);       // the whole tree aborted at the root
      expect(elapsed).toBeLessThan(1500);          // cut at ~300ms, NOT the child's 5s sleep
      // The cut shell op inside the CHILD propagated up to the root's uncertain-log.
      expect(r.uncertainEffects?.[0]?.opKind).toBe("shell");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Phase 1 — guardrails (nudge lint + outlives-call registration guard)", () => {
  it("nudge: a skill with an external dispatch and no `# Deadline:` gets a tier-3 advisory", async () => {
    const r = await lint(`# Status: Approved
# Skill: t
default: run
run:
    shell(command="curl https://x") -> A
`, { shellAllowlist: ["curl"] });
    const f = r.findings.find((x) => x.rule === "unbounded-no-deadline");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
  });

  it("nudge: does NOT fire when `# Deadline:` is present", async () => {
    const r = await lint(`# Status: Approved
# Skill: t
# Deadline: 30
default: run
run:
    shell(command="curl https://x") -> A
`, { shellAllowlist: ["curl"] });
    expect(r.findings.find((x) => x.rule === "unbounded-no-deadline")).toBeUndefined();
  });

  it("nudge: does NOT fire for a pure-compute skill (no external dispatch)", async () => {
    const r = await lint(`# Status: Approved
# Skill: t
default: run
run:
    $set X = "hi"
    emit(text="\${X}")
`);
    expect(r.findings.find((x) => x.rule === "unbounded-no-deadline")).toBeUndefined();
  });

  it("test (j): registering an outlives-call connector with no onAbort throws (leak-prevention)", () => {
    const registry = new Registry();
    const bad = {
      effectBoundary: "outlives-call" as const,
      async call() { return "x"; },
      async manifest() { return { capabilities_version: "1", manifest: { kind: "mock" } }; },
      // no onAbort
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => registry.registerMcpConnector("robot", bad as any)).toThrow(/outlives-call.*onAbort/s);
  });

  it("registering an outlives-call connector WITH onAbort is fine", () => {
    const registry = new Registry();
    const ok = {
      effectBoundary: "outlives-call" as const,
      async call() { return "x"; },
      async manifest() { return { capabilities_version: "1", manifest: { kind: "mock" } }; },
      async onAbort() { /* stop */ },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => registry.registerMcpConnector("robot", ok as any)).not.toThrow();
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

  it("onAbort (item 5): an outlives-call connector's bounded cleanup runs when the deadline cuts an in-flight call", async () => {
    let onAbortCalled = false;
    let onAbortBudget = -1;
    const mock = {
      effectBoundary: "outlives-call" as const,
      // Hangs far longer than the deadline, so the run deadline cuts it in flight.
      async call() { await new Promise((r) => setTimeout(r, 5000)); return "never"; },
      async manifest() { return { capabilities_version: "1", manifest: { kind: "mock" } }; },
      async onAbort(budgetMs: number) { onAbortCalled = true; onAbortBudget = budgetMs; },
    };
    const registry = new Registry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry.registerMcpConnector("robot", mock as any);

    const parsed = parse(`# Skill: t
# Autonomous: true
default: run
run:
    $ robot.move approved="test" -> R (fallback: "fb")
`);
    const start = Date.now();
    const r = await execute(parsed, {}, ["run"], {
      agentId: "test",
      registry,
      effectsAuthorized: true,
      deadlineMs: Date.now() + 150,
    });
    const elapsed = Date.now() - start;

    expect(r.deadlineExceeded).toBe(true);
    expect(onAbortCalled).toBe(true);           // the cleanup hook fired
    expect(onAbortBudget).toBeGreaterThan(0);   // with a positive bounded budget
    expect(onAbortBudget).toBeLessThanOrEqual(1000); // <= CLEANUP_CAP
    expect(r.fallbacks).toEqual([]);            // deadline still uncatchable
    // Bounded: cut + cleanup finish well inside the run budget, nowhere near the 5s hang.
    expect(elapsed).toBeLessThan(1500);
    // Uncertain-log: the cut mutation ($ robot.move) is recorded "outcome uncertain".
    expect(r.uncertainEffects).toBeDefined();
    expect(r.uncertainEffects).toHaveLength(1);
    expect(r.uncertainEffects![0]).toMatchObject({
      opKind: "$",
      op: "robot.move",
      reason: "issued, outcome uncertain",
      retry: false,
    });
  });

  it("uncertain-log: a cut READ is NOT recorded (reads have no uncertain outcome)", async () => {
    const mock = {
      effectBoundary: "call-bounded" as const,
      async call() { await new Promise((r) => setTimeout(r, 5000)); return "never"; },
      async manifest() { return { capabilities_version: "1", manifest: { kind: "mock" } }; },
    };
    const registry = new Registry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry.registerMcpConnector("api", mock as any);
    const parsed = parse(`# Skill: t
default: run
run:
    $ api.get_status -> R (fallback: "fb")
`);
    const r = await execute(parsed, {}, ["run"], {
      agentId: "test", registry, effectsAuthorized: true, deadlineMs: Date.now() + 60,
    });
    expect(r.deadlineExceeded).toBe(true);
    // get_status is a read (classifyMutation → null), so no uncertain effect logged.
    expect(r.uncertainEffects).toBeUndefined();
  });

  it("AbortSignal: a call-bounded connector that honors ctx.signal truly cancels on the deadline cut", async () => {
    let aborted = false;
    const mock = {
      effectBoundary: "call-bounded" as const,
      // Honors the signal: rejects promptly when aborted (true cancel), instead
      // of racing-and-abandoning a 5s hang.
      async call(_tool: string, _args: any, ctx?: { signal?: AbortSignal }) {
        return await new Promise((_res, rej) => {
          const t = setTimeout(() => rej(new Error("should have aborted")), 5000);
          ctx?.signal?.addEventListener("abort", () => { aborted = true; clearTimeout(t); rej(new Error("aborted")); });
        });
      },
      async manifest() { return { capabilities_version: "1", manifest: { kind: "mock" } }; },
    };
    const registry = new Registry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry.registerMcpConnector("api", mock as any);
    const parsed = parse(`# Skill: t
default: run
run:
    $ api.get_status -> R (fallback: "fb")
`);
    const r = await execute(parsed, {}, ["run"], {
      agentId: "test", registry, effectsAuthorized: true, deadlineMs: Date.now() + 60,
    });
    expect(r.deadlineExceeded).toBe(true);
    expect(aborted).toBe(true); // the connector received the abort and stopped
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
