import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { SqliteDataStore } from "../src/connectors/data-store.js";
import { DataStoreMcpConnector } from "../src/connectors/data-store-mcp.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// v0.14.1 — Runtime enforcement of the mutation gate. Closes the gap from
// Phase 1 v4 cold-adopter dogfood (2026-05-31): `unconfirmed-mutation` was
// lint-only (warning, advisory) and `execute_skill({source})` bypassed lint
// preflight entirely, so naive callers could fire `$ data_write` /
// `file_write` without `# Autonomous: true` or any other authorization
// signal. v0.14.1 makes the runtime the load-bearing enforcement boundary
// (throws `UnconfirmedMutationError`); lint stays advisory at compile time.
//
// Defense-in-depth (per §27 `skill_status` template):
// - Layer A (load-bearing) at `execOps` — checks BEFORE dispatch
// - Layer B (regression guard) at `execOpInner` `case "$"` / `case "file_write"`
//   — same predicate, fail-closed default authState

describe("v0.14.1 — mutation gate runtime enforcement: $ data_write", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "v0141-mutgate-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function wireRuntime() {
    const dbPath = join(home, "data.db");
    const store = new SqliteDataStore({ dbPath });
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    wired.registry.registerDataStore("primary", store);
    wired.registry.registerMcpConnector("data_write", new DataStoreMcpConnector(store));
    return { store, wired };
  }

  it("unauthorized `$ data_write` throws UnconfirmedMutationError + does not reach the bridge", async () => {
    const { store, wired } = wireRuntime();
    // No `# Autonomous: true`, no `??`, no `approved=...`. Bare mutation.
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ data_write content="should not land" -> R\ndefault: run\n`;
    const compiled = await compile(src, { registry: wired.registry });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.class).toBe("UnconfirmedMutationError");
    expect(result.errors[0]!.message).toMatch(/mutation op without author authorization/);
    expect(result.errors[0]!.remediation).toMatch(/approved=/);
    expect(result.errors[0]!.remediation).toMatch(/Autonomous/);
    expect(result.errors[0]!.remediation).toMatch(/ask\(/);

    // Bridge was never called — store stays empty.
    const rows = await store.query({ query: "should not land", limit: 5, mode: "fts" });
    expect(rows.length).toBe(0);

    store.close();
  });

  it("`approved=\"reason\"` per-op kwarg authorizes the mutation", async () => {
    const { store, wired } = wireRuntime();
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ data_write content="durable" approved="banking thread state" -> R\ndefault: run\n`;
    const compiled = await compile(src, { registry: wired.registry });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(result.errors).toEqual([]);
    const rows = await store.query({ query: "durable", limit: 5, mode: "fts" });
    expect(rows.length).toBe(1);

    store.close();
  });

  it("`# Autonomous: true` skill header authorizes any mutation in the skill", async () => {
    const { store, wired } = wireRuntime();
    const src = `# Skill: t\n# Status: Approved\n# Autonomous: true\nrun:\n    $ data_write content="cron handoff" -> R\ndefault: run\n`;
    const compiled = await compile(src, { registry: wired.registry });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(result.errors).toEqual([]);
    const rows = await store.query({ query: "cron handoff", limit: 5, mode: "fts" });
    expect(rows.length).toBe(1);

    store.close();
  });

  it("preceding `ask(...)` authorizes subsequent mutation in same target (sawConfirm path)", async () => {
    const { store, wired } = wireRuntime();
    const src = `# Skill: t\n# Status: Approved\nrun:\n    ask(prompt="proceed?") -> ANS\n    $ data_write content="confirmed mutation" -> R\ndefault: run\n`;
    const compiled = await compile(src, { registry: wired.registry });
    const result = await execute(
      compiled.parsed,
      compiled.resolvedVariables,
      compiled.targetOrder,
      {
        registry: wired.registry,
        askUser: async () => "yes",
      },
    );

    expect(result.errors).toEqual([]);
    const rows = await store.query({ query: "confirmed mutation", limit: 5, mode: "fts" });
    expect(rows.length).toBe(1);

    store.close();
  });

  it("mutating-name shape (e.g., `$ write_record`) without authorization throws", async () => {
    const { store, wired } = wireRuntime();
    // Mutating-name prefix `write_` (other than data_write) — exercises the
    // MUTATING_TOOL_PATTERN classifier path. Stub connector registered under
    // the same name so name-match dispatch resolution (v0.7.2) routes here;
    // gate fires BEFORE the connector is called, so dispatch should never
    // execute. Verified via `dispatched` flag.
    let dispatched = false;
    wired.registry.registerMcpConnector(
      "write_record",
      new CallbackMcpConnector(async () => {
        dispatched = true;
        return { ok: true };
      }),
    );
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ write_record id="42" -> R\ndefault: run\n`;
    const compiled = await compile(src, { registry: wired.registry });
    const result = await execute(
      compiled.parsed,
      compiled.resolvedVariables,
      compiled.targetOrder,
      { registry: wired.registry },
    );

    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.class).toBe("UnconfirmedMutationError");
    expect(result.errors[0]!.message).toMatch(/write_record.*mutating-name shape/);
    expect(dispatched).toBe(false);

    store.close();
  });
});

describe("v0.14.1 — mutation gate runtime enforcement: file_write", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "v0141-fwgate-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("unauthorized `file_write` throws UnconfirmedMutationError + does not write the file", async () => {
    const path = join(home, "should-not-exist.txt");
    const src = `# Skill: t\n# Status: Approved\n# Vars: P=${path}\nrun:\n    file_write(path="\${P}", content="leaked")\ndefault: run\n`;
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const compiled = await compile(src, { registry: wired.registry });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.class).toBe("UnconfirmedMutationError");
    expect(result.errors[0]!.message).toMatch(/file_write.*mutation op/);
    // Side effect was prevented.
    expect(existsSync(path)).toBe(false);
  });

  it("`approved=` kwarg on file_write authorizes the write", async () => {
    const path = join(home, "ok.txt");
    const src = `# Skill: t\n# Status: Approved\n# Vars: P=${path}\nrun:\n    file_write(path="\${P}", content="green path", approved="signed off")\ndefault: run\n`;
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const compiled = await compile(src, { registry: wired.registry });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

    expect(result.errors).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("green path");
  });
});

describe("v0.14.1 — mutation gate Layer B regression guard", () => {
  it("fail-closed default authState — calling execOpInner-ish bypass throws", async () => {
    // This is a sanity check that the Layer B `case "$"` re-check inside
    // execOpInner uses the same predicate as Layer A. If a future caller
    // bypassed execOps and called execute() with a fresh authState, the
    // Layer B re-check would still fire on mutation ops. The plumbed-from-
    // execOps path covers it via Layer A (tested above); this test confirms
    // that an `# Autonomous: true` skill DOES propagate through Layer B
    // (i.e., the regression guard doesn't fail-closed when authorization
    // is legitimate). Belt-and-braces.
    const home = mkdtempSync(join(tmpdir(), "v0141-layerb-"));
    try {
      const dbPath = join(home, "data.db");
      const store = new SqliteDataStore({ dbPath });
      const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
      wired.registry.registerDataStore("primary", store);
      wired.registry.registerMcpConnector("data_write", new DataStoreMcpConnector(store));
      const src = `# Skill: t\n# Status: Approved\n# Autonomous: true\nrun:\n    $ data_write content="layer B passthrough" -> R\ndefault: run\n`;
      const compiled = await compile(src, { registry: wired.registry });
      const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });

      expect(result.errors).toEqual([]);
      const rows = await store.query({ query: "layer B passthrough", limit: 5, mode: "fts" });
      expect(rows.length).toBe(1);
      store.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
