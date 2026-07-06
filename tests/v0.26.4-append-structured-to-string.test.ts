import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

/**
 * v0.26.4 — `append-structured-to-string` advisory (Perry `c052581b`).
 *
 * Sibling of `object-iteration-advisory`. Fires when a `$append` into a STRING
 * accumulator takes a bare `$` op-output ref (a possibly-structured list/object)
 * with no `.field` accessor and no `|json` filter — the case that silently
 * mangled enter-project's `$append DOMAIN_INSTRUCTIONS ${DI}` (DI =
 * amp_list_memories array-of-objects → comma-fragmented blob).
 *
 * Tier-3 advisory (info), not a warning: a `$` op's return shape is statically
 * unknowable, so warning-tier would over-fire on legitimate string→string
 * appends. Same severity + uncertainty posture as its sibling.
 */

const RULE = "append-structured-to-string";

function findRule(findings: { rule: string }[]) {
  return findings.filter((f) => f.rule === RULE);
}

describe("v0.26.4 append-structured-to-string advisory", () => {
  it("FIRES: bare ${DI} ($ op-output) appended to a string accumulator", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: RAW\nrun:\n    $ json_parse \${RAW} -> DI\n    $set S = ""\n    $append S \${DI}\n    emit(text="\${S}")\ndefault: run\n`;
    const r = await lint(src);
    const hits = findRule(r.findings);
    expect(hits.length).toBe(1);
    expect(hits[0]!.severity).toBe("info"); // tier-3 advisory, not warning/error
  });

  it("SUPPRESSED: `.field` accessor projects a scalar", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: RAW\nrun:\n    $ json_parse \${RAW} -> DI\n    $set S = ""\n    $append S \${DI.detail}\n    emit(text="\${S}")\ndefault: run\n`;
    const r = await lint(src);
    expect(findRule(r.findings)).toEqual([]);
  });

  it("SUPPRESSED: `|json` filter serializes explicitly", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: RAW\nrun:\n    $ json_parse \${RAW} -> DI\n    $set S = ""\n    $append S \${DI|json}\n    emit(text="\${S}")\ndefault: run\n`;
    const r = await lint(src);
    expect(findRule(r.findings)).toEqual([]);
  });

  it("NO FIRE: list target (bare append is correct)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: RAW\nrun:\n    $ json_parse \${RAW} -> DI\n    $set L = []\n    $append L \${DI}\ndefault: run\n`;
    const r = await lint(src);
    expect(findRule(r.findings)).toEqual([]);
  });

  it("NO FIRE: string→string append (ref origin is a $set literal, not a $ op)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $set T = "hello"\n    $set S = ""\n    $append S \${T}\n    emit(text="\${S}")\ndefault: run\n`;
    const r = await lint(src);
    expect(findRule(r.findings)).toEqual([]);
  });

  it("FIRES: a non-`json` filter (e.g. |trim) does NOT suppress — only .field/|json are hatches", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Vars: RAW\nrun:\n    $ json_parse \${RAW} -> DI\n    $set S = ""\n    $append S \${DI|trim}\n    emit(text="\${S}")\ndefault: run\n`;
    const r = await lint(src);
    expect(findRule(r.findings).length).toBe(1);
  });

  it("enter-project repro: $append DOMAIN_INSTRUCTIONS ${DI} fires the advisory", async () => {
    // The exact shape that produced the comma-fragmented blob.
    const src = `# Skill: enter-project\n# Status: Approved\n# Vars: RAW\nrun:\n    $ json_parse \${RAW} -> DI\n    $set DOMAIN_INSTRUCTIONS = ""\n    $append DOMAIN_INSTRUCTIONS \${DI}\n    emit(text="\${DOMAIN_INSTRUCTIONS}")\ndefault: run\n`;
    const r = await lint(src);
    const hits = findRule(r.findings);
    expect(hits.length).toBe(1);
    expect(hits[0]!.message).toContain("DOMAIN_INSTRUCTIONS");
  });
});
