import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

/**
 * v0.16.5 — `unknown-llm-arg` + `unknown-data-read-arg` lint tests.
 *
 * Sibling lints to v0.16.4's `unknown-llm-model`. Same shape: tier-2
 * warning when a `$ <connector>` op carries a kwarg outside the
 * documented closed surface. Per memory `9254a648`.
 */

const llmSkill = (extra: string): string => `# Skill: probe
# Status: Draft
t:
    $ llm prompt="hi" ${extra}
default: t
`;

const dataReadSkill = (extra: string): string => `# Skill: probe
# Status: Draft
t:
    $ data_read mode=fts query="x" ${extra}
default: t
`;

describe("v0.16.5 — unknown-llm-arg lint", () => {
  it("fires on a provider-API kwarg (`temperature=0.7`) silently dropped by the bridge", async () => {
    const result = await lint(llmSkill('temperature=0.7'));
    const f = result.findings.find((x) => x.rule === "unknown-llm-arg");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.extras?.["kwarg"]).toBe("temperature");
    expect(f!.message).toContain("temperature");
    // Message lists the canonical surface so the author can fix.
    expect(f!.message).toContain("prompt");
    expect(f!.message).toContain("maxTokens");
  });

  it("clean for canonical kwargs (prompt + maxTokens + model + timeout + approved + fallback)", async () => {
    const sources = [
      llmSkill('maxTokens=100'),
      llmSkill('model="qwen"'),
      llmSkill('timeout=30'),
      llmSkill('approved=true'),
      llmSkill('fallback="default response"'),
    ];
    for (const src of sources) {
      const result = await lint(src);
      const f = result.findings.find((x) => x.rule === "unknown-llm-arg");
      expect(f, `expected clean for: ${src.slice(40, 100)}`).toBeUndefined();
    }
  });

  it("does NOT fire on non-llm $ ops (scoped to op.mcpConnector === 'llm' / first-token 'llm')", async () => {
    const source = `# Skill: probe
# Status: Draft
t:
    $ amp.query_memories query="x" temperature=0.7
default: t
`;
    const result = await lint(source);
    expect(result.findings.find((x) => x.rule === "unknown-llm-arg")).toBeUndefined();
  });

  it("dedupes findings — same unknown kwarg used in N ops in the same target → 1 finding", async () => {
    const source = `# Skill: probe
# Status: Draft
t:
    $ llm prompt="a" temperature=0.5
    $ llm prompt="b" temperature=0.7
    $ llm prompt="c" temperature=0.9
default: t
`;
    const result = await lint(source);
    const findings = result.findings.filter((x) => x.rule === "unknown-llm-arg");
    expect(findings.length).toBe(1);
  });

  it("reports each distinct unknown kwarg separately in the same target", async () => {
    const source = `# Skill: probe
# Status: Draft
t:
    $ llm prompt="x" temperature=0.7 top_p=0.9 stop="\\n"
default: t
`;
    const result = await lint(source);
    const findings = result.findings.filter((x) => x.rule === "unknown-llm-arg");
    expect(findings.length).toBe(3);
    expect(findings.map((f) => f.extras?.["kwarg"]).sort()).toEqual(["stop", "temperature", "top_p"]);
  });

  it("recognizes named-form `$ llm.run` (hypothetical adopter-named tool) — fires same shape", async () => {
    // Currently `$ llm.run` isn't a real surface (llm is a bare-form bridge),
    // but the rule's mcpConnector check would activate if it were. This
    // test documents the named-form fallthrough.
    const source = `# Skill: probe
# Status: Draft
t:
    $ llm.run prompt="x" temperature=0.5
default: t
`;
    // The parser sets op.mcpConnector = "llm" for named-form `$ llm.run`,
    // so the rule activates. The first-token check (head === "llm") only
    // applies to bare form where mcpConnector is undefined.
    const result = await lint(source);
    const f = result.findings.find((x) => x.rule === "unknown-llm-arg");
    expect(f).toBeDefined();
    expect(f!.extras?.["kwarg"]).toBe("temperature");
  });
});

describe("v0.16.5 — unknown-data-read-arg lint", () => {
  it("fires on an unknown kwarg (`tags=`, before the canonical `domain_tags=`)", async () => {
    const result = await lint(dataReadSkill('tags="a,b"'));
    const f = result.findings.find((x) => x.rule === "unknown-data-read-arg");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.extras?.["kwarg"]).toBe("tags");
  });

  it("clean for canonical kwargs (mode + query + limit + connector + fallback + domain_tags + filters + min_confidence)", async () => {
    const sources = [
      dataReadSkill('limit=10'),
      dataReadSkill('connector="memory"'),
      dataReadSkill('fallback="[]"'),
      dataReadSkill('domain_tags="a,b"'),
      dataReadSkill('filters="{}"'),
      dataReadSkill('min_confidence=0.5'),
    ];
    for (const src of sources) {
      const result = await lint(src);
      const f = result.findings.find((x) => x.rule === "unknown-data-read-arg");
      expect(f, `expected clean for: ${src.slice(40, 100)}`).toBeUndefined();
    }
  });

  it("does NOT fire on non-data_read $ ops", async () => {
    const source = `# Skill: probe
# Status: Draft
t:
    $ data_write content="x" tags="a"
default: t
`;
    const result = await lint(source);
    expect(result.findings.find((x) => x.rule === "unknown-data-read-arg")).toBeUndefined();
  });

  it("dedupes — same unknown kwarg across multiple ops in same target → 1 finding", async () => {
    const source = `# Skill: probe
# Status: Draft
t:
    $ data_read mode=fts query="a" tags="x"
    $ data_read mode=fts query="b" tags="y"
default: t
`;
    const result = await lint(source);
    const findings = result.findings.filter((x) => x.rule === "unknown-data-read-arg");
    expect(findings.length).toBe(1);
  });

  it("reports each distinct unknown kwarg separately", async () => {
    const source = `# Skill: probe
# Status: Draft
t:
    $ data_read mode=fts query="x" tags="a" pinned=true score_min=0.5
default: t
`;
    const result = await lint(source);
    const findings = result.findings.filter((x) => x.rule === "unknown-data-read-arg");
    expect(findings.length).toBe(3);
    expect(findings.map((f) => f.extras?.["kwarg"]).sort()).toEqual(["pinned", "score_min", "tags"]);
  });
});
