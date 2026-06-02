import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/lint.js";
import { compile } from "../src/compile.js";
import { parse } from "../src/parser.js";
import { bootstrap } from "../src/bootstrap.js";
import { helpResponse } from "../src/help-content.js";
import type { BootstrapResult } from "../src/bootstrap.js";

/**
 * v0.2.11 — six bug fixes + composition docs from Perry's wild-and-crazy
 * harness (thread b6176e02). All sourced from cold-author observations
 * authoring against v0.2.9–v0.2.10.
 *
 *   Bug 4: `unsafe-shell-ambiguous-subst` false-positives on documented
 *     ambient refs (`$(EVENT.fired_at_unix)`, `$(NOW)`) inside `@ unsafe`
 *     bodies — was telling cold authors to rewrite as `$$(EVENT...)` bash
 *     command-sub. Now skips dotted refs and known ambient bare refs.
 *
 *   Bug 5: `@ unsafe` op compiled clean even when the runtime was
 *     configured `enableUnsafeShell: false` — runtime would refuse at
 *     first fire. Now tier-1 error (`unsafe-shell-disabled`) when caller
 *     passes `enableUnsafeShell: false` explicitly.
 *
 *   Bug 6: `unconfirmed-mutation` keyword list missed archive_/prune_/
 *     deploy_/expire_/consolidate_/purge_/reset_ and a few more — Perry's
 *     `archive-old-threads`, `prune-threads`, `dangerous-cleanup`'s
 *     `expire_*` all slipped past unchallenged.
 *
 *   Bug 7: `$ execute_skill skill_name="missing-name"` skipped the
 *     `unknown-skill-reference` lint that fires for `&` refs. Now both
 *     primitives validate against the SkillStore.
 *
 *   Bug 10: Indent-tracker reportedly lost position after closing `else:`
 *     block (A-3 minion's `backup-rotator`). Already closed by v0.2.10
 *     Bug 3 fix (walk-down scope-stack); this test locks in the regression
 *     coverage.
 *
 *   Bug 14: Unknown block-introducers (`parallel:`, `try:`, `catch X:`,
 *     `branch X:`) emitted a confusing "Mid-block indent change" cascade.
 *     Now emit a specific `Unknown block-introducer` diagnostic listing
 *     the recognized set and absorb children into a synthetic frame so
 *     follow-on errors don't pile up.
 *
 *   Docs: `help({topic: "composition"})` topic + 4th example skill
 *     (orchestrator using `$ execute_skill`).
 */

describe("v0.2.11 Bug 4 — unsafe-shell-ambiguous-subst skips documented ambient refs", () => {
  it("EVENT.* dotted ref inside `@ unsafe` no longer fires the warning", async () => {
    const src = "# Skill: t\n# Status: Approved\nsnap:\n    shell(command=\"tar czf /tmp/snap-$(EVENT.fired_at_unix).tgz /tmp\", unsafe=true) -> OUT\ndefault: snap\n";
    const r = await lint(src);
    const subst = r.findings.find((f) => f.rule === "unsafe-shell-ambiguous-subst");
    expect(subst).toBeUndefined();
  });

  it("NOW bare ambient ref inside `@ unsafe` no longer fires the warning", async () => {
    const src = "# Skill: t\n# Status: Approved\nsnap:\n    shell(command=\"echo $(NOW) >> /tmp/log\", unsafe=true) -> OUT\ndefault: snap\n";
    const r = await lint(src);
    const subst = r.findings.find((f) => f.rule === "unsafe-shell-ambiguous-subst");
    expect(subst).toBeUndefined();
  });

  it("genuinely undeclared bare var inside `@ unsafe` still fires", async () => {
    const src = "# Skill: t\n# Status: Approved\nsnap:\n    shell(command=\"echo $(MYSTERY_VAR)\", unsafe=true) -> OUT\ndefault: snap\n";
    const r = await lint(src);
    const subst = r.findings.find((f) => f.rule === "unsafe-shell-ambiguous-subst");
    expect(subst).toBeDefined();
    expect(subst!.message).toMatch(/MYSTERY_VAR/);
  });
});

describe("v0.2.11 Bug 5 — `@ unsafe` tier-1 when enableUnsafeShell:false", () => {
  it("compiles clean when enableUnsafeShell is undefined (unchanged backwards-compat)", async () => {
    const src = "# Skill: t\n# Status: Approved\nrun:\n    shell(command=\"ls /tmp\", unsafe=true)\ndefault: run\n";
    await expect(compile(src)).resolves.toBeDefined();
  });

  it("fails tier-1 when enableUnsafeShell is explicitly false", async () => {
    const src = "# Skill: t\n# Status: Approved\nrun:\n    shell(command=\"ls /tmp\", unsafe=true)\ndefault: run\n";
    await expect(compile(src, { enableUnsafeShell: false })).rejects.toThrow(/unsafe-shell-disabled/);
  });

  it("compiles clean when enableUnsafeShell is explicitly true (only tier-2 warning fires)", async () => {
    const src = "# Skill: t\n# Status: Approved\nrun:\n    shell(command=\"ls /tmp\", unsafe=true)\ndefault: run\n";
    await expect(compile(src, { enableUnsafeShell: true })).resolves.toBeDefined();
    const r = await lint(src, { enableUnsafeShell: true });
    expect(r.findings.find((f) => f.rule === "unsafe-shell-disabled")).toBeUndefined();
    expect(r.findings.find((f) => f.rule === "unsafe-shell-op")).toBeDefined();
  });

  it("does not fire on skills that don't use `@ unsafe`", async () => {
    const src = "# Skill: t\n# Status: Approved\nrun:\n    shell(command=\"ls /tmp\")\ndefault: run\n";
    const r = await lint(src, { enableUnsafeShell: false });
    expect(r.findings.find((f) => f.rule === "unsafe-shell-disabled")).toBeUndefined();
  });
});

describe("v0.2.11 Bug 6 — unconfirmed-mutation catches archive/prune/deploy/etc.", () => {
  const MUTATING_PREFIXES = ["archive", "prune", "deploy", "expire", "consolidate", "purge", "reset", "rotate", "move", "rename", "drop", "truncate", "upsert", "overwrite", "clear", "wipe", "finalize"];

  for (const prefix of MUTATING_PREFIXES) {
    it(`fires on \`$ ${prefix}_thing arg=v\` without prior \`??\``, async () => {
      const src = `# Skill: t\n# Status: Approved\nrun:\n    $ ${prefix}_thing target=foo\ndefault: run\n`;
      const r = await lint(src);
      const mut = r.findings.find((f) => f.rule === "unconfirmed-mutation");
      expect(mut, `expected unconfirmed-mutation to fire for ${prefix}_thing`).toBeDefined();
    });
  }

  it("does NOT fire when op carries `approved=\"...\"` kwarg", async () => {
    const src = "# Skill: t\n# Status: Approved\nrun:\n    $ prune_threads older_than=30d approved=\"user confirmed\"\ndefault: run\n";
    const r = await lint(src);
    expect(r.findings.find((f) => f.rule === "unconfirmed-mutation")).toBeUndefined();
  });
});

describe("v0.2.11 Bug 7 — `$ execute_skill` validates skill_name like `&`", () => {
  let wired: BootstrapResult;
  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "v0211-bug7-"));
    wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
    await wired.skillStore.store("child-known", "# Skill: child-known\n# Status: Approved\nrun:\n    emit(text=\"hi\")\ndefault: run\n");
  });

  it("fires unknown-skill-reference for `$ execute_skill skill_name=<missing>`", async () => {
    const src = "# Skill: parent\n# Status: Approved\norch:\n    $ execute_skill skill_name=child-missing -> OUT\ndefault: orch\n";
    const r = await lint(src, { skillStore: wired.skillStore });
    const ref = r.findings.find((f) => f.rule === "unknown-skill-reference");
    expect(ref).toBeDefined();
    expect(ref!.message).toMatch(/child-missing/);
  });

  it("clean lint when child exists in SkillStore (quoted skill_name)", async () => {
    const src = `# Skill: parent\n# Status: Approved\norch:\n    $ execute_skill skill_name="child-known" -> OUT\ndefault: orch\n`;
    const r = await lint(src, { skillStore: wired.skillStore });
    expect(r.findings.find((f) => f.rule === "unknown-skill-reference")).toBeUndefined();
  });

  it("clean lint when child exists in SkillStore (bare skill_name)", async () => {
    const src = "# Skill: parent\n# Status: Approved\norch:\n    $ execute_skill skill_name=child-known -> OUT\ndefault: orch\n";
    const r = await lint(src, { skillStore: wired.skillStore });
    expect(r.findings.find((f) => f.rule === "unknown-skill-reference")).toBeUndefined();
  });
});

describe("v0.2.11 Bug 10 — indent-tracker dedent back to outer scope after `else:`", () => {
  it("A-3 backup-rotator shape compiles (if/else then sibling `!` at outer indent)", async () => {
    const src = "# Skill: backup-rotator\n# Status: Approved\n# Vars: TAR_OUT=ok\nverify:\n    if $(TAR_OUT) != \"snapshot failed\":\n        emit(text=\"snapshot ok\")\n    else:\n        emit(text=\"snapshot FAILED\")\n    emit(text=\"next horizon: $(EVENT.fired_at_plus_1d_unix)\")\ndefault: verify\n";
    const r = await compile(src);
    expect(r.output).toMatch(/snapshot ok/);
    expect(r.output).toMatch(/snapshot FAILED/);
    expect(r.output).toMatch(/next horizon/);
  });

  it("if/elif/else then sibling op at outer indent (compound chain)", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: X=foo\nverify:\n    if $(X) == \"foo\":\n        emit(text=\"a\")\n    elif $(X) == \"bar\":\n        emit(text=\"b\")\n    else:\n        emit(text=\"c\")\n    emit(text=\"sibling\")\ndefault: verify\n";
    const r = await compile(src);
    expect(r.output).toMatch(/sibling/);
  });
});

describe("v0.2.11 Bug 14 — unknown-block-introducer diagnostic", () => {
  it("emits specific diagnostic for `parallel:`, not 'Mid-block indent change'", () => {
    const src = "# Skill: t\n# Status: Approved\nclassify:\n    parallel:\n        branch a:\n            emit(text=\"one\")\n        branch b:\n            emit(text=\"two\")\ndefault: classify\n";
    const r = parse(src);
    const unk = r.parseErrors.find((m) => /Unknown block-introducer 'parallel:'/.test(m));
    expect(unk).toBeDefined();
    expect(unk!).toMatch(/Skillscript recognizes/);
  });

  it("emits specific diagnostic for `try:` / `catch X:`", () => {
    const src = "# Skill: t\n# Status: Approved\nverdict:\n    try:\n        emit(text=\"one\")\n    catch any as E:\n        emit(text=\"two\")\ndefault: verdict\n";
    const r = parse(src);
    expect(r.parseErrors.find((m) => /Unknown block-introducer 'try:'/.test(m))).toBeDefined();
    expect(r.parseErrors.find((m) => /Unknown block-introducer 'catch:'/.test(m))).toBeDefined();
  });

  it("does NOT misfire on recognized block-introducers", () => {
    const src = "# Skill: t\n# Status: Approved\n# Vars: X=foo\nrun:\n    if $(X) == \"foo\":\n        emit(text=\"ok\")\n    elif $(X) == \"bar\":\n        emit(text=\"ok2\")\n    else:\n        emit(text=\"ok3\")\n    foreach IT in $(X):\n        emit(text=\"item\")\ndefault: run\n";
    const r = parse(src);
    expect(r.parseErrors.find((m) => /Unknown block-introducer/.test(m))).toBeUndefined();
  });
});

describe("v0.2.11 docs — help() composition topic + 4th example", () => {
  it("`help()` lists 'composition' in available_topics", () => {
    const r = helpResponse(null, "0.2.11") as { available_topics: string[] };
    expect(r.available_topics).toContain("composition");
  });

  it("`help({topic: 'composition'})` returns content covering canonical primitives", () => {
    const r = helpResponse("composition", "0.2.11") as { content: string };
    expect(r.content).toMatch(/data-skill inline/i);
    expect(r.content).toMatch(/inline\(skill=/);
    expect(r.content).toMatch(/execute_skill/);
    expect(r.content).toMatch(/depth-5|recursion/i);
    expect(r.content).toMatch(/unknown-skill-reference/);
  });

  it("`help({topic: 'examples'})` now includes a 4th orchestrator example", () => {
    const r = helpResponse("examples", "0.2.11") as { content: string };
    expect(r.content).toMatch(/## 4\. Composition/);
    expect(r.content).toMatch(/morning-brief-orchestrator/);
    // v0.7.2: function-call form replaces legacy $ execute_skill symbol-form
    expect(r.content).toMatch(/execute_skill\(skill_name=/);
  });
});
