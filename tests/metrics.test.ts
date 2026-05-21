import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTraceStore, TraceBuilder, type TraceRecord } from "../src/trace.js";
import { healthMetrics } from "../src/metrics.js";

function withStore(): { store: FilesystemTraceStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "skillscript-metrics-"));
  return {
    store: new FilesystemTraceStore(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeTrace(opts: {
  skill: string;
  firedAt: number;
  ops: Array<{ kind: string; target?: string; durationMs: number; errored?: boolean; connector?: string }>;
  errors?: Array<{ opKind: string; class: string }>;
}): TraceRecord {
  const builder = new TraceBuilder(opts.skill, "v1", { source: "manual", name: "", fired_at_ms: opts.firedAt }, {});
  for (const op of opts.ops) {
    builder.recordOp({
      op_kind: op.kind,
      target: op.target ?? "t",
      body: "",
      started_at_ms: opts.firedAt,
      duration_ms: op.durationMs,
      errored: op.errored ?? false,
      ...(op.connector !== undefined ? { connector: op.connector } : {}),
    });
  }
  const errors = (opts.errors ?? []).map((e) => ({
    target: "t",
    opKind: e.opKind,
    message: "",
    class: e.class,
  }));
  return builder.finalize([], {}, errors);
}

describe("healthMetrics", () => {
  it("computes per-skill fireCount + successRate + error categories", async () => {
    const { store, cleanup } = withStore();
    try {
      const now = Date.now();
      await store.write(makeTrace({ skill: "alpha", firedAt: now - 10_000, ops: [{ kind: "!", durationMs: 1 }] }));
      await store.write(makeTrace({ skill: "alpha", firedAt: now - 8000, ops: [{ kind: "!", durationMs: 1 }] }));
      await store.write(makeTrace({
        skill: "alpha",
        firedAt: now - 5000,
        ops: [{ kind: "$", durationMs: 5, errored: true }],
        errors: [{ opKind: "$", class: "ConnectorNotFoundError" }],
      }));
      const m = await healthMetrics(store, {});
      expect(m.totalFires).toBe(3);
      expect(m.perSkill["alpha"]!.fireCount).toBe(3);
      expect(m.perSkill["alpha"]!.successCount).toBe(2);
      expect(m.perSkill["alpha"]!.errorCount).toBe(1);
      expect(m.perSkill["alpha"]!.successRate).toBeCloseTo(2 / 3);
      expect(m.perSkill["alpha"]!.errorCategories["$"]!["ConnectorNotFoundError"]).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("computes per-connector latency percentiles + error rate", async () => {
    const { store, cleanup } = withStore();
    try {
      const now = Date.now();
      // Three calls to 'primary' MCP: durations 10, 20, 30 ms; one errored.
      await store.write(makeTrace({
        skill: "s", firedAt: now - 1000,
        ops: [
          { kind: "$", durationMs: 10, connector: "primary" },
          { kind: "$", durationMs: 20, connector: "primary" },
          { kind: "$", durationMs: 30, connector: "primary", errored: true },
        ],
        errors: [{ opKind: "$", class: "OpTimeoutError" }],
      }));
      const m = await healthMetrics(store, {});
      expect(m.perConnector["primary"]!.callCount).toBe(3);
      expect(m.perConnector["primary"]!.errorCount).toBe(1);
      expect(m.perConnector["primary"]!.errorRate).toBeCloseTo(1 / 3);
      // Sorted latencies [10, 20, 30]; p50 = idx 1 = 20; p95 + p99 = idx 2 = 30.
      expect(m.perConnector["primary"]!.latencyMs.p50).toBe(20);
      expect(m.perConnector["primary"]!.latencyMs.p95).toBe(30);
    } finally {
      cleanup();
    }
  });

  it("respects skills filter", async () => {
    const { store, cleanup } = withStore();
    try {
      const now = Date.now();
      await store.write(makeTrace({ skill: "a", firedAt: now - 1000, ops: [{ kind: "!", durationMs: 1 }] }));
      await store.write(makeTrace({ skill: "b", firedAt: now - 1000, ops: [{ kind: "!", durationMs: 1 }] }));
      const m = await healthMetrics(store, { skills: ["a"] });
      expect(m.totalFires).toBe(1);
      expect(m.perSkill["a"]).toBeDefined();
      expect(m.perSkill["b"]).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("respects connectors filter (only listed connectors aggregated)", async () => {
    const { store, cleanup } = withStore();
    try {
      const now = Date.now();
      await store.write(makeTrace({
        skill: "s", firedAt: now - 1000,
        ops: [
          { kind: "$", durationMs: 5, connector: "primary" },
          { kind: "~", durationMs: 50, connector: "gemma2" },
        ],
      }));
      const m = await healthMetrics(store, { connectors: ["primary"] });
      expect(m.perConnector["primary"]).toBeDefined();
      expect(m.perConnector["gemma2"]).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("respects since_ms + until_ms window", async () => {
    const { store, cleanup } = withStore();
    try {
      const now = Date.now();
      await store.write(makeTrace({ skill: "win", firedAt: now - 100_000, ops: [{ kind: "!", durationMs: 1 }] }));
      await store.write(makeTrace({ skill: "win", firedAt: now - 50_000, ops: [{ kind: "!", durationMs: 1 }] }));
      const recent = await healthMetrics(store, { since_ms: now - 75_000 });
      expect(recent.totalFires).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("empty trace store → empty metrics with no errors", async () => {
    const { store, cleanup } = withStore();
    try {
      const m = await healthMetrics(store, {});
      expect(m.totalFires).toBe(0);
      expect(m.perSkill).toEqual({});
      expect(m.perConnector).toEqual({});
    } finally {
      cleanup();
    }
  });
});
