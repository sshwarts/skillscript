import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/lint.js";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { helpResponse } from "../src/help-content.js";
import type { BootstrapResult } from "../src/bootstrap.js";

/**
 * v0.3.1 — forward-reference deferred resolution. Demote
 * `unknown-skill-reference` and `unknown-template-reference` from tier-1
 * (error) to tier-2 (warning). Add tier-3 `deferred-skill-reference`
 * advisory. New runtime `MissingSkillReferenceError extends OpError`
 * throws at execute time if refs still unresolved. # OnError: stays
 * tier-1 (stronger contract); disabled-skill-reference stays tier-1.
 * Spec approved by Perry in memory `be9993e3`.
 */

let wired: BootstrapResult;
beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "v031-"));
  wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  await wired.skillStore.store("known-child", "# Skill: known-child\n# Status: Approved\nrun:\n    ! child says hi\ndefault: run\n");
});

describe("v0.3.1 — unknown-skill-reference demoted to tier-2", () => {
  it("$ execute_skill skill_name=<missing> fires WARNING (was error)", async () => {
    const src = "# Skill: parent\n# Status: Approved\norch:\n    $ execute_skill skill_name=child-missing -> OUT\ndefault: orch\n";
    const r = await lint(src, { skillStore: wired.skillStore });
    const f = r.findings.find((x) => x.rule === "unknown-skill-reference");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
  });

  it("compile succeeds (no longer blocks) with missing skill ref", async () => {
    const src = "# Skill: parent\n# Status: Approved\norch:\n    $ execute_skill skill_name=child-missing -> OUT\ndefault: orch\n";
    await expect(compile(src, { skillStore: wired.skillStore })).resolves.toBeDefined();
  });

  it("clean (no warning) when child exists in SkillStore", async () => {
    const src = "# Skill: parent\n# Status: Approved\norch:\n    $ execute_skill skill_name=known-child -> OUT\ndefault: orch\n";
    const r = await lint(src, { skillStore: wired.skillStore });
    expect(r.findings.find((x) => x.rule === "unknown-skill-reference")).toBeUndefined();
  });
});

describe("v0.3.1 — unknown-template-reference demoted to tier-2", () => {
  it("# Templates: <missing> fires WARNING (was error)", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Templates: missing-template\n# Output: agent: agent\nm:\n    ! hi\ndefault: m\n";
    const r = await lint(src, { skillStore: wired.skillStore });
    const f = r.findings.find((x) => x.rule === "unknown-template-reference");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
  });

  it("compile succeeds with missing template", async () => {
    const src = "# Skill: t\n# Status: Approved\n# Templates: missing-template\n# Output: agent: agent\nm:\n    ! hi\ndefault: m\n";
    await expect(compile(src, { skillStore: wired.skillStore })).resolves.toBeDefined();
  });
});

describe("v0.3.1 — deferred-skill-reference advisory (REMOVED in v0.9.4.1)", () => {
  // The tier-3 advisory was paired with unknown-skill-reference/
  // unknown-template-reference to "confirm the deferred-resolution path is
  // engaged." Per Perry's `77ed6c65` next-ring finding ("4 diagnostics for
  // 2 missing skills") it was just noise — the warning's remediation
  // already explains the forward-ref path. Removed in v0.9.4.1.

  it("rule no longer fires (replaced by tier-2 warning's remediation)", async () => {
    const src = "# Skill: parent\n# Status: Approved\norch:\n    $ execute_skill skill_name=child-missing -> OUT\ndefault: orch\n";
    const r = await lint(src, { skillStore: wired.skillStore });
    expect(r.findings.find((x) => x.rule === "deferred-skill-reference")).toBeUndefined();
    // The tier-2 warning still fires (carries the forward-ref guidance via remediation field).
    const warning = r.findings.find((x) => x.rule === "unknown-skill-reference");
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");
  });

  it("does NOT fire when the ref resolves cleanly", async () => {
    const src = "# Skill: parent\n# Status: Approved\norch:\n    $ execute_skill skill_name=known-child -> OUT\ndefault: orch\n";
    const r = await lint(src, { skillStore: wired.skillStore });
    expect(r.findings.find((x) => x.rule === "deferred-skill-reference")).toBeUndefined();
  });
});

describe("v0.3.1 — runtime MissingSkillReferenceError on still-unresolved refs", () => {
  it("execute throws MissingSkillReferenceError when $ execute_skill target is still missing", async () => {
    const src = "# Skill: parent\n# Status: Approved\norch:\n    $ execute_skill skill_name=child-missing -> OUT\n    ! after\ndefault: orch\n";
    const r = await compile(src, { skillStore: wired.skillStore });
    const result = await execute(r.parsed, {}, r.targetOrder, { registry: wired.registry });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/child-missing/);
  });

  it("`& <missing>` reaching runtime throws MissingSkillReferenceError (with structured class)", async () => {
    const src = "# Skill: t\n# Status: Approved\nt:\n    & voice-guide-missing\ndefault: t\n";
    const compiled = await compile(src, { skipLintPreflight: true });
    const result = await execute(compiled.parsed, {}, compiled.targetOrder, { registry: wired.registry });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.class).toBe("MissingSkillReferenceError");
    expect(result.errors[0]!.opKind).toBe("&");
  });
});

describe("v0.3.1 — `# OnError:` validation stays tier-1 (stronger contract)", () => {
  it("# OnError: <missing> still blocks compile", async () => {
    const src = "# Skill: t\n# Status: Approved\n# OnError: missing-fallback-skill\nrun:\n    ! body\ndefault: run\n";
    await expect(compile(src, { skillStore: wired.skillStore })).rejects.toThrow(/missing-fallback-skill|fallback/i);
  });

  it("# OnError: <existing> is fine", async () => {
    const src = "# Skill: t\n# Status: Approved\n# OnError: known-child\nrun:\n    ! body\ndefault: run\n";
    await expect(compile(src, { skillStore: wired.skillStore })).resolves.toBeDefined();
  });
});

describe("v0.3.1 — help surface", () => {
  it("lint-codes topic moves unknown-skill-reference + unknown-template-reference to tier-2", () => {
    const r = helpResponse("lint-codes", "0.3.1") as { content: string };
    // Both should appear in the Tier-2 section, not Tier-1.
    const tier2Section = r.content.split("## Tier-2")[1] ?? "";
    expect(tier2Section).toMatch(/unknown-skill-reference/);
    expect(tier2Section).toMatch(/unknown-template-reference/);
  });

  it("lint-codes topic lists deferred-skill-reference under Tier-3", () => {
    const r = helpResponse("lint-codes", "0.3.1") as { content: string };
    const tier3Section = r.content.split("## Tier-3")[1] ?? "";
    expect(tier3Section).toMatch(/deferred-skill-reference/);
  });

  it("composition topic mentions forward-reference deferred resolution", () => {
    const r = helpResponse("composition", "0.3.1") as { content: string };
    expect(r.content).toMatch(/[Ff]orward reference/);
    expect(r.content).toMatch(/MissingSkillReferenceError|deferred-skill-reference|tier-2/);
  });
});

describe("v0.3.1 — disabled-skill-reference stays tier-1 (stronger contract)", () => {
  it("disabled skill reference is still an error, not a warning", async () => {
    const home2 = mkdtempSync(join(tmpdir(), "v031-disabled-"));
    const wired2 = bootstrap({ skillsDir: join(home2, "skills"), traceDir: join(home2, "traces") });
    await wired2.skillStore.store("disabled-child", "# Skill: disabled-child\n# Status: Disabled\nrun:\n    ! body\ndefault: run\n");
    const src = "# Skill: t\n# Status: Approved\norch:\n    $ execute_skill skill_name=disabled-child -> OUT\ndefault: orch\n";
    const r = await lint(src, { skillStore: wired2.skillStore });
    const f = r.findings.find((x) => x.rule === "disabled-skill-reference");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
  });
});
