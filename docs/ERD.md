# Skillscript ERD — engineering requirements (placeholder, in flight)

Engineering requirements document for the Skillscript runtime + compiler. Audience: engineers building skillscript-runtime. Threads scope to ERD slices when work begins.

Status: placeholder. Requirements being shaped in conversation between Scott + Perry; sections will fill in as decisions land. See companion docs under project anchor `cc2d7cfb`:
- `skillscript-prd` — product positioning, value prop
- `skillscript-language-reference` — language syntax and semantics

Initial requirements sketched in conversation 2026-05-19 (Scott's starter list + Perry's adds): codebase shape, modifiability, connector contracts, security, compiler architecture, runtime architecture, observability, testing strategy, distribution shape. To be expanded as the design crystallizes.

## §1 Codebase shape — small enough to understand, explicit LOC ceiling

**Requirement.** The skillscript-runtime codebase must be small enough that one person (or one agent) can read it end-to-end in a sitting.

**Concrete commitments:**
- One process. No internal microservice boundaries.
- Parser + compiler + executor + connector registry + lint together ≤ ~5K LOC for the core. Tests and conformance suite are separate budget.
- Fewer than 20 source files in the core. (Tests + adversarial library count separately.)
- No internal RPC; in-process function calls only. External integration goes through connectors.

**Why explicit numbers:** "small" drifts upward over feature releases. A PR that pushes past the LOC ceiling is a deliberate decision, not a slide. The ceiling enforces architectural pressure toward fewer, more orthogonal abstractions.

**Affordance for understanding:** the codebase ships with a one-page architecture map (which file does what), kept current with each release. New contributors (human or agent) read the map first, the code second.

**Out of scope for this section:** specific file naming, module boundaries (those live in the compiler/runtime architecture sections). This section only sets the size ceiling.

## §2 Modifiability — three concrete properties for agent-modifiable codebase

**Requirement.** Agents (Claude, CC, or future) must be able to modify the codebase and bring in upstream changes without losing local work. "Easy to modify" is operationalized via three concrete properties.

**1. Tests give clear signals.**
- Every behavioral rule has a test that names the rule and fails predictably when the rule breaks.
- A passing test suite is sufficient evidence that the change ships.
- Test names are diagnostic, not just descriptive — "throws when `?` has no prompt" rather than "test 47."
- No tests gated on environment-specific state (network, time-of-day, host config).

**2. Code structure maps to language features.**
- Adding a new op kind = adding a file in `ops/` and registering it. Predictable, mechanical.
- Adding a new filter = adding a function in `filters/` and registering it.
- Adding a new connector instance = config change, no code change.
- New contributors (agent or human) can predict where a feature lives without reading the whole codebase.

**3. Design rationale lives near the code.**
- Non-obvious decisions get a comment explaining the reason, not just the rule. ("Why this works this way" not "what this does.")
- Major design decisions reference the ERD section that justifies them.
- Avoid relying on git blame archaeology for "why is this here?" — the answer is in the source or one click away.

**Upstream-merge property:** local plugin extensions (filters, connector implementations) live in `~/.skillscript/plugins/` or `node_modules/skillscript-plugin-*`, never in the core source tree. Upstream merges don't touch user extensions.

**Validation:** does an agent reading the codebase for the first time know where to add a new filter without being told? If yes, this requirement is met. If no, the structure is wrong.

## §3 Connectors and the AMP proof case — contracts as the integration boundary

**Requirement.** All external integration happens through typed connector contracts. The compiler and runtime are connector-agnostic; deployments wire concrete implementations behind the contract interfaces. Skillscript's storage-agnostic claim in the PRD (Adoption flexibility, Substrate independence) depends on this separation: choosing one connector backend doesn't determine the others.

Satisfies PRD requirements FR-4 (pluggable backends), FR-12 (MCP server contract), NFR-7 (substrate independence), NFR-12 (multi-instance), NFR-13 (containerizable).

## The four connector contracts

The runtime defines four typed connector contracts. Each is a distinct integration boundary; implementations live behind the contract.

### MemoryStore — backs `>` retrieval

```typescript
interface MemoryStore {
  query(filters: QueryFilters): Promise<PortableMemory[]>;
  capabilities(): Capabilities;
}
```

Returns `PortableMemory[]` to the runtime. Substrate-specific extensions in `metadata`. Curated subset (thread_status, pinned, confidence, etc.) populated where the concept applies.

### LocalModel — backs `~` invocations

```typescript
interface LocalModel {
  run(prompt: string, opts?: { maxTokens?: number; timeoutMs?: number }): Promise<string>;
  capabilities(): Capabilities;
}
```

Per-instance timeout config (per decision 5: `timeout_ms` field, default 60000ms). Multi-instance by design — multiple named LocalModel instances per deployment.

### McpConnector — backs `$` MCP-tool ops

```typescript
interface McpConnector {
  call(toolName: string, args: object, ctxOverrides?: McpDispatchCtx): Promise<unknown>;
  capabilities(): Capabilities;
}
```

Per-call identity propagation via `ctxOverrides`. Registry-configured per-connector identity merges with per-call ctx (registry top, ctx fallback).

### SkillStore — backs the compiler's source loading (per decision 3)

```typescript
interface SkillStore {
  // Read
  load(name: string, version?: string): Promise<SkillSource>;
  query(filter?: SkillFilter): Promise<SkillMeta[]>;
  metadata(name: string): Promise<SkillMeta>;
  versions(name: string): Promise<VersionInfo[]>;

  // Write
  store(name: string, source: string, metadata?: Partial<SkillMeta>): Promise<VersionInfo>;
  delete(name: string): Promise<void>;
  update_status(name: string, status: SkillStatus): Promise<VersionInfo>;

  // Introspection
  capabilities(): Capabilities;
}
```

Eight methods. SkillStore is separate from MemoryStore because access patterns and lifecycle differ fundamentally — random read by name vs query by predicate, lifecycle-state-aware operations vs continuous accumulation. The compiler reads from SkillStore; the dashboard (FR-8) reads from SkillStore for the management UI; lint tools read from SkillStore for discovery.

## Common types referenced above

```typescript
// Lifecycle states (per decision 6 — three states, additive expansion deferred)
type SkillStatus = "draft" | "approved" | "disabled";

// Source as loaded from the store
interface SkillSource {
  name: string;
  version: string;        // opaque substrate-declared label (see below)
  content_hash: string;   // substrate-independent identity (see below)
  source: string;         // raw skillscript text
  metadata: SkillMeta;    // parsed header data + storage metadata
}

// Metadata derived from headers + storage layer
interface SkillMeta {
  name: string;
  version: string;
  content_hash: string;
  status: SkillStatus;
  description?: string;

  // Headers extracted from source
  vars?: string[];                // declared input variables
  requires?: string[];            // referenced skills (composition deps)
  triggers?: TriggerDecl[];       // declared triggers
  outputs?: string[];             // declared output channels
  type?: "procedural" | "data";   // per decision 1; defaults to procedural

  // Storage metadata
  created_at: number;             // unix seconds
  updated_at: number;
  status_changed_at?: number;
  author?: string;                // agent_id of last writer

  // Substrate-specific bag (matches PortableMemory pattern)
  metadata_bag?: Record<string, unknown>;
}

// Returned by every write op
interface VersionInfo {
  name: string;
  version: string;
  content_hash: string;
  status: SkillStatus;
  changed_at: number;
  changed_by?: string;
}

// Predicate for `query()`
interface SkillFilter {
  status?: SkillStatus | SkillStatus[];
  type?: "procedural" | "data";
  tag?: string | string[];        // substrate-defined tag mechanism
  author?: string;
  since?: number;                 // updated since this unix-seconds timestamp
  name_pattern?: string;          // glob or regex
  limit?: number;
  offset?: number;
  [key: string]: unknown;         // substrate-specific pass-through
}

interface TriggerDecl {
  source: "cron" | "session" | "event" | "agent-event" | "file-watch" | "sensor";
  name: string;
  agent_id?: string;
}

interface PortableMemory {
  // Core fields — mandatory on every connector return.
  id: string;
  summary: string;
  detail?: string;
  score?: number;

  // Curated substrate subset — concept-portable, value-substrate-specific.
  thread_status?: string;
  pinned?: boolean;
  confidence?: number;
  domain_tags?: string[];
  payload_type?: string;
  knowledge_type?: string;
  recipients?: string[];
  expires_at?: number;
  created_at?: number;
  agent_id?: string;
  vault?: string;

  // Substrate-specific bag. Accessed via $(MEMORY.metadata.X).
  metadata?: Record<string, unknown>;
}

interface QueryFilters {
  query: string;
  limit: number;
  mode: "fts" | "semantic" | "rerank" | string;
  [key: string]: unknown;
}

interface McpDispatchCtx {
  agentId?: string;
  isAdmin?: boolean;
}
```

## Version vs content_hash semantics

Every skill carries two version-like fields. They serve different roles and must not be conflated:

- **`version`** — the **opaque substrate-declared label**. Semver if the substrate maintains semver versioning, content-hash if filesystem-backed and no separate versioning concept exists, monotonic counter, build identifier, whatever the substrate uses internally. **Equality-comparison-only as discipline.** Consumers MUST NOT parse this string, sort it, or attempt arithmetic on it. The runtime treats it as an opaque token; what it means depends on the substrate.

- **`content_hash`** — the **substrate-independent identity**. Always a SHA-256 of the canonicalized source bytes at load time. The compiler computes this if the substrate doesn't provide it. This is what consumers reason about when they need cross-substrate equality.

### Which consumer uses which

- **Provenance recording (§5)** — stores both. `version` for human-readable display in compiled-artifact headers and the dashboard; `content_hash` for identity comparison during recompile-staleness detection.
- **Staleness detection** — compares `content_hash` between the stored compiled-artifact's recorded inputs and the current source. Substrate-independent; works identically for filesystem-backed and versioned-DB substrates.
- **Version pinning** (e.g., `# Requires: voice-guide@v7`) — substrate-specific. The substrate either understands semver pinning and resolves to the matching `version`, or treats the pin as opaque equality. Contract doesn't constrain.
- **Dependency walking** — uses `content_hash` for equality comparison. "Did this dependency change since I last compiled?" is a content-hash question.

The discipline: if you find yourself wanting to know whether a version string is "newer," you're reaching into substrate-specific territory. Either use `content_hash` (which is identity, not order) or ask the substrate via `versions(name)` and let it return its ordered history.

## Error contract

All four contracts throw structured errors. Implementations subclass the base `ConnectorError` from `skillscript-runtime/errors`:

```typescript
class ConnectorError extends Error {
  connector_type: ConnectorType;
  implementation: string;
  // ...
}

// SkillStore errors
class SkillNotFoundError extends ConnectorError { skill_name: string; }
class VersionNotFoundError extends ConnectorError { skill_name: string; version: string; }
class LintFailureError extends ConnectorError { diagnostics: LintDiagnostic[]; }
class StorageConflictError extends ConnectorError { skill_name: string; reason: string; }

// MemoryStore / LocalModel / McpConnector errors
class QueryError extends ConnectorError { mode?: string; }
class DispatchError extends ConnectorError { tool?: string; }
class ModelError extends ConnectorError { model?: string; }
class TimeoutError extends ConnectorError { timeout_ms: number; }
```

Per-method contract:

**MemoryStore:**
- `query(filters)` returns `[]` on empty result (never throws). Throws `QueryError` on malformed filter; `TimeoutError` if substrate times out.

**LocalModel:**
- `run(prompt, opts)` returns string on success. Throws `ModelError` on model failure; `TimeoutError` if `timeoutMs` elapses.

**McpConnector:**
- `call(toolName, args, ctxOverrides?)` returns whatever the tool returns. Throws `DispatchError` on tool failure; preserves inner cause via `error.cause`.

**SkillStore:**
- `load(name, version?)` throws `SkillNotFoundError` if name missing; `VersionNotFoundError` if version specified and missing.
- `query(filter?)` returns `[]` if no matches (never throws). Throws `QueryError` on malformed filter.
- `metadata(name)` throws `SkillNotFoundError` if missing.
- `versions(name)` throws `SkillNotFoundError` if missing.
- `store(name, source, meta?)` throws `LintFailureError` if tier-1 lint rejects; `StorageConflictError` if substrate refuses overwrite.
- `delete(name)` throws `SkillNotFoundError` if missing. Implementations decide referential-integrity behavior (does deleting `voice-guide` orphan dependent skills, or refuse with `StorageConflictError`? Substrate-specific).
- `update_status(name, status)` throws `SkillNotFoundError` if missing; returns new `VersionInfo`.
- `capabilities()` never throws.

**Error propagation through the runtime:** the executor catches these structured errors and routes them through the language's `else:` / `# OnError:` machinery (per §6). Authors see the error class via filter helpers (`$(ERR|class)` returns `"SkillNotFoundError"` etc.); inner cause preserved for nested error reasoning.

## Connector boundary properties

- **The contract IS the boundary.** Anything beyond the contract is implementation detail.
- **Multi-instance by design.** Each contract supports multiple named instances per deployment. `local-model.default` and `local-model.qwen` and `local-model.fast` registered simultaneously; per-skill resolution selects via `~ model=<name>`.
- **Capability declarations.** Each connector exposes `capabilities()` for runtime + compile-time validation. The compiler can refuse to compile a skillscript that requires capabilities a configured connector doesn't provide.
- **Three-layer config resolution** (env var → working-dir config file → bundled default). All deployment-specific config (paths, endpoints, credentials) is overridable; nothing is host-hardcoded (NFR-13).

## Capabilities specification

The `capabilities()` method on every contract returns a `Capabilities` object that the compiler and runtime use for feature matching, dynamic dispatch, and authoring-tool discovery.

```typescript
interface Capabilities {
  // Identity
  connector_type: ConnectorType;     // "memory_store" | "local_model" | "mcp_connector" | "skill_store"
  implementation: string;             // e.g., "AmpMemoryStore", "OllamaLocalModel", "FilesystemSkillStore"
  contract_version: string;           // semver of the contract this impl satisfies

  // Feature flags — true means the impl supports the named feature
  features: Record<string, boolean>;

  // Optional structured manifest for substrate-specific details
  manifest?: Record<string, unknown>;
}
```

### Per-contract feature flag namespaces

The compiler matches `# Requires:` headers against these flag names.

**MemoryStore (`memory_store.*`):**
- `supports_semantic` — `mode: "semantic"` queries work
- `supports_rerank` — `mode: "rerank"` queries work
- `supports_tag_filter` — `domain_tags`-style filtering
- `supports_thread_status_filter`
- `supports_pinning` — `pinned` populated on returns
- `supports_decay_model` — decay-aware ranking
- `supports_writes` — substrate has a write surface (read-only stores omit)

**LocalModel (`local_model.*`):**
- `supports_streaming` — `runStream()` method present (decision 5 v2 path; v1 impls omit)
- `supports_max_tokens` — `maxTokens` opt respected
- `supports_timeout` — `timeoutMs` opt respected (assumed true in v1)
- `supports_embedding` — generates embeddings (future surface)

Plus `manifest.models_available: string[]` — the list of model identifiers this LocalModel instance can serve.

**McpConnector (`mcp_connector.*`):**
- `supports_identity_propagation` — accepts `ctxOverrides`
- `supports_streaming_responses` — for long-running tool calls
- `supports_batch` — multi-call batching surface (future)

Plus `manifest.tools_available: string[]` — the list of tool names exposed by the underlying MCP server.

**SkillStore (`skill_store.*`):**
- `supports_versioning` — `versions()` returns history > 1 entry
- `supports_tag_filter`
- `supports_audit_trail` — status changes produce auditable history
- `supports_writes` — `store()` + `delete()` + `update_status()` all work
- `supports_atomic_status_transitions` — `update_status()` is transactional

### How the compiler uses Capabilities

Skill author declares required features via `# Requires:`:

```
# Requires: memory_store.supports_semantic local_model.supports_streaming
```

The compiler matches against the configured connector's `capabilities().features`. Missing feature → compile-time error with a clear diagnostic ("skill requires `memory_store.supports_semantic` but connector `primary` reports `supports_semantic: false`"). Skills without `# Requires:` compile against any configured connector.

This is Phase 5 of the connector work; the spec is locked now so v1 impls populate the flag namespace correctly.

### How the runtime uses Capabilities

`listMemoryStores()` / `listLocalModels()` / `listMcpConnectors()` return arrays of `{ name, capabilities }` pairs. Authoring tools surface the registered set; agents can query mid-execution to pick a connector based on the moment's needs.

## ContractConformance test suite

To verify that any implementation actually honors a contract, `skillscript-runtime/testing` exports a conformance suite per contract:

```typescript
// External package author runs this against their custom MemoryStore
import { MemoryStoreConformance } from "skillscript-runtime/testing";
import { MyCustomMemoryStore } from "./my-store";

describe("MyCustomMemoryStore conformance", () => {
  const store = new MyCustomMemoryStore({ /* test config */ });
  MemoryStoreConformance.runAll(store);
});
```

`MemoryStoreConformance.runAll(store)` executes every test in the suite. Tests are keyed by rule ID so failures diagnose precisely.

### Test categories per contract

Every conformance suite covers:

1. **Method existence + signatures.** Every method on the interface is callable with documented param types and returns the documented shape.
2. **Return type conformance.** Returns parse-validate against the type schema (uses Zod or equivalent for runtime check).
3. **Error contract conformance.** Methods throw the documented error class on the documented trigger condition. Inner `cause` chain preserved where applicable.
4. **Capability declaration conformance.** `capabilities()` returns a valid Capabilities object; `connector_type` matches; `contract_version` is recognized.
5. **Substrate-specific behavior.** For every feature flag the impl declares true, the corresponding behavior actually works (e.g., if `supports_semantic: true`, semantic queries return results).

### Fixture pattern

Conformance tests need substrate state to exercise. Each impl supplies a fixture builder:

```typescript
interface ConformanceFixture<T> {
  reset(): Promise<void>;                 // clear test state
  createSkill(name: string, source: string, meta?: Partial<SkillMeta>): Promise<void>;
  createMemory(memory: Partial<PortableMemory>): Promise<void>;
  // ... per-contract setup helpers
}
```

The conformance suite calls the fixture to set up state, then exercises the contract. Each substrate handles its own fixture setup (filesystem-backed: write files; SQLite: insert rows; AMP-backed: write memories).

### What conformance does NOT cover

- **Performance.** Conformance verifies correctness, not speed. Performance benchmarks are a separate `skillscript-runtime/benchmarks` suite (per §9).
- **Cross-impl interop.** Conformance is per-impl. Cross-impl consistency (does Filesystem + AMP produce equivalent results for the same logical query?) is a separate concern; out of scope for v1.

### Bundled-default + AMP-backed conformance gate

The Thread 2 acceptance criteria require both bundled-default impls AND AMP-backed impls (from Thread 8) to pass `*Conformance.runAll()`. If AMP-backed impls fail conformance, either AMP or the contract is wrong; we fix whichever's incorrect before declaring T2 done.

## Bundled default implementations

Out-of-the-box runnable on first install — `skillfile init` + `skillfile run examples/hello.skill` works without any deployment configuration.

- **MemoryStore default:** SQLite-backed local store with FTS + tag filters. Lives at `~/.skillscript/memory.db` (overridable). Single-process, single-user. Capabilities: `supports_tag_filter: true`, `supports_writes: true`, `supports_semantic: false` (v1 — semantic via SQLite extensions is a v1.x add).
- **LocalModel defaults:** three Ollama-backed instances — `default` (gemma2:9b), `gemma2` (alias of default), `qwen` (qwen2.5:7b). All at `localhost:11434` (per-instance overridable). Capabilities: `supports_timeout: true`, `supports_max_tokens: true`, `supports_streaming: false` (v1).
- **McpConnector default:** none wired. Deployments configure their own MCP servers per `connectors.json`. `skillfile init` includes a commented example.
- **SkillStore default:** filesystem-backed at `~/.skillscript/skills/` (overridable). Skills live as `.skill` files; status changes recorded via in-file `# Status:` header edit + git commit (if git initialized) or in a sidecar `.versions.jsonl`. Capabilities: `supports_versioning: true`, `supports_tag_filter: true`, `supports_audit_trail: true` (via git when present, sidecar otherwise), `supports_writes: true`, `supports_atomic_status_transitions: true`.

## AMP connector as proof case for the contract

AMP-backed implementations of all four contracts ship as the primary integration test (Thread 8). The architectural value isn't AMP specifically — it's that AMP exercises each contract at its full surface area. If AMP fits cleanly, simpler substrates (filesystem, SQLite, vector stores) fit trivially. If something doesn't fit, the contract is incomplete and we learn what's missing.

Concrete:

- **AmpMemoryStore** (`memory_store.query` → `amp_query_memories`). Translates AMP results into `PortableMemory` shape. AMP-specific fields (vault, confidence_basis, decay_model, knowledge_type) populate the curated subset; everything else goes into `metadata`. Capabilities: `supports_semantic: true`, `supports_rerank: true`, `supports_tag_filter: true`, `supports_thread_status_filter: true`, `supports_pinning: true`, `supports_decay_model: true`, `supports_writes: false` (read-only adapter for v1; writes go through `amp_write_memory` directly, not the connector).
- **AmpSkillStore** (`skill_store.load` → AMP `payload_type:skill` memory by name; `update_status` → memory revision with new `# Status:` header; `versions` → memory version history; `query` → AMP tag/status filter). Lifecycle operations produce an auditable memory revision per call. Capabilities: `supports_versioning: true`, `supports_tag_filter: true`, `supports_audit_trail: true`, `supports_writes: true`, `supports_atomic_status_transitions: true`.
- **AmpMcpConnector** (`call` → amp-mcp's MCP server). Most generic of the four; uses AMP's MCP surface as one of N possible MCP backends. Capabilities: `supports_identity_propagation: true`, `manifest.tools_available` lists the amp_* tool surface.
- **AmpLocalModel** — not applicable. LocalModel is Ollama-shaped; AMP doesn't host models.

The AMP proof case is Thread 8, parallelizable with T3-T7 once Thread 2 contracts pin.

## Model selection convention (from olsen-nightly diagnosis 2026-05-20)

LocalModel instances should be allocated by use-case-tier, not picked arbitrarily. Convention:

- **gemma2 (or equivalent classification-class model) for batch/scan work** — Olsen scan, atomization, large-batch classification, anything async or background-scheduled.
- **qwen (or equivalent dispatch-class model) for interactive verdicts in skills** — single-shot decisions inside an active skill execution where latency matters and queue contention with batch work would block forward progress.

Skill authors use `~ model="qwen"` for latency-sensitive calls. When in doubt: gemma2 if the call is asynchronous from a user/agent's perspective, qwen if a downstream op depends on the response. This convention also lives in the Language Reference's Connectors section.

## Contention property (the structural lesson behind the convention)

Any skill that calls `~` shares the underlying model runner with every other process on the deployment that calls the same model. Ollama serializes per-model dispatch. A skill that dispatches async gemma2 work AND then uses gemma2 directly will race itself — the canonical example being olsen-nightly's `$ amp_olsen_task task_type="scan"` (which fires N gemma2 classification calls) followed by `~ prompt="..."` (which queues behind them).

**The runtime does not promise concurrency-safe model dispatch.** Skill authors and operators own model-tier allocation. The lint rule for v1.x will flag the in-skill case (a skill body with both `$` ops known to dispatch model X and `~ model=X` ops gets a tier-2 warning). Cross-skill contention isn't compile-detectable; that's a deployment-coordination concern, addressed by the model-tier convention above.

## Open questions remaining for Thread 2

- **Referential integrity on `delete()`.** When `voice-guide` is deleted and three skills `& voice-guide` reference it, what happens? Options: (a) substrate refuses with `StorageConflictError`, (b) substrate orphans the references and the next compile of a dependent skill errors, (c) substrate cascades. Lean: (a) by default, with substrate-specific override possible. Worth confirming before T2 implementations begin.
- **Status transition validity.** Are `draft → approved → disabled` and `approved → disabled` valid? What about `disabled → approved` (revive a previously disabled skill)? Lean: all transitions valid in v1; the dashboard / CLI can enforce policy by refusing certain UI paths. Validity at the contract level is permissive.
- **Capability registration mechanism.** Does the runtime auto-discover capabilities by introspecting registered connectors, or does the connector declare them at registration time? Lean: connectors declare via `capabilities()`; runtime caches the declaration on first call. Worth confirming.

## Resolved

- **`SkillSource.version` shape (2026-05-20):** opaque substrate-declared label + always-populated `content_hash` for substrate-independent identity. Both fields on `SkillSource`, `SkillMeta`, and `VersionInfo`. `version` is equality-comparison-only; `content_hash` is what consumers reach for when they need cross-substrate identity. See "Version vs content_hash semantics" section above.

## §4 Security — credential isolation, identity propagation, sandbox guarantees, audit trail

**Requirement.** Security is enforced at multiple layers, with each layer providing distinct guarantees. No single point of failure.

Satisfies PRD requirements FR-7 (lifecycle states enforce status), FR-14 (structured error handling), NFR-8 (security boundaries), NFR-13 (containerizable).

The security story rests on a specific architectural commitment from the PRD: **the constraint IS the safety story, enforced at the language level, not as an aspiration.** Every layer below operates downstream of that commitment.

## Credential isolation

Credentials are per-connector instance, not global. A skillscript dispatching through `mcp.personal` does not have access to credentials for `mcp.production`. Concrete:

- Per-connector credential storage (env vars or `connectors.json`), scoped to the connector instance name.
- Credentials never appear in compiled skillscript artifacts. Connector identity is referenced by name; the runtime resolves credentials at dispatch time.
- The compiler refuses to compile a skillscript that hard-codes credentials in `$ ... apikey="..."` arguments. Lint rule enforced as tier-1.
- Containerized deployments (NFR-13) mount credentials via environment variables or secret-mount paths; both are first-class resolution sources.

## Identity propagation

When a skillscript fires, whose authority does it act under? Merge order (top wins):
1. Registry-configured per-connector identity (`connectors.json` field `identity: { agentId: "scotts", isAdmin: false }`).
2. Per-call `ctxOverrides` threaded by the runtime.
3. (No intrinsic identity — adapter forwards whatever the merge produces.)

A skill running as Perry can dispatch against a personal MCP server under a different identity without needing connector-internal state. The runtime's admin-privilege-drop discipline (from CC's `ecb6e1b` security boundary work) applies by default — skills don't inherit scheduler authority.

## Language-level sandbox: the `@` op (per decision 2)

The `@` op is **structurally bounded by the language grammar**, not by runtime sandboxing. Per decision 2 (restricted no-control-flow subset):

- *One binary per `@` invocation.* `@ curl -s "wttr.in/..." -> RAW` is valid; `@ curl ... | jq ...` is a parse error (pipes are not in the grammar).
- *No shell control flow.* No `if`/`for`/`while` inside `@`. No subshells (`$(...)`). No backticks. No `&&` / `||`.
- *Args parsed structurally.* The compiler sees every arg the binary will receive; static analysis can validate them.
- *Pipe-like composition via `@` op chains.* `@ curl ... -> RAW` followed by `@ jq ... stdin=$(RAW) -> PARSED` is the idiomatic pattern. Each `@` is one binary; the runtime feeds previous output as stdin where declared.

This delivers the PRD's safety promise: the language grammar can't express `curl | sh` or `cat | base64 -d | bash`. There's no syntactic path to those constructions, regardless of runtime sandbox configuration.

### Opt-in escape hatch: `@@`

For truly irreducible shell-pipeline cases, the language provides an explicit unsafe form: `@@ <full-shell-command>` invokes a full bash shell with the command as-is. Properties:

- **Lint-flagged tier-2 every time it appears.** Lint warning says "tier-2: this skillscript uses unsafe shell exec; review required for production admission."
- **Runtime-refuse by default.** `runtime.enable_unsafe_shell = false` (default) means `@@` ops fail at runtime with a clean error. Operators must explicitly enable to use.
- **Visible in audit.** `skillfile audit <path>` enumerates every `@@` op, the command shape, and the line number. Reviewers see exactly what's being asked.

The escape hatch exists because some legitimate pipeline patterns truly can't decompose. The high cost of using it (lint warning + runtime config + audit visibility) ensures it's reserved for the rare case where the architectural commitment yields to pragmatic necessity.

## Lint enforcement at admission

Per FR-6 + §7 (Validation and testing):
- **Disabled skills** rejected at compile (status enforcement, per Lang Ref Lifecycle section). Cannot enter the library.
- **Draft skills** compile-warn. Cannot fire under default trigger dispatch.
- **`@@` ops** flagged tier-2 (requires human review before storage).
- **Mutating ops without `??` confirmation gates** flagged tier-2.
- **Model-contention pattern** (in-skill `$` dispatching gemma2 + downstream `~ model=gemma2`) flagged tier-2 per §3.
- **Plugin name collisions** (filesystem + npm package with same name) flagged tier-3 per §10.
- **Credential hard-coding in `$` args** rejected at compile (tier-1).

## Audit trail

Every dispatch logged:
- Skill ID + version
- Trigger origin (manual / cron / event / agent-invocation)
- Identity used (post-merge per identity propagation rules above)
- Ops fired (kind + connector + result/error)
- Outputs produced (channel + content hash)

The trail is part of the storage substrate (AMP versioning, file-based + git, or runtime trace memory depending on deployment per §8). Audit tooling reads the trail via `skillfile audit <skill> --history` or equivalent.

## Status enforcement

Skillscripts in Draft or Disabled states cannot fire under default trigger dispatch (per Lang Ref Lifecycle section + decision 6). This is a security property as much as a lifecycle one — operational mistakes (forgot to flip Draft → Approved) don't become production fires.

The trigger registry respects status; a Draft skill's cron trigger is registered but the scheduler skips dispatch.

## Plugin loader security (per decision 4)

Plugin loading from `~/.skillscript/plugins/` is a real attack surface for security-conscious deployments. Decision 4's resolution config supports:

- *Default* (`["filesystem", "packages"]`): filesystem wins, then npm packages.
- *Packages-only* (`["packages"]`): filesystem plugins entirely disabled. No local-override surface. All plugins come from signed, versioned npm packages.
- *Filesystem-only* (`["filesystem"]`): less restrictive but predictable. No npm-package surface to compromise.

Security-conscious deployments set `plugins.resolution_order = ["packages"]` and require all plugins to come from signed, versioned npm packages. The runtime refuses to load anything from local filesystem. Reproducibility holds.

## Containerization (per NFR-13)

The security boundaries above all work inside container isolation. Specifically:

- *Credential isolation:* container-mounted secrets work the same as host-mounted; resolution chain unchanged.
- *Language sandbox:* the `@` op's grammar constraint operates at the parse level, not the OS level. No nested-isolation concern — the language doesn't permit the dangerous primitives regardless of host.
- *Network endpoints:* per-connector URL config covers all in-container vs out-of-container reachability questions.

The nested-isolation question that came up in NFR-13 discussion ("sandboxed bash inside a container") is moot in the decision-2 model — there is no sandboxed bash. The language is the sandbox. Containers add a second isolation layer; they don't conflict with the language layer.

## Open questions for the security thread

- **Capability declaration shape** — what does `Capabilities` actually expose, and how does the compiler validate a skillscript's `# Connectors:` declaration against the configured connector's capabilities? Specify before §3 contracts pin.
- **Status state quarantine** — should there be an explicit `Quarantined` state separate from Disabled, for skills under suspicion (security review pending)? Or is "Disabled with a `memory_subtype:quarantine` tag" sufficient? V1 leans: Disabled-with-tag is enough.
- **Cross-organizational trust** — if skillscripts are shared via a registry / marketplace, what verifies the source? Signature-based attestation? Out of v1 scope.
- **`@@` enable/disable as deployment policy** — should there be a way for a deployment to enable `@@` for specific skills only (allowlist by skill name)? V1: binary enable/disable. V2: per-skill if needed.

## §5 Compiler architecture — parser, semantic analysis, render

**Requirement.** The compiler is the canonical deliverable. It must be pure (no side effects beyond reading source + emitting artifact), deterministic (same source + same referenced data-skill versions → byte-identical artifact), and bounded (compile time sub-second for typical skills per NFR-1).

Satisfies PRD requirements FR-1 (compile to procedural artifact), FR-9 (composition), FR-10 (data skills), FR-13 (audit trail provenance), NFR-1 (compile-time performance), NFR-9 (compile-time determinism).

## Three subsystems

The compiler has three sequential phases. Each is its own module; each can be tested independently against fixture inputs.

### 1. Parser

Source text → AST. Recognizes the full v1 grammar:
- Header lines (`# Skill:`, `# Status:`, `# Description:`, `# Vars:`, `# Requires:`, `# Triggers:`, `# Output:`, `# Connectors:`, `# OnError:`, `# Timeout:`, `# Tests:`)
- Targets with optional `needs:` dependencies
- Op lines (`$`, `~`, `>`, `@`, `@@`, `!`, `??`, `$set`, `?`, `&`)
- Variable interpolation (`$(NAME)`, `$(NAME|filter)`, `$(target.output)`, `$(M.field)`)
- Conditional structures (`if`/`elif`/`else`, with the v1 narrow grammar — truthy / `==` / `!=` / `in` / `not in`)
- `foreach IDENT in EXPR:` blocks with indent-based dedent
- Target-trailing `else:` (error handler) vs conditional `else:` (parser scope-stack discriminates)

Parser errors are clean: syntax errors name the offending line + column + expected token. Semantic errors are caught in the next phase, not at parse.

### 2. Semantic analysis

AST → resolved skill model. Three sub-phases:

**a. Variable resolution.** Walks the `# Requires:` cascade, calls SkillStore.metadata() for each referenced skill, populates variable bindings. Caller-supplied inputs > `# Requires:` > `# Vars:` defaults > unresolved error.

**b. Data-skill compile-time inlining** (per decision 1). When the source references another skillscript via `&`:
- The compiler calls `SkillStore.load(name)` for the referenced skill.
- If the referenced skill has `# Type: data`, its content is **inlined** into the compiled artifact at every reference site. The data is baked into the output; the runtime never fetches it.
- If the referenced skill is procedural (no `# Type: data`), the reference compiles to a runtime invocation — `& other-skill` becomes a runtime call through the executor's skill-invocation machinery.
- The compiler tracks which data-skill versions were inlined: the compiled artifact's provenance records "compiled against `voice-guide@v7`, `taxonomy@v3`." Recompile detection works by hash comparison against current data-skill versions.

**c. Topological sort.** Resolves the target dependency DAG. `default:` names the goal; the compiler walks dependencies backward to produce the leaves-first execution order. Cycle detection at compile time; orphan-target warnings (targets unreachable from the goal) surface in `warnings[]`.

**d. Lint passes.** Runs alongside semantic analysis. Validates structural rules (FR-6): undeclared variables, missing dependencies, malformed op grammar, conditional-syntax violations, lifecycle-status enforcement (Disabled skills error at compile; Draft warns), `@@` opt-in shell flagged tier-2, model-contention warnings from §3, plugin-collision warnings from §10. Lint output is structured diagnostic format (rule + block + line).

### 3. Render

Resolved skill model → output artifact. Three output formats:

- **`prompt`** (canonical) — procedural artifact for agent execution. Anthropic-Skill-shaped markdown that bundles description + resolved variables + topo-sorted target list with translated ops. Data skills appear inlined as their content. The artifact is self-contained — an agent reading it doesn't need to fetch anything else.
- **`prose`** — narrative format for human reading. Per-target paragraphs with heading + flowing prose. Used for documentation, never for execution.
- **`test`** (v1.x) — test harness runner. Executes `# Tests:` block assertions against the compiled artifact.

## Provenance tracking (NFR-9, FR-13)

Every compiled artifact records its full provenance:
```
{
  source_skill: { name: "support-response-draft", version: "v12", hash: "..." },
  data_skills_inlined: [
    { name: "support-voice-guide", version: "v7", hash: "..." },
    { name: "support-response-examples", version: "v4", hash: "..." }
  ],
  compiled_at: 1779290000,
  compiler_version: "1.0.0",
  language_version: "1.0"
}
```

The provenance is recorded as a structured block in the compiled artifact (or in a sidecar `.provenance.json`). The `skillfile audit <path>` command reads the provenance + compares against current source state, surfacing "data-skill X has been updated since this artifact was compiled" warnings.

Cross-references FR-13 (audit-trail outputs) and the lifecycle-staleness story from the PRD's "What good looks like" section.

## Compile-time vs runtime distinction

Compile-time:
- Header parsing, target resolution
- `# Requires:` cascade resolution
- Variable substitution for static values (caller inputs, defaults)
- Data-skill inlining (decision 1)
- Lint validation
- Output rendering

Runtime:
- Ambient ref substitution (`$(NOW)`, iterator vars, output bindings from `>`/`~`)
- `~`/`>`/`@` dispatch
- `$` MCP calls
- foreach iteration
- Conditional evaluation
- Output routing

The line matters because compile-time is bounded + deterministic; runtime is not. Anything that can be pushed to compile-time (data skill content, variable defaults, dependency resolution) should be.

## Timeout configuration (per decision 7)

The compiler reads `# Timeout: N` headers and bakes them into the compiled artifact. The runtime's timeout resolution chain becomes:

1. Per-op override (`~ ... timeoutSeconds=N`) — highest precedence
2. Skill-level `# Timeout: N` header — applies to all ops in the skill
3. Connector instance default (`local_model.<name>.timeout_ms`, `mcp.<name>.timeout_ms`)
4. Built-in language fallback — 300000ms (5 minutes), absolute backstop

The compiler validates that per-op overrides don't exceed the built-in fallback (5 minutes is the absolute ceiling). If a skill explicitly needs more time than that, the operator overrides the built-in fallback at runtime config; the language doesn't permit unbounded execution.

## Reuse from current amp-mcp

Per the May 17 design notes: parser ~80% reusable, semantic analysis ~60% reusable (the data-skill inlining is new), render ~70% reusable (extending for provenance is straightforward). The reusable code lives in `amp-mcp/src/skills/parser.ts` + `compile_skill.ts` + `render.ts` — porting to standalone runtime is mostly module-shape work, not algorithmic.

## Open questions for the compiler thread

- **Compile output format pin.** The PRD says "Anthropic-Skill-shaped." Concretely: what's the format spec? Markdown with declared frontmatter, declared section structure, declared field set. Worth committing to the exact shape so consumers (agents reading the artifact) can rely on it.
- **Provenance block: inline or sidecar?** Inline keeps the compiled artifact self-describing (auditor reads one file). Sidecar keeps the artifact uncluttered (consumer agents don't see provenance unless they look). Lean: sidecar by default with `--inline-provenance` flag for audit-priority compiles.
- **Lint rule versioning surface.** Per §7 testing strategy — lint rules need to be versioned independently from the compiler. Specify how rules are loaded + how rule version is tracked in compile output.
- **Compile error format.** Error messages need to be structured (for agent consumption) and human-readable (for humans). Same format for both? Different? Specify.

## §6 Runtime architecture — executor, dispatcher, trigger scheduler

**Requirement.** The runtime is the secondary deliverable (compiler is canonical). It interprets parsed skillscripts directly, dispatching through configured connectors. Used for autonomous fires (cron, event-triggered, scheduled) where no agent is in the loop.

Satisfies PRD requirements FR-2 (runtime-mediated execution), FR-3 (agent-mediated execution), FR-5 (autonomous triggers), FR-14 (structured error propagation), NFR-2 (runtime overhead), NFR-11 (observability), NFR-13 (containerizable).

## Three subsystems

The runtime has three subsystems. Each owns a distinct concern; failures isolate per subsystem.

### Executor

Walks the parsed AST, evaluating ops in topological order from `default:` target's dependencies up to the goal. Manages:
- Variable binding scope (per-target locals, foreach iterator vars, ambient refs)
- Conditional branch evaluation (`if`/`elif`/`else` with v1 grammar)
- foreach iteration (one execution per item, scoped binding cleared between iterations)
- Error propagation through `else:` blocks + `# OnError:` fallbacks + op-level fallback values

Per-op error contract: every op returns either a result (bound to `-> VAR`) or throws via `makeOpError`. Thrown errors land in `result.errors[]` with origin (target + op kind + inner message preserved). The executor never silently swallows.

This is CC's surface 1+2 fix from 2026-05-17 (`f292532d`), portable verbatim into the standalone runtime. Inner-tool `isError` results propagate as op errors; `else:` and `# OnError:` machinery catches them; the scheduler reads `result.errors[]` and logs to stderr.

### Dispatcher

Per-op routing through connector contracts (per §3). Resolution chain for each op:

- `$ <connector>.<tool>` → `McpConnector.call()` against the named connector instance; bare `$ <tool>` → `primary` McpConnector
- `~ prompt=... [model=name]` → `LocalModel.run()` against the named instance; bare → `default`
- `>` → `MemoryStore.query()` against the named instance (via `connector=name` kwarg); bare → `primary`
- `@ <command>` → restricted sandbox shell exec, per decision 2 — one binary per `@`, no control flow, no pipes
- `@@ <command>` → opt-in unsafe full-shell exec, lint-flagged tier-2 every time; runtime refuses if `runtime.enable_unsafe_shell = false` (default)
- `! <text>` → emission via configured output router
- `?? <prompt>` → user-input prompt via interactive surface (refuse in autonomous mode per decision 6)
- `&` → SkillStore.load() + recursive compilation + executor invocation (for procedural skill composition; data skills are inlined at compile time per §5)

### Trigger scheduler

Polls for due triggers, dispatches matching skillscripts. Sources (per Lang Ref Triggers section):
- `cron` — time-based via standard 5-field expression
- `session` — lifecycle hooks (start/end)
- `event` / `agent-event` / `file-watch` / `sensor` — parse-only in v1; dispatch in later phases

**Status state respect.** The scheduler does not fire skills in Draft or Disabled status (per decision 6). The trigger is registered (visible via `list_triggers`) but the scheduler skips dispatch. When the skill transitions to Approved, its triggers activate.

**Concurrency.** Each skillscript executes single-threaded. The runtime can execute multiple skillscripts concurrently in independent execution contexts; no shared mutable state between executions. Trigger fires that overlap in time run in parallel; the runtime doesn't serialize.

## Per-op timeout enforcement (per decision 7)

Every op carries a configurable timeout. The resolution chain (top wins):
1. Per-op override (`~ ... timeoutSeconds=30 ...`) — author's explicit per-call ceiling
2. Skill-level `# Timeout: N` header — applies to all ops in the skill
3. Connector instance default (`local_model.qwen.timeout_ms = 60000`, etc.)
4. Built-in language fallback — 300000ms (5 minutes), absolute backstop

When the timeout fires, the runtime aborts the in-flight op via AbortController (or equivalent for non-fetch ops), propagates a structured op-error with the timeout context (which timeout fired, at what level), and routes through the `else:` / `# OnError:` machinery.

The 5-minute built-in fallback is configurable via `runtime.absolute_timeout_ms` for the rare deployment that needs to override either way, but 5 minutes is the canonical default per decision 7.

## Contention property (the lesson the runtime carries)

**The runtime does not promise concurrency-safe model dispatch.** Skill authors and operators own model-tier allocation. When skillscript A's `~ model=gemma2` fires while skillscript B's `$ amp_olsen_task` (which dispatches N gemma2 classification calls) is in flight, the calls serialize at the Ollama runner level. The runtime can't prevent this — it's a shared-resource property.

The runtime's contribution to mitigating this is:
- Per-instance LocalModel config (decision 5) lets operators provision separate model tiers (gemma2 for batch, qwen for interactive).
- The lint pass flags in-skill self-contention (per §3 contention rule).
- The trigger scheduler does not currently rate-limit or queue based on shared-resource awareness — that's a v2 concern.

## Streaming `~` timeout migration (per decision 5)

V1 ships with single full-completion timeout. The `~` op against `LocalModel.run()` waits for the full response or aborts. This catches "model hung entirely" but not "model trickles tokens forever."

V2 migration path:
- LocalModel interface grows a `runStream(prompt, opts)` method returning an async iterator of tokens.
- The runtime gains decomposed timeout config: `# FirstTokenTimeout: N` + `# IdleTimeout: N` headers.
- Existing `# Timeout: N` headers stay valid (semantics: full-completion ceiling).
- Backward compatibility: v1-era skillscripts continue to work; v2 features are additive.

When v2 ships, the lint rule for `# Timeout:` without `# IdleTimeout:` may warn for cron-fired skills (where idle detection matters more), but stays advisory.

## Out of scope for runtime

- Storage governance (vault, supersession, versioning) — that's the connector's job per §3.
- Memory consolidation, decay, freshness inference — substrate-specific, lives behind the MemoryStore connector.
- Agent-style reasoning. The runtime executes deterministic dispatch; reasoning happens at the agent-mediated path (compile to prompt, agent reads + reasons + dispatches via own tools).
- Shared-resource queueing / priority dispatch — per §3 contention property, this is operator-coordination, not runtime concern.

## Containerization considerations (per NFR-13)

The runtime runs cleanly in a container. All filesystem paths (scratch dir for `@` ops, SkillStore default location, MemoryStore default DB path) are configurable via env vars or config file. The `@` sandbox (restricted no-control-flow subset, decision 2) operates inside container isolation — nested isolation isn't a concern because the language constraint is the boundary, not the host sandbox.

Network endpoints (Ollama URL, MCP server URLs, etc.) are configurable per-connector. The bundled defaults assume `localhost:11434` for Ollama, which a containerized deployment overrides via `local_model.default.url`.

## Reuse from current amp-mcp

Per the May 17 design notes: executor + dispatcher ~60% reusable. Trigger scheduler ~30% reusable (broker-coupled, needs rewrite for standalone). CC's error-visibility surface fix (commit `c580de5`) is verbatim-portable. The skill-execution code in `amp-mcp/src/skills/runtime/executor.ts` is the starting point.

## Open questions for the runtime thread

- **Trigger scheduler de-dup.** When `cron: 0 8 * * *` and `event: scott.present` both fire within seconds, does the skill run twice (independent) or get deduped? V1 lean: independent (per Lang Ref Open Q #9).
- **Concurrent skill execution limits.** A runtime under heavy trigger load (many skills firing simultaneously) could saturate. Should the runtime cap concurrent executions? Default unlimited; configurable per-deployment. v1.x.
- **`@@` runtime enable/disable.** The opt-in unsafe shell op needs a runtime config toggle (`runtime.enable_unsafe_shell = false` by default). Operators enable explicitly per deployment; lint flags skills using `@@` regardless.
- **AbortController equivalent for non-fetch ops.** `~` aborts via fetch's AbortController. `$` MCP calls go through HTTP — same mechanism. `@` shell exec needs `SIGKILL` or equivalent. The runtime needs a unified timeout-abort mechanism that handles all op kinds.

## §7 Validation and testing — lint, conformance suite, adversarial library

**Requirement.** Skillscripts pass static validation before entering the library. Validation is enforced by a lint tool that shares the parser with the compiler. The lint vocabulary is designed for agent consumption (structured diagnostics naming the rule + block + line). The lint and parser are validated by a conformance test suite plus an adversarial library.

Satisfies PRD requirements FR-6 (lint validation), FR-13 (audit trail), NFR-9 (compile-time determinism), NFR-11 (observability).

## Lint architecture

- *Shared parser, independent rule engine.* The lint tool parses with the same parser as the compiler (single source of truth, no parser-drift risk). Lint rules are a separate engine that walks the parsed AST.
- *Three severity tiers* (per yesterday's CC review):
  - *Tier 1 — won't execute correctly.* Undeclared variables, missing dependencies, calls to skills that don't exist, syntactically valid but semantically broken, credential hard-coding in `$` args. **Hard-blocks storage.**
  - *Tier 2 — might be unsafe.* `@@` unsafe shell ops, mutating ops without `??` confirmation gates, in-skill model contention pattern, disabled-skill references, agent-authored skills with path-1 requirements that contradict declared `# Paths:`. **Requires human review before admission.**
  - *Tier 3 — structurally suspicious.* No `default:`, unreachable blocks (orphan-target warnings), duplicate skill names, plugin-name collisions across resolution locations. **Advisory only.**
- *Agent-consumable output.* Diagnostics name the block + line + rule + remediation suggestion, not just "warning." Format designed for agent re-authoring loops.
- *Lint rules versioned independently.* New attack patterns get new rules; existing library re-linted on rule updates.

## V1 lint rule set

Concrete rules the lint tool enforces:

**Tier 1 (hard-block):**
- `undeclared-var` — `$(NAME)` references an undefined variable
- `missing-dependency` — `needs:` references a target that doesn't exist
- `unknown-filter` — `$(VAR|filter)` with a filter not in the filter registry
- `malformed-op-grammar` — op line doesn't parse per the op kind's expected shape
- `invalid-conditional-syntax` — conditional outside v1 narrow grammar (truthy / `==` / `!=` / `in` / `not in`)
- `unknown-skill-reference` — `&` references a skill not in the SkillStore
- `disabled-skill-reference` — `&` references a Disabled skill
- `credential-in-args` — `$` op has args matching credential patterns (`apikey=`, `token=`, `password=`)
- `status-disabled` — the skillscript being compiled has `# Status: Disabled`
- `circular-dependency` — target dependency DAG has a cycle

**Tier 2 (requires review):**
- `unsafe-shell-op` — `@@` op present in skillscript body (always)
- `unconfirmed-mutation` — `$` op invoking known-mutating tool (write, delete, update) without preceding `??` confirmation
- `model-contention` — skill body has both `$` op known to dispatch model X async (e.g., `amp_olsen_task`) AND downstream `~ model=X` op
- `path-declaration-mismatch` — `# Paths:` header declares `runtime` but skill body contains `@` ops requiring agent-mediated path
- `draft-with-trigger` — skill has `# Status: Draft` but declares triggers (the triggers won't fire, but the author should know)

**Tier 3 (advisory):**
- `no-default-target` — multi-target skill without explicit `default:` declaration
- `unreachable-target` — target declared but not reached from `default:` via dependency walk
- `duplicate-skill-name` — multiple skills in the library share a name
- `plugin-collision` — same plugin name resolves in both `~/.skillscript/plugins/` and `node_modules/`
- `data-skill-staleness` — compiled artifact references a data skill version that has been updated since compile

## Conformance test suite

Behavioral contracts of the language captured as test cases. Every language feature has at least one test that names the feature and fails predictably when broken. Each new feature ships with conformance tests; new tests are additive (don't modify existing).

Test categories:
- *Parser:* every op kind, every header, every conditional shape, every filter chain
- *Compiler:* variable resolution, data-skill inlining, target topo sort, lint pass integration
- *Runtime:* op dispatch via mock connectors, error propagation through `else:` / `# OnError:`, foreach scoping, conditional evaluation
- *Connectors:* contract conformance — bundled implementations satisfy the contract; AMP-backed implementations satisfy the same contract
- *Lint:* every rule has at least one positive test (lint catches the violation) and one negative test (lint doesn't false-positive on the boundary case)

Conformance suite runs on every PR. Regressions fail the build.

## Adversarial library

Companion to the conformance suite. Each entry is a skillscript designed to *look reasonable but trigger a specific lint rule or break a specific assumption*.

Sources:
- *Production failures* — every skill that broke at execute-time becomes a new adversarial example with metadata explaining the trap.
- *Lint-flagged unexpected* — when a skill triggers a lint rule the author didn't anticipate, that's a candidate adversarial example for the rule's edge cases.
- *Deliberate fuzzing* — randomized op generation against the parser; surviving cases that parse but should have been rejected go into the library.
- *Agent-generated adversarial* — cron-fired skill that asks a model "produce adversarial skillscripts for lint rule X." Tireless source.

Stored as procedural memory (per the framing from yesterday's CC review). Each example carries metadata: what rule it tests, what trap it sets, discovery context, expected behavior. Re-runs on lint version updates; pruned when underlying issues are rendered impossible by architectural changes.

## Validation properties

- *Differential testing.* Renderer + interpreter agree on a skillscript's shape — if they disagree, the disagreement itself is the diagnostic. The conformance suite includes "renderer/interpreter agreement" as an explicit property.
- *Lint as preflight.* A skillscript that fails lint cannot enter the library. The authoring loop is "author → lint → revise → store," not "author → store → break at 3am."
- *No silent passes.* Lint output is structured; consumers (agents or humans) can act on it programmatically.

## Open questions for the validation/testing thread

- *Adversarial example bootstrap.* How do we generate the initial seed library? Nightly cron-fired adversarial generation skill that asks a model "produce adversarial skillscripts for lint rule X"? Lean: ship with ~50 hand-authored adversarial examples per rule, grow via agent-generated adversarial after launch.
- *Lint rule versioning surface.* Config-as-data (lint rules expressible as a typed data skill, letting non-engineers contribute new rules) vs code-shipped (rules are TypeScript modules). Lean: config-as-data for tier-3 advisory rules (community-contributable); code-shipped for tier-1/tier-2 (security-critical, requires review).
- *Test infrastructure for skillscript runtime tests.* The `# Tests:` block (FR-15 visualization adjacent) needs sandboxed runtime execution that doesn't pollute production memory or fire production triggers. Specify the test-sandbox shape.
- *Conformance suite as part of distribution.* Should the adversarial library + conformance suite ship with the npm package? Probably yes (operators can re-run conformance against their deployment). Size matters — ~10K test cases × a few KB each = ~100MB. Lean: ship core conformance with package; full adversarial library is a separate downloadable.

## §8 Observability — error propagation, dispatch traces, lifecycle visibility

**Requirement.** Failures must be visible. The runtime never silently fails — every op error propagates to the dispatching agent and into the persistent trace. Status changes are visible. Trigger fire outcomes are tracked. The browser dashboard (FR-8) is the operator-facing control plane on top of these surfaces.

Satisfies PRD requirements FR-8 (browser dashboard), FR-13 (audit trail), FR-14 (structured error propagation), NFR-11 (observability).

## Error propagation contract

The foundation: op errors throw via `makeOpError` (or equivalent). The throw routes through the language's error-handling machinery (`else:` blocks, `# OnError:` fallbacks, op-level fallback values per Lang Ref Error Handling section). Unhandled errors accumulate in `result.errors[]`.

The scheduler reads `result.errors[]` and logs each entry to stderr with origin (skill + target + op kind + inner cause preserved). No silent swallowing. This is CC's surface 1+2 fix from `f292532d` (commit `c580de5`), portable verbatim into the standalone runtime.

The pattern applies to every op kind, not just `$`. Per-op error contract:
- `$` op returns `isError: true` → executor throws, error propagates
- `~` op times out or model errors → executor throws, error propagates
- `>` op fails → executor throws, error propagates
- `@` / `@@` op exit code non-zero or sandbox refuses → executor throws, error propagates
- `&` op invoked skill itself errors → executor throws with sub-error preserved as nested context

## Dispatch trace

Per-fire trace recording. Three modes (configurable per-deployment):

- **Off** — no per-fire trace recorded. Error-only trace still required (NFR-11). Production-default for high-volume deployments.
- **On** — every op + every output recorded with timestamp, args, result, duration. Stored per-deployment substrate (AMP-backed: memory with `domain_tags: ["trace:skillscript:<name>"]`; file-backed: JSON log per fire).
- **Sample** — N% of fires recorded for telemetry without full volume.

When enabled, trace memory follows the "procedural memory" framing from CC's review — traces become re-runnable for debugging, not just historical record. `skillfile replay <trace_id>` replays the trace against current connectors.

## Lifecycle visibility

The dashboard (FR-8) reads from SkillStore via the §3 contract operations:

- *List view:* `skill_store.list({filter?})` returns SkillMeta[] for every skill in the library — name, description, status, last-fired, fire success rate, ops dispatch count.
- *Detail view:* `skill_store.metadata(name)` + `skill_store.versions(name)` shows skill source, version history, status transition log.
- *Status toggle:* `skill_store.update_status(name, new_state)` is the dashboard's primary write operation — operators flip Draft → Approved or Approved → Disabled via UI without CLI access.
- *Trigger inspection:* `list_triggers({skill?})` shows what's registered, when last fired, error rate, next scheduled fire.
- *Connector inspection:* `list_connectors()` shows what's wired up — which connector backs which contract, capability flags, recent error rate.

## Health metrics surface

Aggregate observability beyond per-fire detail:

- *Fire rate per skill* — N fires/day broken down by trigger source
- *Success rate per skill* — % of fires that completed without errors in `result.errors[]`
- *Error category breakdown* — for skills with non-zero error rate, distribution by op kind and error type
- *Connector health* — per-connector latency, error rate, last-successful-call timestamp
- *Lifecycle queue* — count of skills in each status state across the library

These power the dashboard's overview view. Operators see at a glance: which skills are misbehaving, which connectors are degraded, what's queued in Draft awaiting promotion.

## Sentinel diagnostics (CLI-facing audit tools)

- `skillfile diagram <skill>` — mermaid graph of control flow + dispatch. Audit artifact for human review.
- `skillfile audit <skill>` — dispatch shape report (every tool called, every memory write template, every model prompt template, declared inputs, declared output channels). Static analysis, no LLM.
- `skillfile sign <skill>` / `skillfile verify <skill>` — content-hash signing so reviewers confirm what's running matches what was reviewed.
- `skillfile audit <skill> --history` — fire history + error log for the skill. Reads the dispatch trace store.

## Trigger fire visibility

Every trigger fire records:
- skill_id + version compiled against
- trigger source + name + fire timestamp
- success/failure outcome
- error categories (if any)
- output channels emitted to (per skill's `# Output:` declaration)

Per-skill aggregate visible via dashboard or `skillfile fires <skill>`. Bounded retention — fires older than configurable threshold (default 30 days) auto-pruned.

The trigger fire log is what catches the kind of issue olsen-nightly experienced — a trigger that's registered, that fires nightly, but whose skill body errors silently. Without per-fire visibility, that pattern persists undetected. With it, the error rate per fire is visible at the dashboard level on day one.

## Dashboard architecture (FR-8 detail)

The dashboard is a separate process from skillscript-runtime. Communicates via the runtime's MCP server contract (§10):

- *Stack:* lightweight HTTP server + browser UI. Lean: small SPA bundled with the runtime, served at `localhost:<port>` by default. Configurable port + bind address for containerized deployments.
- *Auth:* v1 ships with no auth (single-user / localhost-only assumption). Operators deploying in shared environments configure reverse proxy with auth.
- *Read path:* dashboard polls runtime MCP server every N seconds for state. Calls `skill_list`, `list_triggers`, health-metrics endpoint.
- *Write path:* dashboard calls `skill_status({name, new_state})` for status transitions. Calls `skill_register_trigger` / `skill_unregister_trigger` for trigger management.
- *Containerization (NFR-13):* dashboard image published alongside runtime; can be run separately or co-deployed via `docker-compose.yml`.

The dashboard is the "operational control plane for non-engineers" per FR-8. Engineers can do everything via CLI; the dashboard exists for operators who need a one-click way to disable a misbehaving skill.

## Open questions for the observability thread

- *Trace memory volume.* Production deployments may produce thousands of fires/day. Default-on trace is probably wrong (storage + cost); default-off-with-error-only-trace is the safer floor. Configurable per-skill or per-trigger.
- *Centralized observability vs per-skill.* Does a deployment have ONE observability dashboard, or per-skill query surfaces? Probably both at maturity; per-skill query surface is the foundational layer.
- *Dashboard auth.* V1 no-auth is suitable for localhost; multi-user deployments need something. JWT? OAuth? Reverse-proxy assumption?
- *Real-time vs polling.* Dashboard polls runtime every N seconds today; should it use WebSockets or SSE for real-time updates? Probably v1.x — polling is simpler and works fine for "dashboard refreshing every 30s."

## §9 Performance bounds — what the runtime commits to

**Requirement.** The runtime commits to specific performance properties. These aren't aspirational targets — they're tested invariants the conformance suite verifies.

**Compile-time bounds:**
- *Sub-second for typical skillscripts.* "Typical" defined as: ≤ 100 ops total across all targets, ≤ 5 levels of nested conditionals/foreach, ≤ 20 referenced data skills.
- *Linear in skill size.* No exponential blowups from composition or variable resolution. A skillscript twice as large compiles in roughly twice the time.
- *Bounded memory footprint.* Compile-time memory usage stays under ~50MB for typical skills (no compiler-state leak across compiles).

**Runtime bounds:**
- *Sub-millisecond op dispatch overhead.* The runtime's per-op cost (variable substitution, dispatch routing, output binding) is under 1ms. Actual op execution time depends on the underlying call (LocalModel ~150ms warm, MCP tool call variable).
- *Bounded foreach iteration.* No unbounded loops; iteration count is the iterable's length, evaluated once. A skill iterating over 1000 items is bounded at 1000 iterations.
- *Per-op timeout enforcement.* Every op respects its configured timeout (skill-level header + per-op override + runtime default + built-in fallback). No op can hang the runtime indefinitely.

**Concurrency:**
- One skillscript executes single-threaded. No parallel op dispatch within a skill in v1. (v2 may add explicit `parallel:` blocks.)
- Multiple skillscripts can execute concurrently in independent runtime instances. The runtime is stateless across skill executions; concurrency is a deployment-level concern.

**Memory footprint:**
- Runtime base memory under ~100MB excluding connector implementations.
- Connector implementations (LocalModel especially — Ollama keeps models loaded) own their own memory budget, not the runtime's.

**Throughput targets:**
- Single-process runtime handles ≥ 100 concurrent skillscript executions before saturation. Higher throughput is a horizontal scale problem (multiple runtime instances), not a single-process tuning problem.

**Validation:**
- Performance benchmarks run as part of the conformance suite. Regressions fail the build.
- Real-fire benchmarks (production-shaped skill bodies, not synthetic) run nightly; results tracked over time.

**Open questions:**
- v1 single-process is fine; v2 needs to decide on the parallel `&` invocation model (skills calling skills — can they parallelize?). Probably yes, but with explicit syntax.
- Connector latency budgets — should the runtime enforce per-connector budgets (e.g., "no MCP call may exceed 30s")? Or leave to the connector? Probably per-connector config.

## §10 Distribution and integration — npm package, CLI, MCP server contract

**Requirement.** Skillscript-runtime ships as a single, installable package with three integration surfaces: CLI binary, library exports, MCP server. Distribution is friction-free; first-run installations work without elaborate configuration. Containerized deployment is first-class.

Satisfies PRD requirements FR-11 (CLI), FR-12 (MCP server contract), NFR-3 (memory footprint), NFR-4 (installability), NFR-13 (containerizable).

## Package shape

- *Single npm package* — `skillscript-runtime`. Installable via `npm install -g skillscript-runtime` (or `pnpm`, etc.). Cross-platform Node.js binary (Linux, macOS, Windows).
- *Single binary distribution* recommended for v1.x via `pkg` or similar — for non-Node environments and friction-free installs that don't require Node setup.
- *Container image* — published alongside npm. `docker pull skillscript-runtime:latest` works for containerized deployments without npm dependency.

## CLI binary (`skillfile`)

Author-facing commands:
- `skillfile init` — scaffolds a working config + sample skillscript in `~/.skillscript/` (overridable). First-run friendly.
- `skillfile run <path|name> --input KEY=value` — execute a skillscript (compile + run)
- `skillfile compile <path|name>` — render the compiled artifact (Skill-shaped output)
- `skillfile lint <path>` — run static validation
- `skillfile diagram <path>` — render mermaid graph
- `skillfile audit <path>` — dispatch shape report (per §8 observability)
- `skillfile sign <path>` / `skillfile verify <path>` — content-hash signing for audit

Operator-facing commands:
- `skillfile list` — show available skillscripts (per configured SkillStore)
- `skillfile status <skill> <new-state>` — transition lifecycle state (Draft / Approved / Disabled per decision 6)
- `skillfile register-trigger <skill> <source> <name>` — imperative trigger registration
- `skillfile list-triggers` — show active trigger registry

## Library exports

`import { compile, execute, lint, render, audit } from 'skillscript-runtime'` for embedding in larger TypeScript/Node applications. Exports follow semver per §11. Breaking changes documented per the versioning policy.

## MCP server contract (FR-12)

`skillscript-runtime` itself exposes an MCP server (`skillfile-mcp` or similar). Tools surfaced:

- `skill_run({skill_id|path, inputs})` → result
- `skill_compile({skill_id|path, inputs, mechanical?})` → rendered artifact
- `skill_lint({skill_id|path})` → validation report
- `skill_list({filter?})` / `skill_get({skill_id|path})` — discovery
- `skill_status({skill_id|path, new_state})` — lifecycle transitions
- `skill_register_trigger`, `skill_list_triggers`, `skill_unregister_trigger`

Compatibility: works as MCP server for Claude Desktop, Claude Code, Cursor, any MCP-aware client. The MCP server is how agents in those clients invoke skills without direct CLI access.

## Plugin loader (per decision 4)

Plugins (filter implementations, connector implementations beyond bundled defaults) load from two locations:

- *Filesystem:* `~/.skillscript/plugins/` (overridable via env var `SKILLSCRIPT_PLUGINS_DIR` or `plugins.local_dir` in config). For experimentation, local dev loop, deployment-specific extensions.
- *npm packages:* discovered via standard Node resolution as `node_modules/skillscript-plugin-*`. For distribution, team-shared extensions, signed/versioned plugin libraries.

**Resolution order** (per decision 4): default `["filesystem", "packages"]` — filesystem wins when a plugin name resolves in both locations. Operators invert via config:

```toml
[plugins]
resolution_order = ["filesystem", "packages"]   # default — filesystem wins
# or:
resolution_order = ["packages", "filesystem"]   # packages win
# or:
resolution_order = ["packages"]                 # filesystem disabled (no local overrides)
```

Security-conscious deployments set `["packages"]` and reject filesystem plugins entirely. Operators see this is a deployment policy choice, not a language constraint.

**Collision detection:** when both locations have the same plugin name, lint warns ("plugin `my-hash-filter` resolves to filesystem version 0.3.1 but packages also provide 0.4.0; filesystem wins per config"). Author can decide which to keep.

## Configuration

Config discovery via three-layer resolution (per NFR-13 containerization requirement):

1. *Env vars* — `SKILLFILE_CONFIG`, `SKILLSCRIPT_PLUGINS_DIR`, per-connector overrides. Ad-hoc / per-process override.
2. *Working-dir / agent-scoped `skillfile.config.toml`* — persistent per-deployment config.
3. *Bundled defaults* — shipping with the package. Sensible for first-run.

**Bundled defaults** (per §3):
- SkillStore: filesystem at `~/.skillscript/skills/`
- MemoryStore: SQLite at `~/.skillscript/memory.db`
- LocalModel: Ollama at `localhost:11434` with `gemma2:9b` and `qwen2.5:7b` registered as `default` and `qwen` respectively
- McpConnector: no servers wired by default; commented example in init scaffold

All defaults are file paths or `localhost` references — explicitly overridable when running in a container.

## Friction-free first run (NFR-4)

```
npm install -g skillscript-runtime
skillfile init
skillfile run examples/hello.skill
```

Three commands. Working installation. Bundled examples demonstrate each form (autonomous, inline, compile-to-skill — mirroring the PRD's Use Cases section).

## Containerization (NFR-13)

The runtime ships with first-class containerization support:

- **Published container image** — `skillscript-runtime:latest` on Docker Hub (or org-equivalent). Multi-arch (linux/amd64, linux/arm64).
- **Sample `docker-compose.yml`** in the package — wires `skillscript-runtime` alongside `ollama` (for LocalModel) and a SQLite volume (for MemoryStore and SkillStore filesystem backend). Demonstrates a working deployment.
- **Configuration via env vars** — every config field has a corresponding env var (`SKILLSCRIPT_MEMORY_DB_PATH`, `SKILLSCRIPT_OLLAMA_URL`, etc.). Containers can be configured entirely via env without mounting a config file.
- **Secrets handling** — supports container-mounted secrets at `/run/secrets/<name>` (Docker/Kubernetes convention). Credentials referenced by path in `connectors.json`.
- **Plugin loading in containers** — `~/.skillscript/plugins/` is mountable via volume; `node_modules/skillscript-plugin-*` works as in any Node app. Security-conscious deployments set `plugins.resolution_order = ["packages"]` and don't mount the filesystem plugins dir at all.

## Open questions for the distribution thread

- **Container image base.** `node:alpine` (small) vs `node:slim` (more compatible) vs distroless. Lean toward distroless for security-conscious deployments; `node:alpine` for the default image.
- **IDE integration.** VS Code extension for syntax highlighting + lint? Probably v1.x deferral. Workable for v1: tree-sitter grammar published as a separate package so any IDE with tree-sitter support gets highlighting.
- **Distribution beyond npm.** Homebrew, apt, Chocolatey. Probably v2; v1 sticks to npm + container image + manual install.
- **Versioning + auto-update.** Does the CLI check for updates? Lean: no auto-update; explicit `skillfile self-update` command in v1.x.

## §11 Versioning and backward compatibility — language version, breaking-change discipline

**Requirement.** Skillscript follows semantic versioning at the language level. Breaking changes to language grammar or runtime contract are clearly demarcated; deprecation periods give authors time to migrate.

**Language version:**
- *Major.* Breaking changes to grammar or semantics. New major version = old skillscripts may not compile or execute correctly. Mandatory migration tooling ships alongside.
- *Minor.* New ops, new filters, new triggers, new output kinds. Existing skillscripts unaffected. Compiler is forward-compatible (older sources compile under newer minor versions).
- *Patch.* Bug fixes, performance improvements, lint rule additions. No language surface changes.

**Skillscript-source version declaration:**
- Skillscripts may declare `# Language: 1.x` to lock to a specific language version. Compiler reads the declaration and applies version-appropriate semantics.
- Default version (if declaration omitted): latest stable.

**Connector contract version:**
- `MemoryStore` / `LocalModel` / `McpConnector` / `SkillStore` contracts versioned independently from the language. Connector implementations declare which contract version they implement.
- Runtime checks compatibility at startup; refuses to wire a connector that implements an incompatible contract version.

**Deprecation discipline:**
- Deprecated language features compile-warn for at least one minor version before becoming compile errors in the next major.
- Migration tooling: `skillfile migrate <path>` walks a skillscript, identifies deprecated patterns, proposes replacements. Authoring assistance, not automated rewrite.

**Breaking-change criteria** (what counts as a major-version bump):
- Removing or renaming an op kind (e.g., killing `?` op).
- Changing the semantics of an existing op (e.g., changing `$` op error propagation).
- Changing the connector contract surface in non-additive ways.
- Removing or renaming a filter.

**Non-breaking criteria** (minor or patch):
- Adding a new op, filter, header, trigger source, or output kind.
- Adding a new contract method (additive).
- Adding a new lint rule (tier 1/2/3 advisory; existing skills re-linted).
- Bug fixes that align behavior with documented spec.

**Compatibility commitment:**
- Once a major version ships, no breaking changes within that major for at least 12 months.
- Major versions supported with patches for at least 12 months after the next major ships (overlap period).

**Open questions:**
- Language version vs runtime version — should they be tied or independent? Probably tied (runtime implements one language version at a time, with explicit compatibility matrix).
- Per-skill version pinning for executed-by-old-runtime case — if a skillscript declares `# Language: 1.x` but the runtime is `2.x`, runtime should compile under 1.x semantics. Specify the runtime's multi-version compile capability.
- Connector contract evolution — how do existing skillscripts behave when a connector contract grows? Skillscripts don't see the connector contract directly (they see the ops); contract evolution should be invisible to source.

---

*Rendered from `skillscript/skillscript-erd` — 2026-05-20 13:56 EDT*  
*Source of truth: AMP (`amp_render_document("skillscript/skillscript-erd")`)*