import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "../src/mcp-server.js";
import { DashboardServer } from "../src/dashboard/server.js";
import { Scheduler } from "../src/scheduler.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { FilesystemTraceStore } from "../src/trace.js";
import { Registry } from "../src/connectors/registry.js";
import { generateApprovalKeypair, setSecuredMode, setApprovalPublicKey } from "../src/approval.js";

interface Ctx {
  server: DashboardServer;
  mcpServer: McpServer;
  skillStore: FilesystemSkillStore;
  baseUrl: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const home = mkdtempSync(join(tmpdir(), "skillscript-dash-"));
  const skillStore = new FilesystemSkillStore(join(home, "skills"));
  const traceStore = new FilesystemTraceStore(join(home, "traces"));
  const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
  const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
  // Port 0 → OS assigns a free ephemeral port (no cross-test collisions).
  const server = new DashboardServer({ mcpServer, port: 0, bindAddress: "127.0.0.1" });
  await server.start();
  return {
    server,
    mcpServer,
    skillStore,
    baseUrl: `http://127.0.0.1:${server.boundPort()}`,
    cleanup: async () => {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe("DashboardServer static handler", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await ctx.cleanup(); });

  it("GET / serves index.html with text/html content-type", async () => {
    const r = await fetch(`${ctx.baseUrl}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    const body = await r.text();
    expect(body).toMatch(/skillscript-runtime/);
  });

  it("GET /app.js serves SPA JS", async () => {
    const r = await fetch(`${ctx.baseUrl}/app.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/javascript/);
    const body = await r.text();
    expect(body).toMatch(/POLL_INTERVAL_MS/);
  });

  it("GET /styles.css serves CSS", async () => {
    const r = await fetch(`${ctx.baseUrl}/styles.css`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/css/);
  });

  it("GET /unknown.txt returns 404", async () => {
    const r = await fetch(`${ctx.baseUrl}/unknown.txt`);
    expect(r.status).toBe(404);
  });

  it("GET /../etc/passwd is 403 (path traversal protection)", async () => {
    const r = await fetch(`${ctx.baseUrl}/../etc/passwd`);
    // Either 403 (path traversal caught) or 404 (URL normalization)
    expect([403, 404]).toContain(r.status);
  });
});

describe("DashboardServer /rpc endpoint", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await ctx.cleanup(); });

  it("POST /rpc routes initialize to McpServer", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.id).toBe(1);
    expect(json.result.protocolVersion).toBe("2024-11-05");
    expect(json.result.serverInfo.name).toBe("skillscript-runtime");
  });

  it("POST /rpc routes tools/list", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const json = await r.json();
    expect(json.result.tools.length).toBe(17);
  });

  it("POST /rpc routes tools/call (skill_list, v0.9.8 SkillCatalog)", async () => {
    // alpha is agent-invokable (no # Output:, no triggers) — surfaces in skills
    // per v0.9.8.1 inference branch.
    await ctx.skillStore.store("alpha", "# Skill: alpha\n# Status: Approved\nt:\n    emit(text=\"hi\")\ndefault: t\n");
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "skill_list", arguments: {} },
      }),
    });
    const json = await r.json();
    const catalog = JSON.parse(json.result.content[0].text);
    expect(catalog.skills.length).toBe(1);
    expect(catalog.skills[0].name).toBe("alpha");
  });

  it("POST /rpc with malformed JSON returns -32700 parse error", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(r.status).toBe(400);
    const json = await r.json();
    expect(json.error.code).toBe(-32700);
  });

  it("GET /rpc returns 405 (only POST allowed)", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`);
    expect(r.status).toBe(405);
  });
});

describe("DashboardServer auth gate (v0.20.1)", () => {
  // A server with the dashboard token set. Mirrors setup() but adds authToken.
  async function securedSetup(): Promise<Ctx & { token: string }> {
    const home = mkdtempSync(join(tmpdir(), "skillscript-dashauth-"));
    const skillStore = new FilesystemSkillStore(join(home, "skills"));
    const traceStore = new FilesystemTraceStore(join(home, "traces"));
    const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
    const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
    const token = "tok-secret-abc123";
    const server = new DashboardServer({ mcpServer, port: 0, bindAddress: "127.0.0.1", authToken: token });
    await server.start();
    return {
      server, mcpServer, skillStore, token,
      baseUrl: `http://127.0.0.1:${server.boundPort()}`,
      cleanup: async () => { await server.stop(); rmSync(home, { recursive: true, force: true }); },
    };
  }

  let ctx: Ctx & { token: string };
  beforeEach(async () => { ctx = await securedSetup(); });
  afterEach(async () => { await ctx.cleanup(); });

  it("GET / with no token → 401", async () => {
    const r = await fetch(`${ctx.baseUrl}/`, { redirect: "manual" });
    expect(r.status).toBe(401);
  });

  it("GET /?token=<wrong> → 401", async () => {
    const r = await fetch(`${ctx.baseUrl}/?token=nope`);
    expect(r.status).toBe(401);
  });

  it("GET /?token=<correct> → 200 + sets the session cookie", async () => {
    const r = await fetch(`${ctx.baseUrl}/?token=${ctx.token}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/skillscript_dash=/);
    expect(r.headers.get("set-cookie")).toMatch(/HttpOnly/);
  });

  it("the session cookie alone authorizes follow-up requests", async () => {
    const r = await fetch(`${ctx.baseUrl}/app.js`, { headers: { cookie: `skillscript_dash=${ctx.token}` } });
    expect(r.status).toBe(200);
  });

  it("POST /rpc with a Bearer token → 200 (programmatic callers)", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(200);
  });

  it("POST /rpc with no token → 401", async () => {
    const r = await fetch(`${ctx.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
  });
});

describe("DashboardServer in-browser approval — passcode session-unlock (v0.20.2)", () => {
  async function signingSetup(): Promise<{ baseUrl: string; skillStore: FilesystemSkillStore; cleanup: () => Promise<void> }> {
    const home = mkdtempSync(join(tmpdir(), "skillscript-sign-"));
    const skillStore = new FilesystemSkillStore(join(home, "skills"));
    const traceStore = new FilesystemTraceStore(join(home, "traces"));
    const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
    const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
    const { publicKeyPem, privateKeyPem } = generateApprovalKeypair();
    const keyFile = join(home, "approval.key");
    writeFileSync(keyFile, privateKeyPem);
    // Arm secured + public key so signingEnabled() is true + the store honors v3.
    setApprovalPublicKey(publicKeyPem);
    setSecuredMode(true);
    await skillStore.store("needs-approval", "# Skill: needs-approval\n# Status: Draft\nrun:\n    emit(text=\"hi\")\ndefault: run\n", { status: "Draft" });
    const server = new DashboardServer({ mcpServer, port: 0, bindAddress: "127.0.0.1", skillStore, approvalKeyFile: keyFile, approvalPasscode: "sesame" });
    await server.start();
    return {
      baseUrl: `http://127.0.0.1:${server.boundPort()}`,
      skillStore,
      cleanup: async () => { await server.stop(); setSecuredMode(false); setApprovalPublicKey(null); rmSync(home, { recursive: true, force: true }); },
    };
  }

  let ctx: Awaited<ReturnType<typeof signingSetup>>;
  beforeEach(async () => { ctx = await signingSetup(); });
  afterEach(async () => { await ctx.cleanup(); });

  const post = (path: string, body: unknown, cookie?: string) => fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

  it("GET /signing-status → enabled:true when wired", async () => {
    const r = await fetch(`${ctx.baseUrl}/signing-status`);
    expect(await r.json()).toEqual({ enabled: true });
  });

  it("/approve without an unlock session → 401 needs_passcode", async () => {
    const r = await post("/approve", { name: "needs-approval" });
    expect(r.status).toBe(401);
    expect((await r.json() as { needs_passcode: boolean }).needs_passcode).toBe(true);
  });

  it("/unlock with the wrong passcode → 401", async () => {
    const r = await post("/unlock", { passcode: "wrong" });
    expect(r.status).toBe(401);
  });

  it("unlock → approve signs the skill v3 and stores it Approved", async () => {
    const unlock = await post("/unlock", { passcode: "sesame" });
    expect(unlock.status).toBe(200);
    const cookie = (unlock.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toMatch(/skillscript_unlock=/);

    const approve = await post("/approve", { name: "needs-approval" }, cookie);
    expect(approve.status).toBe(200);
    expect((await approve.json() as { approved: boolean }).approved).toBe(true);

    const loaded = await ctx.skillStore.load("needs-approval");
    expect(loaded.source).toMatch(/^# Status: Approved v3:/m);
  });

  it("a stale (expired/forged) unlock cookie is rejected", async () => {
    const r = await post("/approve", { name: "needs-approval" }, "skillscript_unlock=forged-session-id");
    expect(r.status).toBe(401);
  });
});

describe("DashboardServer /approve re-registers declarative triggers (v0.21.2 bug fix)", () => {
  it("dashboard-approving a cron skill registers its trigger in the live scheduler", async () => {
    const home = mkdtempSync(join(tmpdir(), "skillscript-approve-trig-"));
    const skillStore = new FilesystemSkillStore(join(home, "skills"));
    const traceStore = new FilesystemTraceStore(join(home, "traces"));
    const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
    const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
    const { publicKeyPem, privateKeyPem } = generateApprovalKeypair();
    const keyFile = join(home, "approval.key");
    writeFileSync(keyFile, privateKeyPem);
    setApprovalPublicKey(publicKeyPem);
    setSecuredMode(true);
    // A cron skill currently Draft (e.g. just edited → forced Draft in secured mode).
    await skillStore.store("nightly", "# Skill: nightly\n# Status: Draft\n# Triggers: cron: 0 3 * * *\n# Autonomous: true\nrun:\n    emit(text=\"tick\")\ndefault: run\n", { status: "Draft" });
    // Draft → no trigger registered yet (the bug's precondition).
    expect(scheduler.listTriggers().some((t) => t.skillName === "nightly")).toBe(false);
    const server = new DashboardServer({ mcpServer, port: 0, bindAddress: "127.0.0.1", scheduler, skillStore, approvalKeyFile: keyFile, approvalPasscode: "sesame" });
    await server.start();
    try {
      const base = `http://127.0.0.1:${server.boundPort()}`;
      const post = (path: string, body: unknown, cookie?: string) => fetch(`${base}${path}`, {
        method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
      });
      const unlock = await post("/unlock", { passcode: "sesame" });
      const cookie = (unlock.headers.get("set-cookie") ?? "").split(";")[0]!;
      const approve = await post("/approve", { name: "nightly" }, cookie);
      expect(approve.status).toBe(200);
      // THE FIX: the cron trigger is now in the live scheduler (Triggers view + firing).
      const trigs = scheduler.listTriggers().filter((t) => t.skillName === "nightly");
      expect(trigs.length).toBe(1);
      expect(trigs[0]!.source).toBe("cron");
      expect(trigs[0]!.name).toBe("0 3 * * *");
    } finally {
      await server.stop();
      setSecuredMode(false);
      setApprovalPublicKey(null);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("DashboardServer /delete (operator destructive delete)", () => {
  it("preflight scan without force surfaces dependents + deletes nothing; force deletes + drops triggers + frees the name", async () => {
    const home = mkdtempSync(join(tmpdir(), "skillscript-del-"));
    const skillStore = new FilesystemSkillStore(join(home, "skills"));
    const traceStore = new FilesystemTraceStore(join(home, "traces"));
    const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
    const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
    await skillStore.store("util", "# Skill: util\n# Status: Approved\n# Triggers: cron: 0 3 * * *\n# Autonomous: true\nrun:\n    emit(text=\"u\")\ndefault: run\n", { status: "Approved" });
    await skillStore.store("caller", "# Skill: caller\n# Status: Approved\nrun:\n    execute_skill(name=\"util\") -> R\ndefault: run\n", { status: "Approved" });
    scheduler.syncDeclarativeTriggersForSkill("util", [{ source: "cron", name: "0 3 * * *" }], [], "Approved");
    const server = new DashboardServer({ mcpServer, port: 0, bindAddress: "127.0.0.1", scheduler, skillStore });
    await server.start();
    try {
      const base = `http://127.0.0.1:${server.boundPort()}`;
      const del = (body) => fetch(`${base}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

      // No force → preflight scan only: surfaces the dependent, deletes nothing.
      const scan = await (await del({ name: "util" })).json();
      expect(scan.deleted).toBe(false);
      expect(scan.preflight).toBe(true);
      expect(scan.dependents).toEqual(["caller"]);
      // util still present + trigger intact.
      expect((await skillStore.query()).map((m) => m.name)).toContain("util");
      expect(scheduler.listTriggers({ skillName: "util" })).toHaveLength(1);

      // Force → deleted, trigger dropped, name freed.
      const done = await (await del({ name: "util", force: true })).json();
      expect(done.deleted).toBe(true);
      expect((await skillStore.query()).map((m) => m.name)).not.toContain("util");
      expect(scheduler.listTriggers({ skillName: "util" })).toHaveLength(0);
    } finally {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preflight without force never deletes even when there are no dependents", async () => {
    const home = mkdtempSync(join(tmpdir(), "skillscript-del-nodep-"));
    const skillStore = new FilesystemSkillStore(join(home, "skills"));
    const traceStore = new FilesystemTraceStore(join(home, "traces"));
    const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
    const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
    await skillStore.store("lonely", "# Skill: lonely\n# Status: Approved\nrun:\n    emit(text=\"x\")\ndefault: run\n", { status: "Approved" });
    const server = new DashboardServer({ mcpServer, port: 0, bindAddress: "127.0.0.1", scheduler, skillStore });
    await server.start();
    try {
      const base = `http://127.0.0.1:${server.boundPort()}`;
      const del = (body) => fetch(`${base}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

      // No force, no dependents → still a preflight: nothing deleted.
      const scan = await (await del({ name: "lonely" })).json();
      expect(scan.deleted).toBe(false);
      expect(scan.preflight).toBe(true);
      expect(scan.dependents).toEqual([]);
      expect((await skillStore.query()).map((m) => m.name)).toContain("lonely");

      // Force commits the delete.
      const done = await (await del({ name: "lonely", force: true })).json();
      expect(done.deleted).toBe(true);
      expect((await skillStore.query()).map((m) => m.name)).not.toContain("lonely");
    } finally {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("DashboardServer in-browser approval — disabled by default", () => {
  it("/unlock + /approve + signing-status:false when no passcode is wired", async () => {
    const home = mkdtempSync(join(tmpdir(), "skillscript-nosign-"));
    const skillStore = new FilesystemSkillStore(join(home, "skills"));
    const traceStore = new FilesystemTraceStore(join(home, "traces"));
    const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
    const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
    const server = new DashboardServer({ mcpServer, port: 0, bindAddress: "127.0.0.1" });
    await server.start();
    try {
      const base = `http://127.0.0.1:${server.boundPort()}`;
      expect(await (await fetch(`${base}/signing-status`)).json()).toEqual({ enabled: false });
      const u = await fetch(`${base}/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(u.status).toBe(404);
      const a = await fetch(`${base}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(a.status).toBe(404);
    } finally {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("DashboardServer signing-misconfigured detection (v0.21.0, adopter finding 46e9b6f7)", () => {
  afterEach(() => { setSecuredMode(false); setApprovalPublicKey(null); });

  it("secured + passcode but NO skillStore → signing disabled (the silent-lockout case, now detectable)", async () => {
    const home = mkdtempSync(join(tmpdir(), "skillscript-misconfig-"));
    const skillStore = new FilesystemSkillStore(join(home, "skills"));
    const traceStore = new FilesystemTraceStore(join(home, "traces"));
    const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
    const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
    setSecuredMode(true);
    // Programmatic-adopter mistake: passcode set, skillStore NOT passed to DashboardServer.
    const server = new DashboardServer({ mcpServer, port: 0, bindAddress: "127.0.0.1", approvalPasscode: "x" });
    await server.start();
    try {
      const r = await fetch(`http://127.0.0.1:${server.boundPort()}/signing-status`);
      expect(await r.json()).toEqual({ enabled: false }); // not silently "working"
    } finally {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
