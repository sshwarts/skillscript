/**
 * v0.23.0 — connector-aware input lint (schema-retain ring, phase 1).
 *
 * Retain the downstream `inputSchema` we used to discard at tools/list, then
 * validate `$ connector.tool arg=...` arg names against it. Catches the typo
 * class (`$ ddg.search querry=...`) statically. Two rules: unknown-connector-arg
 * + missing-required-connector-arg. Must degrade arg-agnostic (no false
 * positives) when no schema is cached/reachable.
 */
import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";
import { Registry } from "../src/connectors/registry.js";
import type { McpConnector, McpToolDescriptor, ManifestInfo } from "../src/connectors/types.js";

const SEARCH: McpToolDescriptor = {
  name: "search",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
  },
};

function injectedSchemas(): Map<string, Map<string, McpToolDescriptor>> {
  return new Map([["ddg", new Map([["search", SEARCH]])]]);
}

function skill(body: string): string {
  return `# Skill: s\n# Status: Draft\n\nrun:\n    ${body}\ndefault: run\n`;
}

const baseOpts = { mcpConnectorNames: ["ddg"] };

function rulesOf(findings: Array<{ rule: string }>): string[] {
  return findings.map((f) => f.rule);
}

describe("v0.23.0 — connector-aware input lint (injected schemas)", () => {
  it("flags an unknown arg name (the `querry=` typo)", async () => {
    const res = await lint(skill(`$ ddg.search querry="hi" -> R`), {
      ...baseOpts,
      mcpConnectorToolSchemas: injectedSchemas(),
    });
    const f = res.findings.find((x) => x.rule === "unknown-connector-arg");
    expect(f).toBeDefined();
    expect(f!.message).toContain("querry");
    expect(f!.severity).toBe("warning");
  });

  it("stays silent when the arg names are all valid", async () => {
    const res = await lint(skill(`$ ddg.search query="hi" limit=5 -> R`), {
      ...baseOpts,
      mcpConnectorToolSchemas: injectedSchemas(),
    });
    expect(rulesOf(res.findings)).not.toContain("unknown-connector-arg");
    expect(rulesOf(res.findings)).not.toContain("missing-required-connector-arg");
  });

  it("ignores the runtime-reserved `timeout` kwarg", async () => {
    const res = await lint(skill(`$ ddg.search query="hi" timeout=30 -> R`), {
      ...baseOpts,
      mcpConnectorToolSchemas: injectedSchemas(),
    });
    expect(rulesOf(res.findings)).not.toContain("unknown-connector-arg");
  });

  it("flags a missing required arg", async () => {
    const res = await lint(skill(`$ ddg.search limit=5 -> R`), {
      ...baseOpts,
      mcpConnectorToolSchemas: injectedSchemas(),
    });
    const f = res.findings.find((x) => x.rule === "missing-required-connector-arg");
    expect(f).toBeDefined();
    expect(f!.message).toContain("query");
  });

  it("does not flag unknown args on an open schema (additionalProperties: true)", async () => {
    const open: Map<string, Map<string, McpToolDescriptor>> = new Map([
      ["ddg", new Map([["search", {
        name: "search",
        inputSchema: { type: "object", properties: { query: {} }, additionalProperties: true },
      }]])],
    ]);
    const res = await lint(skill(`$ ddg.search query="x" anything=1 -> R`), {
      ...baseOpts,
      mcpConnectorToolSchemas: open,
    });
    expect(rulesOf(res.findings)).not.toContain("unknown-connector-arg");
  });

  it("degrades arg-agnostic when no schema is cached (no false positive)", async () => {
    const res = await lint(skill(`$ ddg.search querry="hi" -> R`), { ...baseOpts });
    expect(rulesOf(res.findings)).not.toContain("unknown-connector-arg");
    expect(rulesOf(res.findings)).not.toContain("missing-required-connector-arg");
  });

  it("degrades for a tool that declares no inputSchema", async () => {
    const noSchema: Map<string, Map<string, McpToolDescriptor>> = new Map([
      ["ddg", new Map([["search", { name: "search" }]])],
    ]);
    const res = await lint(skill(`$ ddg.search querry="hi" -> R`), {
      ...baseOpts,
      mcpConnectorToolSchemas: noSchema,
    });
    expect(rulesOf(res.findings)).not.toContain("unknown-connector-arg");
  });
});

// Fake connector exercising the async collection + describeTools warming path.
class FakeMcpConnector implements McpConnector {
  constructor(private readonly behavior: "ok" | "reject", private readonly calls?: { n: number }) {}
  async call(): Promise<unknown> { return null; }
  async manifest(): Promise<ManifestInfo> {
    return { capabilities_version: "1", manifest: { kind: "fake" } } as ManifestInfo;
  }
  async describeTools(): Promise<McpToolDescriptor[]> {
    if (this.calls !== undefined) this.calls.n += 1;
    if (this.behavior === "reject") throw new Error("upstream unreachable");
    return [SEARCH];
  }
}

describe("v0.23.0 — connector-aware input lint (registry warming path)", () => {
  it("collects schemas from a wired connector's describeTools() and validates", async () => {
    const calls = { n: 0 };
    const registry = new Registry();
    registry.registerMcpConnector("ddg", new FakeMcpConnector("ok", calls));
    const res = await lint(skill(`$ ddg.search querry="hi" -> R`), { registry });
    expect(rulesOf(res.findings)).toContain("unknown-connector-arg");
    expect(calls.n).toBeGreaterThan(0); // describeTools was warmed via the lint path
  });

  it("degrades silently when describeTools rejects (unreachable upstream)", async () => {
    const registry = new Registry();
    registry.registerMcpConnector("ddg", new FakeMcpConnector("reject"));
    const res = await lint(skill(`$ ddg.search querry="hi" -> R`), { registry });
    expect(rulesOf(res.findings)).not.toContain("unknown-connector-arg");
  });

  it("does not validate args for a tool gated off by allowed_tools", async () => {
    const registry = new Registry();
    // Connector exposes `search` but the operator gates to a different tool only,
    // so `search`'s schema must NOT be surfaced for arg validation. The
    // disallowed-tool rule owns that case.
    registry.registerMcpConnector("ddg", new FakeMcpConnector("ok"), ["other_tool"]);
    const res = await lint(skill(`$ ddg.search querry="hi" -> R`), { registry });
    expect(rulesOf(res.findings)).not.toContain("unknown-connector-arg");
  });

  // Adopter finding 262d5ab9: the tier-3 unverified-qualified-tool advisory
  // (gates only on staticTools) co-fired against a describeTools connector and
  // contradicted the tier-2 arg validation on the same op.
  it("does NOT co-fire unverified-qualified-tool when describeTools verifies the tool", async () => {
    const registry = new Registry();
    registry.registerMcpConnector("ddg", new FakeMcpConnector("ok")); // describeTools, no staticTools
    const res = await lint(skill(`$ ddg.search querry="hi" -> R`), { registry });
    const rules = rulesOf(res.findings);
    expect(rules).toContain("unknown-connector-arg"); // tier-2 DID validate the schema
    expect(rules).not.toContain("unverified-qualified-tool"); // tier-3 must not contradict it
  });

  it("still fires unverified-qualified-tool for a tool NOT in the warmed surface", async () => {
    const registry = new Registry();
    registry.registerMcpConnector("ddg", new FakeMcpConnector("ok")); // exposes only `search`
    const res = await lint(skill(`$ ddg.nonexistent query="x" -> R`), { registry });
    expect(rulesOf(res.findings)).toContain("unverified-qualified-tool");
  });
});
