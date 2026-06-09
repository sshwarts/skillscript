import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { bootstrap } from "../src/bootstrap.js";
import { helpResponse } from "../src/help-content.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v0.5.0 item 7 — outputs.text shape clarification.
 *
 * R3 minion 3 finding: `outputs.text` from a multi-emit skill contains
 * just ONE item. Cold-author surprise — they expected the joined
 * emissions string.
 *
 * Investigation result: the runtime DOES distinguish "programmatic
 * surfaces" (text, file:) from "human-readable surfaces" (prompt-
 * context, template, slack, card). Programmatic surfaces default to
 * lastBoundVar (structured); human-readable surfaces default to joined
 * emissions. The behavior is intentional per the runtime comment block
 * at line 246-253; the surprise is a docs gap.
 *
 * v0.5.0 closes the docs gap (help-content updated). Tests below pin
 * the documented behavior so future refactors can't drift silently.
 * Emit-as-binding primitive (`! "text" -> VAR` + principled outputs.text)
 * is a v0.5.1 design item — bigger scope than this clarification.
 */

async function runSkill(src: string): Promise<{ outputs: Record<string, unknown>; emissions: string[]; errors: unknown[] }> {
  const home = mkdtempSync(join(tmpdir(), "v050-out-"));
  const wired = bootstrap({ skillsDir: join(home, "skills"), traceDir: join(home, "traces") });
  const compiled = await compile(src);
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry: wired.registry });
  return { outputs: result.outputs, emissions: result.emissions, errors: result.errors };
}

describe("v0.5.0 item 7 — outputs.text shape (v0.19.10 emit-first semantic)", () => {
  // v0.19.10 — emit-first semantic. Per Perry's `650c5a9c` Finding 3: if
  // the author explicitly writes `emit()`, emissions ARE the canonical
  // output; `-> R` / `$set` bindings are internal scratch. Pre-v0.19.10
  // lastBoundVar masked emissions — silent-wrong, fixed.

  it("emits-only skill (no var bound) → outputs.text is joined emissions string", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="line one")\n    emit(text="line two")\n    emit(text="line three")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.outputs.text).toBe("line one\nline two\nline three");
  });

  it("emits + $set bind → outputs.text is the joined emissions (NOT the bound scratch)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="prelude")\n    $set RESULT = "structured"\n    emit(text="coda")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    // v0.19.10 — emit() entries are the canonical output; $set RESULT is
    // internal scratch that no longer masks the emissions.
    expect(result.outputs.text).toBe("prelude\ncoda");
    expect(result.emissions).toEqual(["prelude", "coda"]);
  });

  it("$set only (no emit) → outputs.text is the LAST bound var (lastBoundVar fallback intact)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $set A = "first"\n    $set B = "second"\n    $set C = "third"\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    // No emissions → falls to lastBoundVar (compute-and-return pattern).
    expect(result.outputs.text).toBe("third");
  });
});

describe("v0.5.0 item 7 — outputs.text vs human-readable kinds", () => {
  it("# Output: agent: agent → joined emissions string (not lastBoundVar)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Output: agent: assistant\nrun:\n    emit(text="prelude")\n    $set RESULT = "structured"\n    emit(text="coda")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    expect(result.outputs["agent:assistant"]).toBe("prelude\ncoda");
    // outputs.text is NOT published here — only the declared kind.
    expect(result.outputs.text).toBeUndefined();
  });

  it("# Output: text + # Output: agent: same skill → both shapes coexist (v0.19.10 unified emit-first)", async () => {
    const src = `# Skill: t\n# Status: Approved\n# Output: text\n# Output: agent: assistant\nrun:\n    emit(text="prelude")\n    $set RESULT = "structured"\n    emit(text="coda")\ndefault: run\n`;
    const result = await runSkill(src);
    expect(result.errors).toEqual([]);
    // v0.19.10 — emissions over lastBoundVar for text kind too. Both
    // delivery channels now consistently surface the emit() output;
    // the silent-leak-into-text-via-lastBoundVar is closed.
    expect(result.outputs.text).toBe("prelude\ncoda");
    expect(result.outputs["agent:assistant"]).toBe("prelude\ncoda");
  });
});

describe("v0.5.0 item 7 — help docs surface the shape distinction", () => {
  it("frontmatter topic explains outputs.text vs prompt-context value shapes", () => {
    const r = helpResponse("frontmatter", "0.5.0") as { content: string };
    expect(r.content).toMatch(/last-bound variable value/);
    expect(r.content).toMatch(/joined emissions/);
  });
});
