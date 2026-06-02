import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePathJoin, validatePathComponent } from "../src/safe-path.js";
import { InvalidPathError } from "../src/errors.js";
import { FilesystemTraceStore } from "../src/trace.js";

describe("safePathJoin", () => {
  it("joins clean components like node:path.join", () => {
    expect(safePathJoin("/base", "alpha", "beta")).toBe(join("/base", "alpha", "beta"));
  });

  it("accepts components with dots in name (extensions, dotfiles)", () => {
    expect(safePathJoin("/base", "skill.skill.md")).toBe(join("/base", "skill.skill.md"));
    expect(safePathJoin("/base", ".gitignore")).toBe(join("/base", ".gitignore"));
    expect(safePathJoin("/base", "trace-id.json")).toBe(join("/base", "trace-id.json"));
  });

  it("rejects `.` component", () => {
    expect(() => safePathJoin("/base", ".")).toThrow(InvalidPathError);
  });

  it("rejects `..` component (the classic path-traversal vector)", () => {
    expect(() => safePathJoin("/base", "..")).toThrow(InvalidPathError);
  });

  it("rejects all-dots components (`...`, `....`, etc.)", () => {
    expect(() => safePathJoin("/base", "...")).toThrow(InvalidPathError);
    expect(() => safePathJoin("/base", "....")).toThrow(InvalidPathError);
  });

  it("rejects components containing `/` separator", () => {
    expect(() => safePathJoin("/base", "evil/escape")).toThrow(InvalidPathError);
    expect(() => safePathJoin("/base", "../../etc/passwd")).toThrow(InvalidPathError);
  });

  it("rejects components containing `\\` separator (Windows-style)", () => {
    expect(() => safePathJoin("/base", "evil\\escape")).toThrow(InvalidPathError);
  });

  it("rejects components containing null bytes", () => {
    expect(() => safePathJoin("/base", "evil\0name")).toThrow(InvalidPathError);
  });

  it("rejects empty components", () => {
    expect(() => safePathJoin("/base", "")).toThrow(InvalidPathError);
  });

  it("validates per-component (only the bad one throws)", () => {
    expect(() => safePathJoin("/base", "ok", "..", "more")).toThrow(/all-dots/);
  });
});

describe("validatePathComponent", () => {
  it("accepts canonical filesystem-safe names", () => {
    expect(() => validatePathComponent("skill-name")).not.toThrow();
    expect(() => validatePathComponent("trace_id_42")).not.toThrow();
    expect(() => validatePathComponent("a.b.c")).not.toThrow();
  });

  it("error carries the bad component + reason", () => {
    try {
      validatePathComponent("..");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPathError);
      expect((err as InvalidPathError).badComponent).toBe("..");
      expect((err as InvalidPathError).reason).toMatch(/all-dots/);
    }
  });

  it("truncates long bad components in error message (don't blow up log lines)", () => {
    const long = "a/" + "b".repeat(100);
    try {
      validatePathComponent(long);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPathError);
      expect((err as Error).message).toMatch(/\.\.\./);
      expect((err as Error).message.length).toBeLessThan(300);
    }
  });
});

describe("FilesystemTraceStore — path-traversal boundary", () => {
  it("write() throws InvalidPathError when skill_name is `..`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-traversal-write-"));
    try {
      const store = new FilesystemTraceStore(dir);
      await expect(
        store.write({
          trace_id: "t1",
          skill_name: "..",
          fired_at_ms: Date.now(),
          fired_at_iso: new Date().toISOString(),
          trigger_id: "test",
          trigger_type: "inline",
          mode: "on",
          ops: [],
          emissions: [],
          errors: [],
          fallbacks: [],
          mechanical: false,
          succeeded: true,
          duration_ms: 0,
        } as never),
      ).rejects.toThrow(InvalidPathError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("get() returns null when traceId is `..` (path-traversal rejected silently)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-traversal-get-"));
    try {
      // Put a real file at a sibling location to confirm `..` doesn't escape.
      const sibling = join(dir, "..", "leaked.json");
      writeFileSync(sibling, '{"trace_id":"leaked","skill_name":"x"}', "utf8");
      const store = new FilesystemTraceStore(dir);
      const result = await store.get("..");
      expect(result).toBeNull();
      // Cleanup the bait file.
      rmSync(sibling, { force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("get() rejects traceId with `/` separator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-traversal-getslash-"));
    try {
      const store = new FilesystemTraceStore(dir);
      const result = await store.get("../etc/passwd");
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("query() returns [] when filter.skill_name is `..`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-traversal-query-"));
    try {
      const store = new FilesystemTraceStore(dir);
      const results = await store.query({ skill_name: ".." });
      expect(results).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write() succeeds for normal skill_name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-normal-write-"));
    try {
      const store = new FilesystemTraceStore(dir);
      await store.write({
        trace_id: "t1",
        skill_name: "alpha",
        fired_at_ms: Date.now(),
        fired_at_iso: new Date().toISOString(),
        trigger_id: "test",
        trigger_type: "inline",
        mode: "on",
        ops: [],
        emissions: [],
        errors: [],
        fallbacks: [],
        mechanical: false,
        succeeded: true,
        duration_ms: 0,
      } as never);
      const got = await store.get("t1");
      expect(got).not.toBeNull();
      expect(got!.skill_name).toBe("alpha");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("get() probe twice (idempotency) — repeat invocation returns same record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-idempotent-"));
    try {
      const store = new FilesystemTraceStore(dir);
      mkdirSync(join(dir, "skill-name"), { recursive: true });
      writeFileSync(
        join(dir, "skill-name", "abc.json"),
        JSON.stringify({ trace_id: "abc", skill_name: "skill-name", fired_at_ms: 1, ops: [] }),
        "utf8",
      );
      const first = await store.get("abc");
      const second = await store.get("abc");
      expect(first).toEqual(second);
      expect(first!.trace_id).toBe("abc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
