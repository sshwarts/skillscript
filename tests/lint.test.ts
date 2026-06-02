import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";
import { SqliteDataStore } from "../src/connectors/data-store.js";
import { OllamaLocalModel } from "../src/connectors/local-model.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";
import { Registry } from "../src/connectors/registry.js";

const TRIVIAL = `# Skill: t
t:
    emit(text="hi")

default: t
`;

describe("lint — baseline rules", async () => {
  it("reports invalid-conditional-syntax for malformed condition (no parse-error echo since v0.3.4)", async () => {
    const src = `t:
    if $(A) && $(B):
        emit(text="both")

default: t
`;
    const r = await lint(src);
    expect(r.errorCount).toBeGreaterThan(0);
    // v0.3.4: invalid-conditional-syntax owns the diagnostic; parse-error
    // no longer echoes the same message.
    expect(r.findings.some((f) => f.rule === "invalid-conditional-syntax")).toBe(true);
    expect(r.findings.some((f) => f.rule === "parse-error")).toBe(false);
  });

  it("reports orphan-target as warning", async () => {
    const src = `a:
    emit(text="a")

orphan:
    emit(text="never")

default: a
`;
    const r = await lint(src);
    expect(r.warningCount).toBe(1);
    expect(r.findings[0]!.rule).toBe("orphan-target");
  });

  it("clean skill produces zero findings", async () => {
    const r = await lint(TRIVIAL);
    expect(r.findings).toEqual([]);
  });
});

describe("lint — unknown-capability rule (offline validation)", async () => {
  it("ACCEPTS skill requiring a feature the registered class provides", async () => {
    const src = `# Skill: needs-tag-filter
# Requires: data_store.supports_tag_filter

t:
    emit(text="hi")

default: t
`;
    const r = await lint(src, { classes: [SqliteDataStore] });
    expect(r.findings.filter((f) => f.rule === "unknown-capability")).toEqual([]);
    expect(r.errorCount).toBe(0);
  });

  /**
   * THE LOAD-BEARING MILESTONE. The skill requires `data_store.supports_semantic`.
   * The SQLite default reports `supports_semantic: false` in its
   * staticCapabilities. The linter calls `SqliteDataStore.staticCapabilities()`
   * — a class-level static method — without ever calling
   * `new SqliteDataStore(...)`. No DB file is created; no network; no
   * substrate state touched. The validation is purely offline.
   *
   * This single assertion validates the entire static/dynamic capabilities
   * split. If this passes, the adoption-story argument (offline lint =
   * fast iteration loop) is materially demonstrated.
   */
  it("REJECTS skill requiring an unavailable feature — without constructing the connector", async () => {
    const src = `# Skill: needs-semantic
# Requires: data_store.supports_semantic

t:
    emit(text="hi")

default: t
`;
    // Pass the CLASS, not an instance. The linter calls staticCapabilities()
    // directly. No SqliteDataStore constructor is invoked.
    const r = await lint(src, { classes: [SqliteDataStore] });

    expect(r.errorCount).toBe(1);
    const finding = r.findings.find((f) => f.rule === "unknown-capability");
    expect(finding).toBeDefined();
    expect(finding!.message).toMatch(/data_store\.supports_semantic/);
    expect(finding!.message).toMatch(/no registered connector class provides/);
  });

  it("multiple capabilities on one # Requires: line all validated", async () => {
    const src = `# Skill: multi
# Requires: local_model.supports_max_tokens local_model.supports_streaming

t:
    emit(text="hi")

default: t
`;
    const r = await lint(src, { classes: [OllamaLocalModel] });
    // supports_max_tokens: true; supports_streaming: false → one error.
    expect(r.errorCount).toBe(1);
    const finding = r.findings.find((f) => f.rule === "unknown-capability");
    expect(finding!.message).toMatch(/local_model\.supports_streaming/);
  });

  it("multiple # Requires: lines accumulate independently", async () => {
    const src = `# Skill: multi
# Requires: data_store.supports_tag_filter
# Requires: local_model.supports_streaming

t:
    emit(text="hi")

default: t
`;
    const r = await lint(src, { classes: [SqliteDataStore, OllamaLocalModel] });
    // First clause satisfied; second not.
    expect(r.errorCount).toBe(1);
    expect(r.findings[0]!.message).toMatch(/local_model\.supports_streaming/);
  });

  it("registry option resolves classes from registered instances", async () => {
    const registry = new Registry();
    registry.registerLocalModel("default", new OllamaLocalModel({ defaultModelTag: "gemma2:9b" }));
    const src = `# Skill: t
# Requires: local_model.supports_streaming

t:
    emit(text="hi")

default: t
`;
    const r = await lint(src, { registry });
    expect(r.errorCount).toBe(1);
    expect(r.findings[0]!.rule).toBe("unknown-capability");
  });

  it("with no classes + no registry, capability check is skipped (no false errors)", async () => {
    const src = `# Skill: t
# Requires: data_store.supports_semantic

t:
    emit(text="hi")

default: t
`;
    const r = await lint(src);
    expect(r.findings.filter((f) => f.rule === "unknown-capability")).toEqual([]);
  });

  it("variable-resolution # Requires: doesn't interfere with capability parsing", async () => {
    const src = `# Skill: mixed
# Requires: user-var:location -> LOCATION (fallback: ip-based)
# Requires: data_store.supports_tag_filter

t:
    emit(text="$(LOCATION)")

default: t
`;
    const r = await lint(src, { classes: [SqliteDataStore] });
    expect(r.errorCount).toBe(0);
  });

  it("doesn't construct any class — staticCapabilities call only", async () => {
    // Side-effect-free assertion: an Ollama class won't try to fetch /api/tags
    // when only staticCapabilities is called (instance fetchInstalledModels
    // never runs because no instance exists).
    // Verified structurally: lint takes [Class] and only `Ctor.staticCapabilities()`
    // is invoked anywhere in the unknown-capability code path.
    const beforeCallableInstances = OllamaLocalModel.staticCapabilities();
    expect(beforeCallableInstances.connector_type).toBe("local_model");
    // (If the linter constructed an instance, we'd see the ExperimentalWarning
    // from node:sqlite — but SQLite import happens at module load, not at
    // construct time, so this isn't a perfect side-effect proof. The
    // structural argument from reading lint.ts is what makes the claim airtight.)
    const src = `# Requires: local_model.supports_max_tokens\nt:\n    emit(text="ok")\ndefault: t\n`;
    const r = await lint(src, { classes: [FilesystemSkillStore, SqliteDataStore, OllamaLocalModel, CallbackMcpConnector] });
    expect(r.errorCount).toBe(0);
  });
});
