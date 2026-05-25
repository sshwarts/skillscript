import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

// v0.7.2 — object-iteration tier-3 advisory closes R4's strongest cold-author
// signal (4 of 5 minions hit it). Fires when `foreach IT in ${VAR}` iterates
// a bare `$` MCP output without a `.field` accessor. Placeholder for v0.8
// tool-schema introspection.

describe("v0.7.2 — object-iteration-advisory tier-3 lint", () => {
  it("fires on `foreach IT in ${VAR}` over `$` MCP output", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    $ youtrack_search query="state:Open" -> ISSUES
    foreach I in \${ISSUES}:
        emit(text="\${I.summary}")
default: run
`;
    const r = await lint(src);
    const adv = r.findings.filter((f) => f.rule === "object-iteration-advisory");
    expect(adv).toHaveLength(1);
    expect(adv[0]!.severity).toBe("info");
    expect(adv[0]!.message).toMatch(/foreach I in/);
    expect(adv[0]!.message).toMatch(/\.items/);
  });

  it("silent when foreach uses `.field` accessor", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    $ youtrack_search query="x" -> ISSUES
    foreach I in \${ISSUES.items}:
        emit(text="\${I.summary}")
default: run
`;
    const r = await lint(src);
    const adv = r.findings.filter((f) => f.rule === "object-iteration-advisory");
    expect(adv).toEqual([]);
  });

  it("silent on legacy $(VAR.field) form", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    $ youtrack_search query="x" -> ISSUES
    foreach I in $(ISSUES.items):
        emit(text="\${I.summary}")
default: run
`;
    const r = await lint(src);
    const adv = r.findings.filter((f) => f.rule === "object-iteration-advisory");
    expect(adv).toEqual([]);
  });

  it("silent on legacy ~ op output (not a $ origin)", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    ~ prompt="list" -> ITEMS
    foreach I in \${ITEMS}:
        emit(text="\${I}")
default: run
`;
    const r = await lint(src);
    const adv = r.findings.filter((f) => f.rule === "object-iteration-advisory");
    // ~ op output origin is "~", not "$". Lint targets $ origin specifically.
    expect(adv).toEqual([]);
  });

  it("silent when foreach iterates a # Vars: declared list", async () => {
    const src = `# Skill: t
# Status: Approved
# Vars: ITEMS=[1,2,3]
run:
    foreach I in \${ITEMS}:
        emit(text="\${I}")
default: run
`;
    const r = await lint(src);
    const adv = r.findings.filter((f) => f.rule === "object-iteration-advisory");
    expect(adv).toEqual([]);
  });

  it("fires once per foreach (not deduped across multiple foreaches)", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    $ search query="x" -> R1
    $ search query="y" -> R2
    foreach A in \${R1}:
        emit(text="\${A.x}")
    foreach B in \${R2}:
        emit(text="\${B.y}")
default: run
`;
    const r = await lint(src);
    const adv = r.findings.filter((f) => f.rule === "object-iteration-advisory");
    expect(adv).toHaveLength(2);
  });
});
