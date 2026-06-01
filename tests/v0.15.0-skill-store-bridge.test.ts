import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStoreMcpConnector } from "../src/connectors/skill-store-mcp.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { KNOWN_CONNECTOR_CLASSES } from "../src/connectors/config.js";
import { bootstrap } from "../src/bootstrap.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";

// v0.15.0 — SkillStoreMcpConnector. Bridge exposes a SkillStore as
// McpConnector so `$ skill_write` / `$ skill_read` / `$ skill_delete` work
// as in-skill dispatch. Closes substrate-symmetry asymmetry with
// DataStoreMcpConnector. Trust model: in-skill writes flow through the
// widened mutation gate; `# Autonomous: true` (or `??` / `approved=`) is
// required to authorize.

describe("v0.15.0 — SkillStoreMcpConnector unit", () => {
  let home: string;
  let store: FilesystemSkillStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v015-skill-bridge-"));
    store = new FilesystemSkillStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("dispatches skill_write through to SkillStore.store with Draft-only override", async () => {
    const bridge = new SkillStoreMcpConnector(store);
    // Body declares Approved; bridge forces Draft regardless (v0.15.0 trust
    // boundary — see file header). Outside-MCP writes keep the declared
    // status; only in-skill dispatch sees the override.
    const result = await bridge.call("skill_write", {
      name: "child-skill",
      source: "# Skill: child-skill\n# Status: Approved\nrun:\n    emit(text=\"hi\")\ndefault: run\n",
    });
    expect(result).toMatchObject({ name: "child-skill", status: "Draft" });
    const reloaded = await store.load("child-skill");
    expect(reloaded.source).toMatch(/# Status: Draft/);
    expect(reloaded.source).not.toMatch(/# Status: Approved/);
  });

  it("skill_write with no Status header inserts `# Status: Draft`", async () => {
    const bridge = new SkillStoreMcpConnector(store);
    await bridge.call("skill_write", {
      name: "no-status",
      source: "# Skill: no-status\nrun:\n    emit(text=\"hi\")\ndefault: run\n",
    });
    const reloaded = await store.load("no-status");
    expect(reloaded.source).toMatch(/# Status: Draft/);
    expect(reloaded.metadata.status).toBe("Draft");
  });

  it("skill_write with `# Status: Disabled` rewrites to Draft", async () => {
    const bridge = new SkillStoreMcpConnector(store);
    await bridge.call("skill_write", {
      name: "was-disabled",
      source: "# Skill: was-disabled\n# Status: Disabled\nrun:\n    emit(text=\"hi\")\ndefault: run\n",
    });
    const reloaded = await store.load("was-disabled");
    expect(reloaded.source).toMatch(/# Status: Draft/);
    expect(reloaded.source).not.toMatch(/# Status: Disabled/);
  });

  it("dispatches skill_read through to SkillStore.load", async () => {
    await store.store("read-target", "# Skill: read-target\n# Status: Approved\nrun:\n    emit(text=\"ok\")\ndefault: run\n");
    const bridge = new SkillStoreMcpConnector(store);
    const result = await bridge.call("skill_read", { name: "read-target" }) as { name: string; source: string };
    expect(result.name).toBe("read-target");
    expect(result.source).toMatch(/# Skill: read-target/);
  });

  it("skill_write without overwrite rejects when a clashing name exists", async () => {
    await store.store("taken", "# Skill: taken\n# Status: Approved\nrun:\n    emit(text=\"first\")\ndefault: run\n");
    const bridge = new SkillStoreMcpConnector(store);
    await expect(bridge.call("skill_write", {
      name: "taken",
      source: "# Skill: taken\n# Status: Approved\nrun:\n    emit(text=\"second\")\ndefault: run\n",
    })).rejects.toThrow(/already exists/);
  });

  it("skill_write with overwrite=true replaces in place", async () => {
    await store.store("replace-me", "# Skill: replace-me\n# Status: Approved\nrun:\n    emit(text=\"old\")\ndefault: run\n");
    const bridge = new SkillStoreMcpConnector(store);
    await bridge.call("skill_write", {
      name: "replace-me",
      source: "# Skill: replace-me\n# Status: Approved\nrun:\n    emit(text=\"new\")\ndefault: run\n",
      overwrite: true,
    });
    const reloaded = await store.load("replace-me");
    expect(reloaded.source).toMatch(/emit\(text="new"\)/);
  });

  it("missing `name` on skill_write throws", async () => {
    const bridge = new SkillStoreMcpConnector(store);
    await expect(bridge.call("skill_write", { source: "..." })).rejects.toThrow(/name/);
  });

  it("missing `source` on skill_write throws", async () => {
    const bridge = new SkillStoreMcpConnector(store);
    await expect(bridge.call("skill_write", { name: "anon" })).rejects.toThrow(/source/);
  });

  it("staticCapabilities reports implementation = SkillStoreMcpConnector", () => {
    const caps = SkillStoreMcpConnector.staticCapabilities();
    expect(caps.implementation).toBe("SkillStoreMcpConnector");
    expect(caps.connector_type).toBe("mcp_connector");
  });

  it("staticTools returns the two canonical names (write + read; delete deferred)", () => {
    expect(SkillStoreMcpConnector.staticTools().sort()).toEqual(["skill_read", "skill_write"]);
  });
});

describe("v0.15.0 — SkillStoreMcpConnector is registered in KNOWN_CONNECTOR_CLASSES", () => {
  it("SkillStoreMcpConnector is in the bundled closed set", () => {
    expect(KNOWN_CONNECTOR_CLASSES.has("SkillStoreMcpConnector")).toBe(true);
  });

  it("has no fromConfig — wire via embedder code only (parallel to DataStoreMcpConnector)", () => {
    const entry = KNOWN_CONNECTOR_CLASSES.get("SkillStoreMcpConnector");
    expect(entry?.fromConfig).toBeUndefined();
  });
});

describe("v0.15.0 — bootstrap auto-wires SkillStoreMcpConnector", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v015-bootstrap-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("registers skill_read + skill_write connector names by default", () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    expect(wired.registry.hasMcpConnector("skill_read")).toBe(true);
    expect(wired.registry.hasMcpConnector("skill_write")).toBe(true);
  });

  it("does NOT register skill_delete (v0.15.0 deferred per Perry's threat-model push-back)", () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    expect(wired.registry.hasMcpConnector("skill_delete")).toBe(false);
  });

  it("`$ skill_write` from inside a skill with `# Autonomous: true` round-trips through the bridge", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const src = `# Skill: parent\n# Status: Approved\n# Autonomous: true\nrun:\n    $ skill_write name="child" source="# Skill: child\\n# Status: Approved\\nrun:\\n    emit(text=\\"hi from child\\")\\ndefault: run\\n" -> W\n    $ skill_read name="child" -> R\n    emit(text="wrote ${"$"}{W.name}; read ${"$"}{R.source|length} bytes")\ndefault: run\n`;
    const compiled = await compile(src, { registry: wired.registry });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions.join("\n")).toMatch(/wrote child/);
  });

  it("unauthorized `$ skill_write` is blocked by the mutation gate (no skill written)", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const src = `# Skill: parent\n# Status: Approved\nrun:\n    $ skill_write name="blocked-child" source="# Skill: blocked-child\\nrun:\\n    emit(text=\\"never\\")\\ndefault: run\\n" -> W\ndefault: run\n`;
    const compiled = await compile(src, { registry: wired.registry });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.class).toBe("UnconfirmedMutationError");
    // Child never landed.
    await expect(wired.skillStore.load("blocked-child")).rejects.toThrow(/Skill not found/);
  });
});
