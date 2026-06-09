import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { execute } from "../src/runtime.js";
import { lint } from "../src/lint.js";
import { Registry } from "../src/connectors/registry.js";

/**
 * v0.19.10 — Perry's `650c5a9c` dogfood findings.
 *
 * Finding 1 (HIGH): `$ <connector> <tool>` space-separated parses as
 * bare-form with first-token-as-tool. Server replies misdirecting
 * "Tool 'X' not found." Now: tier-1 `connector-as-tool` lint catches
 * the foot-gun at authoring time.
 *
 * Finding 2 (MED): `${R|length}` on a $-bound value can silently return
 * char-count when the server's response doesn't JSON-parse cleanly
 * (prose-wrapped, multi-content). Tier-3 `remote-result-needs-parse`
 * advisory + doc.
 *
 * Finding 3 (LOW-MED): outputs.text masked emit() with lastBoundVar
 * (internal scratch). Runtime now prefers emissions over lastBoundVar.
 */

const APPROVED = "# Status: Approved";

describe("v0.19.10 — Finding 1: connector-as-tool lint", () => {
  it("fires tier-1 on `$ <connector> <tool>` bare-form (space-separated)", async () => {
    const src = `${APPROVED}
# Skill: bad
# Vars: (none)

run:
    $ youtrack find_projects -> R
default: run
`;
    const r = await lint(src, { mcpConnectorNames: ["youtrack"] });
    const f = r.findings.find((x) => x.rule === "connector-as-tool");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.message).toMatch(/`youtrack` is a connector name, not a tool/);
    expect(f!.message).toMatch(/\$ youtrack\.find_projects/);
    expect(f!.message).toMatch(/\$ find_projects/);
  });

  it("does NOT fire on dotted form `$ connector.tool`", async () => {
    const src = `${APPROVED}
# Skill: clean
# Vars: (none)

run:
    $ youtrack.find_projects -> R
default: run
`;
    const r = await lint(src, { mcpConnectorNames: ["youtrack"] });
    expect(r.findings.find((x) => x.rule === "connector-as-tool")).toBeUndefined();
  });

  it("does NOT fire on legit same-name `$ data_write content=...` (kwarg shape)", async () => {
    const src = `${APPROVED}
# Skill: legit
# Vars: (none)

# Autonomous: true

run:
    $ data_write content="hello" approved="ok" -> R
default: run
`;
    const r = await lint(src, { mcpConnectorNames: ["data_write"] });
    expect(r.findings.find((x) => x.rule === "connector-as-tool")).toBeUndefined();
  });

  it("does NOT fire when connector list is empty (no false positives without context)", async () => {
    const src = `${APPROVED}
# Skill: ambient
# Vars: (none)

run:
    $ youtrack find_projects -> R
default: run
`;
    const r = await lint(src);
    expect(r.findings.find((x) => x.rule === "connector-as-tool")).toBeUndefined();
  });
});

describe("v0.19.10 — Finding 2: remote-result-needs-parse advisory", () => {
  it("fires info on `${R|length}` for $-bound R (warns about prose-wrap char-count trap)", async () => {
    const src = `${APPROVED}
# Skill: length-check
# Vars: (none)

run:
    $ youtrack.search_issues query="test" -> ISS
    emit(text="Found \${ISS|length} items")
default: run
`;
    const r = await lint(src, { mcpConnectorNames: ["youtrack"] });
    const f = r.findings.find((x) => x.rule === "remote-result-needs-parse");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
    expect(f!.message).toMatch(/char-count/);
  });

  it("SUPPRESSED when the skill defensively json_parses first", async () => {
    const src = `${APPROVED}
# Skill: defended
# Vars: (none)

run:
    $ youtrack.search_issues query="test" -> ISS
    $ json_parse \${ISS} -> P
    emit(text="Found \${P|length} items")
default: run
`;
    const r = await lint(src, { mcpConnectorNames: ["youtrack"] });
    expect(r.findings.find((x) => x.rule === "remote-result-needs-parse")).toBeUndefined();
  });

  it("does NOT fire on `${R.field}` access (only on |length — the silent-wrong path)", async () => {
    const src = `${APPROVED}
# Skill: dotted
# Vars: (none)

run:
    $ youtrack.search_issues query="test" -> ISS
    emit(text="First: \${ISS.items.0.id}")
default: run
`;
    const r = await lint(src, { mcpConnectorNames: ["youtrack"] });
    // Dotted access on a string raises UnresolvedVariableError at runtime —
    // loud, not silent-wrong. Advisory scopes to the |length trap only.
    expect(r.findings.find((x) => x.rule === "remote-result-needs-parse")).toBeUndefined();
  });
});

describe("v0.19.10 — Finding 3: emit-first over lastBoundVar", () => {
  const minimalCtx = () => ({
    agentId: "test-agent",
    registry: new Registry(),
  });

  it("emit + $set bind → outputs.text is joined emissions (NOT lastBoundVar)", async () => {
    const src = `# Skill: emit-first
# Vars: (none)

run:
    emit(text="brief: hello")
    $set INTERNAL = "scratch"
default: run
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], minimalCtx());
    expect(r.outputs.text).toBe("brief: hello");
  });

  it("emit interleaved with $set → emissions still win", async () => {
    const src = `# Skill: interleaved
# Vars: (none)

run:
    $set EARLY = "a"
    emit(text="line one")
    $set MIDDLE = "b"
    emit(text="line two")
    $set LATE = "c"
default: run
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], minimalCtx());
    expect(r.outputs.text).toBe("line one\nline two");
  });

  it("compute-only ($set, no emit) → lastBoundVar fallback still works", async () => {
    const src = `# Skill: compute
# Vars: (none)

run:
    $set A = "first"
    $set B = "second"
default: run
`;
    const parsed = parse(src);
    const r = await execute(parsed, {}, ["run"], minimalCtx());
    expect(r.outputs.text).toBe("second");
  });
});
