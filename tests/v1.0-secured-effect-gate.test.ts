import { describe, it, expect, afterEach } from "vitest";
import { compile } from "../src/compile.js";
import { execute } from "../src/runtime.js";
import { Registry } from "../src/connectors/registry.js";
import { setSecuredMode } from "../src/approval.js";

/**
 * v1.0 Gate #7 — Phase 1b: the complete-mediation capability gate.
 *
 * In SECURED mode, effectful ops (egress/mutation: `$`, shell, file_write,
 * notify) and output-routing delivery dispatch ONLY when the execution carries
 * `effectsAuthorized` (minted by a verified approval at load). Source-mode /
 * Draft / unapproved bodies run without it → effects refused at the dispatch
 * choke, regardless of mechanical's (incomplete) suppression. When the boundary
 * is OFF, the capability is ignored entirely (zero behavior change).
 */

async function run(
  source: string,
  opts: { secured?: boolean; authorized?: boolean } = {},
) {
  setSecuredMode(opts.secured ?? false);
  const compiled = await compile(source, { skipLintPreflight: true });
  return execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
    registry: new Registry(),
    shellAllowlist: [],
    enableUnsafeShell: false,
    effectsAuthorized: opts.authorized ?? false,
  });
}

afterEach(() => setSecuredMode(false));

const WITH_EFFECT = `# Skill: t
# Status: Approved
# Output: text
run:
    emit(text="before-effect")
    file_write(path="/tmp/secgate-probe.txt", content="wrote", approved="audit")
default: run
`;

describe("capability gate — effectful ops in secured mode", () => {
  it("REFUSES an effectful op when secured + unauthorized (source-mode shape)", async () => {
    const r = await run(WITH_EFFECT, { secured: true, authorized: false });
    const refused = r.errors.find((e) => /secured mode requires an approved/i.test(e.message));
    expect(refused).toBeDefined();
    // Non-effectful ops still run — emit fired before the refusal.
    expect(r.emissions).toContain("before-effect");
  });

  it("ALLOWS the effectful op when secured + authorized (verified approval)", async () => {
    const r = await run(WITH_EFFECT, { secured: true, authorized: true });
    expect(r.errors.find((e) => /secured mode requires an approved/i.test(e.message))).toBeUndefined();
  });

  it("ignores the capability entirely when the boundary is OFF (no behavior change)", async () => {
    const r = await run(WITH_EFFECT, { secured: false, authorized: false });
    expect(r.errors.find((e) => /secured mode/i.test(e.message))).toBeUndefined();
  });
});

describe("capability gate — output-routing delivery", () => {
  const WITH_DELIVERY = `# Skill: t
# Status: Approved
# Output: agent: oncall
run:
    emit(text="hello")
default: run
`;

  it("REFUSES agent delivery when secured + unauthorized", async () => {
    const r = await run(WITH_DELIVERY, { secured: true, authorized: false });
    expect(r.agentDeliveryReceipts ?? []).toHaveLength(0);
  });

  it("performs delivery (NoOp receipt) when authorized", async () => {
    const r = await run(WITH_DELIVERY, { secured: true, authorized: true });
    expect((r.agentDeliveryReceipts ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

describe("capability gate — non-effectful ops never refused", () => {
  it("$set / emit run under secured + unauthorized", async () => {
    const src = `# Skill: t
# Status: Approved
# Output: text
run:
    $set MSG = "computed"
    emit(text="\${MSG}")
default: run
`;
    const r = await run(src, { secured: true, authorized: false });
    expect(r.errors).toEqual([]);
    expect(r.emissions).toContain("computed");
  });
});
