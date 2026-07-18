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
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { parse } from "../src/parser.js";
import { execute, dispatchUncertainWhenCut } from "../src/runtime.js";
import { lint } from "../src/lint.js";
import { bootstrap } from "../src/bootstrap.js";
import { canonicalizeForSigning } from "../src/approval.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { executeSkillFromSource } from "../src/composition.js";
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

describe("Phase 1 — `# Deadline:` is IN the signing hash (safety-envelope re-approval)", () => {
  // The deadline is the safety envelope the approver signed off on: it changes
  // whether/when the skill completes. So — unlike `# Tags:`, pure classification
  // metadata that's carved OUT of the hash — a `# Deadline:` edit MUST change the
  // canonical form, invalidating the signature and reverting the skill to Draft.
  // Even a tightening edit re-approves. This locks that carve-out asymmetry.
  it("a `# Deadline:` edit changes the canonical form (→ signature invalid → Draft)", () => {
    const five = SKILL("# Deadline: 5");
    const ten = SKILL("# Deadline: 10");
    expect(canonicalizeForSigning(five)).not.toBe(canonicalizeForSigning(ten));
  });

  it("even TIGHTENING the deadline re-approves (10 → 5 is not canonical-equal)", () => {
    const loose = SKILL("# Deadline: 10");
    const tight = SKILL("# Deadline: 5");
    expect(canonicalizeForSigning(tight)).not.toBe(canonicalizeForSigning(loose));
  });

  it("contrast: a `# Tags:` edit is canonical-neutral (stays Approved) — the carve-out mirror", () => {
    const a = SKILL("# Deadline: 5\n# Tags: robot");
    const b = SKILL("# Deadline: 5\n# Tags: robot, latency-sensitive");
    expect(canonicalizeForSigning(a)).toBe(canonicalizeForSigning(b));
  });
});

describe("Phase 1 — adopter finding B (operator ceiling covers the `skillfile execute` CLI)", () => {
  // Before the fix the ceiling was resolved only in the server/MCP path; a
  // one-shot CLI run was bounded solely by its own `# Deadline:`. The ceiling is
  // a hard operator guard — it must cover the CLI execution surface too. Spawns
  // the real built CLI: a no-`# Deadline:` skill that sleeps 5s under a 1s ceiling
  // must be cut (before the fix it ran the full 5s and exited clean).
  it("SKILLSCRIPT_MAX_DEADLINE_SECONDS bounds a CLI run with no # Deadline", async () => {
    const home = mkdtempSync(join(tmpdir(), "dl-cli-"));
    try {
      const skillsDir = join(home, "skills");
      mkdirSync(skillsDir, { recursive: true });
      await new FilesystemSkillStore(skillsDir).store(
        "slow",
        "# Skill: slow\n# Status: Approved\ndefault: run\nrun:\n    shell(command=\"sleep 5\") -> A\n",
        { status: "Approved" },
      );
      const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");
      const started = Date.now();
      const r = spawnSync("node", [CLI, "execute", "slow"], {
        encoding: "utf8",
        env: {
          ...process.env,
          SKILLSCRIPT_HOME: home,
          SKILLSCRIPT_SHELL_ALLOWLIST: "sleep",
          SKILLSCRIPT_MAX_DEADLINE_SECONDS: "1",
        },
      });
      const elapsed = Date.now() - started;
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      expect(out).toMatch(/deadline exceeded/i);
      expect(elapsed).toBeLessThan(4000); // cut at ~1s, not the 5s sleep
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);
});

describe("Phase 1 — adopter finding D (connector/model dispatch cuts record uncertain effects)", () => {
  // The uncertain-log used to key on classifyMutation — a mutating-NAME heuristic
  // that misses `send_message` (no "send" verb) and every un-verbed connector
  // tool, i.e. exactly the production mutations ($ agentmail.send_message,
  // $ data_write via a bridge, etc). A `$` dispatch cut mid-flight now records by
  // SAFE DEFAULT; only provably-non-effecting local builtins are excluded.

  it("predicate: connector/model dispatch is uncertain-when-cut; reads/pure/compose are not", () => {
    // Recorded (the previously-dropped classes + the obvious mutations):
    for (const t of ["send_message", "llm", "anything", "amp_write_memory", "data_write", "publish", "charge"]) {
      expect(dispatchUncertainWhenCut(t)).toBe(true);
    }
    // Excluded — a read, a pure parse, composition (children self-record):
    for (const t of ["data_read", "json_parse", "execute_skill"]) {
      expect(dispatchUncertainWhenCut(t)).toBe(false);
    }
  });

  // A hanging connector whose tool name (`send_message`) classifyMutation would
  // have MISSED — the exact production shape from the finding.
  const hangRegistry = () => {
    const r = new Registry();
    r.registerMcpConnector("hang", {
      async call() { await new Promise((res) => setTimeout(res, 5000)); return "never"; },
      async manifest() { return { capabilities_version: "1", manifest: { kind: "mock" } }; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return r;
  };
  const HANG_SEND = `# Skill: p
# Autonomous: true
default: run
run:
    $ hang.send_message to="x" -> R (fallback: "FB")
`;

  it("a cut `$ connector.send_message` records an uncertain effect (was dropped)", async () => {
    const r = await execute(parse(HANG_SEND), {}, ["run"], {
      agentId: "p",
      registry: hangRegistry(),
      effectsAuthorized: true,
      deadlineMs: Date.now() + 150, // fires mid-dispatch
    });
    expect(r.deadlineExceeded).toBe(true);
    expect(r.uncertainEffects).toHaveLength(1);
    expect(r.uncertainEffects?.[0]).toMatchObject({
      opKind: "$", op: "hang.send_message", reason: "issued, outcome uncertain", retry: false,
    });
  });

  it("it surfaces on the MCP execute_skill RETURN too (the adopter's harness)", async () => {
    const result = await executeSkillFromSource(HANG_SEND, {}, {
      ctx: {
        agentId: "p",
        registry: hangRegistry(),
        effectsAuthorized: true,
        deadlineMs: Date.now() + 150,
      },
    });
    expect(result.deadline_exceeded).toBe(true);
    expect(result.uncertain_effects?.[0]?.op).toBe("hang.send_message");
  });
});

describe("Phase 1 — adopter findings A + C (message + MCP-entry return envelope)", () => {
  // Finding A: the message reported the ABSOLUTE epoch instant ("# Deadline:
  // 1784388381s") instead of the declared budget. It must now name the duration
  // the author/operator set + where it came from, and never a bare epoch.
  it("A: the message reports the declared budget + source (# Deadline), not an epoch", async () => {
    const parsed = parse(`# Skill: t
# Deadline: 1
default: run
run:
    shell(command="sleep 8") -> A
`);
    const r = await execute(parsed, {}, ["run"], {
      agentId: "test",
      registry: new Registry(),
      effectsAuthorized: true,
      shellAllowlist: ["sleep"],
    });
    const msg = r.errors[0]!.message;
    expect(msg).toContain("1s budget (# Deadline)");
    expect(msg).not.toMatch(/\d{10}s/); // no epoch-seconds leak
  });

  it("A: an operator-ceiling cut names the ceiling as the source", async () => {
    const parsed = parse("# Skill: t\ndefault: run\nrun:\n    shell(command=\"sleep 8\") -> A\n");
    const r = await execute(parsed, {}, ["run"], {
      agentId: "test",
      registry: new Registry(),
      effectsAuthorized: true,
      shellAllowlist: ["sleep"],
      maxDeadlineMs: 2000,
    });
    const msg = r.errors[0]!.message;
    expect(msg).toContain("2s budget (operator ceiling)");
    expect(msg).not.toMatch(/\d{10}s/);
  });

  // Finding C: an MCP-entered run reaches execute() via the composition wrapper,
  // which increments recursionDepth to 1 — so the run-boundary used to RE-THROW
  // (depth>0) instead of converting, and the deadline escaped into mcp-server's
  // catch-all, dropping deadline_exceeded/uncertain_effects from the RETURN. The
  // wrapper is the run root (`_runRoot`) and must CONVERT to a partial result.
  it("C: executeSkillFromSource (MCP entry) RETURNS a partial, not a throw", async () => {
    const source = `# Skill: t
# Autonomous: true
default: run
run:
    shell(command="sleep 5") -> A (fallback: "FB")
`;
    // mid-flight cut; ctx has NO _insideExecute → the wrapper is the run root.
    const result = await executeSkillFromSource(source, {}, {
      ctx: {
        agentId: "test",
        registry: new Registry(),
        effectsAuthorized: true,
        shellAllowlist: ["sleep"],
        deadlineMs: Date.now() + 150,
      },
    });
    // Did NOT throw — and the fields are on the returned envelope.
    expect(result.deadline_exceeded).toBe(true);
    expect(result.uncertain_effects?.[0]?.opKind).toBe("shell");
    expect(result.errors.some((e) => e.class === "RunDeadlineExceeded")).toBe(true);
  });
});

describe("Phase 1 — deadline outcome is DURABLE in the trace (autonomous/cron fires)", () => {
  // A cron/event fire is fire-and-forget: no live caller reads
  // ExecuteResult.uncertainEffects. The trace is the only record, so the
  // uncertain-effect log MUST survive there — else "the robot may still be
  // moving" is lost for exactly the autonomous case that motivated the feature.
  it("records deadline_exceeded + uncertain_effects on the persisted TraceRecord", async () => {
    const home = mkdtempSync(join(tmpdir(), "dl-trace-"));
    try {
      const store = new FilesystemTraceStore(join(home, "traces"));
      // MID-FLIGHT cut: the op dispatches, then the deadline fires while it's in
      // flight — that's the only shape that yields an uncertain effect (a
      // pre-expired deadline fail-fasts before dispatch, nothing in flight).
      const parsed = parse(`# Skill: cronjob
default: run
run:
    shell(command="sleep 1") -> A
`);
      const r = await execute(parsed, {}, ["run"], {
        agentId: "test",
        registry: new Registry(),
        effectsAuthorized: true,
        shellAllowlist: ["sleep"],
        deadlineMs: Date.now() + 60, // fires mid-sleep
        trace: { mode: "on" },
        traceStore: store,
      });
      expect(r.deadlineExceeded).toBe(true);

      // The durable record — what an operator/dashboard reads after the fact.
      const records = await store.query({});
      expect(records.length).toBe(1);
      const rec = records[0]!;
      expect(rec.deadline_exceeded).toBe(true);
      expect(rec.uncertain_effects?.[0]?.opKind).toBe("shell");
      // And it's machine-distinguishable via the error class, too.
      expect(rec.errors.some((e) => e.class === "RunDeadlineExceeded")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("omits both fields on a normal (non-deadline) fire", async () => {
    const home = mkdtempSync(join(tmpdir(), "dl-trace-ok-"));
    try {
      const store = new FilesystemTraceStore(join(home, "traces"));
      const parsed = parse("# Skill: ok\ndefault: run\nrun:\n    emit(text=\"hi\")\n");
      await execute(parsed, {}, ["run"], {
        agentId: "test",
        registry: new Registry(),
        trace: { mode: "on" },
        traceStore: store,
      });
      const rec = (await store.query({}))[0]!;
      expect(rec.deadline_exceeded).toBeUndefined();
      expect(rec.uncertain_effects).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

describe("Phase 1 — operator max-deadline ceiling (the cheating-agent guard)", () => {
  const opMaxCtx = (extra) => ({
    agentId: "test",
    registry: new Registry(),
    effectsAuthorized: true,
    shellAllowlist: ["sleep"],
    maxDeadlineMs: 150, // operator ceiling
    ...extra,
  });

  it("bounds a skill that declares NO `# Deadline:` (an agent can't evade by omitting it)", async () => {
    const parsed = parse(`# Skill: t
default: run
run:
    shell(command="sleep 8") -> A
`);
    const start = Date.now();
    const r = await execute(parsed, {}, ["run"], opMaxCtx());
    expect(r.deadlineExceeded).toBe(true);          // bounded despite no # Deadline
    expect(Date.now() - start).toBeLessThan(1200);  // ~150ms, not 8s
  });

  it("caps a skill declaring a HUGE `# Deadline:` — a skill can't loosen past the operator max", async () => {
    const parsed = parse(`# Skill: t
# Deadline: 99999
default: run
run:
    shell(command="sleep 8") -> A
`);
    const start = Date.now();
    const r = await execute(parsed, {}, ["run"], opMaxCtx());
    expect(r.deadlineExceeded).toBe(true);          // the 99999s deadline is capped at the 150ms operator max
    expect(Date.now() - start).toBeLessThan(1200);
  });

  it("a skill with no external dispatch + no deadline runs fine even under an operator ceiling", async () => {
    const parsed = parse(`# Skill: t
default: run
run:
    $set X = "hi"
`);
    const r = await execute(parsed, {}, ["run"], opMaxCtx());
    expect(r.deadlineExceeded).toBeUndefined();     // fast op finishes well under the ceiling
    expect(r.errors).toEqual([]);
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

  it("uncertain-log: a read-NAMED connector op is STILL recorded (safe default — name can't downgrade)", async () => {
    // Per finding D: the runtime can't know a connector tool is a read from its
    // name (`get_status` looks read-ish, `send_message` looks not-a-mutation but
    // is). So every connector dispatch cut mid-flight is recorded conservatively;
    // genuine read-exclusion for connector tools is the Phase-2 effect_class
    // annotation, not a name guess. (Built-in local reads ARE excluded — see the
    // dispatchUncertainWhenCut predicate test.)
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
    expect(r.uncertainEffects?.[0]?.op).toBe("api.get_status");
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
