import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConnectorsConfig } from "../src/connectors/config.js";

/**
 * v0.19.9 — connectors.json gotchas (adopter `14609652` findings).
 *
 * Finding 1 (SECURITY): `allowed_tools` placed inside `config:` was
 * silently dropped → allow-all → security control quietly nonexistent.
 * Now: hard parse error, refuses to load.
 *
 * Finding 2: scaffold's mcp-remote example omitted `framing` → adopters
 * inherited the legacy 'lsp' default → silent init-timeout hang. Now:
 * scaffold sets `framing: "newline"` explicitly + the init-timeout error
 * names framing as a likely cause.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function tmpCfg(content: object): string {
  const dir = mkdtempSync(join(tmpdir(), "v0199-"));
  const path = join(dir, "connectors.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe("v0.19.9 — Finding 1: misplaced allowed_tools (security)", () => {
  it("allowed_tools inside config: refused with explicit remediation", () => {
    const cfg = tmpCfg({
      youtrack: {
        class: "RemoteMcpConnector",
        config: {
          command: "node",
          args: ["-e", "process.exit(0)"],
          allowed_tools: ["list_issues"], // INTENTIONALLY misplaced
        },
      },
    });
    const result = loadConnectorsConfig({ path: cfg });
    expect(result.connectors).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/'allowed_tools' inside the 'config:' block/);
    expect(result.errors[0]).toMatch(/silently ignored/);
    expect(result.errors[0]).toMatch(/silent allow-all bypass/);
    // Remediation shows the correct shape inline
    expect(result.errors[0]).toMatch(/sibling to 'class' and 'config'/);
  });

  it("allowed_tools at entry top-level (correct placement) still works", () => {
    const cfg = tmpCfg({
      youtrack: {
        class: "RemoteMcpConnector",
        config: {
          command: "node",
          args: ["-e", "process.exit(0)"],
        },
        allowed_tools: ["list_issues", "get_issue"],
      },
    });
    const result = loadConnectorsConfig({ path: cfg });
    expect(result.errors).toEqual([]);
    expect(result.connectors[0]!.allowedTools).toEqual(["list_issues", "get_issue"]);
  });

  it("refusal does NOT leak the connector with allowedTools=undefined", () => {
    // The silent-allow-all bug pre-fix: connector loaded with allowedTools
    // undefined (allow-all semantics). Post-fix: connector doesn't load at all.
    const cfg = tmpCfg({
      youtrack: {
        class: "RemoteMcpConnector",
        config: {
          command: "node",
          args: ["-e", "process.exit(0)"],
          allowed_tools: ["restricted-set"],
        },
      },
    });
    const result = loadConnectorsConfig({ path: cfg });
    expect(result.connectors).toEqual([]);
  });
});

describe("v0.19.9 — Finding 2: scaffold sets framing explicitly", () => {
  it("bundled scaffold connectors.json sets framing: newline on mcp-remote example", () => {
    const scaffold = readFileSync(join(REPO_ROOT, "scaffold", "connectors.json"), "utf-8");
    const parsed = JSON.parse(scaffold);
    const example = parsed._example_disabled_remote_mcp;
    expect(example.config.framing).toBe("newline");
  });

  it("bundled scaffold uses correct allowed_tools placement (entry top-level)", () => {
    const scaffold = readFileSync(join(REPO_ROOT, "scaffold", "connectors.json"), "utf-8");
    const parsed = JSON.parse(scaffold);
    const example = parsed._example_disabled_remote_mcp;
    // Demonstrates correct placement
    expect(example.allowed_tools).toBeDefined();
    expect(Array.isArray(example.allowed_tools)).toBe(true);
    // NOT inside config block
    expect(example.config.allowed_tools).toBeUndefined();
  });
});
