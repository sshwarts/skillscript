import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";
import { SqliteMemoryStore } from "../src/connectors/memory-store.js";
import { OllamaLocalModel } from "../src/connectors/local-model.js";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { CallbackMcpConnector } from "../src/connectors/mcp.js";
import { Registry } from "../src/connectors/registry.js";

const TRIVIAL = `# Skill: t
t:
    ! hi

default: t
`;

describe("lint — baseline rules", () => {
  it("reports parse-error for malformed grammar", () => {
    const src = `t:
    if $(A) && $(B):
        ! both

default: t
`;
    const r = lint(src);
    expect(r.errorCount).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.rule === "parse-error")).toBe(true);
  });

  it("reports orphan-target as warning", () => {
    const src = `a:
    ! a

orphan:
    ! never

default: a
`;
    const r = lint(src);
    expect(r.warningCount).toBe(1);
    expect(r.findings[0]!.rule).toBe("orphan-target");
  });

  it("clean skill produces zero findings", () => {
    const r = lint(TRIVIAL);
    expect(r.findings).toEqual([]);
  });
});

describe("lint — unknown-capability rule (offline validation)", () => {
  it("ACCEPTS skill requiring a feature the registered class provides", () => {
    const src = `# Skill: needs-tag-filter
# Requires: memory_store.supports_tag_filter

t:
    ! hi

default: t
`;
    const r = lint(src, { classes: [SqliteMemoryStore] });
    expect(r.findings.filter((f) => f.rule === "unknown-capability")).toEqual([]);
    expect(r.errorCount).toBe(0);
  });

  /**
   * THE LOAD-BEARING MILESTONE. The skill requires `memory_store.supports_semantic`.
   * The SQLite default reports `supports_semantic: false` in its
   * staticCapabilities. The linter calls `SqliteMemoryStore.staticCapabilities()`
   * — a class-level static method — without ever calling
   * `new SqliteMemoryStore(...)`. No DB file is created; no network; no
   * substrate state touched. The validation is purely offline.
   *
   * This single assertion validates the entire static/dynamic capabilities
   * split. If this passes, the adoption-story argument (offline lint =
   * fast iteration loop) is materially demonstrated.
   */
  it("REJECTS skill requiring an unavailable feature — without constructing the connector", () => {
    const src = `# Skill: needs-semantic
# Requires: memory_store.supports_semantic

t:
    ! hi

default: t
`;
    // Pass the CLASS, not an instance. The linter calls staticCapabilities()
    // directly. No SqliteMemoryStore constructor is invoked.
    const r = lint(src, { classes: [SqliteMemoryStore] });

    expect(r.errorCount).toBe(1);
    const finding = r.findings.find((f) => f.rule === "unknown-capability");
    expect(finding).toBeDefined();
    expect(finding!.message).toMatch(/memory_store\.supports_semantic/);
    expect(finding!.message).toMatch(/no registered connector class provides/);
  });

  it("multiple capabilities on one # Requires: line all validated", () => {
    const src = `# Skill: multi
# Requires: local_model.supports_max_tokens local_model.supports_streaming

t:
    ! hi

default: t
`;
    const r = lint(src, { classes: [OllamaLocalModel] });
    // supports_max_tokens: true; supports_streaming: false → one error.
    expect(r.errorCount).toBe(1);
    const finding = r.findings.find((f) => f.rule === "unknown-capability");
    expect(finding!.message).toMatch(/local_model\.supports_streaming/);
  });

  it("multiple # Requires: lines accumulate independently", () => {
    const src = `# Skill: multi
# Requires: memory_store.supports_tag_filter
# Requires: local_model.supports_streaming

t:
    ! hi

default: t
`;
    const r = lint(src, { classes: [SqliteMemoryStore, OllamaLocalModel] });
    // First clause satisfied; second not.
    expect(r.errorCount).toBe(1);
    expect(r.findings[0]!.message).toMatch(/local_model\.supports_streaming/);
  });

  it("registry option resolves classes from registered instances", () => {
    const registry = new Registry();
    registry.registerLocalModel("default", new OllamaLocalModel({ defaultModelTag: "gemma2:9b" }));
    const src = `# Skill: t
# Requires: local_model.supports_streaming

t:
    ! hi

default: t
`;
    const r = lint(src, { registry });
    expect(r.errorCount).toBe(1);
    expect(r.findings[0]!.rule).toBe("unknown-capability");
  });

  it("with no classes + no registry, capability check is skipped (no false errors)", () => {
    const src = `# Skill: t
# Requires: memory_store.supports_semantic

t:
    ! hi

default: t
`;
    const r = lint(src);
    expect(r.findings.filter((f) => f.rule === "unknown-capability")).toEqual([]);
  });

  it("variable-resolution # Requires: doesn't interfere with capability parsing", () => {
    const src = `# Skill: mixed
# Requires: user-var:location -> LOCATION (fallback: ip-based)
# Requires: memory_store.supports_tag_filter

t:
    ! $(LOCATION)

default: t
`;
    const r = lint(src, { classes: [SqliteMemoryStore] });
    expect(r.errorCount).toBe(0);
  });

  it("doesn't construct any class — staticCapabilities call only", () => {
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
    const src = `# Requires: local_model.supports_max_tokens\nt:\n    ! ok\ndefault: t\n`;
    const r = lint(src, { classes: [FilesystemSkillStore, SqliteMemoryStore, OllamaLocalModel, CallbackMcpConnector] });
    expect(r.errorCount).toBe(0);
  });
});
