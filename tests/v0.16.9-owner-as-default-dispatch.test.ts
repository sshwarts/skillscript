import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";

/**
 * v0.16.9 item 4 — Owner-as-default for ALL dispatch paths.
 *
 * v0.16.8 landed for the MCP `execute_skill` entry only. v0.16.9
 * generalizes to:
 *   - In-skill `$ execute_skill` composition (composition.ts) — child runs
 *     under CHILD's author (Bob), not parent's caller (Alice). Per Perry's
 *     `fd18e3f7` cross-author callout. v0.17+ adds dual-identity delegation.
 *   - Scheduler-fired dispatch (scheduler.ts) — cron / scheduled / event-
 *     source skills carry the skill's author as ctx.agentId. Closes the
 *     `olsen-nightly` cron case from Scott's original framing.
 *
 * Invariant for v0.16.9: `ctx.agentId = SkillMeta.author` for every skill
 * run, regardless of dispatcher.
 */

const APPROVED_PROBE = (name: string) => `# Skill: ${name}
# Status: Approved

run:
    $ probe ping=1
default: run
`;

describe("v0.16.9 — owner-as-default for in-skill $ execute_skill composition", () => {
  it("child skill runs under CHILD's author identity (not parent's)", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0169-compose-author-"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });
    // Capture the ctx every probe connector receives.
    const seen: Array<{ agentId?: string }> = [];
    wired.registry.registerMcpConnector("probe", new CallbackMcpConnector(async (_t, _a, ctx) => {
      seen.push({ ...ctx });
      return { ok: true };
    }));

    // Store two skills with distinct authors.
    await wired.skillStore.store("child-skill", APPROVED_PROBE("child-skill"), { author: "bob" });
    const parentBody = `# Skill: parent-skill
# Status: Approved

run:
    $ probe parent_dispatch=1
    $ execute_skill skill_name="child-skill" -> R
    $ probe post_compose=1
default: run
`;
    await wired.skillStore.store("parent-skill", parentBody, { author: "alice" });

    // Invoke parent via MCP execute_skill. Caller-side identity is alice
    // (parent's author per v0.16.8 + v0.16.9 dispatch). When parent calls
    // child via $ execute_skill, child's ctx.agentId should be bob.
    const resp = await wired.mcpServer.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "execute_skill", arguments: { skill_name: "parent-skill" } },
    });
    const r = resp as { result: { content: Array<{ text: string }> }; error?: unknown };
    expect(r.error).toBeUndefined();

    // Three probe calls: parent_dispatch (alice), child's run (bob), post_compose (alice).
    expect(seen.length).toBe(3);
    expect(seen[0]!.agentId).toBe("alice");
    expect(seen[1]!.agentId).toBe("bob");
    expect(seen[2]!.agentId).toBe("alice");
  });

  it("nested $ execute_skill recursion preserves the identity-follows-skill invariant", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0169-compose-nested-"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });
    const seen: Array<{ agentId?: string }> = [];
    wired.registry.registerMcpConnector("probe", new CallbackMcpConnector(async (_t, _a, ctx) => {
      seen.push({ ...ctx });
      return { ok: true };
    }));

    // Three-skill chain: A → B → C. Each authored differently.
    await wired.skillStore.store("c-skill", APPROVED_PROBE("c-skill"), { author: "carol" });
    await wired.skillStore.store("b-skill", `# Skill: b-skill
# Status: Approved

run:
    $ probe b_dispatch=1
    $ execute_skill skill_name="c-skill" -> R
default: run
`, { author: "bob" });
    await wired.skillStore.store("a-skill", `# Skill: a-skill
# Status: Approved

run:
    $ probe a_dispatch=1
    $ execute_skill skill_name="b-skill" -> R
default: run
`, { author: "alice" });

    const resp = await wired.mcpServer.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "execute_skill", arguments: { skill_name: "a-skill" } },
    });
    const r = resp as { result?: unknown; error?: unknown };
    expect(r.error).toBeUndefined();

    // Three probe calls, one per skill in the chain. Each carries its own author.
    expect(seen.length).toBe(3);
    expect(seen[0]!.agentId).toBe("alice");  // A's $ probe
    expect(seen[1]!.agentId).toBe("bob");    // B's $ probe (nested)
    expect(seen[2]!.agentId).toBe("carol");  // C's $ probe (doubly-nested)
  });
});

describe("v0.16.9 — owner-as-default for scheduler-fired dispatch (olsen-nightly case)", () => {
  it("scheduler dispatchExecute populates ctx.agentId from skill metadata.author", async () => {
    const home = mkdtempSync(join(tmpdir(), "v0169-scheduler-author-"));
    const wired = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      dataDbPath: join(home, "data.db"),
    });
    let seenCtx: { agentId?: string } | undefined;
    wired.registry.registerMcpConnector("probe", new CallbackMcpConnector(async (_t, _a, ctx) => {
      seenCtx = { ...ctx };
      return { ok: true };
    }));

    // Store a skill with author=perry — the canonical olsen-nightly case.
    await wired.skillStore.store("nightly-skill", APPROVED_PROBE("nightly-skill"), { author: "perry" });

    // Invoke via scheduler's dispatchSkill — the path trigger-firings flow
    // through. Same code path the cron firing would take.
    const result = await wired.scheduler.dispatchSkill("nightly-skill");
    expect(result?.errors).toEqual([]);
    expect(seenCtx?.agentId).toBe("perry");
  });
});
