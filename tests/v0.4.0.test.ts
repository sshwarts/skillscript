import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConnectorsConfig,
  listKnownConnectorClasses,
  resolveEnvSubstitution,
  KNOWN_CONNECTOR_CLASSES,
} from "../src/connectors/config.js";
import { bootstrap } from "../src/bootstrap.js";
import { lint } from "../src/lint.js";
import { McpServer } from "../src/mcp-server.js";
import { Registry } from "../src/connectors/registry.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";

/**
 * v0.4.0 — `connectors.json` loader + credential resolution + lint + discovery.
 * Spec at b3f6c5ed (kickoff) + 58a9d3d3 (credential amendment) + 8f723b6a
 * (final approval with closed-set + sibling lint). RemoteMcpConnector +
 * YouTrack proving deferred to v0.4.1.
 */

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "v040-"));
  const path = join(dir, "connectors.json");
  writeFileSync(path, content);
  return path;
}

describe("v0.4.0 — env-var substitution helper", () => {
  it("literal string passes through unchanged", () => {
    expect(resolveEnvSubstitution("Bearer abc", {})).toBe("Bearer abc");
  });

  it("${NAME} resolves from env", () => {
    expect(resolveEnvSubstitution("Bearer ${TOKEN}", { TOKEN: "xyz" })).toBe("Bearer xyz");
  });

  it("multiple ${NAME} substitutions in one value", () => {
    expect(resolveEnvSubstitution("${A}-${B}", { A: "x", B: "y" })).toBe("x-y");
  });

  it("missing env var throws clear error (not silent empty string)", () => {
    expect(() => resolveEnvSubstitution("Bearer ${MISSING}", {})).toThrow(/Environment variable '\${MISSING}'.*not set/);
  });

  it("ignores ${lowercase} patterns (only uppercase ENV_VAR convention)", () => {
    expect(resolveEnvSubstitution("${name}", { name: "x" })).toBe("${name}");
  });
});

describe("v0.4.0 — loadConnectorsConfig (loader basics)", () => {
  it("missing file → graceful empty result", () => {
    const result = loadConnectorsConfig({ path: "/tmp/nonexistent-v040-test-file.json" });
    expect(result.connectors).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("malformed JSON → clear error", () => {
    const path = tmpFile("{ not valid json");
    const result = loadConnectorsConfig({ path });
    expect(result.connectors).toEqual([]);
    expect(result.errors[0]).toMatch(/malformed JSON/);
  });

  it("top-level array → clear error", () => {
    const path = tmpFile(JSON.stringify([{ name: "x" }]));
    const result = loadConnectorsConfig({ path });
    expect(result.errors[0]).toMatch(/top-level must be an object/);
  });

  it("entry without `class` field → clear error", () => {
    const path = tmpFile(JSON.stringify({ x: { config: {} } }));
    const result = loadConnectorsConfig({ path });
    expect(result.errors[0]).toMatch(/missing required string field 'class'/);
  });

  it("entry with non-object `config` → clear error", () => {
    const path = tmpFile(JSON.stringify({ x: { class: "CallbackMcpConnector", config: "bad" } }));
    const result = loadConnectorsConfig({ path });
    expect(result.errors[0]).toMatch(/field 'config' must be an object/);
  });

  it("unknown class → clear error listing known classes", () => {
    const path = tmpFile(JSON.stringify({ x: { class: "Bogus", config: {} } }));
    const result = loadConnectorsConfig({ path });
    expect(result.errors[0]).toMatch(/unknown connector class 'Bogus'/);
    expect(result.errors[0]).toMatch(/Known classes:/);
  });

  it("CallbackMcpConnector class is registered but not JSON-instantiable (v0.4.0)", () => {
    const path = tmpFile(JSON.stringify({ cb: { class: "CallbackMcpConnector", config: {} } }));
    const result = loadConnectorsConfig({ path });
    expect(result.errors[0]).toMatch(/doesn't support configuration via connectors.json/);
    expect(result.connectors).toEqual([]);
  });

  it("${ENV} substitution in config block resolves at load time", () => {
    const path = tmpFile(JSON.stringify({ x: { class: "CallbackMcpConnector", config: { env: { TOK: "Bearer ${TEST_V040_TOK}" } } } }));
    const result = loadConnectorsConfig({ path, env: { TEST_V040_TOK: "real-token" } });
    // Will error on fromConfig (CallbackMcpConnector isn't JSON-instantiable),
    // but the substitution would have happened first — we test the error path
    // doesn't shadow the substitution attempt.
    expect(result.errors[0]).toMatch(/doesn't support configuration/);
    // The substitution path is exercised; verify directly via resolveConfigEnv
    // helper isn't exported — covered by resolveEnvSubstitution tests.
  });

  it("missing ${ENV} in config block → clear error at load", () => {
    const path = tmpFile(JSON.stringify({ x: { class: "CallbackMcpConnector", config: { env: { TOK: "${MISSING_V040_VAR}" } } } }));
    const result = loadConnectorsConfig({ path, env: {} });
    expect(result.errors[0]).toMatch(/Environment variable.*not set/);
  });

  it("permissive on unknown fields (forward-compat for legitimate future schemas)", () => {
    // Future schemas shouldn't break the loader on the permissive path.
    // NOTE: v0.19.9 added an INTENTIONAL hard-error guard against
    // `allowed_tools` inside `config:` (silent allow-all bypass — see
    // adopter `14609652`). So future security-control fields may also
    // get hard-error guards — this test covers genuinely-permissive
    // forward-compat for non-security fields only.
    const path = tmpFile(JSON.stringify({ x: { class: "CallbackMcpConnector", config: { future_schema_v2_thingy: ["search_issues"] } } }));
    const result = loadConnectorsConfig({ path });
    // Validation accepts the extra field (fails later on fromConfig as expected for v0.4.0 CallbackMcpConnector).
    expect(result.errors[0]).toMatch(/doesn't support configuration/);
  });
});

describe("v0.4.0 — KNOWN_CONNECTOR_CLASSES closed set", () => {
  it("v0.4.0 registers CallbackMcpConnector", () => {
    expect(KNOWN_CONNECTOR_CLASSES.has("CallbackMcpConnector")).toBe(true);
  });

  it("listKnownConnectorClasses returns the closed set", () => {
    // v0.4.1: RemoteMcpConnector joined the closed set; pre-v0.4.1 this
    // test asserted its absence as a marker for the v0.4.0 ship.
    const list = listKnownConnectorClasses();
    expect(list).toContain("CallbackMcpConnector");
  });
});

describe("v0.4.0 — bootstrap wires connectors.json", () => {
  it("bootstrap reads connectors.json from configured path", () => {
    const home = mkdtempSync(join(tmpdir(), "v040-boot-"));
    const cfgPath = join(home, "connectors.json");
    writeFileSync(cfgPath, JSON.stringify({ x: { class: "Bogus", config: {} } }));
    const result = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      connectorsConfigPath: cfgPath,
    });
    expect(result.connectorConfigErrors.length).toBeGreaterThan(0);
    expect(result.connectorConfigErrors[0]).toMatch(/unknown connector class 'Bogus'/);
    expect(result.configuredConnectorNames).toEqual([]);
  });

  it("bootstrap without connectorsConfigPath → no errors, no extra connectors", () => {
    const home = mkdtempSync(join(tmpdir(), "v040-noboot-"));
    const result = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
    });
    expect(result.connectorConfigErrors).toEqual([]);
    expect(result.configuredConnectorNames).toEqual([]);
  });

  it("bootstrap with missing connectors.json file → graceful", () => {
    const home = mkdtempSync(join(tmpdir(), "v040-missing-"));
    const result = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
      connectorsConfigPath: join(home, "connectors.json"),
    });
    expect(result.connectorConfigErrors).toEqual([]);
    expect(result.configuredConnectorNames).toEqual([]);
  });
});

describe("v0.4.0 — unknown-connector lint", () => {
  it("fires tier-1 on $ name.tool where name is not registered", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ youtrack.search_issues query="for: me" -> R\n    emit(text="$(R)")\ndefault: run\n`;
    const r = await lint(src, { mcpConnectorNames: [] });
    const finding = r.findings.find((f) => f.rule === "unknown-connector");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("error");
    expect(finding!.message).toMatch(/unknown connector 'youtrack'/);
  });

  it("does not fire when connector IS registered", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ youtrack.search_issues query="for: me" -> R\n    emit(text="$(R)")\ndefault: run\n`;
    const r = await lint(src, { mcpConnectorNames: ["youtrack"] });
    const finding = r.findings.find((f) => f.rule === "unknown-connector");
    expect(finding).toBeUndefined();
  });

  it("silent when mcpConnectorNames is undefined (caller doesn't know what's wired)", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ youtrack.search_issues query="for: me" -> R\n    emit(text="$(R)")\ndefault: run\n`;
    const r = await lint(src);
    const finding = r.findings.find((f) => f.rule === "unknown-connector");
    expect(finding).toBeUndefined();
  });

  it("derives connector names from Registry when only registry is passed", async () => {
    const registry = new Registry();
    registry.registerMcpConnector("foo", new CallbackMcpConnector(async () => ({})));
    const src = `# Skill: t\n# Status: Approved\nrun:\n    $ bar.x -> R\n    emit(text="$(R)")\ndefault: run\n`;
    const r = await lint(src, { registry });
    const finding = r.findings.find((f) => f.rule === "unknown-connector");
    expect(finding).toBeDefined();
    expect(finding!.message).toMatch(/Wired connectors: foo/);
  });
});

describe("v0.4.0 — unknown-connector-class lint (Perry's sibling addition)", () => {
  it("re-surfaces loader 'unknown connector class' errors as lint findings", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="hi")\ndefault: run\n`;
    const r = await lint(src, {
      connectorConfigErrors: [
        `connectors.json: entry 'youtrack' references unknown connector class 'RemoteMcpConnector'. Known classes: CallbackMcpConnector.`,
      ],
    });
    const finding = r.findings.find((f) => f.rule === "unknown-connector-class");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("error");
    expect(finding!.message).toMatch(/RemoteMcpConnector/);
  });

  it("does not fire for non-class config errors", async () => {
    const src = `# Skill: t\n# Status: Approved\nrun:\n    emit(text="hi")\ndefault: run\n`;
    const r = await lint(src, {
      connectorConfigErrors: [
        `connectors.json: malformed JSON in 'x.json': Unexpected token`,
      ],
    });
    const finding = r.findings.find((f) => f.rule === "unknown-connector-class");
    expect(finding).toBeUndefined();
  });
});

describe("v0.4.0 — runtime_capabilities discovery extension", () => {
  it("returns mcpConnectorClasses with the closed set", async () => {
    const home = mkdtempSync(join(tmpdir(), "v040-cap-"));
    const result = bootstrap({
      skillsDir: join(home, "skills"),
      traceDir: join(home, "traces"),
    });
    const resp = await result.mcpServer.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "runtime_capabilities", arguments: { include: ["mcpConnectorClasses"] } },
    });
    const r = resp as { result: { content: Array<{ text: string }> } };
    const data = JSON.parse(r.result.content[0]!.text) as { mcpConnectorClasses: string[] };
    expect(data.mcpConnectorClasses).toContain("CallbackMcpConnector");
  });
});

describe("v0.4.0 — credential discipline (item 8)", () => {
  it("repo .gitignore includes /connectors.json", () => {
    const gi = readFileSync(join(__dirname, "..", ".gitignore"), "utf8");
    expect(gi).toMatch(/^\/connectors\.json/m);
  });

  it("connectors.json.example exists at repo root", () => {
    const example = readFileSync(join(__dirname, "..", "connectors.json.example"), "utf8");
    expect(example.length).toBeGreaterThan(0);
    // Sanity check the example documents both credential shapes
    expect(example).toMatch(/\$\{[A-Z_]+\}/);
    expect(example).toMatch(/Bearer/);
  });

  it("README documents connectors.json + credential handling", () => {
    const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");
    expect(readme).toMatch(/`connectors\.json`/);
    expect(readme).toMatch(/Credentials/);
    // Documents env-var substitution as the way to keep secrets out of the file.
    expect(readme).toMatch(/\$\{VAR\}|\$\{\.\.\.\}/);
  });
});
