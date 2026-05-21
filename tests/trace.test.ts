import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTraceStore, shouldSample, shouldTraceFire, TraceBuilder, TRACE_DEFAULTS } from "../src/trace.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";

function withTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "skillscript-trace-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("shouldSample (deterministic SHA-256 hash)", () => {
  it("same trigger_id + skill_name produces same decision across calls", () => {
    const a = shouldSample("t-1", "hello", 50);
    const b = shouldSample("t-1", "hello", 50);
    expect(a).toBe(b);
  });

  it("different trigger_ids may produce different decisions", () => {
    // Across many trigger ids, observe both true and false outcomes at 50%.
    const seen = new Set<boolean>();
    for (let i = 0; i < 50; i++) seen.add(shouldSample(`t-${i}`, "hello", 50));
    expect(seen.has(true)).toBe(true);
    expect(seen.has(false)).toBe(true);
  });

  it("pct=100 always fires; pct=0 never fires", () => {
    expect(shouldSample("t-x", "any", 100)).toBe(true);
    expect(shouldSample("t-y", "any", 0)).toBe(false);
  });
});

describe("shouldTraceFire", () => {
  it("mode off → never trace", () => {
    expect(shouldTraceFire({ mode: "off" }, "t-1", "hello")).toBe(false);
  });
  it("undefined config → never trace", () => {
    expect(shouldTraceFire(undefined, "t-1", "hello")).toBe(false);
  });
  it("mode on → always trace", () => {
    expect(shouldTraceFire({ mode: "on" }, "t-1", "hello")).toBe(true);
  });
  it("mode sample defers to shouldSample with default pct", () => {
    const decisions = new Set<boolean>();
    for (let i = 0; i < 100; i++) {
      decisions.add(shouldTraceFire({ mode: "sample" }, `t-${i}`, "skill"));
    }
    // With default 10% sample, at least some should be false.
    expect(decisions.has(false)).toBe(true);
  });
});

describe("FilesystemTraceStore", () => {
  it("write + get round-trips", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      const store = new FilesystemTraceStore(dir);
      const builder = new TraceBuilder("hello", "v1", { source: "manual", name: "", fired_at_ms: Date.now() }, {});
      const record = builder.finalize([], {}, []);
      await store.write(record);
      const loaded = await store.get(record.trace_id);
      expect(loaded).not.toBeNull();
      expect(loaded!.trace_id).toBe(record.trace_id);
      expect(loaded!.skill_name).toBe("hello");
    } finally {
      cleanup();
    }
  });

  it("query filters by skill_name + sorts newest first", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      const store = new FilesystemTraceStore(dir);
      // Two skills, three records total.
      for (const [name, when] of [["a", 1000], ["b", 2000], ["a", 3000]] as const) {
        const b = new TraceBuilder(name, "v1", { source: "manual", name: "", fired_at_ms: when }, {});
        await store.write(b.finalize([], {}, []));
      }
      const allA = await store.query({ skill_name: "a" });
      expect(allA.length).toBe(2);
      expect(allA[0]!.fired_at_ms).toBe(3000); // newest first
      expect(allA[1]!.fired_at_ms).toBe(1000);

      const all = await store.query({});
      expect(all.length).toBe(3);
    } finally {
      cleanup();
    }
  });

  it("query respects since_ms + until_ms window", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      const store = new FilesystemTraceStore(dir);
      for (const when of [1000, 2000, 3000, 4000]) {
        const b = new TraceBuilder("s", "v1", { source: "manual", name: "", fired_at_ms: when }, {});
        await store.write(b.finalize([], {}, []));
      }
      const middle = await store.query({ skill_name: "s", since_ms: 1500, until_ms: 3500 });
      expect(middle.map((r) => r.fired_at_ms)).toEqual([3000, 2000]);
    } finally {
      cleanup();
    }
  });

  it("prune removes records older than retentionMs", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      const store = new FilesystemTraceStore(dir);
      const now = Date.now();
      // Old (older than 1h)
      const old = new TraceBuilder("p", "v1", { source: "manual", name: "", fired_at_ms: now - 7_200_000 }, {});
      await store.write(old.finalize([], {}, []));
      // Fresh
      const fresh = new TraceBuilder("p", "v1", { source: "manual", name: "", fired_at_ms: now - 60_000 }, {});
      await store.write(fresh.finalize([], {}, []));
      const removed = await store.prune(3_600_000); // 1h retention
      expect(removed).toBe(1);
      const remaining = await store.query({ skill_name: "p" });
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.fired_at_ms).toBe(fresh.finalize([], {}, []).fired_at_ms);
    } finally {
      cleanup();
    }
  });

  it("TRACE_DEFAULTS exposes sample pct + retention values", () => {
    expect(TRACE_DEFAULTS.SAMPLE_PCT).toBe(10);
    expect(TRACE_DEFAULTS.RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("execute() with trace recording", () => {
  it("trace.mode='on' + traceStore writes a TraceRecord with all ops captured", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      const store = new FilesystemTraceStore(dir);
      const src = `# Skill: traced
t:
    $set X = "hello"
    ! greeting: $(X)

default: t
`;
      const compiled = await compile(src, { skipLintPreflight: true });
      const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
        registry: new Registry(),
        trace: { mode: "on" },
        traceStore: store,
        skillVersion: "v1",
      });
      expect(result.errors).toEqual([]);
      const records = await store.query({ skill_name: "traced" });
      expect(records.length).toBe(1);
      const rec = records[0]!;
      expect(rec.version).toBe(1);
      expect(rec.skill_version).toBe("v1");
      expect(rec.ops.length).toBe(2); // $set + !
      expect(rec.ops[0]!.op_kind).toBe("$set");
      expect(rec.ops[0]!.errored).toBe(false);
      expect(rec.ops[1]!.op_kind).toBe("!");
      expect(rec.emissions).toEqual(["greeting: hello"]);
      expect(rec.duration_ms).toBeGreaterThanOrEqual(0);
    } finally {
      cleanup();
    }
  });

  it("trace.mode='off' + traceStore wired → no trace record written", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      const store = new FilesystemTraceStore(dir);
      const src = `# Skill: silent
t:
    ! hi

default: t
`;
      const compiled = await compile(src, { skipLintPreflight: true });
      await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
        registry: new Registry(),
        trace: { mode: "off" },
        traceStore: store,
      });
      const records = await store.query({ skill_name: "silent" });
      expect(records.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("trace records errored op when an op throws", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      const store = new FilesystemTraceStore(dir);
      const src = `# Skill: failing
t:
    @ false

default: t
`;
      const compiled = await compile(src, { skipLintPreflight: true });
      const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
        registry: new Registry(),
        trace: { mode: "on" },
        traceStore: store,
        skillVersion: "v1",
      });
      expect(result.errors.length).toBe(1);
      const records = await store.query({ skill_name: "failing" });
      expect(records.length).toBe(1);
      const rec = records[0]!;
      expect(rec.ops.length).toBe(1);
      expect(rec.ops[0]!.errored).toBe(true);
      expect(rec.errors.length).toBe(1);
      expect(rec.errors[0]!.opKind).toBe("@");
    } finally {
      cleanup();
    }
  });

  it("trace.mode='sample' deterministically samples based on trigger_id", async () => {
    const { dir, cleanup } = withTempDir();
    try {
      const store = new FilesystemTraceStore(dir);
      const src = `# Skill: sampled
t:
    ! hi

default: t
`;
      const compiled = await compile(src, { skipLintPreflight: true });
      // Pick a trigger_id we know will sample at 100% (effectively forcing trace).
      await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
        registry: new Registry(),
        trace: { mode: "sample", samplePct: 100 },
        traceStore: store,
        triggerCtx: { source: "cron", name: "* * * * *", fired_at_ms: Date.now(), trigger_id: "t-fixed" },
        skillVersion: "v1",
      });
      const recs = await store.query({ skill_name: "sampled" });
      expect(recs.length).toBe(1);
    } finally {
      cleanup();
    }
  });
});
