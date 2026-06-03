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
  DataStore,
  DataStoreClass,
  PortableData,
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
          if (caps.connector_type !== "skill_store") return; // fixture mismatch — skip
          if (caps.features["supports_audit_trail"] !== true) return; // feature opt-out
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
          if (caps.connector_type !== "skill_store") return; // fixture mismatch — skip
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

// ─── DataStore ──────────────────────────────────────────────────────────

export interface DataStoreFixture {
  build(): DataStore;
  ctor: DataStoreClass;
  seed?(instance: DataStore, memories: Partial<PortableData>[]): Promise<void>;
  teardown?(instance: DataStore): Promise<void>;
}

export const DataStoreConformance = {
  buildTests(fixture: DataStoreFixture): ConformanceTest[] {
    return [
      ...staticCapabilitiesTests(fixture.ctor, "data_store"),
      methodExistence("DataStore.query present", fixture, "query"),
      methodExistence("DataStore.manifest present", fixture, "manifest"),
      {
        category: "return-type",
        name: "query returns array of PortableData shape",
        run: withInstance(fixture, async (store) => {
          const r = await store.query({ query: "anything", limit: 10, mode: "fts" });
          assert(Array.isArray(r), `query must return an array (got ${typeof r})`);
          for (const m of r) {
            assert(typeof m.id === "string", "PortableData.id must be string");
            assert(typeof m.summary === "string", "PortableData.summary must be string");
          }
        }),
      },
      {
        category: "feature-behavior",
        name: "optional modes (semantic, rerank) work when declared",
        run: withInstance(fixture, async (store) => {
          const caps = fixture.ctor.staticCapabilities();
          if (caps.connector_type !== "data_store") return; // fixture mismatch — skip
          // FTS is the baseline mode (always supported); only check optionals.
          const optionalModes = ["semantic", "rerank"] as const;
          for (const mode of optionalModes) {
            const flag = `supports_${mode}` as const;
            if (caps.features[flag] === true) {
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

// ─── runtime_capabilities ─────────────────────────────────────────────────
//
// v0.16.5 — Conformance suite for the `runtime_capabilities` discovery
// surface. Different shape from the per-connector suites above: instead of
// validating a single connector against its contract, this validates the
// runtime AS A WHOLE — schema correctness across all five substrate slots +
// the 3-state manifest schema (working / manifest_error / manifest_unsupported)
// from v0.16.3 + adopter-supplied execution-path probes paired with the
// capability flags they declare.
//
// Closes the long-running discipline-only-contracts pattern called out in
// Perry's `adf47c0b`: every flag in `runtime_capabilities` must have a
// matching execution-path probe test. Without lockstep enforcement, the
// "lint passes, runtime fails" multi-layer-promise pattern keeps recurring
// (5 instances pre-v0.15.4; now structurally closable).

/**
 * Minimal `mcpServer` surface the conformance fixture talks to. The wired
 * runtime exposes far more than this — fixture only needs JSON-RPC handle()
 * to call `runtime_capabilities` + `tools/list`.
 */
export interface RuntimeCapabilitiesFixtureRuntime {
  mcpServer: {
    handle(request: {
      jsonrpc: "2.0";
      id: number | string;
      method: string;
      params?: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/**
 * Per-flag execution-path probe. Adopters provide a probe per capability
 * flag they declare in `runtime_capabilities`. The probe exercises the
 * runtime dispatch path that the flag claims to govern + throws if the
 * declared discipline isn't actually honored.
 *
 * Flag paths use dot-notation matching the `runtime_capabilities` response
 * shape: `shellExecution.unsafe_enabled`, `localModels[0].features.supports_streaming`,
 * etc. Adopter chooses which flags to probe; the fixture's `requiredFlags`
 * arg lets you enforce coverage on a specific subset.
 */
export type RuntimeCapabilityProbe = (runtime: RuntimeCapabilitiesFixtureRuntime) => Promise<void>;

export interface RuntimeCapabilitiesFixture {
  /**
   * Build the wired runtime under test. Called once per generated
   * ConformanceTest. Fixture is responsible for `teardown` cleanup if
   * the runtime allocates resources (file handles, sqlite connections,
   * etc.).
   */
  buildRuntime(): Promise<RuntimeCapabilitiesFixtureRuntime> | RuntimeCapabilitiesFixtureRuntime;
  teardown?(runtime: RuntimeCapabilitiesFixtureRuntime): Promise<void> | void;
  /**
   * Per-flag execution-path probes. Map flag path → probe function. The
   * fixture runs each probe + asserts no error thrown.
   */
  flagProbes?: Record<string, RuntimeCapabilityProbe>;
  /**
   * Flag paths that MUST appear in `flagProbes`. If any required flag has
   * no probe, the coverage test fails — forces adopters to wire BOTH the
   * capability declaration AND the dispatch-path probe in lockstep.
   *
   * This is the load-bearing piece per Perry's `adf47c0b`: it makes the
   * discipline-only-contracts pattern structurally hard rather than
   * relying on author diligence.
   */
  requiredFlags?: string[];
}

export const RuntimeCapabilitiesConformance = {
  buildTests(fixture: RuntimeCapabilitiesFixture): ConformanceTest[] {
    const tests: ConformanceTest[] = [];

    // ─── Schema tests — verify the runtime_capabilities response shape ──
    tests.push({
      category: "return-type",
      name: "runtime_capabilities returns a JSON object with runtimeVersion + runtimeMode",
      run: withRuntime(fixture, async (runtime) => {
        const caps = await callRuntimeCapabilities(runtime);
        assert(typeof caps["runtimeVersion"] === "string", "runtimeVersion must be string");
        assert(typeof caps["runtimeMode"] === "string", "runtimeMode must be string");
      }),
    });

    tests.push({
      category: "return-type",
      name: "every substrate-slot entry has 5 required fields + the v0.16.3 manifest field",
      run: withRuntime(fixture, async (runtime) => {
        const caps = await callRuntimeCapabilities(runtime);
        for (const slot of ["skillStores", "dataStores", "localModels", "mcpConnectors", "agentConnectors"] as const) {
          const entries = caps[slot];
          assert(Array.isArray(entries), `${slot} must be an array (got ${typeof entries})`);
          for (const entry of entries as Array<Record<string, unknown>>) {
            assert(typeof entry["name"] === "string", `${slot}[].name must be string`);
            assert(typeof entry["implementation"] === "string", `${slot}[].implementation must be string`);
            assert(typeof entry["contract_version"] === "string", `${slot}[].contract_version must be string`);
            assert(typeof entry["connector_type"] === "string", `${slot}[].connector_type must be string`);
            assert(typeof entry["features"] === "object", `${slot}[].features must be object`);
            assert("manifest" in entry, `${slot}[].manifest field must be present (v0.16.3 schema)`);
          }
        }
      }),
    });

    tests.push({
      category: "return-type",
      name: "every entry's manifest field is in exactly one of the three v0.16.3 states",
      run: withRuntime(fixture, async (runtime) => {
        const caps = await callRuntimeCapabilities(runtime);
        for (const slot of ["skillStores", "dataStores", "localModels", "mcpConnectors", "agentConnectors"] as const) {
          for (const entry of (caps[slot] as Array<Record<string, unknown>>) ?? []) {
            const m = entry["manifest"];
            const hasError = typeof entry["manifest_error"] === "string";
            const isUnsupported = entry["manifest_unsupported"] === true;
            if (m !== null && m !== undefined) {
              // State 1: working manifest. Must be an object with capabilities_version.
              assert(typeof m === "object", `${slot}[${String(entry["name"])}].manifest must be object when present (got ${typeof m})`);
              assert(!hasError, `${slot}[${String(entry["name"])}] has both manifest data AND manifest_error — pick one`);
              assert(!isUnsupported, `${slot}[${String(entry["name"])}] has both manifest data AND manifest_unsupported — pick one`);
            } else {
              // State 2 (manifest_error) or State 3 (manifest_unsupported) — exactly one must be set.
              const stateCount = (hasError ? 1 : 0) + (isUnsupported ? 1 : 0);
              assert(stateCount === 1, `${slot}[${String(entry["name"])}].manifest is null but neither manifest_error nor manifest_unsupported is set (or both are) — got ${stateCount} flags`);
            }
          }
        }
      }),
    });

    tests.push({
      category: "return-type",
      name: "AgentConnector entries use manifest_unsupported (never manifest_error) — v0.9.6 audit",
      run: withRuntime(fixture, async (runtime) => {
        const caps = await callRuntimeCapabilities(runtime);
        for (const entry of (caps["agentConnectors"] as Array<Record<string, unknown>>) ?? []) {
          assert(entry["manifest"] === null, `agentConnectors[${String(entry["name"])}].manifest must be null (contract has no manifest())`);
          assert(entry["manifest_unsupported"] === true, `agentConnectors[${String(entry["name"])}] must set manifest_unsupported:true (structural absence per v0.9.6 audit)`);
          assert(entry["manifest_error"] === undefined, `agentConnectors[${String(entry["name"])}] must NOT set manifest_error (it's a structural absence, not a runtime failure)`);
        }
      }),
    });

    tests.push({
      category: "return-type",
      name: "mcpConnectors entries include allowed_tools field (null or string[])",
      run: withRuntime(fixture, async (runtime) => {
        const caps = await callRuntimeCapabilities(runtime);
        for (const entry of (caps["mcpConnectors"] as Array<Record<string, unknown>>) ?? []) {
          assert("allowed_tools" in entry, `mcpConnectors[${String(entry["name"])}].allowed_tools field must be present`);
          const at = entry["allowed_tools"];
          assert(at === null || Array.isArray(at), `mcpConnectors[${String(entry["name"])}].allowed_tools must be null or string[]`);
        }
      }),
    });

    tests.push({
      category: "feature-behavior",
      name: "shellExecution surface declares mode + unsafe_enabled fields",
      run: withRuntime(fixture, async (runtime) => {
        const caps = await callRuntimeCapabilities(runtime);
        const shell = caps["shellExecution"] as Record<string, unknown> | undefined;
        assert(shell !== undefined, "shellExecution surface must be present");
        assert(typeof shell["mode"] === "string", "shellExecution.mode must be string");
        assert(typeof shell["unsafe_enabled"] === "boolean", "shellExecution.unsafe_enabled must be boolean");
      }),
    });

    // ─── Flag-probe orchestration tests (the discipline-only-contracts close) ──
    const flagProbes = fixture.flagProbes ?? {};
    const requiredFlags = fixture.requiredFlags ?? [];

    for (const [flagPath, probe] of Object.entries(flagProbes)) {
      tests.push({
        category: "feature-behavior",
        name: `flag '${flagPath}': execution-path probe succeeds`,
        run: withRuntime(fixture, async (runtime) => {
          await probe(runtime);
        }),
      });
    }

    if (requiredFlags.length > 0) {
      tests.push({
        category: "feature-behavior",
        name: "coverage: every required flag has an execution-path probe",
        run: async () => {
          const missing = requiredFlags.filter((f) => !(f in flagProbes));
          assert(
            missing.length === 0,
            `Required flags missing execution-path probes: ${missing.join(", ")}. ` +
              `Each capability flag in runtime_capabilities must have a matching dispatch-path probe so the ` +
              `discipline-only-contracts class is structurally enforced. Add probe entries to fixture.flagProbes ` +
              `for the listed flags, OR drop them from fixture.requiredFlags if they're aspirational.`,
          );
        },
      });
    }

    // v0.16.9 — auto-coverage: when any registered McpConnector declares
    // `supports_identity_propagation: true` in its staticCapabilities,
    // adopter MUST supply BOTH Level 1 + Level 2 probes via flagProbes,
    // keyed by `mcpConnectors.<name>.supports_identity_propagation.level1`
    // and `.level2`. Closes the structural-honesty gate per Perry's
    // `9af842f7` charter — declaring the flag without probes is a
    // discipline-only-contract instance. Per warm-adopter `1e1c9305`:
    // per-call-header connectors against session-pinning substrates pass
    // Level 1 while failing Level 2 — the gap probe must catch.
    tests.push({
      category: "feature-behavior",
      name: "auto-coverage: supports_identity_propagation:true requires Level 1 + Level 2 probes per connector",
      run: withRuntime(fixture, async (runtime) => {
        const caps = await callRuntimeCapabilities(runtime);
        const connectors = (caps["mcpConnectors"] as Array<Record<string, unknown>>) ?? [];
        const missingProbes: string[] = [];
        for (const entry of connectors) {
          const features = entry["features"] as Record<string, unknown> | undefined;
          if (features?.["supports_identity_propagation"] !== true) continue;
          const name = String(entry["name"]);
          const l1Key = `mcpConnectors.${name}.supports_identity_propagation.level1`;
          const l2Key = `mcpConnectors.${name}.supports_identity_propagation.level2`;
          if (!(l1Key in flagProbes)) missingProbes.push(l1Key);
          if (!(l2Key in flagProbes)) missingProbes.push(l2Key);
        }
        assert(
          missingProbes.length === 0,
          `Connectors declare \`supports_identity_propagation: true\` but Level 1/2 probes are missing: ` +
            `${missingProbes.join(", ")}. The flag claims end-to-end identity propagation; adopter must supply ` +
            `probes that exercise it. Level 1: identity reaches transport. Level 2: distinct ctx.agentId yields ` +
            `distinct observable substrate scopes. Add probe entries to fixture.flagProbes — Level 1 is ` +
            `substrate-independent; Level 2 needs a real substrate (warm-adopter pattern: identity-pinned mock ` +
            `or live substrate). Without these probes, the flag is structurally-asserted-but-empirically-unverified.`,
        );
      }),
    });

    return tests;
  },
};

async function callRuntimeCapabilities(runtime: RuntimeCapabilitiesFixtureRuntime): Promise<Record<string, unknown>> {
  const resp = await runtime.mcpServer.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "runtime_capabilities",
      arguments: {
        include: ["runtimeVersion", "runtimeMode", "skillStores", "dataStores", "localModels", "mcpConnectors", "agentConnectors", "shellExecution"],
      },
    },
  });
  const r = resp as { result?: { content?: Array<{ text?: string }> }; error?: unknown };
  assert(r.error === undefined, `runtime_capabilities returned JSON-RPC error: ${JSON.stringify(r.error)}`);
  const text = r.result?.content?.[0]?.text;
  assert(typeof text === "string", "runtime_capabilities reply must carry content[0].text");
  return JSON.parse(text) as Record<string, unknown>;
}

function withRuntime(
  fixture: RuntimeCapabilitiesFixture,
  body: (runtime: RuntimeCapabilitiesFixtureRuntime) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const runtime = await fixture.buildRuntime();
    try {
      await body(runtime);
    } finally {
      if (typeof fixture.teardown === "function") await fixture.teardown(runtime);
    }
  };
}

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
