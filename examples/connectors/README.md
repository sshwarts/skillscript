# examples/connectors/

Worked examples + fork-me templates for adopter-written connectors. The bundled defaults live in `src/connectors/`; this directory holds patterns for adopters writing their own.

## Connector landscape

| Contract | Bundled defaults | Worked example | Fork template |
|---|---|---|---|
| `SkillStore` | `FilesystemSkillStore`, `SqliteSkillStore` (in `src/connectors/`) | — | **[SkillStoreTemplate/](./SkillStoreTemplate/)** |
| `DataStore` | `SqliteDataStore` (in `src/connectors/`) | — | **[DataStoreTemplate/](./DataStoreTemplate/)** |
| `LocalModel` | `OllamaLocalModel` (in `src/connectors/`; opt-in via substrate config) | — | **[LocalModelTemplate/](./LocalModelTemplate/)** |
| `McpConnector` | `HttpMcpConnector`, `RemoteMcpConnector`, `CallbackMcpConnector`, `LocalModelMcpConnector`, `DataStoreMcpConnector`, `SkillStoreMcpConnector` (in `src/connectors/`) | **[RestConnector/](./RestConnector/)** | **[McpConnectorTemplate/](./McpConnectorTemplate/)** |
| `AgentConnector` | `NoOpAgentConnector` (in `src/connectors/`) | **[HttpWebhookAgentConnector/](./HttpWebhookAgentConnector/)** | — |

**Bundled defaults** are runnable out of the box — wired through `connectors.json` substrate config or programmatic bootstrap.

**Worked examples** are real implementations for substrates that aren't bundled — copy + customize for your specific deployment. HttpWebhookAgentConnector demonstrates the AgentConnector contract against a generic HTTP-webhook substrate. RestConnector demonstrates that the McpConnector contract is wire-protocol-agnostic — it fronts a plain REST/HTTP API (no MCP wire protocol), and coexists in the same registry with actual MCP connectors.

**Fork templates** are skeletons (every method throws TODO). Useful when you want the bare contract surface without any specific substrate assumptions. SkillStoreTemplate is the starting point for Postgres-, MongoDB-, AMP-, or vector-DB-backed SkillStore impls.

## Forking workflow (any connector type)

1. **Pick your starting point**:
   - Fork from a worked example if it's close to your substrate (e.g., another HTTP service → fork HttpWebhookAgentConnector)
   - Fork from a template if you're targeting a substrate type not yet demonstrated (e.g., Postgres SkillStore → fork SkillStoreTemplate)
   - Fork from `src/connectors/` if you want the bundled default's behavior as a starting point (e.g., another SQL flavor → adapt sqlite-skill-store.ts)
2. **Copy the directory** into your codebase
3. **Implement against your substrate** (each method has a TODO comment)
4. **Update `staticCapabilities()`** to declare what your impl actually supports
5. **Register via `Registry.register*`** from your bootstrap
6. **Validate via the conformance suite** (`<Contract>Conformance.buildTests()` from `skillscript-runtime/testing`)

## Reference materials

- **[`docs/configuration.md`](../../docs/configuration.md)** — substrate selection via `connectors.json`; programmatic-bootstrap vs declarative patterns
- **[`docs/adopter-playbook.md`](../../docs/adopter-playbook.md)** — Case 1 vs Case 2 wiring decisions; two-instance posture; upstream-merge-friendly conventions
- **[`docs/connector-contract-reference.md`](../../docs/connector-contract-reference.md)** — interface contracts for adopter agents writing connector impls
- **`src/connectors/types.ts`** — authoritative contract interfaces (SkillStore, DataStore, LocalModel, McpConnector)
- **`src/testing/conformance.ts`** — the per-contract conformance test suites

## Naming convention

Bundled defaults in `src/connectors/`: `<Substrate><Contract>` (e.g., `FilesystemSkillStore`, `SqliteSkillStore`, `OllamaLocalModel`).

Worked examples + adopter forks in `examples/connectors/`: same `<Substrate><Contract>` pattern (e.g., `HttpWebhookAgentConnector`, your `PostgresSkillStore`).

Templates: `<Contract>Template` (e.g., `SkillStoreTemplate`).
