/**
 * v0.9.0 — hash-token approval gate (universal execution gate).
 *
 * Per thread 29b6208e: every execution path (manual MCP, in-skill compose,
 * scheduler dispatch, compile-time data-skill inline) requires the skill
 * body to carry `# Status: Approved vN:<token>` where the token re-computes
 * from f(body − Status line). Mismatches block with a clear error.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonRpcRequest } from "../src/mcp-server.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import {
  verifyApprovalToken,
  evaluateApprovalGate,
  parseApprovalToken,
  extractStatusFromBody,
  generateApprovalKeypair,
  stampApprovalEd25519,
  setSecuredMode,
  setApprovalPublicKey,
} from "../src/approval.js";
import { Registry } from "../src/connectors/registry.js";
import { McpServer } from "../src/mcp-server.js";
import { parse } from "../src/parser.js";

const HELLO_DRAFT = `# Skill: hello
# Status: Draft
# Vars: WHO=world

greet:
    emit(text="Hello, $(WHO)!")

default: greet
`;

function rpc(method: string, params: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method, params } as JsonRpcRequest;
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await server.handle(rpc("tools/call", { name, arguments: args }));
  if ("error" in resp) throw new Error((resp as { error: { message: string } }).error.message);
  const r = resp as { result: { content: Array<{ text: string }> } };
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

describe("v0.9.0 — approval gate", () => {
  describe("token parsing + v3 verification", () => {
    it("parses well-formed token strings", () => {
      expect(parseApprovalToken("v3:abc12345")).toEqual({ version: "v3", token: "abc12345" });
      expect(parseApprovalToken("v42:my-token_value")).toEqual({ version: "v42", token: "my-token_value" });
      expect(parseApprovalToken("abc")).toBeNull();
      expect(parseApprovalToken("v3:")).toBeNull();
      expect(parseApprovalToken(":abc")).toBeNull();
    });

    it("verifyApprovalToken accepts a v3-signed body and rejects a tampered one", () => {
      const { publicKeyPem, privateKeyPem } = generateApprovalKeypair();
      setApprovalPublicKey(publicKeyPem);
      setSecuredMode(true);
      try {
        const body = stampApprovalEd25519("# Skill: x\n# Status: Approved\nm:\n    emit(text=\"hi\")\ndefault: m\n", privateKeyPem);
        const ext = extractStatusFromBody(body)!;
        expect(verifyApprovalToken(body, ext.approvalToken!).ok).toBe(true);
        const tampered = body.replace("hi", "BYE");
        const v = verifyApprovalToken(tampered, ext.approvalToken!);
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.reason).toMatch(/signature is invalid/);
      } finally {
        setSecuredMode(false);
        setApprovalPublicKey(null);
      }
    });

    it("rejects v0 (reserved) and any non-v3 version", () => {
      expect(verifyApprovalToken("body", "v0:abc").ok).toBe(false);
      expect(verifyApprovalToken("body", "v1:abc").ok).toBe(false); // v1 retired
    });
  });

  describe("gate evaluation", () => {
    it("rejects Draft", () => {
      const g = evaluateApprovalGate(HELLO_DRAFT);
      expect(g.ok).toBe(false);
      if (!g.ok) expect(g.reason).toMatch(/Draft/);
    });

    it("rejects Disabled", () => {
      const g = evaluateApprovalGate(HELLO_DRAFT.replace("Draft", "Disabled"));
      expect(g.ok).toBe(false);
      if (!g.ok) expect(g.reason).toMatch(/Disabled/);
    });

    it("rejects bodies with no # Status: header", () => {
      const g = evaluateApprovalGate("# Skill: x\nm:\n    emit(text=\"hi\")\ndefault: m\n");
      expect(g.ok).toBe(false);
      if (!g.ok) expect(g.reason).toMatch(/no `# Status:`/);
    });

    it("accepts naked Approved in unsecured mode (unkeyed — status header is sufficient)", () => {
      // v1.0 Gate #7 — unsecured approval is unkeyed: a bare `# Status: Approved`
      // runs (no token required; v1 retired). Secured-mode refusal of naked
      // Approved is covered in v1.0-approval-ed25519.test.ts.
      const g = evaluateApprovalGate(HELLO_DRAFT.replace("Draft", "Approved"));
      expect(g.ok).toBe(true);
    });
  });

  describe("parser — token extraction", () => {
    it("captures the approval token from # Status: Approved v1:<token>", () => {
      const body = "# Skill: x\n# Status: Approved v1:abc12345\nm:\n    emit(text=\"hi\")\ndefault: m\n";
      const parsed = parse(body);
      expect(parsed.status).toBe("Approved");
      expect(parsed.approvalToken).toBe("v1:abc12345");
    });

    it("rejects token on non-Approved status", () => {
      const body = "# Skill: x\n# Status: Draft v1:abc12345\nm:\n    emit(text=\"hi\")\ndefault: m\n";
      const parsed = parse(body);
      expect(parsed.parseErrors.some((e) => /only 'Approved' may carry/.test(e))).toBe(true);
    });
  });

  describe("SkillStore — update_status auto-stamps", () => {
    let dir: string;
    let store: FilesystemSkillStore;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "v0.9-approval-"));
      store = new FilesystemSkillStore(dir);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("update_status(_, 'Approved') yields a runnable bare Approved (unkeyed, no token)", async () => {
      // v1.0 Gate #7 — unsecured approval is unkeyed: the transition sets a bare
      // `# Status: Approved` and mints NO token (v1 retired). The gate accepts it.
      await store.store("hello", HELLO_DRAFT);
      await store.update_status("hello", "Approved");
      const loaded = await store.load("hello");
      const ext = extractStatusFromBody(loaded.source);
      expect(ext?.status).toBe("Approved");
      expect(ext?.approvalToken).toBeNull();
      expect(evaluateApprovalGate(loaded.source).ok).toBe(true);
    });

    it("update_status('Draft') strips the token (next stamp recomputes)", async () => {
      await store.store("hello", HELLO_DRAFT);
      await store.update_status("hello", "Approved");
      await store.update_status("hello", "Draft");
      const loaded = await store.load("hello");
      const ext = extractStatusFromBody(loaded.source);
      expect(ext?.status).toBe("Draft");
      expect(ext?.approvalToken).toBeNull();
    });
  });

  describe("runtime — universal gate", () => {
    let dir: string;
    let registry: Registry;
    let store: FilesystemSkillStore;
    let mcpServer: McpServer;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "v0.9-runtime-"));
      store = new FilesystemSkillStore(dir);
      registry = new Registry();
      registry.registerSkillStore("primary", store);
      mcpServer = new McpServer({ skillStore: store, registry });
    });
    afterEach(() => {
      setSecuredMode(false);
      setApprovalPublicKey(null);
      rmSync(dir, { recursive: true, force: true });
    });

    it("MCP execute_skill refuses Draft", async () => {
      // The test setup hook only auto-stamps Approved bodies; Draft bodies
      // land raw so the gate refusal path is exercised here.
      await store.store("draft-skill", HELLO_DRAFT);
      const r = await callTool(mcpServer, "execute_skill", { skill_name: "draft-skill" });
      expect((r["errors"] as Array<{ class: string }>).some((e) => e.class === "ApprovalRejectedError")).toBe(true);
    });

    it("MCP execute_skill refuses a tampered body (secured mode — keyed tamper-evidence)", async () => {
      // v1.0 Gate #7 — tamper-evidence is a SECURED-mode property (the v3
      // signature breaks when the body changes). Unsecured mode is unkeyed by
      // design, so we arm secured + a keypair, store a v3-signed victim, then
      // corrupt the body on disk → the signature no longer verifies → refused.
      const { publicKeyPem, privateKeyPem } = generateApprovalKeypair();
      setApprovalPublicKey(publicKeyPem);
      setSecuredMode(true);
      const signed = stampApprovalEd25519(HELLO_DRAFT.replace("Draft", "Approved"), privateKeyPem);
      await store.store("victim", signed, { status: "Approved" });
      const tampered = signed.replace("Hello,", "MALICIOUS,");
      const fs = await import("node:fs/promises");
      await fs.writeFile(join(dir, "victim.skill.md"), tampered, "utf8");
      const r = await callTool(mcpServer, "execute_skill", { skill_name: "victim" });
      expect((r["errors"] as Array<{ class: string }>).some((e) => e.class === "ApprovalRejectedError")).toBe(true);
    });

    it("MCP execute_skill accepts properly-stamped Approved", async () => {
      // Test hook stamps automatically on store
      await store.store("real", HELLO_DRAFT.replace("Draft", "Approved"));
      const r = await callTool(mcpServer, "execute_skill", { skill_name: "real" });
      expect((r["errors"] as Array<unknown>).length).toBe(0);
      expect((r["transcript"] as string[]).join("\n")).toMatch(/Hello, world!/);
    });
  });
});
