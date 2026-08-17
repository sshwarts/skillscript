import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStaticDependents } from "../src/skill-dependents.js";
import { executeSkillByName } from "../src/composition.js";
import { lint } from "../src/lint.js";
import {
  SkillNotFoundError,
  MissingSkillReferenceError,
  SkillStoreUnavailableError,
  OpError,
} from "../src/errors.js";
import { McpServer, type JsonRpcRequest } from "../src/mcp-server.js";
import { FilesystemTraceStore } from "../src/trace.js";
import {
  setSecuredMode, setApprovalPublicKey, generateApprovalKeypair,
} from "../src/approval.js";
import type { SkillStore, SkillSource, SkillMeta, VersionInfo } from "../src/connectors/types.js";

/**
 * 2d2a7fd4 — store-transport-flatten. A store failure ("could not tell") must
 * never be flattened into a negative answer ("not found" / "no dependents" /
 * "no valid signature"). The discriminator is the ERROR TYPE: `SkillNotFoundError`
 * is a genuine miss; anything else means the question was never answered.
 *
 * Substrate-distinguishing observable throughout: the SAME reference resolves
 * differently depending on whether the store threw SkillNotFoundError (a real
 * miss) or a transport error (an outage) — the two must NOT produce identical
 * output.
 */

const TRANSPORT = () => new Error("UND_ERR_CONNECT_TIMEOUT: connect timed out");

// Configurable store: choose what query/load/metadata do per call.
interface Knobs {
  queryThrows?: Error;
  queryReturns?: SkillMeta[];
  // per-name behaviour for load/metadata
  bodies?: Record<string, string>;
  loadThrows?: Record<string, Error>;
  metadataThrows?: Record<string, Error>;
}
function metaFor(name: string, src: string): SkillMeta {
  return { name, status: "Approved", version: "v", content_hash: "h" } as SkillMeta;
}
class ConfigurableStore implements SkillStore {
  constructor(private k: Knobs) {}
  static staticCapabilities() { return { connector_type: "skill_store", implementation: "ConfigurableStore", contract_version: "1.0.0", features: {} } as never; }
  async manifest() { return { capabilities_version: "1", manifest: {} } as never; }
  async query(): Promise<SkillMeta[]> {
    if (this.k.queryThrows) throw this.k.queryThrows;
    return this.k.queryReturns ?? [];
  }
  async load(name: string): Promise<SkillSource> {
    const e = this.k.loadThrows?.[name];
    if (e) throw e;
    const src = this.k.bodies?.[name];
    if (src === undefined) throw new SkillNotFoundError(name, "ConfigurableStore");
    return { name, version: "v", content_hash: "h", source: src, metadata: metaFor(name, src) };
  }
  async metadata(name: string): Promise<SkillMeta> {
    const e = this.k.metadataThrows?.[name];
    if (e) throw e;
    const src = this.k.bodies?.[name];
    if (src === undefined) throw new SkillNotFoundError(name, "ConfigurableStore");
    return metaFor(name, src);
  }
  async versions(): Promise<VersionInfo[]> { return []; }
  async store(): Promise<VersionInfo> { throw new Error("unused"); }
  async delete(): Promise<void> { /* unused */ }
  async update_status(): Promise<VersionInfo> { throw new Error("unused"); }
}

// ─── #1 skill-dependents fail-closed ────────────────────────────────────────
describe("2d2a7fd4 #1 — findStaticDependents fails closed", () => {
  it("THROWS when query() fails (not [] — an outage must not read as 'no dependents')", async () => {
    const store = new ConfigurableStore({ queryThrows: TRANSPORT() });
    await expect(findStaticDependents(store, "target")).rejects.toThrow(/CONNECT_TIMEOUT/);
  });

  it("THROWS when a per-skill load() fails for a non-not-found reason", async () => {
    const store = new ConfigurableStore({
      queryReturns: [{ name: "other", status: "Approved", version: "v", content_hash: "h" } as SkillMeta],
      loadThrows: { other: TRANSPORT() },
    });
    await expect(findStaticDependents(store, "target")).rejects.toThrow(/CONNECT_TIMEOUT/);
  });

  it("SKIPS a skill that vanished (SkillNotFoundError) between query and load — returns []", async () => {
    const store = new ConfigurableStore({
      queryReturns: [{ name: "gone", status: "Approved", version: "v", content_hash: "h" } as SkillMeta],
      loadThrows: { gone: new SkillNotFoundError("gone", "ConfigurableStore") },
    });
    await expect(findStaticDependents(store, "target")).resolves.toEqual([]);
  });

  it("happy path: an empty array means the scan RAN and found nothing", async () => {
    const store = new ConfigurableStore({
      queryReturns: [
        { name: "dep", status: "Approved", version: "v", content_hash: "h" } as SkillMeta,
        { name: "unrelated", status: "Approved", version: "v", content_hash: "h" } as SkillMeta,
      ],
      bodies: {
        dep: `# Skill: dep\nrun:\n    $ execute_skill name="target"\ndefault: run\n`,
        unrelated: `# Skill: unrelated\nrun:\n    emit(text="x")\ndefault: run\n`,
      },
    });
    await expect(findStaticDependents(store, "target")).resolves.toEqual(["dep"]);
  });
});

// ─── #2 composition catch-by-type ───────────────────────────────────────────
describe("2d2a7fd4 #2 — executeSkillByName distinguishes not-found from unreachable", () => {
  const opts = (store: SkillStore) => ({ ctx: {} as never, skillStore: store, chain: [] });

  it("SkillNotFoundError → MissingSkillReferenceError (the 'typo / forward-ref' case)", async () => {
    const store = new ConfigurableStore({ loadThrows: { missing: new SkillNotFoundError("missing", "ConfigurableStore") } });
    await expect(executeSkillByName("missing", {}, opts(store))).rejects.toBeInstanceOf(MissingSkillReferenceError);
  });

  it("transport failure → SkillStoreUnavailableError, NOT MissingSkillReferenceError", async () => {
    const store = new ConfigurableStore({ loadThrows: { x: TRANSPORT() } });
    const err = await executeSkillByName("x", {}, opts(store)).catch((e) => e);
    expect(err).toBeInstanceOf(SkillStoreUnavailableError);
    expect(err).not.toBeInstanceOf(MissingSkillReferenceError);
  });

  it("SkillStoreUnavailableError preserves the underlying cause and stays an OpError (flows through else:)", async () => {
    const store = new ConfigurableStore({ loadThrows: { x: TRANSPORT() } });
    const err = await executeSkillByName("x", {}, opts(store)).catch((e) => e) as SkillStoreUnavailableError;
    expect(err).toBeInstanceOf(OpError);
    expect(err.message).toMatch(/CONNECT_TIMEOUT/);
    expect(err.message).toMatch(/unreachable|could not be reached/i);
    // the remediation must steer toward store-availability, not a spelling hunt
    expect(err.remediation).toMatch(/reachable|store-availability|availability failure/i);
  });
});

// ─── #1b regression: the guard detects the bare-dispatch form it used to miss ─
// The prior text regex matched only the function-call source forms
// (`execute_skill(name=...)` / `inline(skill=...)`) and silently MISSED the
// `$ execute_skill name="x"` bare-dispatch form — the most common composition
// form — so a skill referenced that way was invisible to the delete guard.
// Parse-based detection now matches what lint/runtime treat as a reference.
describe("2d2a7fd4 #1b — findStaticDependents detects real reference forms", () => {
  const store = (bodies: Record<string, string>) =>
    new ConfigurableStore({
      queryReturns: Object.keys(bodies).map((name) => ({ name, status: "Approved", version: "v", content_hash: "h" } as SkillMeta)),
      bodies,
    });

  it("detects `$ execute_skill name=\"X\"` (bare-dispatch form — the one the old regex missed)", async () => {
    const s = store({ dep: `# Skill: dep\nrun:\n    $ execute_skill name="target"\ndefault: run\n` });
    await expect(findStaticDependents(s, "target")).resolves.toEqual(["dep"]);
  });

  it("detects the `execute_skill(name=\"X\")` function-call form", async () => {
    const s = store({ dep: `# Skill: dep\nrun:\n    execute_skill(name="target") -> R\ndefault: run\n` });
    await expect(findStaticDependents(s, "target")).resolves.toEqual(["dep"]);
  });

  it("detects the `inline(skill=\"X\")` compile-time inline form", async () => {
    const s = store({ dep: `# Skill: dep\nrun:\n    inline(skill="target") -> R\ndefault: run\n` });
    await expect(findStaticDependents(s, "target")).resolves.toEqual(["dep"]);
  });

  it("detects the `skill_name=` back-compat alias", async () => {
    const s = store({ dep: `# Skill: dep\nrun:\n    $ execute_skill skill_name="target"\ndefault: run\n` });
    await expect(findStaticDependents(s, "target")).resolves.toEqual(["dep"]);
  });

  it("does NOT match a different skill name (no false positive)", async () => {
    const s = store({ other: `# Skill: other\nrun:\n    $ execute_skill name="something-else"\ndefault: run\n` });
    await expect(findStaticDependents(s, "target")).resolves.toEqual([]);
  });
});

// ─── #3 lint reference rules ─────────────────────────────────────────────────
const SKILL_REF_SRC = `# Skill: host
run:
    $ execute_skill name="child"
default: run
`;
const TEMPLATE_REF_SRC = `# Skill: host
# Templates: tmpl
run:
    emit(text="x")
default: run
`;

describe("2d2a7fd4 #3 — lint reference rules distinguish outage from missing skill", () => {
  it("SkillNotFoundError → ordinary unknown-skill-reference warning (spelling / forward-ref)", async () => {
    const store = new ConfigurableStore({ metadataThrows: { child: new SkillNotFoundError("child", "ConfigurableStore") } });
    const r = await lint(SKILL_REF_SRC, { skillStore: store });
    const f = r.findings.filter((x) => x.rule === "unknown-skill-reference");
    expect(f).toHaveLength(1);
    expect(f[0]!.extras).toMatchObject({ referenced_skill: "child" });
    expect(f[0]!.extras).not.toHaveProperty("store_unreachable");
  });

  it("transport failure → a SINGLE store-unreachable finding (not 'missing skill'), with its OWN remediation", async () => {
    const store = new ConfigurableStore({ metadataThrows: { child: TRANSPORT() } });
    const r = await lint(SKILL_REF_SRC, { skillStore: store });
    const f = r.findings.filter((x) => x.rule === "unknown-skill-reference");
    expect(f).toHaveLength(1);
    expect(f[0]!.extras).toMatchObject({ store_unreachable: true });
    // the trap: must NOT inherit the rule's "fix the spelling" remediation
    expect(f[0]!.message).toMatch(/unreachable/i);
    expect(f[0]!.remediation).toMatch(/store-availability/i);
    expect(f[0]!.remediation).not.toMatch(/spelling/i);
  });

  it("template rule: transport failure → single store-unreachable finding, own remediation", async () => {
    const store = new ConfigurableStore({ metadataThrows: { tmpl: TRANSPORT() } });
    const r = await lint(TEMPLATE_REF_SRC, { skillStore: store });
    const f = r.findings.filter((x) => x.rule === "unknown-template-reference");
    expect(f).toHaveLength(1);
    expect(f[0]!.extras).toMatchObject({ store_unreachable: true });
    expect(f[0]!.remediation).not.toMatch(/spelling/i);
  });

  it("template rule: SkillNotFoundError → ordinary missing-template warning", async () => {
    const store = new ConfigurableStore({ metadataThrows: { tmpl: new SkillNotFoundError("tmpl", "ConfigurableStore") } });
    const r = await lint(TEMPLATE_REF_SRC, { skillStore: store });
    const f = r.findings.filter((x) => x.rule === "unknown-template-reference");
    expect(f).toHaveLength(1);
    expect(f[0]!.extras).toMatchObject({ referenced_skill: "tmpl" });
    expect(f[0]!.extras).not.toHaveProperty("store_unreachable");
  });
});

// ─── #4 mcp-server skill_status promote message (keep refusal, fix the string) ─
const homes: string[] = [];
function buildServer(store: SkillStore): McpServer {
  const home = mkdtempSync(join(tmpdir(), "store-flatten-"));
  homes.push(home);
  const scheduler = { syncDeclarativeTriggersForSkill: async () => {} } as never;
  return new McpServer({ skillStore: store, scheduler, traceStore: new FilesystemTraceStore(join(home, "t")) });
}
function rpc(name: string, args: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}
async function call(srv: McpServer, name: string, args: Record<string, unknown>) {
  const resp = await srv.handle(rpc(name, args));
  if ("error" in resp) return { ok: false as const, error: (resp as { error: { message: string } }).error.message };
  const r = resp as { result: { content: Array<{ text: string }> } };
  return { ok: true as const, data: JSON.parse(r.result.content[0]!.text) as Record<string, unknown> };
}
afterEach(() => {
  setSecuredMode(false);
  setApprovalPublicKey(null);
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("2d2a7fd4 #4 — skill_status promote REFUSES on a store failure but says WHY", () => {
  it("transport failure → refuses, and blames the store (not a missing signature)", async () => {
    setApprovalPublicKey(generateApprovalKeypair().publicKeyPem);
    setSecuredMode(true);
    const srv = buildServer(new ConfigurableStore({ loadThrows: { s: TRANSPORT() } }));
    const r = await call(srv, "skill_status", { name: "s", new_state: "Approved" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/unreachable|availability/i); // truthful cause
      expect(r.error).not.toMatch(/no valid signature/i);   // NOT the flattened lie
    }
  });

  it("not-found → refuses with a 'no skill stored' message (still refuses — polarity preserved)", async () => {
    setApprovalPublicKey(generateApprovalKeypair().publicKeyPem);
    setSecuredMode(true);
    const srv = buildServer(new ConfigurableStore({ loadThrows: { s: new SkillNotFoundError("s", "ConfigurableStore") } }));
    const r = await call(srv, "skill_status", { name: "s", new_state: "Approved" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no skill by that name|not stored/i);
  });

  it("reachable but unsigned → still the 'no valid signature' refusal (unchanged path)", async () => {
    setApprovalPublicKey(generateApprovalKeypair().publicKeyPem);
    setSecuredMode(true);
    const srv = buildServer(new ConfigurableStore({ bodies: { s: "# Skill: s\n# Status: Draft\nrun:\n    emit(text=\"x\")\ndefault: run\n" } }));
    const r = await call(srv, "skill_status", { name: "s", new_state: "Approved" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no valid signature/i);
  });
});
