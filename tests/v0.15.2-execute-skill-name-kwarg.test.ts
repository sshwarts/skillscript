import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "../src/mcp-server.js";
import { bootstrap } from "../src/bootstrap.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";

// v0.15.2 — kwarg-naming alignment. Pre-v0.15.2 `execute_skill` was the only
// `skill_*` MCP tool taking `skill_name`; the other four take `name`. The
// outlier was historical (disambiguation from `source` kwarg in the inline
// mode), but it created a papercut visible to cold adopters. v0.15.2 accepts
// `name` as canonical going forward, keeps `skill_name` as silent back-compat
// alias per Perry signoff (thread 75abc8c0). No tier-3 advisory, no
// deprecation warn — silent alias.
//
// Scope: MCP-wire (mcp-server.ts) + function-call grammar (parser.ts) +
// composition.ts in-skill dispatch + lint.ts composition-ref extractor.

describe("v0.15.2 — execute_skill MCP-wire accepts `name` as canonical", () => {
  let home: string;
  let server: McpServer;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0152-mcp-wire-"));
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    server = new McpServer({
      skillStore: wired.skillStore,
      registry: wired.registry,
    });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function seed(name: string): Promise<void> {
    await server.listTools().find((t) => t.name === "skill_write")!.handler({
      name,
      source: `# Skill: ${name}\n# Status: Approved\nrun:\n    emit(text="hello from ${name}")\ndefault: run\n`,
    });
  }

  it("`{name}` (canonical) executes the named skill", async () => {
    await seed("alpha");
    const tool = server.listTools().find((t) => t.name === "execute_skill")!;
    const result = await tool.handler({ name: "alpha" }) as { transcript: string[]; errors: unknown[] };
    expect(result.errors).toEqual([]);
    expect(result.transcript.join("\n")).toMatch(/hello from alpha/);
  });

  it("`{skill_name}` (back-compat alias) still executes", async () => {
    await seed("beta");
    const tool = server.listTools().find((t) => t.name === "execute_skill")!;
    const result = await tool.handler({ skill_name: "beta" }) as { transcript: string[]; errors: unknown[] };
    expect(result.errors).toEqual([]);
    expect(result.transcript.join("\n")).toMatch(/hello from beta/);
  });

  it("`{name}` and `{skill_name}` produce identical results when targeting the same skill", async () => {
    await seed("gamma");
    const tool = server.listTools().find((t) => t.name === "execute_skill")!;
    const viaName = await tool.handler({ name: "gamma" }) as Record<string, unknown>;
    const viaSkillName = await tool.handler({ skill_name: "gamma" }) as Record<string, unknown>;
    expect(viaName["transcript"]).toEqual(viaSkillName["transcript"]);
    expect(viaName["errors"]).toEqual(viaSkillName["errors"]);
    expect(viaName["target_order"]).toEqual(viaSkillName["target_order"]);
  });

  it("matching `{name, skill_name}` is accepted (no ambiguity)", async () => {
    await seed("delta");
    const tool = server.listTools().find((t) => t.name === "execute_skill")!;
    const result = await tool.handler({ name: "delta", skill_name: "delta" }) as { errors: unknown[] };
    expect(result.errors).toEqual([]);
  });

  it("conflicting `{name, skill_name}` (different values) is rejected as ambiguous", async () => {
    await seed("epsilon");
    await seed("zeta");
    const tool = server.listTools().find((t) => t.name === "execute_skill")!;
    await expect(tool.handler({ name: "epsilon", skill_name: "zeta" })).rejects.toThrow(/ambiguous/);
  });

  it("`{name, source}` together is still rejected (existing disambiguation preserved)", async () => {
    const tool = server.listTools().find((t) => t.name === "execute_skill")!;
    await expect(tool.handler({
      name: "anything",
      source: "# Skill: x\nrun:\n    emit(text=\"x\")\ndefault: run\n",
    })).rejects.toThrow(/exactly one of/);
  });

  it("`{}` (neither name nor source) is rejected", async () => {
    const tool = server.listTools().find((t) => t.name === "execute_skill")!;
    await expect(tool.handler({})).rejects.toThrow(/exactly one of/);
  });

  it("inputSchema declares both `name` and `skill_name` so adopters discover both", () => {
    const tool = server.listTools().find((t) => t.name === "execute_skill")!;
    const schema = tool.inputSchema as { properties: Record<string, { description?: string }> };
    expect(schema.properties["name"]).toBeDefined();
    expect(schema.properties["skill_name"]).toBeDefined();
    // The alias's description should call out that it's a back-compat alias.
    expect(schema.properties["skill_name"]!.description).toMatch(/alias|back-compat|legacy/i);
  });
});

describe("v0.15.2 — execute_skill function-call grammar accepts `name`", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v0152-funcall-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function seedAndRun(parentBody: string): Promise<{ transcript: string[]; errors: unknown[] }> {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    // Seed a child skill via the SkillStore so execute_skill can resolve it.
    await wired.skillStore.store(
      "child",
      "# Skill: child\n# Status: Approved\nrun:\n    emit(text=\"hello from child\")\ndefault: run\n",
    );
    const compiled = await compile(parentBody, { registry: wired.registry, skillStore: wired.skillStore });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry: wired.registry,
      skillStore: wired.skillStore,
    });
    return { transcript: result.emissions, errors: result.errors };
  }

  it("`execute_skill(name=\"child\") -> R` works (canonical)", async () => {
    const result = await seedAndRun(
      "# Skill: parent\n# Status: Approved\nrun:\n    execute_skill(name=\"child\") -> R\n    emit(text=\"parent saw: ${R.transcript|json}\")\ndefault: run\n",
    );
    expect(result.errors).toEqual([]);
    expect(result.transcript.join("\n")).toMatch(/hello from child/);
  });

  it("`execute_skill(skill_name=\"child\") -> R` still works (back-compat)", async () => {
    const result = await seedAndRun(
      "# Skill: parent\n# Status: Approved\nrun:\n    execute_skill(skill_name=\"child\") -> R\n    emit(text=\"parent saw: ${R.transcript|json}\")\ndefault: run\n",
    );
    expect(result.errors).toEqual([]);
    expect(result.transcript.join("\n")).toMatch(/hello from child/);
  });

  it("conflicting `name` + `skill_name` (different values) is rejected at parse time", async () => {
    const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    const src = "# Skill: parent\n# Status: Approved\nrun:\n    execute_skill(name=\"alpha\", skill_name=\"beta\") -> R\ndefault: run\n";
    await expect(compile(src, { registry: wired.registry, skillStore: wired.skillStore })).rejects.toThrow(/ambiguous/);
  });
});

describe("v0.15.2 — composition lint extractor recognizes `name=` kwarg", () => {
  // lintSync with a SkillStore containing only `existing` — a reference to
  // any other name fires `unknown-skill-reference` (tier-2). This proves
  // the extractor saw the kwarg and recognized it as a skill reference.

  async function lintAgainstSeededStore(src: string): Promise<{ findings: Array<{ rule: string; message: string }> }> {
    const home = mkdtempSync(join(tmpdir(), "v0152-lint-"));
    try {
      const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
      await wired.skillStore.store(
        "existing",
        "# Skill: existing\n# Status: Approved\nrun:\n    emit(text=\"ok\")\ndefault: run\n",
      );
      const { lint } = await import("../src/lint.js");
      const result = await lint(src, { skillStore: wired.skillStore });
      return { findings: result.findings.map((f) => ({ rule: f.rule, message: f.message })) };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("`$ execute_skill name=\"...\"` is captured (unknown-skill-reference fires for missing name)", async () => {
    const { findings } = await lintAgainstSeededStore(
      "# Skill: parent\n# Status: Approved\nrun:\n    $ execute_skill name=\"definitely-missing\" -> R\ndefault: run\n",
    );
    const unknownRef = findings.find((f) => f.rule === "unknown-skill-reference");
    expect(unknownRef, "expected unknown-skill-reference for `name=\"definitely-missing\"`").toBeDefined();
    expect(unknownRef!.message).toMatch(/definitely-missing/);
  });

  it("`$ execute_skill skill_name=\"...\"` is still captured (back-compat alias)", async () => {
    const { findings } = await lintAgainstSeededStore(
      "# Skill: parent\n# Status: Approved\nrun:\n    $ execute_skill skill_name=\"also-missing\" -> R\ndefault: run\n",
    );
    const unknownRef = findings.find((f) => f.rule === "unknown-skill-reference");
    expect(unknownRef).toBeDefined();
    expect(unknownRef!.message).toMatch(/also-missing/);
  });

  it("`$ execute_skill name=\"existing\"` does NOT fire unknown-skill-reference (lint validates the kwarg)", async () => {
    const { findings } = await lintAgainstSeededStore(
      "# Skill: parent\n# Status: Approved\nrun:\n    $ execute_skill name=\"existing\" -> R\ndefault: run\n",
    );
    const unknownRef = findings.find((f) => f.rule === "unknown-skill-reference");
    expect(unknownRef).toBeUndefined();
  });
});
