import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

/**
 * v1.0 fix-cycle papercuts (fix list 33bf53d3):
 *   P2.2 — the `invalid-conditional-syntax` error must teach the CANONICAL
 *          `${REF}` notation, not the deprecated `$(REF)` form. The loud,
 *          helpful error was steering cold authors to deprecated syntax.
 *   P2.4 — the `shell-binary-not-allowed` advisory must cover the argv form
 *          `shell(argv=["bin", ...])`, not just `shell(command="bin ...")`.
 *          Pre-fix the argv binary lived in `op.argv[0]` (op.body empty) so it
 *          silently bypassed the compile-time allowlist check (Perry's `expr`
 *          cascade in cold-data-threshold).
 */

describe("v1.0 P2.2 — conditional-syntax error teaches canonical ${REF} notation", () => {
  it("rejects a bare-numeric RHS and the message uses ${REF}, not deprecated $(REF)", async () => {
    const src = `# Skill: t
# Status: Approved
# Vars: N="5"
run:
    if \${N} > 2:
        emit(text="hi")
default: run
`;
    const { findings } = await lint(src);
    const hit = findings.find((f) => f.rule === "invalid-conditional-syntax");
    expect(hit).toBeDefined();
    expect(hit?.message.includes("${REF}")).toBe(true);
    expect(hit?.message.includes("$(REF)")).toBe(false);
  });
});

describe("v1.0 P2.4 — shell-binary-not-allowed covers the argv form", () => {
  it("fires on an argv-form binary that isn't on the allowlist", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    shell(argv=["expr", "1", "+", "1"]) -> R
default: run
`;
    const { findings } = await lint(src, { shellAllowlist: ["curl"] });
    const hit = findings.find((f) => f.rule === "shell-binary-not-allowed");
    expect(hit).toBeDefined();
    expect(hit?.message.includes("expr")).toBe(true);
  });

  it("does NOT fire when the argv binary IS on the allowlist", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    shell(argv=["curl", "-s", "https://example.com"]) -> R
default: run
`;
    const { findings } = await lint(src, { shellAllowlist: ["curl"] });
    const hits = findings.filter((f) => f.rule === "shell-binary-not-allowed");
    expect(hits).toEqual([]);
  });

  it("regression: the command form still fires", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    shell(command="expr 1 + 1") -> R
default: run
`;
    const { findings } = await lint(src, { shellAllowlist: ["curl"] });
    const hit = findings.find((f) => f.rule === "shell-binary-not-allowed");
    expect(hit).toBeDefined();
    expect(hit?.message.includes("expr")).toBe(true);
  });

  it("skips an argv binary that is itself a substitution (resolved at runtime)", async () => {
    const src = `# Skill: t
# Status: Approved
# Vars: BIN="curl"
run:
    shell(argv=["\${BIN}", "-s", "https://example.com"]) -> R
default: run
`;
    const { findings } = await lint(src, { shellAllowlist: ["curl"] });
    const hits = findings.filter((f) => f.rule === "shell-binary-not-allowed");
    expect(hits).toEqual([]);
  });
});
