import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { extractEffectfulFootprint } from "../src/skill-surface.js";

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
