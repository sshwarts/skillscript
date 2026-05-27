// ContractConformance test suites. Verifies that any connector implementation
// actually honors its contract. Framework-agnostic: each suite returns an
// array of `ConformanceTest { name, run() }` objects that callers wire into
// their test framework. Example in vitest:
//
//   import { describe, it } from "vitest";
//   import { SkillStoreConformance } from "skillscript-runtime/testing";
//
//   describe("FilesystemSkillStore conformance", () => {
//     const tests = SkillStoreConformance.buildTests({
//       build: () => new FilesystemSkillStore(mkdtempSync(...)),
//       ctor: FilesystemSkillStore,
//     });
//     for (const t of tests) it(`[${t.category}] ${t.name}`, t.run);
//   });
//
// Test categories per the v1 spec:
//   1. method-existence    — every declared method present + callable
//   2. return-type         — methods return values matching the contract shape
//   3. error-contract      — methods throw the documented error class on the
//                            documented trigger condition
//   4. static-capabilities — `staticCapabilities()` returns a well-formed
//                            `StaticCapabilities` object
//   5. feature-behavior    — for every feature flag the impl declares true,
//                            the corresponding behavior actually works
//
// What conformance does NOT cover: performance (separate `benchmarks` suite),
// cross-impl interop (v2 work).

import type {
  SkillStore,
  SkillStoreClass,
  SkillMeta,
  MemoryStore,
  MemoryStoreClass,
  PortableMemory,
  LocalModel,
  LocalModelClass,
  McpConnector,
  McpConnectorClass,
  StaticCapabilities,
  ConnectorType,
} from "../connectors/types.js";
import type { AgentConnector, AgentConnectorClass } from "../connectors/agent.js";
import { SkillNotFoundError, ConnectorError } from "../errors.js";

export interface ConformanceTest {
  category: ConformanceCategory;
  name: string;
  run(): Promise<void>;
}

export type ConformanceCategory =
  | "method-existence"
  | "return-type"
  | "error-contract"
  | "static-capabilities"
  | "feature-behavior";

// ─── SkillStore ───────────────────────────────────────────────────────────

export interface SkillStoreFixture {
  build(): SkillStore;
  ctor: SkillStoreClass;
  teardown?(instance: SkillStore): Promise<void>;
}

export const SkillStoreConformance = {
  buildTests(fixture: SkillStoreFixture): ConformanceTest[] {
    return [
      ...staticCapabilitiesTests(fixture.ctor, "skill_store"),
      methodExistence("SkillStore.load present", fixture, "load"),
      methodExistence("SkillStore.query present", fixture, "query"),
      methodExistence("SkillStore.metadata present", fixture, "metadata"),
      methodExistence("SkillStore.versions present", fixture, "versions"),
      methodExistence("SkillStore.store present", fixture, "store"),
      methodExistence("SkillStore.delete present", fixture, "delete"),
      methodExistence("SkillStore.update_status present", fixture, "update_status"),
      methodExistence("SkillStore.manifest present", fixture, "manifest"),
      {
        category: "return-type",
        name: "query returns empty array on empty store",
        run: withInstance(fixture, async (store) => {
          const r = await store.query();
          assert(Array.isArray(r), `query must return an array (got ${typeof r})`);
          assert(r.length === 0, `empty store must return [], got ${r.length} entries`);
        }),
      },
      {
        category: "return-type",
        name: "store returns VersionInfo with required fields",
        run: withInstance(fixture, async (store) => {
          const info = await store.store("conformance-test", SAMPLE_SKILL);
          assert(typeof info.name === "string", "VersionInfo.name must be string");
          assert(typeof info.version === "string", "VersionInfo.version must be string");
          assert(/^[a-f0-9]+$/.test(info.content_hash), "VersionInfo.content_hash must be hex");
          assert(typeof info.changed_at === "number", "VersionInfo.changed_at must be number");
        }),
      },
      {
        category: "return-type",
        name: "load returns SkillSource with non-empty content_hash and source",
        run: withInstance(fixture, async (store) => {
          await store.store("conformance-test", SAMPLE_SKILL);
          const src = await store.load("conformance-test");
          assert(src.source === SAMPLE_SKILL, "load.source must round-trip the stored bytes");
          assert(src.content_hash.length > 0, "load.content_hash must be populated");
          assert(typeof src.metadata.status === "string", "load.metadata.status must be populated");
        }),
      },
      {
        category: "error-contract",
        name: "load throws SkillNotFoundError on missing skill",
        run: withInstance(fixture, async (store) => {
          await expectThrows(
            () => store.load("definitely-missing-skill-xyz"),
            (err) => err instanceof SkillNotFoundError,
            "expected SkillNotFoundError",
          );
        }),
      },
      {
        category: "error-contract",
        name: "delete throws SkillNotFoundError on missing skill",
        run: withInstance(fixture, async (store) => {
          await expectThrows(
            () => store.delete("definitely-missing-skill-xyz"),
            (err) => err instanceof SkillNotFoundError,
            "expected SkillNotFoundError",
          );
        }),
      },
      {
        category: "error-contract",
        name: "errors carry connector_type='skill_store'",
        run: withInstance(fixture, async (store) => {
          try {
            await store.load("missing");
            assertUnreachable("expected throw");
          } catch (err) {
            assert(err instanceof ConnectorError, "error must extend ConnectorError");
            assert((err as ConnectorError).connector_type === "skill_store", "connector_type must be 'skill_store'");
          }
        }),
      },
      {
        category: "feature-behavior",
        name: "update_status: previous_status populated when supports_audit_trail=true",
        run: withInstance(fixture, async (store) => {
          const caps = fixture.ctor.staticCapabilities();
          if (caps.features["supports_audit_trail"] !== true) return; // skip; feature opt-out
          await store.store("conformance-test", SAMPLE_SKILL);
          const v = await store.update_status("conformance-test", "Approved");
          assert(v.previous_status !== undefined, "audit-trail impl must populate previous_status");
          assert(v.status === "Approved", "update_status must persist new status");
        }),
      },
      {
        category: "feature-behavior",
        name: "filter narrows by status when supports_writes=true",
        run: withInstance(fixture, async (store) => {
          const caps = fixture.ctor.staticCapabilities();
          if (caps.features["supports_writes"] !== true) return;
          await store.store("draft-a", SAMPLE_SKILL);
          await store.store("approved-b", SAMPLE_SKILL);
          await store.update_status("approved-b", "Approved");
          const approved = await store.query({ status: "Approved" });
          assert(approved.length === 1, `expected 1 approved skill, got ${approved.length}`);
          assert(approved[0]!.name === "approved-b", `expected 'approved-b', got '${approved[0]!.name}'`);
        }),
      },
    ];
  },
};

// ─── MemoryStore ──────────────────────────────────────────────────────────

export interface MemoryStoreFixture {
  build(): MemoryStore;
  ctor: MemoryStoreClass;
  seed?(instance: MemoryStore, memories: Partial<PortableMemory>[]): Promise<void>;
  teardown?(instance: MemoryStore): Promise<void>;
}

export const MemoryStoreConformance = {
  buildTests(fixture: MemoryStoreFixture): ConformanceTest[] {
    return [
      ...staticCapabilitiesTests(fixture.ctor, "memory_store"),
      methodExistence("MemoryStore.query present", fixture, "query"),
      methodExistence("MemoryStore.manifest present", fixture, "manifest"),
      {
        category: "return-type",
        name: "query returns array of PortableMemory shape",
        run: withInstance(fixture, async (store) => {
          const r = await store.query({ query: "anything", limit: 10, mode: "fts" });
          assert(Array.isArray(r), `query must return an array (got ${typeof r})`);
          for (const m of r) {
            assert(typeof m.id === "string", "PortableMemory.id must be string");
            assert(typeof m.summary === "string", "PortableMemory.summary must be string");
          }
        }),
      },
      {
        category: "feature-behavior",
        name: "supportedModes that declare true actually work",
        run: withInstance(fixture, async (store) => {
          const caps = fixture.ctor.staticCapabilities();
          const modes = ["fts", "semantic", "rerank"] as const;
          for (const mode of modes) {
            const flag = `supports_${mode === "fts" ? "fts" : mode}` as const;
            if (caps.features[flag] === true) {
              // Should not throw; empty result acceptable.
              const r = await store.query({ query: "test", limit: 1, mode });
              assert(Array.isArray(r), `mode='${mode}' must return an array`);
            }
          }
        }),
      },
    ];
  },
};

// ─── LocalModel ───────────────────────────────────────────────────────────

export interface LocalModelFixture {
  build(): LocalModel;
  ctor: LocalModelClass;
  /** Set true if the model is reachable in the test environment. Default false. */
  liveDispatch?: boolean;
  teardown?(instance: LocalModel): Promise<void>;
}

export const LocalModelConformance = {
  buildTests(fixture: LocalModelFixture): ConformanceTest[] {
    return [
      ...staticCapabilitiesTests(fixture.ctor, "local_model"),
      methodExistence("LocalModel.run present", fixture, "run"),
      methodExistence("LocalModel.manifest present", fixture, "manifest"),
      {
        category: "return-type",
        name: "manifest returns capabilities_version + manifest fields",
        run: withInstance(fixture, async (model) => {
          const m = await model.manifest();
          assert(typeof m.capabilities_version === "string", "manifest.capabilities_version must be string");
          assert(typeof m.manifest === "object" && m.manifest !== null, "manifest.manifest must be object");
        }),
      },
      {
        category: "feature-behavior",
        name: "run returns string on success when liveDispatch=true",
        run: withInstance(fixture, async (model) => {
          if (fixture.liveDispatch !== true) return; // skip when not reachable
          const r = await model.run("hi", { maxTokens: 5 });
          assert(typeof r === "string", `run must return string (got ${typeof r})`);
        }),
      },
    ];
  },
};

// ─── McpConnector ─────────────────────────────────────────────────────────

export interface McpConnectorFixture {
  build(): McpConnector;
  ctor: McpConnectorClass;
  /** A tool name the connector should handle; used in the dispatch test. */
  testToolName?: string;
  teardown?(instance: McpConnector): Promise<void>;
}

export const McpConnectorConformance = {
  buildTests(fixture: McpConnectorFixture): ConformanceTest[] {
    return [
      ...staticCapabilitiesTests(fixture.ctor, "mcp_connector"),
      methodExistence("McpConnector.call present", fixture, "call"),
      methodExistence("McpConnector.manifest present", fixture, "manifest"),
      {
        category: "return-type",
        name: "manifest returns capabilities_version + manifest fields",
        run: withInstance(fixture, async (connector) => {
          const m = await connector.manifest();
          assert(typeof m.capabilities_version === "string", "manifest.capabilities_version must be string");
        }),
      },
    ];
  },
};

// ─── AgentConnector (T7.1) ─────────────────────────────────────────────────

export interface AgentConnectorFixture {
  build(): AgentConnector;
  ctor: AgentConnectorClass;
  /** Optional id the connector treats as reachable; used in deliver/wake tests. */
  testAgentId?: string;
  teardown?(instance: AgentConnector): Promise<void>;
}

export const AgentConnectorConformance = {
  buildTests(fixture: AgentConnectorFixture): ConformanceTest[] {
    const tests: ConformanceTest[] = [
      ...staticCapabilitiesTests(fixture.ctor, "agent_connector"),
      methodExistence("AgentConnector.list_agents present", fixture, "list_agents"),
      methodExistence("AgentConnector.deliver present", fixture, "deliver"),
      methodExistence("AgentConnector.wake present", fixture, "wake"),
      // v0.9.6 — manifest() dropped from AgentConnector per audit Q2.
      methodExistence("AgentConnector.health_check present", fixture, "health_check"),
      methodExistence("AgentConnector.request_response present", fixture, "request_response"),
      {
        category: "return-type",
        name: "list_agents returns an array",
        run: withInstance(fixture, async (connector) => {
          const r = await connector.list_agents();
          assert(Array.isArray(r), `list_agents must return an array (got ${typeof r})`);
        }),
      },
      {
        category: "return-type",
        name: "health_check returns boolean",
        run: withInstance(fixture, async (connector) => {
          const r = await connector.health_check();
          assert(typeof r === "boolean", `health_check must return boolean (got ${typeof r})`);
        }),
      },
    ];
    const testAgentId = fixture.testAgentId;
    // v0.9.6 — DeliveryMeta envelope per audit Q8. Conformance fixtures supply
    // a synthetic meta for deliver() probes; adopter substrate is expected to
    // serialize-and-ignore fields it doesn't understand.
    const buildConformanceMeta = (): import("../connectors/agent.js").DeliveryMeta => ({
      dispatch_id: "conformance-test",
      sent_at: Date.now(),
      origin: { skill_name: "conformance-fixture", trigger_kind: "inline" },
    });
    if (testAgentId !== undefined) {
      tests.push({
        category: "feature-behavior",
        name: "deliver(kind=augment) returns DeliveryReceipt with delivered_at",
        run: withInstance(fixture, async (connector) => {
          const receipt = await connector.deliver(testAgentId, { kind: "augment", content: "conformance", meta: buildConformanceMeta() });
          assert(typeof receipt.delivered_at === "number", "DeliveryReceipt.delivered_at must be number");
        }),
      });
      tests.push({
        category: "feature-behavior",
        name: "deliver(kind=template) returns DeliveryReceipt with delivered_at",
        run: withInstance(fixture, async (connector) => {
          const receipt = await connector.deliver(testAgentId, { kind: "template", prompt: "conformance", meta: buildConformanceMeta() });
          assert(typeof receipt.delivered_at === "number", "DeliveryReceipt.delivered_at must be number");
        }),
      });
      tests.push({
        category: "feature-behavior",
        name: "wake returns WakeReceipt with woken_at",
        run: withInstance(fixture, async (connector) => {
          const receipt = await connector.wake(testAgentId);
          assert(typeof receipt.woken_at === "number", "WakeReceipt.woken_at must be number");
        }),
      });
    }
    return tests;
  },
};

// ─── Shared assertion helpers ─────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Conformance assertion failed: ${message}`);
}

function assertUnreachable(message: string): never {
  throw new Error(`Conformance assertion failed: ${message}`);
}

async function expectThrows(
  fn: () => Promise<unknown>,
  predicate: (err: unknown) => boolean,
  message: string,
): Promise<void> {
  try {
    await fn();
    throw new Error(`Conformance assertion failed: ${message}, but no error was thrown`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Conformance assertion failed")) throw err;
    if (!predicate(err)) {
      throw new Error(
        `Conformance assertion failed: ${message}, got ${(err as Error)?.constructor?.name ?? typeof err}: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}

function methodExistence<I extends object>(
  name: string,
  fixture: { build(): I; teardown?: (i: I) => Promise<void> },
  method: string,
): ConformanceTest {
  return {
    category: "method-existence",
    name,
    run: withInstance(fixture, async (instance) => {
      const obj = instance as unknown as Record<string, unknown>;
      assert(typeof obj[method] === "function", `instance.${method} must be a function`);
    }),
  };
}

function staticCapabilitiesTests(
  ctor: { staticCapabilities(): StaticCapabilities },
  expectedKind: ConnectorType,
): ConformanceTest[] {
  return [
    {
      category: "static-capabilities",
      name: `staticCapabilities() returns connector_type='${expectedKind}'`,
      run: async () => {
        const caps = ctor.staticCapabilities();
        assert(caps.connector_type === expectedKind, `connector_type must be '${expectedKind}' (got '${caps.connector_type}')`);
      },
    },
    {
      category: "static-capabilities",
      name: "staticCapabilities() returns non-empty implementation + contract_version",
      run: async () => {
        const caps = ctor.staticCapabilities();
        assert(typeof caps.implementation === "string" && caps.implementation.length > 0, "implementation must be non-empty string");
        assert(typeof caps.contract_version === "string" && /^\d+\.\d+\.\d+$/.test(caps.contract_version), "contract_version must be semver-ish");
      },
    },
    {
      category: "static-capabilities",
      name: "staticCapabilities() features map is well-formed",
      run: async () => {
        const caps = ctor.staticCapabilities();
        assert(typeof caps.features === "object" && caps.features !== null, "features must be object");
        for (const [k, v] of Object.entries(caps.features)) {
          assert(typeof v === "boolean", `feature '${k}' must be boolean (got ${typeof v})`);
        }
      },
    },
    {
      category: "static-capabilities",
      name: "staticCapabilities() callable without instance construction",
      run: async () => {
        // The whole point of static-capabilities: the linter must be able to
        // discover features without paying construction cost. This test
        // asserts the method is on the class (constructor), not on the
        // prototype/instance.
        const caps = ctor.staticCapabilities();
        assert(caps !== null, "static call returned null");
      },
    },
  ];
}

function withInstance<I>(
  fixture: { build(): I; teardown?: (i: I) => Promise<void> },
  body: (instance: I) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const instance = fixture.build();
    try {
      await body(instance);
    } finally {
      if (typeof fixture.teardown === "function") await fixture.teardown(instance);
    }
  };
}

// Sample skill used by SkillStore conformance tests that need a payload.
const SAMPLE_SKILL = `# Skill: conformance-test
# Status: draft

t:
    ! hi

default: t
`;

// Re-export SkillMeta type for fixture authors importing from this module.
export type { SkillMeta } from "../connectors/types.js";
