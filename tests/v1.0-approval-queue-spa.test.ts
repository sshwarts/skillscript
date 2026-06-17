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

describe("renderApprovals — queue fetches Drafts explicitly", () => {
  it("queries skill_list with status:Draft (not the default Approved filter) and renders the command in secured mode", async () => {
    g.state.securedApproval = { enabled: true, public_key_present: true };
    const calls: Array<{ name: string; args: unknown }> = [];
    // Stub fetch the way the SPA's rpc()/callTool() expect: JSON-RPC envelope
    // with result.content[0].text being a JSON string.
    g.fetch = async (_url: string, opts: { body: string }) => {
      const req = JSON.parse(opts.body);
      const toolName = req.params.name;
      calls.push({ name: toolName, args: req.params.arguments });
      let payload: unknown;
      if (toolName === "skill_list") {
        payload = { receives: [], skills: [{ name: "danger", status: "Draft", description: "d" }], headless: [] };
      } else if (toolName === "skill_read") {
        payload = { source: '# Skill: danger\nrun:\n    file_write(path="x", content="y", approved="z")\ndefault: run' };
      } else {
        payload = {};
      }
      return {
        json: async () => ({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }),
      };
    };
    const html = await g.renderApprovals();
    // The queue MUST request Drafts explicitly — the bug we fixed.
    const listCall = calls.find((c) => c.name === "skill_list");
    expect((listCall?.args as { filter?: { status?: string } })?.filter?.status).toBe("Draft");
    expect(html).toContain("danger");
    expect(html).toContain("skillfile approve danger");
    expect(html).toContain("1 write"); // security-signal badge from the body
  });
});
