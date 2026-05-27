/**
 * v0.9.2 — runtime observability signals (P1.1 delivery_skipped + P1.4 fallbacks).
 *
 * Closes the "I can't tell if my skill actually delivered or just
 * silently no-op'd" finding from `dec3ca8a`. Cold authors writing
 * `# Output: agent: oncall` against a runtime without an AgentConnector
 * now get an explicit `delivery_skipped: true` flag; `(fallback:)`
 * substitutions surface in a `fallbacks: []` array.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/connectors/registry.js";
import { execute } from "../src/runtime.js";
import { compile } from "../src/compile.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";

describe("v0.9.2 — runtime signals", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v0.9.2-signals-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("P1.1 — delivery_skipped when no AgentConnector wired", () => {
    it("agentDeliveryReceipts[].delivery_skipped is true when only NoOp is available", async () => {
      const registry = new Registry();
      registry.registerSkillStore("primary", new FilesystemSkillStore(join(dir, "skills")));
      const compiled = await compile(`# Skill: t
# Status: Approved
# Output: agent: oncall

m:
    emit(text="hello on-call")

default: m
`);
      const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
      expect(r.agentDeliveryReceipts).toHaveLength(1);
      const rec = r.agentDeliveryReceipts[0]!;
      expect(rec.agent_id).toBe("oncall");
      expect(rec.output_kind).toBe("agent");
      expect(rec.delivery_skipped).toBe(true);
      expect(rec.reason).toMatch(/No AgentConnector wired/);
    });

    it("delivery_skipped is absent (or false) when a real AgentConnector IS wired", async () => {
      const registry = new Registry();
      registry.registerSkillStore("primary", new FilesystemSkillStore(join(dir, "skills")));
      // Wire a stub AgentConnector
      await registry.registerAgentConnector("primary", {
        async list_agents() { return [{ agent_id: "oncall" }]; },
        async deliver() { return { delivered_at: Date.now(), delivery_id: "stub" }; },
        async wake() { return { woken_at: Date.now() }; },
        async health_check() { return true; },
        async request_response() { throw new Error("not implemented"); },
      });
      const compiled = await compile(`# Skill: t
# Status: Approved
# Output: agent: oncall

m:
    emit(text="hello")

default: m
`);
      const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
      expect(r.agentDeliveryReceipts).toHaveLength(1);
      expect(r.agentDeliveryReceipts[0]!.delivery_skipped).toBeUndefined();
    });
  });

  describe("P1.4 — fallbacks[] populated when fallback fires", () => {
    it("fallbacks[] is empty array when no fallbacks fire", async () => {
      const registry = new Registry();
      registry.registerSkillStore("primary", new FilesystemSkillStore(join(dir, "skills")));
      const compiled = await compile(`# Skill: t
# Status: Approved

m:
    emit(text="no fallback fired")

default: m
`);
      const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
      expect(r.fallbacks).toEqual([]);
    });

    it("file_read fallback substitution surfaces in fallbacks[]", async () => {
      const registry = new Registry();
      registry.registerSkillStore("primary", new FilesystemSkillStore(join(dir, "skills")));
      const compiled = await compile(`# Skill: t
# Status: Approved

m:
    file_read(path="/nonexistent/path/${process.pid}-test.txt") -> CONTENT (fallback: "default-content")
    emit(text="content: \${CONTENT}")

default: m
`);
      const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
      expect(r.fallbacks).toHaveLength(1);
      const fb = r.fallbacks[0]!;
      expect(fb.opKind).toBe("file_read");
      expect(fb.target).toBe("m");
      expect(fb.value).toBe("default-content");
      expect(fb.reason).toMatch(/file_read failed/);
      // The skill still completed cleanly
      expect(r.errors).toEqual([]);
      expect(r.emissions.join("\n")).toMatch(/content: default-content/);
    });

    it("$ op fallback substitution surfaces in fallbacks[]", async () => {
      const registry = new Registry();
      registry.registerSkillStore("primary", new FilesystemSkillStore(join(dir, "skills")));
      // No `nonexistent_tool` connector wired; the $ op fails and the fallback fires
      const compiled = await compile(`# Skill: t
# Status: Approved

m:
    $ nonexistent_tool query="x" -> R (fallback: "tool-was-missing")
    emit(text="got: \${R}")

default: m
`);
      const r = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, { registry });
      expect(r.fallbacks).toHaveLength(1);
      expect(r.fallbacks[0]!.opKind).toBe("$");
      expect(r.fallbacks[0]!.value).toBe("tool-was-missing");
      expect(r.emissions.join("\n")).toMatch(/got: tool-was-missing/);
    });
  });
});
