/**
 * Regression: `# Output: agent: ${VAR}` must resolve the delivery TARGET against
 * the run's vars, not deliver to a phantom agent literally named "${VAR}".
 *
 * The message body was already substituted; the frontmatter output TARGET is
 * parsed once and was used raw at dispatch — so a supervisor handler routing to
 * `# Output: agent: ${SUPERVISOR_AGENT}` addressed a nonexistent agent and
 * silently reached nobody (Perry, live supervisor test). Affects ANY skill using
 * the `# Output: agent: ${VAR}` form.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";

const run = (agentVar: string, target = "${AGENT}") =>
  execute(
    parse(`# Skill: t\n# Status: Approved\n# Autonomous: true\n# Vars: AGENT=nobody\n# Output: agent: ${target}\ndefault: run\nrun:\n    emit(text="alert body")\n`),
    { AGENT: agentVar },
    ["run"],
    { agentId: "t", registry: new Registry(), effectsAuthorized: true },
  );

describe("v0.36.1 — # Output: agent target interpolates against run vars", () => {
  it("resolves ${VAR} in the delivery target (deliver-class)", async () => {
    const r = await run("perry");
    expect(r.agentDeliveryReceipts.map((x) => x.agent_id)).toEqual(["perry"]);
    // and NOT the raw template
    expect(r.agentDeliveryReceipts.map((x) => x.agent_id)).not.toContain("${AGENT}");
  });

  it("a resolved @session target routes to wake-class", async () => {
    const r = await run("ops@session");
    expect(r.agentWakeReceipts.map((x) => x.agent_id)).toEqual(["ops@session"]);
    expect(r.agentDeliveryReceipts).toEqual([]);
  });

  it("a literal (non-var) target still delivers unchanged", async () => {
    const r = await run("ignored", "ops-oncall");
    expect(r.agentDeliveryReceipts.map((x) => x.agent_id)).toEqual(["ops-oncall"]);
  });
});
