/**
 * v0.9.4.1 — lint polish from R-series next-ring (Perry's `77ed6c65`).
 *
 * Two mechanical lint fixes; no contract surface touched. Validation
 * relies on the v0.9.4 baseline (mean UX 4.0/5) — these patches
 * incrementally clean cold-author noise but don't move the threshold.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/lint.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";

describe("v0.9.4.1 — fallback-trailer lint-layering", () => {
  it("demotes unwired-primary-connector to info when `(fallback: ...)` is present", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    $ unknown_tool query="x" -> R (fallback: "missing")
    emit(text="\${R}")

default: m
`;
    const r = await lint(src, { mcpConnectorNames: ["llm", "memory"] });
    const finding = r.findings.find((f) => f.rule === "unwired-primary-connector");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("info");
    expect(finding!.message).toMatch(/every call site declares.*fallback/i);
    expect(finding!.extras?.hasFallback).toBe(true);
  });

  it("keeps error severity when no fallback is present", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    $ unknown_tool query="x" -> R
    emit(text="\${R}")

default: m
`;
    const r = await lint(src, { mcpConnectorNames: ["llm", "memory"] });
    const finding = r.findings.find((f) => f.rule === "unwired-primary-connector");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("error");
  });

  it("keeps error severity when SOME call sites lack fallback (mixed)", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    $ unknown_tool query="a" -> R1 (fallback: "missing")
    $ unknown_tool query="b" -> R2
    emit(text="\${R1} \${R2}")

default: m
`;
    const r = await lint(src, { mcpConnectorNames: ["llm", "memory"] });
    const findings = r.findings.filter((f) => f.rule === "unwired-primary-connector");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
  });

  it("does not fire when a matching connector IS wired (back-compat)", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    $ memory query="x" -> R
    emit(text="\${R}")

default: m
`;
    const r = await lint(src, { mcpConnectorNames: ["memory"] });
    expect(r.findings.find((f) => f.rule === "unwired-primary-connector")).toBeUndefined();
  });
});

describe("v0.9.4.1 — forward-reference dedup", () => {
  let dir: string;
  let store: FilesystemSkillStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v0941-fwd-"));
    store = new FilesystemSkillStore(join(dir, "skills"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("emits one unknown-skill-reference per missing skill, even when referenced via both `&` and `$ execute_skill`", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    & missing-skill -> A
    $ execute_skill skill_name="missing-skill" -> B
    emit(text="\${A} \${B}")

default: m
`;
    const r = await lint(src, { skillStore: store });
    const findings = r.findings.filter((f) => f.rule === "unknown-skill-reference");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toMatch(/`&`.*`\$ execute_skill`|`\$ execute_skill`.*`&`/);
    expect(findings[0]!.extras?.vias).toEqual(expect.arrayContaining(["&", "$ execute_skill"]));
  });

  it("emits N findings for N missing skills (no over-dedup)", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    & missing-a -> A
    & missing-b -> B
    emit(text="\${A} \${B}")

default: m
`;
    const r = await lint(src, { skillStore: store });
    const findings = r.findings.filter((f) => f.rule === "unknown-skill-reference");
    expect(findings).toHaveLength(2);
    const names = findings.map((f) => f.extras?.referenced_skill).sort();
    expect(names).toEqual(["missing-a", "missing-b"]);
  });

  it("does not double-fire deferred-skill-reference (rule removed in v0.9.4.1)", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    & missing-skill -> A
    emit(text="\${A}")

default: m
`;
    const r = await lint(src, { skillStore: store });
    // Pre-v0.9.4.1 this would emit 2 findings (1 warning + 1 info).
    expect(r.findings.filter((f) => f.rule === "deferred-skill-reference")).toEqual([]);
    expect(r.findings.filter((f) => f.rule === "unknown-skill-reference")).toHaveLength(1);
  });

  it("`recipients=` 4-for-2 case: 2 missing skills × dual-ref = 2 findings (down from 4)", async () => {
    const src = `# Skill: t
# Status: Approved

m:
    & missing-a -> A1
    $ execute_skill skill_name="missing-a" -> A2
    & missing-b -> B1
    $ execute_skill skill_name="missing-b" -> B2
    emit(text="\${A1} \${A2} \${B1} \${B2}")

default: m
`;
    const r = await lint(src, { skillStore: store });
    const findings = r.findings.filter((f) => f.rule === "unknown-skill-reference");
    expect(findings).toHaveLength(2);
  });
});
