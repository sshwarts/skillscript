import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { toposort } from "../src/compile.js";
import { applyFilter } from "../src/filters.js";

describe("parser", () => {
  it("parses headers + simple skill", () => {
    const src = `# Skill: hello
# Description: A welcome message
# Vars: WHO=world

greet:
    emit(text="Hello, $(WHO)!")

default: greet
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    expect(p.name).toBe("hello");
    expect(p.description).toBe("A welcome message");
    expect(p.vars).toEqual([{ name: "WHO", default: "world", required: false }]);
    expect(p.entryTarget).toBe("greet");
    expect(p.targets.has("greet")).toBe(true);
    const target = p.targets.get("greet")!;
    expect(target.ops).toHaveLength(1);
    expect(target.ops[0]).toMatchObject({ kind: "emit", body: "Hello, $(WHO)!" });
  });

  it("parses $set, ?, shell, emit ops", () => {
    const src = `t:
    $set X = hello
    ? thinking
    shell(command="ls -la")
    emit(text="talking")

default: t
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    const kinds = p.targets.get("t")!.ops.map((o) => o.kind);
    expect(kinds).toEqual(["$set", "?", "shell", "emit"]);
  });

  it("parses target deps and toposorts", () => {
    const src = `a:
    emit(text="a")

b: a
    emit(text="b")

c: b
    emit(text="c")

default: c
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    const order = toposort(p.targets, "c");
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("detects dep cycles", () => {
    const src = `a: b
    emit(text="a")

b: a
    emit(text="b")

default: a
`;
    const p = parse(src);
    expect(() => toposort(p.targets, "a")).toThrow(/cycle/i);
  });

  it("parses conditionals", () => {
    const src = `t:
    $set MODE = fast
    if $(MODE) == "fast":
        emit(text="fast path")
    elif $(MODE) == "slow":
        emit(text="slow path")
    else:
        emit(text="default")

default: t
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    const ops = p.targets.get("t")!.ops;
    expect(ops[1]!.kind).toBe("if");
    expect(ops[1]!.ifBranches).toHaveLength(2);
    expect(ops[1]!.ifElseBody).toHaveLength(1);
  });

  it("parses foreach", () => {
    const src = `t:
    $set ITEMS = [a, b, c]
    foreach I in $(ITEMS):
        emit(text="$(I)")

default: t
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    const foreachOp = p.targets.get("t")!.ops[1]!;
    expect(foreachOp.kind).toBe("foreach");
    expect(foreachOp.foreachIter).toBe("I");
    expect(foreachOp.foreachList).toBe("$(ITEMS)");
    expect(foreachOp.foreachBody).toHaveLength(1);
  });

  it("parses # Triggers: and # Output: headers", () => {
    const src = `# Skill: notify
# Triggers: cron: */5 * * * *
# Output: agent: oncall

t:
    emit(text="hi")

default: t
`;
    const p = parse(src);
    expect(p.parseErrors).toEqual([]);
    expect(p.triggers).toEqual([{ source: "cron", name: "*/5 * * * *" }]);
    expect(p.outputs).toEqual([{ kind: "agent", target: "oncall" }]);
  });

  it("rejects dropped substrate-specific output kinds (slack, card — removed in v0.7.3)", () => {
    const srcSlack = `# Skill: notify
# Output: slack: #alerts

t:
    emit(text="hi")

default: t
`;
    const pSlack = parse(srcSlack);
    expect(pSlack.parseErrors.length).toBeGreaterThan(0);
    expect(pSlack.parseErrors[0]).toMatch(/Unsupported output kind 'slack'/);

    const srcCard = `# Skill: notify
# Output: card: id

t:
    emit(text="hi")

default: t
`;
    const pCard = parse(srcCard);
    expect(pCard.parseErrors.length).toBeGreaterThan(0);
    expect(pCard.parseErrors[0]).toMatch(/Unsupported output kind 'card'/);
  });

  it("rejects unsupported condition shapes", () => {
    const src = `t:
    if $(A) && $(B):
        emit(text="both")

default: t
`;
    const p = parse(src);
    expect(p.parseErrors.length).toBeGreaterThan(0);
    expect(p.parseErrors[0]).toMatch(/Unsupported condition/);
  });

  it("rejects top-level if/elif", () => {
    const src = `if $(X):
    emit(text="oops")

default: foo
`;
    const p = parse(src);
    expect(p.parseErrors[0]).toMatch(/only valid inside a target body/);
  });
});

describe("applyFilter", () => {
  it("url encodes", () => {
    expect(applyFilter("hello world", "url")).toBe("hello%20world");
  });
  it("shell quotes", () => {
    expect(applyFilter("don't", "shell")).toBe("'don'\\''t'");
  });
  it("trims", () => {
    expect(applyFilter("  hi  \n", "trim")).toBe("hi");
  });
  it("throws on unknown filter", () => {
    expect(() => applyFilter("x", "bogus")).toThrow(/Unknown filter/);
  });
});
