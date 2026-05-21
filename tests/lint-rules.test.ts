import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/lint.js";
import { Registry } from "../src/connectors/registry.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";

let dir: string;
let registry: Registry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skillscript-lint-rules-"));
  registry = new Registry();
  registry.registerSkillStore("primary", new FilesystemSkillStore(dir));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tier-1: undeclared-var", () => {
  it("flags reference to a variable not declared anywhere", async () => {
    const src = `# Skill: t
t:
    ! Hello $(MISSING)

default: t
`;
    const r = await lint(src);
    const f = r.findings.find((f) => f.rule === "undeclared-var");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.message).toMatch(/MISSING/);
  });

  it("allows reference to declared # Vars:", async () => {
    const src = `# Skill: t
# Vars: NAME=world

t:
    ! Hello $(NAME)

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "undeclared-var")).toBeUndefined();
  });

  it("allows reference to locally-bound var ($set, output binding)", async () => {
    const src = `# Skill: t
t:
    $set X = hello
    ! $(X)

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "undeclared-var")).toBeUndefined();
  });

  it("allows dotted refs (targetname.output, MEMORY.field) as ambient", async () => {
    const src = `# Skill: t
t:
    ! see $(other.output) and $(MEMORY.summary)

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "undeclared-var")).toBeUndefined();
  });

  it("allows foreach iterator var inside the loop body", async () => {
    const src = `# Skill: t
t:
    $set ITEMS = [a, b]
    foreach I in $(ITEMS):
        ! item $(I)

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "undeclared-var")).toBeUndefined();
  });
});

describe("tier-1: unknown-filter", () => {
  it("flags unregistered filter name", async () => {
    const src = `# Skill: t
# Vars: X=hello

t:
    ! see $(X|bogus)

default: t
`;
    const r = await lint(src);
    const f = r.findings.find((f) => f.rule === "unknown-filter");
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/bogus/);
  });

  it("accepts every registered filter (url, shell, json, trim)", async () => {
    const src = `# Skill: t
# Vars: X=hello

t:
    ! $(X|url)
    ! $(X|shell)
    ! $(X|json)
    ! $(X|trim)

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "unknown-filter")).toBeUndefined();
  });
});

describe("tier-1: unknown-skill-reference", () => {
  it("flags & op pointing at a missing skill", async () => {
    const src = `# Skill: caller
t:
    & nonexistent-skill

default: t
`;
    const r = await lint(src, { skillStore: registry.getSkillStore() });
    const f = r.findings.find((f) => f.rule === "unknown-skill-reference");
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/nonexistent-skill/);
  });

  it("doesn't fire when SkillStore isn't provided (can't validate)", async () => {
    const src = `# Skill: caller
t:
    & some-skill

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "unknown-skill-reference")).toBeUndefined();
  });
});

describe("tier-1: disabled-skill-reference", () => {
  it("flags & op pointing at a # Status: disabled skill", async () => {
    await registry.getSkillStore().store("target", `# Skill: target
# Status: disabled

t:
    ! hi

default: t
`);
    const src = `# Skill: caller
t:
    & target

default: t
`;
    const r = await lint(src, { skillStore: registry.getSkillStore() });
    const f = r.findings.find((f) => f.rule === "disabled-skill-reference");
    expect(f).toBeDefined();
  });

  it("doesn't fire for active skills", async () => {
    await registry.getSkillStore().store("target", `# Skill: target
# Status: approved

t:
    ! hi

default: t
`);
    const src = `# Skill: caller
t:
    & target

default: t
`;
    const r = await lint(src, { skillStore: registry.getSkillStore() });
    expect(r.findings.find((f) => f.rule === "disabled-skill-reference")).toBeUndefined();
  });
});

describe("tier-1: credential-in-args", () => {
  it("flags $ op carrying apikey=...", async () => {
    const src = `# Skill: t
t:
    $ some_tool apikey=sk-abcdef url=https://api.example.com

default: t
`;
    const r = await lint(src);
    const f = r.findings.find((f) => f.rule === "credential-in-args");
    expect(f).toBeDefined();
  });

  it("flags token=, password=, bearer=", async () => {
    for (const pattern of ["token=abc", "password=hunter2", "bearer=jwt"]) {
      const src = `# Skill: t
t:
    $ tool ${pattern}

default: t
`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeDefined();
    }
  });

  it("doesn't fire on benign args", async () => {
    const src = `# Skill: t
t:
    $ tool name=foo limit=10

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeUndefined();
  });
});

describe("tier-1: circular-dependency", () => {
  it("flags target-dep cycle", async () => {
    const src = `# Skill: t
a: b
    ! a

b: a
    ! b

default: a
`;
    const r = await lint(src);
    const f = r.findings.find((f) => f.rule === "circular-dependency");
    expect(f).toBeDefined();
    expect(f!.extras?.cycle).toBeDefined();
    expect(Array.isArray(f!.extras!.cycle)).toBe(true);
  });
});

describe("tier-1: missing-dependency", () => {
  it("flags needs: ref to undeclared target", async () => {
    const src = `# Skill: t
a: ghost
    ! a

default: a
`;
    const r = await lint(src);
    const f = r.findings.find((f) => f.rule === "missing-dependency");
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/ghost/);
  });
});

describe("tier-1: missing-skillstore-for-data-ref", () => {
  it("flags & op when no SkillStore passed to lint", async () => {
    const src = `# Skill: caller
t:
    & voice-guide

default: t
`;
    const r = await lint(src);
    const f = r.findings.find((f) => f.rule === "missing-skillstore-for-data-ref");
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/voice-guide/);
    expect(f!.extras?.call_site).toBeDefined();
  });

  it("doesn't fire when SkillStore is passed", async () => {
    await registry.getSkillStore().store("voice-guide", `# Skill: voice-guide
# Type: data
t:
    ! tone
default: t
`);
    const src = `# Skill: caller
t:
    & voice-guide

default: t
`;
    const r = await lint(src, { skillStore: registry.getSkillStore() });
    expect(r.findings.find((f) => f.rule === "missing-skillstore-for-data-ref")).toBeUndefined();
  });

  it("doesn't fire on skills without & ops", async () => {
    const src = `# Skill: t
t:
    ! hi

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "missing-skillstore-for-data-ref")).toBeUndefined();
  });
});

describe("tier-1: malformed-op-grammar + invalid-conditional-syntax (via parse-error categorization)", () => {
  it("flags malformed-op-grammar for bad > op", async () => {
    const src = `# Skill: t
t:
    > badshape

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "malformed-op-grammar")).toBeDefined();
  });

  it("flags invalid-conditional-syntax for unsupported condition", async () => {
    const src = `# Skill: t
t:
    if $(A) && $(B):
        ! both

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "invalid-conditional-syntax")).toBeDefined();
  });
});

describe("tier-1: status-disabled", () => {
  it("flags compiling a disabled skill", async () => {
    const src = `# Skill: gone
# Status: disabled

t:
    ! hi

default: t
`;
    const r = await lint(src);
    const f = r.findings.find((f) => f.rule === "status-disabled");
    expect(f).toBeDefined();
  });
});

describe("tier-2: unsafe-shell-op", () => {
  it("flags @@ shell opt-in", async () => {
    // Parser treats `@@ ...` as an `@` op whose body starts with `@`.
    const src = `# Skill: t
t:
    @ @rm -rf /tmp/something

default: t
`;
    const r = await lint(src);
    const f = r.findings.find((f) => f.rule === "unsafe-shell-op");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
  });
});

describe("tier-2: unconfirmed-mutation", () => {
  it("flags $ op invoking a mutating-named tool without ??", async () => {
    const src = `# Skill: t
t:
    $ delete_record id=42

default: t
`;
    const r = await lint(src);
    const f = r.findings.find((f) => f.rule === "unconfirmed-mutation");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
  });

  it("accepts mutation when preceded by ??", async () => {
    const src = `# Skill: t
t:
    ?? Are you sure you want to delete?
    $ delete_record id=42

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "unconfirmed-mutation")).toBeUndefined();
  });
});

describe("tier-2: model-contention", () => {
  it("flags $ op with batch-shaped tool name + ~ on the same model", async () => {
    const src = `# Skill: t
t:
    $ run_olsen_scan task_type=classify
    ~ prompt="verdict" model=gemma2 -> V

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "model-contention")).toBeDefined();
  });
});

describe("tier-2: draft-with-trigger", () => {
  it("flags draft skill with triggers declared", async () => {
    const src = `# Skill: t
# Status: draft
# Triggers: cron: */5 * * * *

t:
    ! hi

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "draft-with-trigger")).toBeDefined();
  });

  it("doesn't fire on approved skills with triggers", async () => {
    const src = `# Skill: t
# Status: approved
# Triggers: cron: */5 * * * *

t:
    ! hi

default: t
`;
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "draft-with-trigger")).toBeUndefined();
  });
});

describe("tier-2: reference-to-disabled-skill", () => {
  it("warns when & refs a disabled skill", async () => {
    await registry.getSkillStore().store("legacy", `# Skill: legacy
# Status: disabled

t:
    ! old behavior

default: t
`);
    const src = `# Skill: caller
t:
    & legacy

default: t
`;
    const r = await lint(src, { skillStore: registry.getSkillStore() });
    const f = r.findings.find((f) => f.rule === "reference-to-disabled-skill");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
  });
});

describe("tier-3: duplicate-skill-name", () => {
  it("reports info finding when SkillStore has duplicates", async () => {
    // Filesystem store can't actually have duplicates (filename unique).
    // Rule fires when query() returns multiple matches; test the predicate
    // by stubbing query.
    const stubStore = {
      ...registry.getSkillStore(),
      query: async () => [
        { name: "shared", version: "v1", content_hash: "h1", status: "Draft" as const, created_at: 0, updated_at: 0 },
        { name: "shared", version: "v2", content_hash: "h2", status: "Approved" as const, created_at: 0, updated_at: 0 },
      ],
    };
    const src = `# Skill: shared\nt:\n    ! hi\ndefault: t\n`;
    const r = await lint(src, { skillStore: stubStore });
    const f = r.findings.find((f) => f.rule === "duplicate-skill-name");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
  });
});

describe("compile preflight integration", () => {
  it("LintFailureError thrown when tier-1 rule fires at compile time", async () => {
    const src = `# Skill: t
t:
    ! Hello $(MISSING)

default: t
`;
    const { compile } = await import("../src/compile.js");
    await expect(compile(src)).rejects.toThrow(/Tier-1 lint failure/);
  });

  it("LintFailureError carries the diagnostics array", async () => {
    const src = `# Skill: t
t:
    ! Hello $(MISSING) and $(ALSO_MISSING)

default: t
`;
    const { compile } = await import("../src/compile.js");
    const { LintFailureError } = await import("../src/errors.js");
    try {
      await compile(src);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LintFailureError);
      const e = err as InstanceType<typeof LintFailureError>;
      expect(e.diagnostics.length).toBeGreaterThanOrEqual(2);
      expect(e.diagnostics.every((d) => d.severity === "error")).toBe(true);
      expect(e.diagnostics[0]!.remediation).toBeDefined();
    }
  });

  it("skipLintPreflight: true bypasses preflight (escape hatch)", async () => {
    const src = `# Skill: t
t:
    ! Hello $(MISSING)

default: t
`;
    const { compile } = await import("../src/compile.js");
    // Bypassing preflight, compile still parses + renders successfully.
    // The bad ref surfaces at runtime as substituteRuntime throws unresolved.
    const result = await compile(src, { skipLintPreflight: true });
    expect(result.output).toMatch(/Hello/);
  });
});
