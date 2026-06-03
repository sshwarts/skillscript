import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

/**
 * v0.16.8 — object-iteration-advisory wording softened + adopter-configurable
 * `bareArrayReturnTools` suppression. Per Perry's `c497b479` finding 2 +
 * warm-adopter's `1e1c9305` empirical confirmation.
 *
 * Pre-v0.16.8: advisory PRESCRIBED `.items` access. Authors trusting it
 * against bare-array-returning tools rewrote `foreach L in ${LESSONS}` →
 * `foreach L in ${LESSONS.items}` and got runtime "Unresolved variable
 * reference" failures. Asymmetric: ignoring the advisory was invisible
 * success; trusting it was silent breakage.
 *
 * v0.16.8: wording acknowledges shape ambiguity (bare array OR envelope);
 * `LintOptions.bareArrayReturnTools` (default empty, adopter-configurable)
 * suppresses the advisory for tools known to return bare arrays.
 *
 * Substrate-neutral: no AMP-specific names in the runtime's bundled
 * defaults (per `845bfab7`). Adopters configure per their MCP ecosystem.
 */

const FOREACH_BARE_ARRAY = `# Skill: probe
# Status: Draft
t:
    $ amp.amp_query_memories query="lessons" -> LESSONS
    foreach L in \${LESSONS}:
        emit(text="\${L.summary}")
default: t
`;

describe("v0.16.8 — object-iteration-advisory softened wording", () => {
  it("advisory fires (default config) but message no longer prescribes `.items` specifically", async () => {
    const result = await lint(FOREACH_BARE_ARRAY);
    const f = result.findings.find((x) => x.rule === "object-iteration-advisory");
    expect(f).toBeDefined();
    // The fragile old prescription is gone — message acknowledges shape
    // ambiguity ("bare array OR envelope") rather than asserting `.items`.
    expect(f!.message).toContain("bare array");
    expect(f!.message).toContain("envelope");
    // Remediation no longer says "use `.items`" prescriptively.
    expect(f!.remediation).toContain("Verify the tool's response shape");
  });

  it("captures the source tool name in extras so adopters can identify which tool triggered the advisory", async () => {
    const result = await lint(FOREACH_BARE_ARRAY);
    const f = result.findings.find((x) => x.rule === "object-iteration-advisory");
    expect(f).toBeDefined();
    expect(f!.extras?.["tool_name"]).toBe("amp_query_memories");
  });
});

describe("v0.16.8 — LintOptions.bareArrayReturnTools suppresses advisory for configured tools", () => {
  it("default empty bareArrayReturnTools — advisory fires as before", async () => {
    const result = await lint(FOREACH_BARE_ARRAY);
    expect(result.findings.find((x) => x.rule === "object-iteration-advisory")).toBeDefined();
  });

  it("configured bareArrayReturnTools suppresses advisory for matching tool", async () => {
    const result = await lint(FOREACH_BARE_ARRAY, {
      bareArrayReturnTools: ["amp_query_memories"],
    });
    expect(result.findings.find((x) => x.rule === "object-iteration-advisory")).toBeUndefined();
  });

  it("non-matching tool name in config doesn't suppress (specificity preserved)", async () => {
    const result = await lint(FOREACH_BARE_ARRAY, {
      bareArrayReturnTools: ["amp_list_memories"], // different tool — doesn't match
    });
    expect(result.findings.find((x) => x.rule === "object-iteration-advisory")).toBeDefined();
  });

  it("multiple tools in config — each suppressed independently", async () => {
    const source = `# Skill: probe
# Status: Draft
t:
    $ amp.amp_query_memories query="x" -> A
    $ amp.amp_list_memories filter="y" -> B
    foreach IT in \${A}:
        emit(text="\${IT.summary}")
    foreach IT in \${B}:
        emit(text="\${IT.summary}")
default: t
`;
    const result = await lint(source, {
      bareArrayReturnTools: ["amp_query_memories", "amp_list_memories"],
    });
    expect(result.findings.find((x) => x.rule === "object-iteration-advisory")).toBeUndefined();
  });

  it("bare-form dispatch ($ tool) suppressed by config matching first-token tool name", async () => {
    // Bare-form: $ data_read mode=fts ... — first token of op.body is the tool name.
    const source = `# Skill: probe
# Status: Draft
t:
    $ data_read mode=fts query="x" -> R
    foreach IT in \${R}:
        emit(text="\${IT.summary}")
default: t
`;
    const result = await lint(source, {
      bareArrayReturnTools: ["data_read"],
    });
    expect(result.findings.find((x) => x.rule === "object-iteration-advisory")).toBeUndefined();
  });
});

describe("v0.16.8 — substrate-neutrality of bareArrayReturnTools defaults", () => {
  it("bundled defaults: bareArrayReturnTools is empty (no substrate-specific names)", async () => {
    // The bundled default is empty per source-reader-signal discipline
    // (`845bfab7`). Adopters add their tool names per substrate. Public
    // runtime stays neutral.
    const result = await lint(FOREACH_BARE_ARRAY);
    // If the default were non-empty and included `amp_query_memories`,
    // this advisory would be suppressed. It fires → confirming default is
    // empty and substrate-neutral.
    expect(result.findings.find((x) => x.rule === "object-iteration-advisory")).toBeDefined();
  });
});
