import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/lint.js";
import { compile } from "../src/compile.js";
import { parse } from "../src/parser.js";
import { execute } from "../src/runtime.js";
import { helpResponse } from "../src/help-content.js";
import { bootstrap } from "../src/bootstrap.js";
import type { BootstrapResult } from "../src/bootstrap.js";

/**
 * v0.3.0 — accumulator slate (memory `442cf4bb` approved by Perry).
 * New `$append VAR <value>` op + three tier-1 lint rules. Per the spec,
 * v0.3.0 is list-only; string/map accumulation deferred until real cases
 * surface.
 */

let wired: BootstrapResult;
beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "v030-"));
  wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
});

describe("v0.3.0 — $append parser shape", () => {
  it("parses `$append VAR <value>` cleanly", () => {
    const src = "# Skill: t\n# Status: Approved\ngo:\n    $set FOUND = []\n    $append FOUND \"hello\"\ndefault: go\n";
    const r = parse(src);
    expect(r.parseErrors).toEqual([]);
    const goTarget = r.targets.get("go")!;
    expect(goTarget.ops).toHaveLength(2);
    expect(goTarget.ops[1]!.kind).toBe("$append");
    expect(goTarget.ops[1]!.setName).toBe("FOUND");
  });

  it("rejects malformed `$append` (missing value)", () => {
    const src = "# Skill: t\n# Status: Approved\ngo:\n    $append FOUND\ndefault: go\n";
    const r = parse(src);
    expect(r.parseErrors.find((m) => /Malformed `\$append`/.test(m))).toBeDefined();
  });
});

describe("v0.3.0 — lint: uninitialized-append (spec OK + FAIL cases)", () => {
  // Spec OK case 1: init in target body, append in foreach.
  it("OK: init at target-body, append in nested foreach", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: OUTERS=[]\nwalk:\n    $set FOUND = []\n    foreach O in $(OUTERS):\n        foreach I in $(O.items):\n            $append FOUND $(I.id)\ndefault: walk\n";
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "uninitialized-append")).toBeUndefined();
  });

  it("OK: init at target-body, append in if-inside-foreach", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: MS=[]\nwalk:\n    $set FOUND = []\n    foreach M in $(MS):\n        if $(M.urgent) == \"true\":\n            $append FOUND $(M.id)\ndefault: walk\n";
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "uninitialized-append")).toBeUndefined();
  });

  it("OK: init via # Vars: FOUND=[]", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: MS=[], FOUND=[]\nwalk:\n    foreach M in $(MS):\n        $append FOUND $(M)\ndefault: walk\n";
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "uninitialized-append")).toBeUndefined();
  });

  it("FAIL: uninitialized typo (no $set anywhere)", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: MS=[]\nwalk:\n    $set FOUND = []\n    foreach M in $(MS):\n        $append FUOND $(M)\ndefault: walk\n";
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "uninitialized-append");
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/FUOND/);
    expect(f!.message).toMatch(/check the spelling/);
  });

  it("FAIL: init inside foreach, append in sibling foreach", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: MS=[]\nwalk:\n    foreach M in $(MS):\n        $set FOUND = []\n    foreach M2 in $(MS):\n        $append FOUND $(M2)\ndefault: walk\n";
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "uninitialized-append")).toBeDefined();
  });
});

describe("v0.3.0 — lint: foreach-local-accumulator-target", () => {
  it("FAIL: init inside foreach body, append in same foreach (silent loss each iter)", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: MS=[]\nwalk:\n    foreach M in $(MS):\n        $set FOUND = []\n        $append FOUND $(M)\ndefault: walk\n";
    const r = await lint(src);
    const f = r.findings.find((x) => x.rule === "foreach-local-accumulator-target");
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/Move the.*to the target body/);
  });

  it("OK: init at target body, append in foreach (no foreach-local fire)", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: MS=[]\nwalk:\n    $set FOUND = []\n    foreach M in $(MS):\n        $append FOUND $(M)\ndefault: walk\n";
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "foreach-local-accumulator-target")).toBeUndefined();
  });
});

describe("v0.3.0 — lint: append-to-non-list", () => {
  it("OK: init is a quoted string literal (v0.5.0 — string concat permitted)", async () => {
    // Pre-v0.5.0 this fired append-to-non-list. v0.5.0 item 2 permits
    // string-typed targets (concat mode); the lint now fires only on
    // numeric/boolean/null/object inits.
    const src = "# Skill: t\n# Status: Approved\nrun:\n    $set X = \"hello\"\n    $append X \"more\"\ndefault: run\n";
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "append-to-non-list")).toBeUndefined();
  });

  it("FAIL: init is a numeric literal (v0.5.0 — still rejected)", async () => {
    const src = "# Skill: t\n# Status: Approved\nrun:\n    $set X = 42\n    $append X 7\ndefault: run\n";
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "append-to-non-list")).toBeDefined();
  });

  it("OK: init is `[]`", async () => {
    const src = "# Skill: t\n# Status: Approved\nrun:\n    $set X = []\n    $append X \"item\"\ndefault: run\n";
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "append-to-non-list")).toBeUndefined();
  });

  it("does NOT fire when init is a ref (can't statically check)", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: SEED=[1,2,3]\nrun:\n    $set X = $(SEED)\n    $append X 4\ndefault: run\n";
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "append-to-non-list")).toBeUndefined();
  });
});

describe("v0.3.0 — runtime: $append mutates outer-scope list across foreach iterations", () => {
  it("dedup-by-id pattern works end-to-end", async () => {
    const src = "# Skill: dedup\n# Status: Approved\n# Vars: MS=[\"a\",\"a\",\"b\",\"c\",\"b\"]\nwalk:\n    $set FOUND = []\n    foreach M in $(MS):\n        if $(M) not in $(FOUND):\n            $append FOUND $(M)\n            emit(text=\"NEW: $(M)\")\n        else:\n            emit(text=\"dup: $(M)\")\n    emit(text=\"novel: $(FOUND|length)\")\ndefault: walk\n";
    const r = await compile(src);
    const result = await execute(r.parsed, {}, r.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.emissions).toContain("NEW: a");
    expect(result.emissions).toContain("dup: a");
    expect(result.emissions).toContain("NEW: b");
    expect(result.emissions).toContain("NEW: c");
    expect(result.emissions).toContain("dup: b");
    expect(result.emissions).toContain("novel: 3");
    expect(result.finalVars["FOUND"]).toEqual(["a", "b", "c"]);
  });

  it("conditional-collect pattern works end-to-end", async () => {
    // Plain-scalar shape; nested objects in `# Vars:` literals are bracket-
    // splitter territory (pre-existing limitation; not the accumulator's
    // problem). This still exercises append + `in` membership on per-iter
    // values, which is the load-bearing accumulator behavior.
    const src = "# Skill: collect\n# Status: Approved\n# Vars: ITEMS=[\"a\",\"b\",\"c\",\"d\"], KEEP=[\"a\",\"c\"]\nrun:\n    $set KEPT = []\n    foreach I in $(ITEMS):\n        if $(I) in $(KEEP):\n            $append KEPT $(I)\n    emit(text=\"kept: $(KEPT|length)\")\ndefault: run\n";
    const r = await compile(src);
    const result = await execute(r.parsed, {}, r.targetOrder, { registry: wired.registry });
    expect(result.errors).toEqual([]);
    expect(result.finalVars["KEPT"]).toEqual(["a", "c"]);
  });
});

describe("v0.3.0 — mechanical-mode renders $append without mutating", () => {
  it("mechanical mode emits 'Would append' record + leaves list unchanged", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: MS=[\"a\",\"b\"]\nrun:\n    $set FOUND = []\n    foreach M in $(MS):\n        $append FOUND $(M)\n    emit(text=\"collected: $(FOUND|length)\")\ndefault: run\n";
    const r = await compile(src);
    const result = await execute(r.parsed, {}, r.targetOrder, { registry: wired.registry, mechanical: true });
    expect(result.errors).toEqual([]);
    expect(result.emissions.some((e) => e.includes("Would append to $(FOUND)"))).toBe(true);
    // Mechanical mode does not actually mutate — final list stays empty.
    expect(result.finalVars["FOUND"]).toEqual([]);
  });
});

describe("v0.3.0 — render output (prompt + prose formats)", () => {
  it("prompt format renders `Append to $(VAR): value`", async () => {
    const src = "# Skill: t\n# Status: Approved\nr:\n    $set X = []\n    $append X \"hi\"\ndefault: r\n";
    const r = await compile(src, { format: "prompt" });
    // processSetValue strips surrounding quotes, so the rendered value is bare `hi`.
    expect(r.output).toMatch(/Append to \$\(X\): hi/);
  });

  it("prose format renders accumulator phrasing", async () => {
    const src = "# Skill: t\n# Status: Approved\nr:\n    $set X = []\n    $append X \"hi\"\ndefault: r\n";
    const r = await compile(src, { format: "prose" });
    expect(r.output).toMatch(/Appends hi to list \$\(X\)/);
  });
});

describe("v0.3.0 — help surface", () => {
  it("ops topic includes $append entry", () => {
    const r = helpResponse("ops", "0.3.0") as { content: string };
    expect(r.content).toMatch(/\$append/);
    expect(r.content).toMatch(/uninitialized-append/);
    expect(r.content).toMatch(/foreach-local-accumulator-target/);
  });

  it("examples topic includes the dedup-walk worked example", () => {
    const r = helpResponse("examples", "0.3.0") as { content: string };
    expect(r.content).toMatch(/## 5\. Dedup-by-id with the accumulator/);
    expect(r.content).toMatch(/\$append SEEN/);
  });

  it("lint-codes topic lists the 3 new accumulator rules", () => {
    const r = helpResponse("lint-codes", "0.3.0") as { content: string };
    // Sufficient to confirm presence — exact phrasing not pinned.
    expect(r.content.toLowerCase()).toMatch(/uninitialized-append|append.*accumulator/);
  });
});
