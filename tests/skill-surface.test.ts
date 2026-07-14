import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { extractEffectfulFootprint, buildSkillFlow } from "../src/skill-surface.js";

/**
 * Effectful-footprint extraction — the "what does this skill touch" surface
 * used by skill_preflight + the approval UX. Derived statically from the AST.
 */

function footprint(source: string) {
  return extractEffectfulFootprint(parse(source));
}

describe("extractEffectfulFootprint", () => {
  it("captures connectors, builtins, shell binaries, and file/notify counts", () => {
    const fp = footprint(`# Skill: kitchen-sink
# Status: Approved
run:
    $ youtrack.search_issues query="open" -> ISSUES
    $ data_write content="x" approved="a" -> W
    shell(command="curl -s https://example.com") -> C
    file_write(path="/tmp/out.txt", content="hi", approved="a")
    file_read(path="/tmp/in.txt") -> IN
    notify(agent="scott@session", message="done")
default: run
`);
    expect(fp.connectors).toEqual(["youtrack"]);
    expect(fp.builtins).toEqual(["data_write"]);
    expect(fp.shell_binaries).toEqual(["curl"]);
    expect(fp.file_writes).toBe(1);
    expect(fp.file_reads).toBe(1);
    expect(fp.notifies).toBe(1);
    expect(fp.unsafe_shell).toBe(0);
  });

  it("flags unsafe shell as bash", () => {
    const fp = footprint(`# Skill: piped
# Status: Approved
run:
    shell(command="echo hi | tr a-z A-Z", unsafe=true) -> R
default: run
`);
    expect(fp.unsafe_shell).toBe(1);
    expect(fp.shell_binaries).toEqual(["bash"]);
  });

  it("descends into foreach + if bodies", () => {
    const fp = footprint(`# Skill: nested
# Status: Approved
# Vars: ITEMS
run:
    foreach X in \${ITEMS}:
        $ data_write content="\${X}" approved="loop" -> W
    if \${W}:
        shell(command="git status") -> G
default: run
`);
    expect(fp.builtins).toContain("data_write");
    expect(fp.shell_binaries).toContain("git");
  });

  it("dedups + sorts across many ops", () => {
    const fp = footprint(`# Skill: dups
# Status: Approved
run:
    shell(command="jq .") -> A
    shell(command="curl x") -> B
    shell(command="jq .") -> C
default: run
`);
    expect(fp.shell_binaries).toEqual(["curl", "jq"]);
  });

  it("a pure-emit skill has an empty footprint", () => {
    const fp = footprint(`# Skill: quiet
# Status: Approved
run:
    emit(text="hello")
default: run
`);
    expect(fp).toEqual({
      connectors: [], builtins: [], shell_binaries: [],
      unsafe_shell: 0, file_writes: 0, file_reads: 0, notifies: 0,
    });
  });
});

describe("buildSkillFlow", () => {
  it("projects targets into dependency-ordered lanes of plain-language steps", () => {
    const flow = buildSkillFlow(parse(`# Skill: pipeline
# Status: Approved
fetch:
    $ data_read query="topic" -> HITS
verify: fetch
    $ llm prompt="check" -> V
dedup: fetch
    $ data_read query="log" -> D
publish: verify dedup
    $ data_write content="x"
default: publish
`));
    const ids = flow.lanes.map((l) => l.id);
    // A needed target precedes its dependents; the entry (publish) lands last.
    expect(ids[0]).toBe("fetch");
    expect(ids[ids.length - 1]).toBe("publish");
    expect(flow.entry).toBe("publish");
    expect(flow.truncated).toBe(false);

    const publish = flow.lanes.find((l) => l.id === "publish")!;
    expect(publish.isEntry).toBe(true);
    expect(publish.deps.slice().sort()).toEqual(["dedup", "verify"]);

    // Ops are described in plain language, writes toned for attention, and each
    // step carries its key argument ("what" it reads / asks / writes).
    const fetchStep = flow.lanes.find((l) => l.id === "fetch")!.steps[0];
    expect(fetchStep.label).toBe("Read from the data store");
    expect(fetchStep.detail).toBe("topic");
    // Each step carries the variable it produces, so data flow is traceable.
    expect(fetchStep.produces).toBe("HITS");
    expect(flow.lanes.find((l) => l.id === "verify")!.steps[0].produces).toBe("V");
    expect(flow.lanes.find((l) => l.id === "verify")!.steps[0].label).toBe("Ask the local model");
    expect(flow.lanes.find((l) => l.id === "verify")!.steps[0].detail).toBe("check");
    expect(publish.steps[0].label).toBe("Write to the data store");
    expect(publish.steps[0].tone).toBe("mutation");
  });

  it("names a composed skill and carries a drill-in ref", () => {
    const flow = buildSkillFlow(parse(`# Skill: caller
# Status: Approved
run:
    execute_skill(skill_name="greeting-helper", inputs={"WHO": "world"}) -> G
    emit(text="\${G}")
default: run
`));
    const step = flow.lanes[0].steps[0];
    expect(step.label).toBe("Run the greeting-helper skill");
    expect(step.ref).toEqual({ skill: "greeting-helper" });
  });

  it("nests loop bodies and branch arms as child steps", () => {
    const flow = buildSkillFlow(parse(`# Skill: loopy
# Status: Approved
run:
    $set LIST = [a, b]
    $set MODE = go
    foreach I in $(LIST):
        $ data_write content="$(I)"
    if $(MODE) == "go":
        emit(text="done")
    else:
        emit(text="wait")
default: run
`));
    const steps = flow.lanes[0].steps;
    const loop = steps.find((s) => s.label.startsWith("For each"))!;
    expect(loop.children?.[0].label).toBe("Write to the data store");
    expect(loop.children?.[0].tone).toBe("mutation");

    const branch = steps.find((s) => Array.isArray(s.branches))!;
    // Condition humanized: `$(MODE) == "go"` → readable plain language.
    expect(branch.branches?.[0].label).toBe("If MODE is go");
    expect(branch.branches?.[branch.branches.length - 1].label).toBe("Otherwise");
    expect(branch.branches?.[0].steps[0].label).toBe("Produce output");
    // Risk tiers: a data_write is a mutation; emit is recessed plumbing.
    expect(loop.children?.[0].tone).toBe("mutation");
    expect(branch.branches?.[0].steps[0].tone).toBe("plumbing");
  });

  it("humanizes branch conditions and classifies steps by effect tier", () => {
    const flow = buildSkillFlow(parse(`# Skill: tiers
# Status: Approved
run:
    $ data_read query="x" -> R
    if \${R|contains:"github.com"}:
        $ data_write content="y"
    else:
        emit(text="skip")
default: run
`));
    const steps = flow.lanes[0].steps;
    expect(steps[0].tone).toBe("external"); // data_read = reaches out
    const branch = steps.find((s) => Array.isArray(s.branches))!;
    // `${R|contains:"github.com"}` → plain language (no raw ${…|…} syntax).
    expect(branch.branches?.[0].label).toBe("If R contains github.com");
    expect(branch.branches?.[0].steps[0].tone).toBe("mutation"); // data_write = blast radius
  });

  it("body-only skill → no lanes; big skills truncate + flag", () => {
    expect(buildSkillFlow(parse(`# Skill: hello\n# Status: Approved\n\nHi.\n`)).lanes).toEqual([]);

    let src = "# Skill: big\n# Status: Approved\n";
    for (let i = 0; i < 45; i++) src += `t${i}:\n    emit(text="x")\n`;
    src += "default: t0\n";
    const big = buildSkillFlow(parse(src));
    expect(big.truncated).toBe(true);
    expect(big.lanes.length).toBe(40);
  });
});
