// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.0 Gate #7 — dashboard approval-queue SPA logic. The SPA is a plain browser
 * script (no module exports), so we eval it as a non-module script into the
 * happy-dom global scope, which makes its top-level function declarations global
 * and accessible here. We then drive the secured-mode branches that decide the
 * approval UX: review-command vs in-page button.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;

beforeAll(() => {
  const src = readFileSync(join(__dirname, "../src/dashboard/spa/app.js"), "utf8");
  // `const state` / function declarations don't reliably attach to globalThis
  // under eval, so append an epilogue (same eval scope) that hands the symbols
  // we test out to globalThis explicitly. The script's DOMContentLoaded/
  // hashchange listeners never fire under the test (no navigation), so eval has
  // no side effects beyond defining the symbols.
  const epilogue = `
    globalThis.state = state;
    globalThis.securedModeOn = securedModeOn;
    globalThis.approveCommand = approveCommand;
    globalThis.shellQuote = shellQuote;
    globalThis.renderStatusActions = renderStatusActions;
    globalThis.approvalSignalBadges = approvalSignalBadges;
    globalThis.renderApprovals = renderApprovals;
    globalThis.approveInBrowser = approveInBrowser;
    // Make the refresh/render side-effects of approveInBrowser inert in tests.
    refresh = async () => {};
    renderCurrentView = () => {};
  `;
  (0, eval)(src + epilogue);
});

beforeEach(() => {
  // Reset the script's shared `state` before each case.
  g.state.securedApproval = null;
  g.state.skills = [];
});

describe("securedModeOn / approveCommand / shellQuote", () => {
  it("securedModeOn reflects state.securedApproval.enabled", () => {
    g.state.securedApproval = null;
    expect(g.securedModeOn()).toBe(false);
    g.state.securedApproval = { enabled: false, public_key_present: false };
    expect(g.securedModeOn()).toBe(false);
    g.state.securedApproval = { enabled: true, public_key_present: true };
    expect(g.securedModeOn()).toBe(true);
  });

  it("approveCommand shell-quotes only when needed", () => {
    expect(g.approveCommand("my-skill")).toBe("skillfile approve my-skill");
    expect(g.approveCommand("weird name")).toBe("skillfile approve 'weird name'");
    expect(g.approveCommand("a'b")).toBe("skillfile approve 'a'\\''b'");
  });
});

describe("renderStatusActions — secured vs unsecured approve UX", () => {
  const meta = { name: "demo", status: "Draft" };

  it("UNSECURED: Draft skill gets an in-page 'Transition to Approved' button", () => {
    g.state.securedApproval = { enabled: false, public_key_present: false };
    const html = g.renderStatusActions("demo", meta, null);
    expect(html).toContain("updateStatus('demo','Approved')");
    expect(html).not.toContain("skillfile approve");
  });

  it("SECURED: Draft skill gets the `skillfile approve` command, NOT a button", () => {
    g.state.securedApproval = { enabled: true, public_key_present: true };
    const html = g.renderStatusActions("demo", meta, null);
    expect(html).not.toContain("updateStatus('demo','Approved')");
    expect(html).toContain("skillfile approve demo");
    expect(html).toContain("copyText(");
  });

  it("SECURED: Draft→Disabled is still a one-click button (revoke grants no effects)", () => {
    g.state.securedApproval = { enabled: true, public_key_present: true };
    const html = g.renderStatusActions("demo", meta, null);
    expect(html).toContain("updateStatus('demo','Disabled')");
  });

  it("SECURED: a stale Approved (gate not ok) surfaces a re-approve command", () => {
    g.state.securedApproval = { enabled: true, public_key_present: true };
    const html = g.renderStatusActions("demo", { name: "demo", status: "Approved" }, { gate_ok: false });
    expect(html).toContain("Re-approve");
    expect(html).toContain("skillfile approve demo");
    expect(html).not.toContain("updateStatus('demo','Approved')");
  });

  it("a healthy Approved skill shows no approve action at all", () => {
    g.state.securedApproval = { enabled: true, public_key_present: true };
    const html = g.renderStatusActions("demo", { name: "demo", status: "Approved" }, { gate_ok: true });
    expect(html).not.toContain("skillfile approve");
    expect(html).toContain("updateStatus('demo','Draft')"); // demote still offered
  });
});

describe("approvalSignalBadges — queue triage column", () => {
  it("flags mutation + unsafe shell + autonomous as error badges", () => {
    const sig = { writeOps: 2, unsafeShell: 1, approvedOps: 0, autonomous: true, shellOps: 3, shellBinaries: ["curl"], wakeAddresses: 0, cronTriggers: 0 };
    const html = g.approvalSignalBadges(sig);
    expect(html).toContain("2 write");
    expect(html).toContain("1 unsafe");
    expect(html).toContain("# Autonomous");
    expect(html).toContain("3 shell");
  });
  it("shows a clean 'no signals' badge when nothing risky", () => {
    const sig = { writeOps: 0, unsafeShell: 0, approvedOps: 0, autonomous: false, shellOps: 0, shellBinaries: [], wakeAddresses: 0, cronTriggers: 0 };
    expect(g.approvalSignalBadges(sig)).toContain("no signals");
  });
});

describe("renderApprovals — queue = Drafts + stale Approved (gate_ok:false)", () => {
  it("queries Draft AND Approved, and surfaces both a Draft and a v1-stale Approved skill", async () => {
    g.state.securedApproval = { enabled: true, public_key_present: true };
    const statuses: string[] = [];
    g.fetch = async (_url: string, opts: { body: string }) => {
      const req = JSON.parse(opts.body);
      const toolName = req.params.name;
      let payload: unknown = {};
      if (toolName === "skill_list") {
        const status = req.params.arguments?.filter?.status;
        statuses.push(status);
        if (status === "Draft") {
          payload = { receives: [], skills: [{ name: "draft-skill", status: "Draft", description: "d", gate_ok: false }], headless: [] };
        } else if (status === "Approved") {
          // one stale (v1) Approved + one healthy v3 Approved — only the stale belongs in the queue
          payload = { receives: [], skills: [
            { name: "legacy-v1", status: "Approved", description: "old", gate_ok: false },
            { name: "healthy-v3", status: "Approved", description: "ok", gate_ok: true },
          ], headless: [] };
        }
      } else if (toolName === "skill_read") {
        payload = { source: `# Skill: ${req.params.arguments.name}\nrun:\n    file_write(path="x", content="y", approved="z")\ndefault: run` };
      }
      return {
        json: async () => ({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }),
      };
    };
    const html = await g.renderApprovals();
    // Both statuses are queried (the 30s poll only sees Approved).
    expect(statuses).toContain("Draft");
    expect(statuses).toContain("Approved");
    // Draft + stale-v1 Approved are in the queue; the healthy v3 one is NOT.
    expect(html).toContain("draft-skill");
    expect(html).toContain("legacy-v1");
    expect(html).not.toContain("healthy-v3");
    expect(html).toMatch(/Approvals \(2\)/);
    expect(html).toContain("re-approval needed"); // the stale-Approved badge
    expect(html).toContain("skillfile approve legacy-v1");
  });
});

describe("approveInBrowser — passcode session-unlock flow (v0.20.2)", () => {
  it("happy path: POSTs /approve and succeeds when already unlocked (no prompt)", async () => {
    const calls: string[] = [];
    let prompted = false;
    g.window.prompt = () => { prompted = true; return "sesame"; };
    g.window.alert = () => {};
    g.fetch = async (url: string, opts: { body: string }) => {
      calls.push(url);
      if (url === "/approve") {
        return { status: 200, json: async () => ({ approved: true, name: JSON.parse(opts.body).name, version: "abc" }) };
      }
      return { status: 200, json: async () => ({}) };
    };
    await g.approveInBrowser("danger");
    expect(calls).toEqual(["/approve"]);
    expect(prompted, "should NOT prompt when already unlocked").toBe(false);
  });

  it("needs-passcode path: 401 → prompt → /unlock → retry /approve", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    g.window.prompt = () => "sesame";
    g.window.alert = () => {};
    let approveCount = 0;
    g.fetch = async (url: string, opts: { body: string }) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (url === "/approve") {
        approveCount += 1;
        if (approveCount === 1) return { status: 401, json: async () => ({ approved: false, needs_passcode: true }) };
        return { status: 200, json: async () => ({ approved: true, version: "v" }) };
      }
      if (url === "/unlock") return { status: 200, json: async () => ({ unlocked: true }) };
      return { status: 200, json: async () => ({}) };
    };
    await g.approveInBrowser("danger");
    expect(calls.map((c) => c.url)).toEqual(["/approve", "/unlock", "/approve"]);
    expect((calls[1].body as { passcode: string }).passcode).toBe("sesame");
  });

  it("wrong passcode: /unlock 401 → alerts, does NOT retry approve", async () => {
    const calls: string[] = [];
    let alerted = false;
    g.window.prompt = () => "wrong";
    g.window.alert = () => { alerted = true; };
    g.fetch = async (url: string) => {
      calls.push(url);
      if (url === "/approve") return { status: 401, json: async () => ({ needs_passcode: true }) };
      if (url === "/unlock") return { status: 401, json: async () => ({ unlocked: false }) };
      return { status: 200, json: async () => ({}) };
    };
    await g.approveInBrowser("danger");
    expect(calls).toEqual(["/approve", "/unlock"]); // no second /approve
    expect(alerted).toBe(true);
  });
});
