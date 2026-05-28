/**
 * v0.9.8 — skill_list evolution → SkillCatalog response shape.
 *
 * Locks the spec per Perry's audit thread `f0b8b832` + addendum `73c79a28`
 * + signoff `011feaf0`. Tests cover:
 *
 *   - Category derivation from `# Output:` (multi-output rule)
 *   - Filter composition (AND-semantics)
 *   - Vars rendering (bare / `=` / `=value`) per addendum table
 *   - Output array shape (multi-output preservation)
 *   - Triggers discriminated union (cron / session / event)
 *   - Audience filter (agent default; all adds headless; headless-only)
 *   - Empty-group shape stability (default groups always present)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { buildSkillCatalog } from "../src/skill-catalog.js";

describe("v0.9.8 — category derivation from # Output:", () => {
  let dir: string;
  let store: FilesystemSkillStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v098-cat-"));
    store = new FilesystemSkillStore(join(dir, "skills"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("agent output → augmenting (surfaces in `receives`)", async () => {
    await store.store("alert", "# Skill: alert\n# Status: Approved\n# Output: agent: oncall\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    const catalog = await buildSkillCatalog(store);
    expect(catalog.receives?.map((e) => e.name)).toEqual(["alert"]);
    expect(catalog.receives?.[0]!.category).toBe("augmenting");
    expect(catalog.skills).toEqual([]);
  });

  it("template output → template (surfaces in `skills`)", async () => {
    await store.store("playbook", "# Skill: playbook\n# Status: Approved\n# Output: template: assistant\nt:\n    emit(text=\"play\")\ndefault: t\n");
    const catalog = await buildSkillCatalog(store);
    expect(catalog.skills?.map((e) => e.name)).toEqual(["playbook"]);
    expect(catalog.skills?.[0]!.category).toBe("template");
    expect(catalog.receives).toEqual([]);
  });

  it("no output → headless (surfaces only when audience filter allows)", async () => {
    await store.store("monitor", "# Skill: monitor\n# Status: Approved\nt:\n    emit(text=\"silent\")\ndefault: t\n");

    const catalogAgent = await buildSkillCatalog(store, { audience: "agent" });
    expect(catalogAgent.headless).toBeUndefined();

    const catalogAll = await buildSkillCatalog(store, { audience: "all" });
    expect(catalogAll.headless?.map((e) => e.name)).toEqual(["monitor"]);
  });

  it("BOTH agent + template outputs → receives (Q1 lock)", async () => {
    await store.store("dual", "# Skill: dual\n# Status: Approved\n# Output: agent: oncall\n# Output: template: assistant\nt:\n    emit(text=\"both\")\ndefault: t\n");
    const catalog = await buildSkillCatalog(store);
    expect(catalog.receives?.map((e) => e.name)).toEqual(["dual"]);
    expect(catalog.skills?.find((e) => e.name === "dual")).toBeUndefined();
  });

  it("agent output preserves both kinds in entry.output array", async () => {
    await store.store("multi", "# Skill: multi\n# Status: Approved\n# Output: agent: oncall\n# Output: file: /tmp/log\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    const catalog = await buildSkillCatalog(store);
    const entry = catalog.receives![0]!;
    expect(entry.output).toEqual([
      { kind: "agent", target: "oncall" },
      { kind: "file", target: "/tmp/log" },
    ]);
  });
});

describe("v0.9.8 — vars rendering per addendum 73c79a28", () => {
  let dir: string;
  let store: FilesystemSkillStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v098-vars-"));
    store = new FilesystemSkillStore(join(dir, "skills"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("renders bare / `=` / `=value` distinctly", async () => {
    await store.store("vars-demo",
      "# Skill: vars-demo\n# Status: Approved\n# Vars: BARE, EMPTY=, WITH_DEFAULT=value\n# Output: template: a\nt:\n    emit(text=\"hi\")\ndefault: t\n",
    );
    const catalog = await buildSkillCatalog(store);
    const entry = catalog.skills![0]!;
    expect(entry.vars).toEqual([
      { name: "BARE", required: true, default: null },
      { name: "EMPTY", required: false, default: "" },
      { name: "WITH_DEFAULT", required: false, default: "value" },
    ]);
  });

  it("empty vars list when no # Vars: declared", async () => {
    await store.store("no-vars", "# Skill: no-vars\n# Status: Approved\n# Output: template: a\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    const catalog = await buildSkillCatalog(store);
    expect(catalog.skills![0]!.vars).toEqual([]);
  });
});

describe("v0.9.8 — triggers discriminated union", () => {
  let dir: string;
  let store: FilesystemSkillStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v098-trig-"));
    store = new FilesystemSkillStore(join(dir, "skills"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("cron → { kind: 'cron', expression }", async () => {
    await store.store("cron-skill",
      "# Skill: cron-skill\n# Status: Approved\n# Triggers: cron: 0 9 * * MON-FRI\n# Output: agent: x\nt:\n    emit(text=\"hi\")\ndefault: t\n",
    );
    const catalog = await buildSkillCatalog(store);
    expect(catalog.receives![0]!.triggers).toEqual([{ kind: "cron", expression: "0 9 * * MON-FRI" }]);
  });

  it("session → { kind: 'session', phase }", async () => {
    await store.store("session-skill",
      "# Skill: session-skill\n# Status: Approved\n# Triggers: session: start\n# Output: agent: x\nt:\n    emit(text=\"hi\")\ndefault: t\n",
    );
    const catalog = await buildSkillCatalog(store);
    expect(catalog.receives![0]!.triggers).toEqual([{ kind: "session", phase: "start" }]);
  });

  it("no triggers → empty array", async () => {
    await store.store("manual-skill", "# Skill: manual-skill\n# Status: Approved\n# Output: template: a\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    const catalog = await buildSkillCatalog(store);
    expect(catalog.skills![0]!.triggers).toEqual([]);
  });
});

describe("v0.9.8 — filter composition (AND-semantics)", () => {
  let dir: string;
  let store: FilesystemSkillStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "v098-filter-"));
    store = new FilesystemSkillStore(join(dir, "skills"));
    // Multiple skills exercising different filter dimensions
    await store.store("project-a-cron",
      "# Skill: project-a-cron\n# Status: Approved\n# Triggers: cron: 0 * * * *\n# Output: agent: ops\nt:\n    emit(text=\"hi\")\ndefault: t\n",
    );
    await store.store("project-a-manual",
      "# Skill: project-a-manual\n# Status: Approved\n# Output: template: a\nt:\n    emit(text=\"hi\")\ndefault: t\n",
    );
    await store.store("project-b-cron",
      "# Skill: project-b-cron\n# Status: Approved\n# Triggers: cron: 0 * * * *\n# Output: agent: ops\nt:\n    emit(text=\"hi\")\ndefault: t\n",
    );
    await store.store("draft-skill",
      "# Skill: draft-skill\n# Status: Draft\n# Output: template: a\nt:\n    emit(text=\"hi\")\ndefault: t\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("default filter: status=Approved excludes Draft", async () => {
    const catalog = await buildSkillCatalog(store);
    const allNames = [...(catalog.receives ?? []), ...(catalog.skills ?? [])].map((e) => e.name);
    expect(allNames).not.toContain("draft-skill");
  });

  it("status=Draft surfaces only Draft skills", async () => {
    const catalog = await buildSkillCatalog(store, { status: "Draft" });
    expect(catalog.skills?.map((e) => e.name)).toEqual(["draft-skill"]);
    expect(catalog.receives).toEqual([]);
  });

  it("name_prefix narrows to matching names", async () => {
    const catalog = await buildSkillCatalog(store, { name_prefix: "project-a" });
    const allNames = [...(catalog.receives ?? []), ...(catalog.skills ?? [])].map((e) => e.name);
    expect(allNames.sort()).toEqual(["project-a-cron", "project-a-manual"]);
  });

  it("trigger_kind=cron narrows to cron-fired skills only", async () => {
    const catalog = await buildSkillCatalog(store, { trigger_kind: "cron" });
    const allNames = [...(catalog.receives ?? []), ...(catalog.skills ?? [])].map((e) => e.name);
    expect(allNames.sort()).toEqual(["project-a-cron", "project-b-cron"]);
  });

  it("AND-composition: name_prefix + trigger_kind narrows further", async () => {
    const catalog = await buildSkillCatalog(store, { name_prefix: "project-a", trigger_kind: "cron" });
    const allNames = [...(catalog.receives ?? []), ...(catalog.skills ?? [])].map((e) => e.name);
    expect(allNames).toEqual(["project-a-cron"]);
  });
});

describe("v0.9.8 — audience filter + empty-group stability", () => {
  let dir: string;
  let store: FilesystemSkillStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v098-aud-"));
    store = new FilesystemSkillStore(join(dir, "skills"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("default audience='agent' present even when both groups empty", async () => {
    const catalog = await buildSkillCatalog(store);
    expect(catalog.receives).toEqual([]);
    expect(catalog.skills).toEqual([]);
    expect(catalog.headless).toBeUndefined();
  });

  it("audience='headless' returns ONLY headless group", async () => {
    await store.store("a", "# Skill: a\n# Status: Approved\n# Output: agent: x\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    await store.store("b", "# Skill: b\n# Status: Approved\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    const catalog = await buildSkillCatalog(store, { audience: "headless" });
    expect(catalog.receives).toBeUndefined();
    expect(catalog.skills).toBeUndefined();
    expect(catalog.headless?.map((e) => e.name)).toEqual(["b"]);
  });

  it("audience='all' includes all three groups", async () => {
    await store.store("aug", "# Skill: aug\n# Status: Approved\n# Output: agent: x\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    await store.store("tmpl", "# Skill: tmpl\n# Status: Approved\n# Output: template: x\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    await store.store("head", "# Skill: head\n# Status: Approved\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    const catalog = await buildSkillCatalog(store, { audience: "all" });
    expect(catalog.receives?.map((e) => e.name)).toEqual(["aug"]);
    expect(catalog.skills?.map((e) => e.name)).toEqual(["tmpl"]);
    expect(catalog.headless?.map((e) => e.name)).toEqual(["head"]);
  });
});

describe("v0.9.8 — Q2 footnote: invocation is independent of grouping", () => {
  it("agent-invokable Augmenting still surfaces in `receives` (output-kind-driven)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v098-q2-"));
    const store = new FilesystemSkillStore(join(dir, "skills"));
    try {
      // Augmenting skill with no triggers — author intends agent-invokable usage
      await store.store("on-demand-augment",
        "# Skill: on-demand-augment\n# Status: Approved\n# Output: agent: oncall\nt:\n    emit(text=\"hi\")\ndefault: t\n",
      );
      const catalog = await buildSkillCatalog(store);
      // Surfaces in `receives` per Q2 lock — output-kind-driven derivation.
      // Footnote: agent can STILL invoke this via execute_skill regardless;
      // discovery is signal, not gating.
      expect(catalog.receives?.map((e) => e.name)).toEqual(["on-demand-augment"]);
      expect(catalog.skills).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
