import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Examples-corpus guard — every shipped example actually works.
 *
 * dogfood-t7 owns existence + lint + ships-as-Draft for the bundled skills.
 * This file owns the stronger bars that were previously untested:
 *
 *   1. every .skill.md COMPILES (with its declared inputs supplied),
 *   2. the infra-free skills EXECUTE end-to-end against the bundled bootstrap,
 *   3. the programmatic trace demo RUNS,
 *   4. every example .ts TYPECHECKS against the current connector contracts.
 *
 * (4) is the fork-template-drift guard: the connector contracts in
 * src/connectors grow, and nothing else compiles the copy-me templates or
 * the onboarding scaffold — pre-announcement review found FOUR example files
 * silently broken this way (DataStore.get missing, stale feature-flag keys,
 * WakeReceipt.woken missing). A drifted fork-me template is the worst
 * first-copy experience an adopter can have.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = `node ${join(REPO_ROOT, "dist/cli.js")}`;
const SKILLS_DIR = join(REPO_ROOT, "examples", "skillscripts");

/**
 * Standard input bag — union of every required var the corpus declares.
 * Skills ignore inputs they don't declare, so passing the union to each
 * compile keeps this table from needing per-skill wiring.
 */
const INPUTS = [
  ["TICKET_TEXT", "app crashes on login"],
  ["TICKET_ID", "T-1"],
  ["QUESTION", "how do triggers work"],
  ["AGENT", "perry"],
].map(([k, v]) => `--input ${k}=${JSON.stringify(v)}`).join(" ");

/**
 * Skills that run end-to-end against the bundled bootstrap in a bare
 * SKILLSCRIPT_HOME (no connectors.json, no local model, no shell allowlist).
 * The rest of the corpus intentionally depends on adopter wiring
 * ($ llm needs a LocalModel; $ youtrack / $ calendar are adopter
 * connectors) — for those, compile-clean is the correct bar.
 */
const INFRA_FREE = [
  "hello-world.skill.md",
  "data-store-roundtrip.skill.md",
  "skill-store-roundtrip.skill.md",
  "queue-length-monitor.skill.md",
];

const skillFiles = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".skill.md"));

describe("examples corpus — compile", () => {
  it("every bundled .skill.md compiles (with declared inputs)", () => {
    expect(skillFiles.length).toBeGreaterThanOrEqual(6);
    for (const f of skillFiles) {
      execSync(`${CLI} compile ${join(SKILLS_DIR, f)} ${INPUTS}`, { encoding: "utf8", stdio: "pipe" });
    }
  });
});

describe("examples corpus — execute (infra-free subset)", () => {
  it("infra-free skills execute end-to-end against the bundled bootstrap", () => {
    const home = mkdtempSync(join(tmpdir(), "ex-corpus-"));
    try {
      for (const f of INFRA_FREE) {
        execSync(`${CLI} execute ${join(SKILLS_DIR, f)} ${INPUTS}`, {
          encoding: "utf8",
          stdio: "pipe",
          env: { ...process.env, SKILLSCRIPT_HOME: home },
        });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("programmatic-trace-demo.mjs runs to completion", () => {
    const home = mkdtempSync(join(tmpdir(), "ex-demo-"));
    try {
      const out = execSync(`node ${join(REPO_ROOT, "examples", "programmatic-trace-demo.mjs")}`, {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, SKILLSCRIPT_HOME: home },
      });
      expect(out).toMatch(/successRate/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("examples corpus — TypeScript contract conformance", () => {
  it("every example .ts typechecks against the current connector contracts", () => {
    const files = [
      "examples/connectors/DataStoreTemplate/DataStoreTemplate.ts",
      "examples/connectors/LocalModelTemplate/LocalModelTemplate.ts",
      "examples/connectors/McpConnectorTemplate/McpConnectorTemplate.ts",
      "examples/connectors/SkillStoreTemplate/SkillStoreTemplate.ts",
      "examples/connectors/HttpWebhookAgentConnector/HttpWebhookAgentConnector.ts",
      "examples/onboarding-scaffold/bootstrap.ts",
      "examples/onboarding-scaffold/file-data-store.ts",
      "examples/onboarding-scaffold/openai-local-model.ts",
      "examples/onboarding-scaffold/tmux-shell-agent-connector.ts",
      "examples/custom-bootstrap.example.ts",
    ].map((f) => join(REPO_ROOT, f));
    // Same strictness the templates advertise; skipLibCheck keeps this to
    // the example files + the contracts they import.
    execSync(
      `npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck ${files.join(" ")}`,
      { encoding: "utf8", stdio: "pipe", cwd: REPO_ROOT },
    );
  }, 90_000);
});
