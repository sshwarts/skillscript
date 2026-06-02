import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

// Sub-charter 3c: broadened credential-in-args lint (closes audit finding #4).
// The pre-v0.16 rule only matched narrow KEY=VALUE shape (`apikey=`, `token=`,
// etc.) on `$` ops. The broadened rule catches:
//   - More key names (client_secret, refresh_token, private_key, etc.)
//   - `:`-separated keys (HTTP-header shape: `Authorization: Bearer ...`)
//   - Value-shape patterns (Bearer tokens, sk-/ghp_ prefixes, JWT triples)
//   - All op kinds (not just `$` — covers shell/emit/$set value/etc.)
//   - `# Vars:` default values (where adopters paste secrets by mistake)

describe("credential-in-args (broadened, audit finding #4)", () => {
  describe("key-shape patterns", () => {
    it("fires on `apikey=` (existing coverage preserved)", async () => {
      const src = `# Skill: t\nt:\n    $ tool apikey=sk-abc -> R\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeDefined();
    });

    it("fires on `client_secret=`", async () => {
      const src = `# Skill: t\nt:\n    $ tool client_secret=xyz -> R\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeDefined();
    });

    it("fires on `refresh_token=`", async () => {
      const src = `# Skill: t\nt:\n    $ tool refresh_token=abc123 -> R\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeDefined();
    });

    it("fires on `Authorization: Bearer ...` (Bearer-value shape, 20+ char token)", async () => {
      const src = `# Skill: t\nt:\n    shell(command="curl -H 'Authorization: Bearer abcdef0123456789abcdef0123456789' https://api.example.com")\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeDefined();
    });

    it("fires on `signing_key:`", async () => {
      const src = `# Skill: t\nt:\n    $ tool config="signing_key: 0x12345abcdef" -> R\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeDefined();
    });
  });

  describe("value-shape patterns", () => {
    it("fires on raw Bearer token in shell command", async () => {
      const src = `# Skill: t\nt:\n    shell(command="echo Bearer abcdef1234567890abcdef1234567890")\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeDefined();
    });

    it("fires on sk- prefix (OpenAI-key shape)", async () => {
      const src = `# Skill: t\nt:\n    $ tool config=sk-abcdef1234567890abcdef -> R\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeDefined();
    });

    it("fires on ghp_ prefix (GitHub-token shape)", async () => {
      const src = `# Skill: t\nt:\n    $ tool token_value=ghp_abc123def456ghi789jkl012 -> R\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeDefined();
    });

    it("fires on JWT triple shape (eyJ.X.Y)", async () => {
      const src = `# Skill: t\nt:\n    $ tool jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF -> R\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeDefined();
    });
  });

  describe("expanded op-kind coverage", () => {
    it("fires on credential in `$set` value", async () => {
      const src = `# Skill: t\nt:\n    $set API_KEY = "sk-abcdef1234567890abcdef"\n    emit(text="\${API_KEY}")\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeDefined();
    });

    it("fires on credential in `shell(command=...)` body", async () => {
      const src = `# Skill: t\nt:\n    shell(command="curl -H 'apikey=sk-abc123def456ghi789jkl0' https://api.x")\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeDefined();
    });

    it("fires on credential in `# Vars:` default", async () => {
      const src = `# Skill: t\n# Vars: API_TOKEN=sk-realkey12345678901234567890abc\nt:\n    emit(text="\${API_TOKEN}")\ndefault: t\n`;
      const r = await lint(src);
      const f = r.findings.find((f) => f.rule === "credential-in-args");
      expect(f).toBeDefined();
      expect(f!.message).toMatch(/# Vars: API_TOKEN/);
    });
  });

  describe("false-positive guards", () => {
    it("does NOT fire on benign args (name, limit, mode)", async () => {
      const src = `# Skill: t\nt:\n    $ tool name=foo limit=10 mode=fts -> R\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeUndefined();
    });

    it("does NOT fire on user-var cascade (the correct credential-sourcing pattern)", async () => {
      const src = `# Skill: t\n# Requires: user-var:API_TOKEN -> TOKEN\nt:\n    $ tool config=\${TOKEN} -> R\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeUndefined();
    });

    it("does NOT fire on short tokens (likely placeholders, not real secrets)", async () => {
      const src = `# Skill: t\nt:\n    $ tool config=sk-short -> R\ndefault: t\n`;
      const r = await lint(src);
      expect(r.findings.find((f) => f.rule === "credential-in-args")).toBeUndefined();
    });
  });

  describe("severity demoted to tier-2 (warning) — broader → more false positives", () => {
    it("fires as warning, not error", async () => {
      const src = `# Skill: t\nt:\n    $ tool apikey=sk-abcdef1234567890abc -> R\ndefault: t\n`;
      const r = await lint(src);
      const f = r.findings.find((ff) => ff.rule === "credential-in-args");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("warning");
    });
  });
});
