import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";

/**
 * v0.39.2 — `$` dispatch kwargs are parsed BEFORE substitution (ticket 7ca043f9).
 *
 * The old path did `substituteRuntime(body)` then `parseToolArgs(body)`, so a
 * value containing a double-quote (or, unquoted, whitespace) truncated the kwarg
 * and reported success — a truncated email reached a customer. The fix tokenizes
 * kwarg BOUNDARIES from the raw body (every value still a `${VAR}` placeholder,
 * so nothing in a value can confuse the tokenizer), then substitutes `${VAR}`
 * INTO each parsed value and coerces per-value.
 *
 * These assert what the CONNECTOR ACTUALLY RECEIVES via a capturing connector —
 * the authoritative surface, since the bug was invisible to the caller (a valid
 * receipt over a corrupted payload).
 */

async function captureDispatch(
  opLine: string,
  vars: string,
  inputs: Record<string, string>,
): Promise<{ args: Record<string, unknown> | undefined; errors: unknown[] }> {
  let captured: Record<string, unknown> | undefined;
  const reg = new Registry();
  reg.registerMcpConnector("conn", new CallbackMcpConnector(async (_t, a) => { captured = a; return { ok: true }; }));
  const src = `# Skill: t\n# Status: Draft\n${vars}\n\nrun:\n    ${opLine}\n    emit(text="done")\ndefault: run\n`;
  const compiled = await compile(src, { skipLintPreflight: true, inputs });
  const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg, effectsAuthorized: true });
  return { args: captured, errors: r.errors };
}

describe("v0.39.2 — embedded quotes no longer truncate a $ kwarg", () => {
  it("Perry's case: a body with embedded quotes + newlines survives whole (no truncation, no stray leading quote)", async () => {
    const BODY = 'Rick,\n\nNow a quoted phrase: from "worth a look" to "check this first".\n\nTail line.';
    const { args, errors } = await captureDispatch(
      `$ conn.send_message to=["\${TO}"] subject="\${SUBJECT}" text="\${BODY}" -> R`,
      "# Vars: TO, SUBJECT, BODY",
      { TO: "rick@x.com", SUBJECT: "Re: thing", BODY },
    );
    expect(errors).toEqual([]);
    expect(args?.text).toBe(BODY); // full value, byte-for-byte
    expect(args?.subject).toBe("Re: thing");
    expect(args?.to).toEqual(["rick@x.com"]);
  });

  it("a following kwarg is not consumed by an embedded quote in the value before it", async () => {
    const { args } = await captureDispatch(
      `$ conn.send text="\${BODY}" flag="END" -> R`,
      "# Vars: BODY",
      { BODY: 'has "quotes" in the middle' },
    );
    expect(args?.text).toBe('has "quotes" in the middle');
    expect(args?.flag).toBe("END"); // the trailing kwarg still parses
  });

  it("array form with an embedded quote in the element stays an ARRAY (Perry's cc probe), not a degraded string", async () => {
    const { args } = await captureDispatch(
      `$ conn.send to=["\${TO}"] cc=["\${CC}"] -> R`,
      "# Vars: TO, CC",
      { TO: "perryscott@pobox.com", CC: 'a"b@example.com' },
    );
    expect(args?.to).toEqual(["perryscott@pobox.com"]);
    expect(Array.isArray(args?.cc)).toBe(true);
    expect(args?.cc).toEqual(['a"b@example.com']); // quote preserved inside the element
  });

  it("nested JSON (attachments) with a quote in a substituted field stays structured", async () => {
    const { args } = await captureDispatch(
      `$ conn.send attachments=[{"filename":"\${FN}","kind":"text"}] -> R`,
      "# Vars: FN",
      { FN: 'weird"name.txt' },
    );
    expect(args?.attachments).toEqual([{ filename: 'weird"name.txt', kind: "text" }]);
  });
});

describe("v0.39.2 — the plain happy path is unchanged (no-quote regression guard)", () => {
  it("ordinary values (quoted string with a colon, bare-var string, number, quoted literal, bool, array) round-trip intact", async () => {
    const { args, errors } = await captureDispatch(
      `$ conn.search q="state: open" subject="\${SUBJ}" id=\${ID} limit=10 mode="fts" flag=true tags=["a","b"] -> R`,
      "# Vars: ID, SUBJ",
      { ID: "BUG-42", SUBJ: "Weekly digest" },
    );
    expect(errors).toEqual([]);
    expect(args?.q).toBe("state: open");        // quoted string with colon + space, no embedded quotes
    expect(args?.subject).toBe("Weekly digest"); // quoted var
    expect(args?.id).toBe("BUG-42");             // bare var → stays string (not numeric)
    expect(args?.limit).toBe(10);                // number literal
    expect(args?.mode).toBe("fts");              // quoted literal
    expect(args?.flag).toBe(true);               // bool literal
    expect(args?.tags).toEqual(["a", "b"]);      // array literal
  });
});

describe("v0.39.2 — typed coercion is preserved (the wrinkle)", () => {
  it("unquoted numeric / boolean substitutions keep their type; quoted stays string", async () => {
    const { args } = await captureDispatch(
      `$ conn.send limit=\${N} flag=\${B} count="\${N}" -> R`,
      "# Vars: N, B",
      { N: "5", B: "true" },
    );
    expect(args?.limit).toBe(5);
    expect(typeof args?.limit).toBe("number");
    expect(args?.flag).toBe(true);
    expect(typeof args?.flag).toBe("boolean");
    expect(args?.count).toBe("5"); // quoted forces string
    expect(typeof args?.count).toBe("string");
  });

  it("bonus: an unquoted substitution containing whitespace no longer truncates at the space", async () => {
    const { args } = await captureDispatch(
      `$ conn.send note=\${SPACES} flag="END" -> R`,
      "# Vars: SPACES",
      { SPACES: "two words here" },
    );
    expect(args?.note).toBe("two words here");
    expect(args?.flag).toBe("END");
  });
});

describe("v0.39.2 — Scott's additions: backslashes + empty string", () => {
  it("a trailing backslash in the value is preserved and does not truncate the kwarg", async () => {
    // The classic tokenizer break: a `\` right before the closing quote. Because
    // boundaries are tokenized on the raw placeholder, a backslash in the DATA
    // can't escape the closing quote — the value comes through whole.
    const { args } = await captureDispatch(
      `$ conn.send text="\${BODY}" flag="END" -> R`,
      "# Vars: BODY",
      { BODY: "ends with a backslash\\" },
    );
    expect(args?.text).toBe("ends with a backslash\\");
    expect(args?.flag).toBe("END"); // boundary intact despite the trailing backslash
  });

  it("an embedded quote after a value is not lost — the tail survives (truncation guard)", async () => {
    const { args } = await captureDispatch(
      `$ conn.send text="\${BODY}" flag="END" -> R`,
      "# Vars: BODY",
      { BODY: 'before "q" AFTER_MARKER' },
    );
    // Core guarantee: everything after the embedded quote is retained.
    expect(args?.text as string).toContain("AFTER_MARKER");
    expect(args?.flag).toBe("END");
  });

  it("empty-string kwarg (literal and via var) binds as \"\" — present, not dropped", async () => {
    const lit = await captureDispatch(
      `$ conn.send to="a@b.com" cc="" text="body" -> R`,
      "",
      {},
    );
    expect(lit.args?.cc).toBe("");
    expect("cc" in (lit.args as object)).toBe(true);

    const viaVar = await captureDispatch(
      `$ conn.send cc="\${CC}" text="body" -> R`,
      "# Vars: CC",
      { CC: "" },
    );
    expect(viaVar.args?.cc).toBe("");
    expect("cc" in (viaVar.args as object)).toBe(true);
  });
});

describe("v0.39.2 — regression guard: positional-arg intercepts still substitute", () => {
  it("$ json_parse substitutes its positional input (not a kwarg) and binds the parsed structure", async () => {
    const reg = new Registry();
    const src = `# Skill: t\n# Status: Draft\n# Vars: RAW\n\nrun:\n    $ json_parse \${RAW} -> P\n    emit(text="id=\${P.id}")\ndefault: run\n`;
    const compiled = await compile(src, { skipLintPreflight: true, inputs: { RAW: '{"id":"abc","n":2}' } });
    const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: reg, effectsAuthorized: true });
    expect(r.errors).toEqual([]);
    expect(r.emissions.join("\n")).toContain("id=abc");
  });
});
