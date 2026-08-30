/**
 * v0.39.4 — GitHub issue #3 (ADumaine, external report).
 *
 * `$set VAR = ${structuredRef}` used to route through `coerceLiteralValue`,
 * which split any bracket-shaped string on every comma — including the commas
 * *inside* each object. `[{"id":1,"name":"a"}]` became four garbage fragments,
 * and a later `foreach` bound each fragment as a string, so `${I.field}` threw.
 *
 * Ticket `2b4191ba`. Acceptance criteria 1-6 are pinned below in order, plus
 * the object sibling: the same function had no brace branch at all, so an
 * object did not survive `$set` either.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";

async function run(source: string, inputs: Record<string, string> = {}) {
  const compiled = await compile(source, { skipLintPreflight: true });
  return execute(compiled.parsed, { ...compiled.resolvedVariables, ...inputs }, compiled.targetOrder, {
    registry: new Registry(),
  });
}

describe("v0.39.4 issue #3 — $set preserves structured values", () => {
  // Criterion 3: the reporter's own repro, verbatim in shape.
  it("array of objects survives $set and iterates with real field access", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    $ json_parse [{"id":1,"name":"a"},{"id":2,"name":"b"}] -> DATA
    $set ITEMS = \${DATA}
    foreach I in \${ITEMS}:
        emit(text="via-set: id=\${I.id} name=\${I.name}")
    foreach J in \${DATA}:
        emit(text="direct: id=\${J.id} name=\${J.name}")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual([
      "via-set: id=1 name=a",
      "via-set: id=2 name=b",
      "direct: id=1 name=a",
      "direct: id=2 name=b",
    ]);
  });

  // Criterion 4: the bare-literal list is why the naive split exists. It must
  // still work. Assert the length FIRST — a test that derives its expectation
  // from a parse result can otherwise pass over an empty loop.
  it("bare literal list [a, b, c] still yields three string elements", async () => {
    const src = `# Skill: t
# Vars: ITEMS=[a, b, c]
# Status: Approved
run:
    foreach I in \${ITEMS}:
        emit(text="el:\${I}")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions.length).toBe(3);
    expect(r.emissions).toEqual(["el:a", "el:b", "el:c"]);
  });

  // Criterion 5.
  it("empty [] and whitespace [ ] both yield zero iterations", async () => {
    for (const decl of ["[]", "[ ]"]) {
      const src = `# Skill: t
# Vars: ITEMS=${decl}
# Status: Approved
run:
    emit(text="before")
    foreach I in \${ITEMS}:
        emit(text="el:\${I}")
    emit(text="after")
default: run
`;
      const r = await run(src);
      expect(r.errors).toEqual([]);
      // Not just "no el: lines" — prove the loop ran zero times rather than
      // once with an empty element.
      expect(r.emissions).toEqual(["before", "after"]);
    }
  });

  // Criterion 6, half one.
  it("JSON array of quoted strings round-trips through $set", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    $ json_parse ["x","y"] -> DATA
    $set ITEMS = \${DATA}
    foreach I in \${ITEMS}:
        emit(text="el:\${I}")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions.length).toBe(2);
    expect(r.emissions).toEqual(["el:x", "el:y"]);
  });

  // Criterion 6, half two. Note the behaviour delta this pins: a bare
  // `# Vars: N=[1, 2, 3]` used to coerce to the STRINGS "1","2","3"; a real
  // JSON array now stays numeric. Conditions compare stringified on both
  // sides, so `== "1"` is unaffected — it is the rendering that changes.
  it("JSON array of numbers round-trips through $set and stays numeric", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    $ json_parse [1,2,3] -> DATA
    $set ITEMS = \${DATA}
    emit(text="rendered:\${ITEMS}")
    foreach I in \${ITEMS}:
        emit(text="el:\${I}")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions[0]).toBe("rendered:[1,2,3]");
    expect(r.emissions.slice(1)).toEqual(["el:1", "el:2", "el:3"]);
  });

  // The object sibling. Same function, same root cause: there was no brace
  // branch, so a stringified object fell through as a plain string and every
  // dotted access on it failed.
  it("object survives $set with dotted field access intact", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    $ json_parse [{"id":1,"name":"a"}] -> ARR
    foreach E in \${ARR}:
        $set COPY = \${E}
        emit(text="copied: id=\${COPY.id} name=\${COPY.name}")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["copied: id=1 name=a"]);
  });

  // Guard the blast radius: scalars must NOT start JSON-parsing, or
  // `$set X = "123"` silently becomes a number and `"true"` a boolean.
  it("scalar assignments stay strings — no JSON coercion outside [] / {}", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    $set A = 123
    $set B = true
    $set C = null
    emit(text="A=\${A} B=\${B} C=\${C}")
    if \${A} == "123":
        emit(text="A compares as the string 123")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["A=123 B=true C=null", "A compares as the string 123"]);
  });

  // A brace shape that is not valid JSON is a malformed object, not a list.
  // It must not fall into the comma-split path.
  it("malformed brace shape stays a string rather than splitting", async () => {
    const src = `# Skill: t
# Status: Approved
run:
    $set X = {not json, at all}
    emit(text="X=\${X}")
default: run
`;
    const r = await run(src);
    expect(r.errors).toEqual([]);
    expect(r.emissions).toEqual(["X={not json, at all}"]);
  });
});
