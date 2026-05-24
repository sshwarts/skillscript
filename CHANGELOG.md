# Changelog

## 0.4.3 — 2026-05-24

**CLI auto-discovers `connectors.json` from `$SKILLSCRIPT_HOME`.** Closes
the v0.4.x arc's last-mile gap: pre-v0.4.3, the loader + lint + runtime
+ allowlist all worked, but `skillfile dashboard` and `skillfile serve`
(both via `cmdRuntimeHost`) called `bootstrap()` without
`connectorsConfigPath`. The scaffold's `connectors.json` was dead-on-
arrival via the canonical CLI path.

### Fixed

- **`cmdRuntimeHost` now passes `connectorsConfigPath: $SKILLSCRIPT_HOME/connectors.json`** to `bootstrap()`. The loader is graceful on missing files (returns empty result), so the default is safe for users without a connectors.json. Bug since v0.4.0.

### Added

- **`--connectors PATH` flag** on `skillfile dashboard` and `skillfile serve` — overrides the default for non-standard layouts. Useful for testing connectors-as-config without modifying `$SKILLSCRIPT_HOME/connectors.json`.

### Implementation notes

- **One-line behavior change.** No architecture impact; just wires the existing config-path through the existing bootstrap API.
- **Tests:** 5 new in `tests/v0.4.3.test.ts` covering `--help` flag presence, bootstrap path resolution, graceful-missing handling, and a source-level regression-lock to guard against silent regression of the wire-up.
- **LOC unchanged at 6593/6600.** Ergonomic patch; no language surface changes.

## 0.4.2 — 2026-05-24

**Markdown support + strict-target detection + `# Autonomous: true`
header.** Closes the cold-author footgun where `.skill.md` files with
markdown prose around the skill code triggered misleading
`missing-dependency` cascade errors (`fbf10206`). Adds the canonical
declarative marker for autonomous-execution skills.

Spec: Perry approval `08a08316` + amendment `f352413d` + final
greenlight `efad035f`.

### Added

- **Markdown extraction at parser layer** — `parse()` scans the
  source for the first ` ```skillscript ` or ` ```skill ` fenced block
  and parses its contents. Cold-author LLMs writing markdown prose
  around their skill code get extraction automatically. Lives in the
  parser, not the skill store — clean layering per Scott's read
  ("storage shouldn't be the format-dispatch layer").

  **Lenient by design**: if no fenced block is found, the whole source
  parses as raw (existing behavior). Backward-compatible with every
  existing `.skill.md` file — no migration, no breakage. The fenced-
  block convention is the *recommended* shape for files with prose;
  pure-code files keep working as-is.

  ```
  # Welcome
  Use this skill for the morning sweep.
  
  ```skillscript
  # Skill: morning-sweep
  # Status: Approved
  run:
      ! morning
  default: run
  \`\`\`
  ```

- **Strict-target-detection** — target declaration lines now require
  `<ident>:` shape (matching `[A-Za-z_][\w-]*`). Prose lines like
  `## Use this:` or `Note (important):` are silently treated as
  comments instead of misread as malformed target declarations. Pairs
  with markdown extraction: even without a fenced block, prose lines
  no longer cascade into misleading missing-dep errors.

- **`# Autonomous: true | false` header** — declarative authorship
  intent marker for unattended-execution skills (cron-fired, agent-
  fired, etc.). Today silences `unconfirmed-mutation` lint warnings
  for the whole skill (since the user-confirmation pattern doesn't
  apply to autonomous skills). Implemented as a category marker on
  `ParsedSkill.autonomous` so future rules + scheduling defaults +
  discovery surfaces can hook into the same field without breaking-
  change — per Perry's framing in `efad035f`.

### Fixed

- **`unconfirmed-mutation` lint conditional on `# Autonomous`** —
  pre-existing rule from v0.2.11 (`Bug 6`) now properly distinguishes
  interactive skills from autonomous ones. Cold-author skills that
  legitimately invoke mutating tools without `??` confirmation
  (cron-fired log-monitoring → YouTrack issue creation, etc.) declare
  intent via the header instead of seeing false-positive warnings.

### Implementation notes

- **Parser-layer extraction** matters because file-extension dispatch
  (the rejected alternative path) would have coupled the skill store
  to markdown semantics. Storage stays format-agnostic; parser handles
  the markdown wrapper concern locally. No skill store changes in this
  release.

- **Tests:** 23 new across `tests/v0.4.2-autonomous.test.ts` (10 —
  header recognition + lint conditional + help-content) and
  `tests/v0.4.2-markdown.test.ts` (13 — extractor + parse integration +
  strict-target-detection + end-to-end cold-author footgun closure).
  Total 965 passing in the suite (3 long-skip browser dogfood).

- **No LOC ceiling nudge.** 6593/6600 — under by 7. The ergonomic
  fixes are small enough to fit in the v0.4.1 ceiling without
  expansion.

## 0.4.1 — 2026-05-24

**`RemoteMcpConnector` + per-connector tool allowlist + YouTrack proving
end-to-end.** First "external-MCP-in-Skillscript" release. v0.4.0
shipped the config-plumbing mechanism (loader, validation, lint,
discovery, discipline); v0.4.1 ships the first JSON-instantiable
connector class and proves it works against real YouTrack through the
`mcp-remote` bridge.

Spec: Perry kickoff `c65e77af` + amendments `8a7356dc` (allowlist) +
`89e2752d` (Scott's framing/scope answers).

### Added

- **`RemoteMcpConnector` class** (`src/connectors/mcp-remote.ts`). Child-
  process spawn + JSON-RPC stdio bridge. Lifecycle: initialize
  handshake, `tools/call` dispatch, clean shutdown via `shutdown` request
  → SIGTERM → SIGKILL fallback. No auto-restart in v0.4.1 — child crash
  puts the connector into an error state; subsequent dispatch throws
  `RemoteMcpDispatchError`. Library-level `connector.call()` returns the
  raw MCP `{content, isError}` envelope; runtime's `unwrapToolResult`
  does the convention-aware unwrap (text → `JSON.parse`).

- **Closed-set class registry adds `RemoteMcpConnector`** with
  `fromConfig` factory. Existing v0.4.0 `connectors.json` shapes pointing
  at this class now instantiate cleanly.

- **`framing` config option** — `"lsp"` (default) or `"newline"`. The
  YouTrack proving case exposed that `mcp-remote` speaks newline-
  delimited JSON-RPC, NOT LSP `Content-Length` headers. The
  config-driven option (item 5 of the kickoff) is exactly the escape
  hatch needed. Lint rejects unknown framing values.

- **Per-connector `allowed_tools` allowlist**. Optional config field on
  connectors.json entries. Semantics: `undefined` = allow-all
  (backward-compat with v0.4.0); `[]` = allow-none (staging disable
  pattern); listed = exactly these tools, nothing else.
  - New tier-1 lint rule `disallowed-tool` fires at compile time on
    `$ name.tool` where `tool` isn't in the allowlist
  - Runtime defense-in-depth: dispatcher refuses disallowed calls even
    if lint is bypassed (the "fail closed even when lint missed it"
    backstop per `8a7356dc`)
  - `runtime_capabilities` surfaces effective allowlist per connector
    (or `null` for allow-all)

- **Env-block-as-scope `${VAR}` substitution.** v0.4.0 only resolved
  `${VAR}` from `process.env`. v0.4.1 resolves the connector's `env`
  block first, then merges into the substitution scope for the rest of
  the config. Composable shape from Claude Desktop's `mcp.json`:

  ```json
  "args": [..., "--header", "Authorization:${AUTH_HEADER}"],
  "env":  { "AUTH_HEADER": "Bearer ${YOUTRACK_TOKEN}" }
  ```

  `YOUTRACK_TOKEN` resolves from process env; `AUTH_HEADER` derives once
  in the env block; args reference the derived value.

- **Loader-time gitignore-detection warning** (folded v0.4.0 deferral).
  At startup, if `connectors.json` is detected in a `.git`-tracked
  directory without a `.gitignore` entry covering it, emit a one-time
  stderr warning. Informational; doesn't block startup.

- **`unknown-connector` lint auto-wires from runtime registry** (folded
  v0.4.0 deferral, closes Perry's signoff observation `a4ae08a6`). MCP
  `lint_skill` + `compile_skill` handlers auto-pass the running
  runtime's `registry` to lint, so `unknown-connector` + `disallowed-
  tool` fire by default without callers having to remember explicit
  options. Cold-author callers targeting a different runtime can
  override via explicit `mcpConnectorNames` / `mcpConnectorAllowedTools`.

- **`foreach` over parsed-JSON arrays** (folded v0.4.0 deferral). v0.2.5
  extended `in`-RHS to tolerate JSON-string values that parse to arrays;
  v0.4.1 mirrors that tolerance into `foreach`. Lets
  `foreach I in $(RAW):` work when `RAW` is a string that JSON-parses
  to an array (e.g., from a `~` op response). `$ json_parse`-bound
  arrays already worked since the parsed structure is in the vars map
  directly.

- **Kwarg type coercion in `$` op calls.** Pre-v0.4.1, `limit=5` in
  `$ youtrack.search_issues query="for: me" limit=5` was sent as the
  string `"5"`. YouTrack (and other typed MCPs) rejected with "expected
  integer, got String." v0.4.1 adds `coerceKwargValue` in
  `parseToolArgs`: unquoted `^-?\d+$` → integer, `^-?\d+\.\d+$` →
  number, `true`/`false` → boolean, `null` → null,
  `[...]`/`{...}` shapes → JSON-parsed if valid. Quoted strings force
  the string type (`count="5"` stays "5").

- **YouTrack proving end-to-end** (`tests/v0.4.1-youtrack-proving.test.ts`).
  8 tests covering direct connector dispatch (initialize, tools/list,
  `get_current_user`, `search_issues` with integer kwarg), full skill
  chain (`examples/youtrack-morning-sweep.skill.md` compile + execute),
  kwarg type coercion regression-lock, allowlist enforcement (positive +
  negative against real YouTrack). Always-fail-if-`YOUTRACK_TEST_TOKEN`-
  missing per Scott's call (`89e2752d`). CI workflow updated.

### Example skill

`examples/youtrack-morning-sweep.skill.md` checked in — the canonical
"external remote MCP in Skillscript" proving case. Compiles + executes
against real YouTrack given a configured `youtrack` connector.

### Implementation notes

- **Narrow-core LOC ceiling 6000 → 6600.** ~330 LOC for the
  `mcp-remote.ts` connector class (spawn + framing + lifecycle), ~60
  LOC across Registry + config + lint + runtime for allowlist
  plumbing, ~40 LOC for env-block-as-scope substitution refactor, ~50
  LOC for kwarg coercion + foreach JSON tolerance + lint auto-wire
  threading. ~50 LOC for the gitignore-detection helper. New file
  takes us to 15 narrow-core files; ceiling stays under 20.

- **Tests:** 50 new across `tests/v0.4.1-mcp-remote.test.ts` (21 —
  bridge core via mock child processes), `tests/v0.4.1-allowlist.test.ts`
  (17 — allowed_tools loader + lint + runtime + discovery),
  `tests/v0.4.1-folded.test.ts` (12 — gitignore detection, lint auto-
  wire, foreach over parsed-JSON), plus 8 in
  `tests/v0.4.1-youtrack-proving.test.ts` (live YouTrack chain). Total
  58 new; 955 passing in the suite (3 long-skip browser dogfood).

- **CI requires `YOUTRACK_TEST_TOKEN` secret.** Set in repo settings.
  Token should be allowlist-scoped (read-only YouTrack tools), not a
  personal admin token. Failure-mode is loud: missing token → CI fails
  at the test step → no publish (avoids silent regression).

## 0.4.0 — 2026-05-24

**`connectors.json` loader + credential discipline (config plumbing).**
First MCP-scripting-era release. Wires the per-host connector
configuration the ERD §3+§4 spec has called for since T2. Loads
`connectors.json` at runtime startup, parses + validates, resolves
`${VAR}` substitutions, and registers each declared instance into the
Registry. Closed-set class registry + two new tier-1 lint rules. Spec
at `b3f6c5ed` (Perry kickoff) + `58a9d3d3` (credential amendment) +
`8f723b6a` (final approval).

**Split note:** `RemoteMcpConnector` (the stdio-bridge class for remote
MCPs via `mcp-remote` etc.) deferred to v0.4.1. v0.4.0 ships the
mechanism — loader, validation, lint, discovery, credential discipline
— but the only class in the v0.4.0 closed set (`CallbackMcpConnector`)
isn't JSON-instantiable (it requires a dispatch function). v0.4.1
adds `RemoteMcpConnector` as the first real configurable class, plus
the YouTrack end-to-end proving test.

### Added

- **`connectors.json` loader.** Reads from `BootstrapOpts.connectorsConfigPath`
  (caller-supplied path; bootstrap stays explicit, doesn't auto-discover).
  Missing file → graceful empty result. Malformed JSON / structural
  errors / unknown class / unset `${VAR}` → clear startup errors via
  `BootstrapResult.connectorConfigErrors`. Permissive on unknown
  fields so v0.4.1 schema additions (`allowed_tools`, etc.) plug in
  without breaking compat.

- **Credential resolution: two shapes.** Matches Claude Desktop's
  `mcp.json` convention:
  - Literal: `"AUTH_HEADER": "Bearer plnt-..."` (in-file)
  - Env-var substitution: `"AUTH_HEADER": "Bearer ${YOUTRACK_TOKEN}"`
    (resolved from `process.env` at load time)

  Missing `${VAR}` → clear error (not silent empty-string substitution).
  Both shapes work; deployments should prefer `${VAR}` per the
  credential-discipline section.

- **Closed-set class registry.** v0.4.0 set: `{CallbackMcpConnector}`.
  Plugin-style runtime-arbitrary class loading deliberately out of
  scope (security surface, discoverability, API maturity). Unknown
  class in `connectors.json` → clear startup error listing the known
  set. The set grows via CHANGELOG-tracked runtime releases.

- **`unknown-connector` tier-1 lint.** Fires on `$ name.tool` ops
  where `name` isn't a wired connector. Includes the list of wired
  names in the diagnostic so cold authors can correct typos quickly.
  Silent when the caller doesn't know what's wired (no false positives).

- **`unknown-connector-class` tier-1 lint** (Perry's sibling addition,
  `8f723b6a`). Re-surfaces the loader's "unknown connector class"
  errors via the lint API for tooling that consumes lint as the
  primary diagnostic surface (compile_skill / lint_skill MCP).

- **`runtime_capabilities` discovery extension.** New `include`
  option: `mcpConnectorClasses` returns the closed-set class names.
  Cold authors introspect "what classes can I configure?" before
  writing `class: "..."` fields.

- **Credential discipline (hard requirement).** Perry's amendment
  promoted from footnote to ship requirement:
  - `connectors.json` added to repo root `.gitignore` (root-anchored
    so the scaffold's bundled placeholder stays tracked)
  - `connectors.json.example` shipped at repo root as the version-
    controlled template
  - README "Connector model" section documents both credential
    shapes + the gitignore default + the discipline rationale
  - Loader-time gitignore-detection warning deferred to v0.4.1

### New module

- **`src/connectors/config.ts`** — loader + env substitution + closed-set
  class registry. ~190 LOC including docstrings. Public surface:
  `loadConnectorsConfig({path, env?})`, `listKnownConnectorClasses()`,
  `resolveEnvSubstitution(value, env)`, `KNOWN_CONNECTOR_CLASSES`.

### Implementation notes

- **Narrow-core LOC ceiling 5750 → 6000.** Net ~190 LOC from the new
  `connectors/config.ts` module plus ~50 for the two lint rules and
  the `mcpConnectorNames` LintContext field. Consistent with v0.3.0's
  200-LOC nudge for `$append`. History entry in `loc-ceiling.mjs`.

- **`BootstrapOpts.connectorsConfigPath`** is explicit (no auto-
  discovery from CWD). Embedders pass the path; the CLI's
  `skillfile dashboard` / `skillfile serve` / `skillfile execute`
  surfaces will auto-pass `${cwd()}/connectors.json` in v0.4.1+ once
  RemoteMcpConnector makes the file practically useful. Until then,
  embedders opt in explicitly.

- **Tests:** 31 new in `tests/v0.4.0.test.ts` covering loader basics
  (missing file, malformed JSON, structural errors, unknown class),
  env substitution (literal pass-through, `${NAME}` resolution,
  missing var error, multiple substitutions, lowercase-name ignore),
  closed-set registry (v0.4.0 set, no RemoteMcpConnector yet),
  bootstrap wiring (graceful missing, errors surface, no false adds),
  both lint rules (positive + negative + silent-when-undefined),
  runtime_capabilities surface, and credential discipline (gitignore +
  example + README content). 897/901 passing (3 long-skip browser
  dogfood).

## 0.3.4 — 2026-05-24

**Conditional multi-filter chain + parse-error dedup + unified sink-scope
parser recovery.** Closes the recurring "filter chain works in
substitution but lags in conditional grammar" pattern named in dev-log
§14 (`a838ca2d`) — third occurrence in the v0.3.x arc. Spec drafted at
`7bafcc8c` (Perry), approved at `221982fc`.

### Added

- **Filter chain support in conditions.** Pre-v0.3.4 the six condition
  regexes (TRUTHY / EQ / EQ_REF / CMP / CMP_REF / IN) captured at most
  one filter — `if $(X|json_parse|length) > "0":` failed grammar
  despite `substituteRuntime` having supported chains since v0.3.2.
  Now both layers carry identical chain semantics. New
  `applyFilterChain(value, chain)` helper in `runtime.ts` (single-
  sourced split + per-filter loop, mirrors `substituteRuntime`'s
  chain-apply at line 1158).

  ```
  if $(X|trim|length) > "0":             ← compiles + evaluates
  if $(A|trim) == $(B|trim):             ← chain on both sides
  if $(A|trim|length) > "0" and          ← chain inside compound
     $(B|trim|length) > "0":
  ```

  No change to compound dispatcher (and/or/not splitter operates above
  the leaf-shape layer; chain only touches leaf matchers).

### Fixed

- **Duplicate parse-error echo across five tier-1 rules (item 2 + fold).**
  Pre-v0.3.4, the generic `parse-error` rule and five specific tier-1
  rules each fired with identical message bodies when their owned shape
  fired — cold authors saw every diagnostic twice. `PARSE_ERROR` rule
  now skips messages owned by `invalid-conditional-syntax`,
  `single-equals`, `malformed-op-grammar`, `reserved-keyword`, and
  `indentation` (the full audit of tier-1 rules that filter
  `parsed.parseErrors`). Catch-all behavior intact for the residual
  shapes (header issues, malformed `foreach`/`needs`, etc.). Closes
  Perry's signoff-time adjacent finding (`61b28daf`).

- **Unified parser-recovery on all condition-rejection paths.** v0.3.3
  added sink-scope frames after rejected `if` / `elif` conditions
  (Bug D) so body lines wouldn't cascade into phantom "Mid-block indent
  change" errors. The single-`=` rejection path was missed in that
  pass — same cascade fired for those authors. v0.3.4 extends the
  sink-scope treatment to the single-`=` paths in both `if` and
  `elif`, making parser-recovery consistent across all
  condition-rejection paths.

### Implementation notes

- **Narrow-core LOC ceiling 5700 → 5750.** Net ~60 LOC: ~30 for the
  12-regex chain sweep (6 in `runtime.ts` + 6 in `parser.ts`) +
  `applyFilterChain` helper, ~5 for the `PARSE_ERROR` filter (item 2),
  ~25 for sink-scope consistency on the single-`=` rejection paths.
  History entry in `scripts/loc-ceiling.mjs`.

- **Tests:** 19 new in `tests/v0.3.4.test.ts` covering parser
  acceptance of chains in all five condition shapes, runtime
  evaluation of chains via `evalCondition`, compound-with-chains
  cross-feature interaction, parse-error dedup for all five owning
  tier-1 rules (`invalid-conditional-syntax`, `single-equals`,
  `malformed-op-grammar`, `reserved-keyword`, `indentation`), and
  regression coverage for non-conditional parse-error paths. Plus 1
  update in `tests/lint.test.ts` reflecting the dedup. 867/870
  passing (3 long-skip browser dogfood).

## 0.3.3 — 2026-05-23

**`$ json_parse` op + `|json_parse` filter removal + cleaner conditional
error UX.** Closes the v0.3.2 spec promise from `af14b7d8` (Perry's
signoff finding `0a409c5c`): `|json_parse` filter was string-in/string-
out, so `.field` access on parsed JSON couldn't propagate structure
through the filter signature. v0.3.3 ships the deferred `$ json_parse`
intercept named in lesson `dc824ee4`, which binds the parsed value as
structured so `resolveRef`'s existing dotted descent handles `$(P.field)`
in conditions + emit for free. Same end-user outcome, no
condition-grammar surface change.

### Breaking change

- **`|json_parse` filter removed.** Use the new `$ json_parse $(VAR) ->
  OUT` op instead. Reason: verb collision risk if both surfaces shared
  `json_parse`, and the filter's actual utility (round-trip through
  `JSON.parse` + `JSON.stringify`) is thin enough that the
  disambiguation cost outweighed the use case. Anyone who actually
  wanted normalized JSON can compose `$ json_parse $(X) -> P` then
  `$(P|json)` with the existing stringify filter. Easier to add back as
  a wrapper later than carry a confused dual-surface forward.

### Added

- **`$ json_parse $(VAR) -> OUT` op (built-in).** Parses the post-
  substitution input as JSON and binds the parsed value (object / array
  / scalar) to `OUT` in the vars map. `resolveRef`'s existing dotted
  descent then handles `$(OUT.field)` in conditions, emit bodies,
  retrieval queries, etc. — no filter+field grammar gymnastics. Mirrors
  the `$ execute_skill` intercept shape in `runtime.ts`.

  ```
  # Vars: PAYLOAD={"status":"ok","count":3}
  read:
      $ json_parse $(PAYLOAD) -> P
      if $(P.status) == "ok" and $(P.count) > "0":
          ! processing $(P.count) items
  ```

  Throws structured error on malformed input (caught by `else:` /
  `# OnError:`). Throws when the input expression is empty.

- **`unparsed-json-field-access` lint advisory (tier-3, info).** Static
  detection of `$(VAR|json_parse).field` in any op text — emit bodies,
  `$set`/`$append` values, `foreach` lists, retrieval/local-model/amp
  params. Remediation points at the new op. (In condition contexts the
  parser rejection fires first as tier-1 with the same remediation
  text.)

- **`CompileResult.advisories: string[]`** and tier-2 lint findings
  carried into `CompileResult.warnings` (was only the orphan-target
  message before). Closes Perry's spec scope item #4 from `af14b7d8`
  — cold authors get separate `warnings` + `advisories` surfaces in
  `compile_skill` MCP responses instead of having to introspect
  separately. Each entry formatted as `<rule>: <message>`.

### Fixed

- **Indent cascade after rejected conditions (Bug D).** Pre-v0.3.3,
  when an `if`/`elif` condition was rejected (`Unsupported condition`
  error), the body lines correctly indented under the rejected block
  triggered a spurious `Mid-block indent change` cascade. Cold authors
  chased phantom indent bugs instead of the real condition issue. The
  parser now pushes a sink scope frame after a rejected condition so
  body lines collect into a throwaway bucket and drop at scope pop.
  Real condition error still surfaces; phantom indent error doesn't.

- **`invalid-conditional-syntax` error message updated (Bug B).** Pre-
  v0.3.3 the parser error and lint rule both claimed "v1 grammar is
  truthy / `==` / `!=` against quoted literals, or `in` / `not in`
  between two `$(NAME)` refs" — stale since v0.2.5 (comparison ops)
  and outright wrong since v0.3.2 (`and`/`or`/`not` shipped). New
  message enumerates current supported shapes accurately AND points
  at `$ json_parse` as the remediation for the `$(VAR|filter).field`
  shape.

### Implementation notes

- **Narrow-core LOC ceiling 5650 → 5700.** Net ~50 LOC: ~25 for the
  runtime `$ json_parse` intercept, ~30 for the new lint advisory
  walker, ~10 for parser sink-scope frames (Bug D), ~5 for compile.ts
  tier-2/tier-3 plumbing, minus ~10 for the yanked `|json_parse` filter
  case. History entry in `scripts/loc-ceiling.mjs`.

- **Tests:** 24 new in `tests/v0.3.3.test.ts` covering the op (parser
  + runtime + dotted descent + array/scalar handling + error paths),
  filter removal (negative coverage), lint advisory, error-message
  updates, indent-cascade sanity (Bug D), help surface, and Bug C
  `CompileResult.advisories` surface. 848/851 passing (3 long-skip
  browser dogfood).

## 0.3.2 — 2026-05-23

**Boolean trio + `|json_parse` filter + filter chain support.** v0.3.2
closes the conditional grammar gap that drove cold authors into nested-
if workarounds (and the falsy-check gap that had no current form), plus
ships the JSON validation/normalization primitive Perry's harness asked
for. Spec drafted in memory `d01c9ab9`, refined for recursive structural
decomposition (NOT a full parser rewrite) in `08759d74`.

### Added

- **`and` / `or` / `not` connectives in conditions.** Two simple
  conditions joined by `and`/`or` is the 80% case (`if $(X) == "ok" and
  $(Y) == "ok":`). Parenthesized sub-expressions handle the override case
  (`(a or b) and c`). `not` closes the falsy-check gap — pre-v0.3.2 the
  inverse of `if $(VAR):` had no current one-liner; authors had to
  enumerate `if $(VAR) == "":` / `if $(VAR) == "false":` / etc.
  
  Precedence (tight → loose): comparison ops > `not` > `and` > `or`.

  **Short-circuit evaluation.** AND skips RHS if LHS is false; OR skips
  RHS if LHS is true. Preserves the validate-then-access pattern:
  `if $(X) == "ok" and $(MAYBE_UNRESOLVED) ...` won't throw on the RHS
  when the LHS short-circuits.

- **`|json_parse` filter.** Sibling to existing `|json` (stringify).
  Parses input as JSON, throws on malformed. Round-trips for valid JSON
  (normalizes whitespace as a side effect). Chains with `|length` for
  array counts: `$(ITEMS|json_parse|length)`.

- **Filter chain support in `substituteRuntime`.** Pre-v0.3.2 the
  substitute regex captured exactly one filter — `$(X|f1|f2)` silently
  failed to match and rendered literally. The grammar always documented
  "chain left-to-right" (`help({topic: "ops"})` filter section). Now the
  implementation matches the docs.

### Implementation notes

- **Recursive structural decomposition** in `evalCondition` (runtime) and
  `validateCondition` (parser/lint). ~50 LOC each. The existing simple-
  shape regex set (TRUTHY/EQ/EQ_REF/CMP/CMP_REF/IN) stays in place as
  the leaf matchers; the new code is just the OR/AND/NOT splitter +
  recursive wiring. NOT a full expression-parser rewrite per Scott's
  pushback during the design pass.

- **Quote-aware splitting.** Outer-token scan respects quoted string
  literals and parenthesized sub-expressions, so `if $(MSG) == "wait
  and see":` doesn't false-split on the embedded `and`.

### Tests
- 26 new tests in `tests/v0.3.2.test.ts`: `|json_parse` round-trip +
  malformed input + filter chain; AND/OR/NOT evaluation + precedence +
  parens + short-circuit; quote-aware splitting; 3-term chains; elif
  with compounds; parser acceptance; help-surface assertions;
  `undeclared-var` lint walks compound conditions.
- Total: 828 passing (was 803 at v0.3.1).

### Loc-ceiling
- Narrow core nudged 5500 → 5650. Boolean trio + filter chain are core
  grammar features; feature-driven nudge.

### What's NOT in v0.3.2 (deferred)

- **`$set X = $(VAR|json_parse)` doesn't preserve parsed-structure type.**
  `$set` remains literals-only per the v0.2.6 dc824ee4 lesson. The
  `|json_parse` filter operates at substitute-time (string-in, string-out
  round-trip). For field-access on JSON values, the existing pattern via
  `$`/`~`/`>` ops that return structured output continues to work
  (`$ tool ... -> X` then `$(X.field)`). A future op (`$parse` or
  similar) could bridge this if real demand surfaces.

### v0.3.x roadmap

Next: **v0.3.3+** harness-driven. Whichever real production case surfaces
first — destructuring, arithmetic in $set/conditionals, parallel
foreach, $parse for JSON-to-struct binding.

## 0.3.1 — 2026-05-23

**Forward-reference deferred resolution.** Cold authors building
composition trees top-down (parent skill before child skills) used to
hit a chicken-and-egg compile error. v0.3.1 demotes the relevant lint
rules from tier-1 (error) to tier-2 (warning); runtime throws
`MissingSkillReferenceError` if the ref still can't resolve at execute
time. Spec approved by Perry in memory `be9993e3`.

### Changed
- **`unknown-skill-reference` demoted: tier-1 → tier-2.** `&`,
  `& invoke`, and `$ execute_skill skill_name=` references to skills
  not in the SkillStore now warn instead of blocking compile.
- **`unknown-template-reference` demoted: tier-1 → tier-2.** Same
  treatment for `# Templates:` refs.

### Added
- **Tier-3 `deferred-skill-reference` advisory.** Fires alongside the
  demoted tier-2 with a teaching message: "Skill 'X' referenced via
  `<op>` is not currently in the SkillStore. Lint demoted in v0.3.1 —
  will resolve at execute time if the skill exists by then, or throw
  `SkillNotFoundError` if not. If this is a typo, fix it now; if it's
  a forward reference, this advisory will clear once you store 'X'."
  Distinguishes "intentional forward-ref" from "typo I should fix now."

- **`MissingSkillReferenceError` extends `OpError`.** New runtime error
  class thrown when composition refs (`&` / `$ execute_skill` /
  `# Templates:`) can't resolve at execute time. Inherits `OpError` so
  it flows through `# OnError:` fallback chains — cold-author skills
  can wire a recovery path naturally. Distinct from the SkillStore
  contract's `SkillNotFoundError` (which is thrown by `store.load()` /
  `store.metadata()` at the connector layer).

- **Compile-time deferral path.** When `&` data-skill inlining can't
  find the target, compile leaves the `&` op intact in the parsed AST
  instead of throwing. Render flows through normally; runtime gets
  another chance to resolve.

### Unchanged (stronger contracts kept at tier-1)
- **`# OnError: <skill>` validation stays tier-1.** OnError is the
  runtime safety net — silently-missing handler discovered at the
  worst possible UX moment (your skill is already failing) is too bad
  an outcome to defer.
- **`disabled-skill-reference` stays tier-1.** Disabled is a stronger
  contract than missing — "explicitly removed from composition,
  deprecated, do not consume" versus "not yet authored, might be
  authored." Demoting Disabled would let silently-rotting composition
  trees ship.

### MCP wire shape
- `execute_skill({skill_name: <missing>})` still surfaces
  `errors[].class: "SkillNotFoundError"` on the wire (consumer-
  compatibility); the underlying runtime now throws
  `MissingSkillReferenceError` and the MCP layer renames at the boundary.

### Harness corpus impact
- 11 cold-author orchestrators that needed stub-skills bootstrapped
  pre-v0.3.1 are now straight `pass` (3 reclassified to
  `needs-fallback-skill` for their `# OnError:` targets which stay
  tier-1). Manifest cleanup committed.

### Tests
- 16 new tests in `tests/v0.3.1.test.ts` covering: demotion of both
  rules, the tier-3 advisory fires + content, runtime
  `MissingSkillReferenceError` throws, `# OnError:` tier-1 unchanged,
  `disabled-skill-reference` tier-1 unchanged, help-surface updates.
- Total suite: 803 passing (was 787 at v0.3.0).

### Loc-ceiling
- Narrow core nudged 5400 → 5500 for the new advisory rule + runtime
  defer-resolve path. Modest growth for a useful language semantic.

### v0.3.x roadmap

Next: **v0.3.2** — `|json_parse` filter + `and`/`or` boolean
connectives (short-circuit semantics explicit in the spec).

## 0.3.0 — 2026-05-23

**First minor bump since v0.2.x — language extension, not a fix patch.**
v0.3.0 ships the loop accumulator: `$append VAR <value>`. Closes the
structurally-impossible-without dedup-by-id pattern that Perry's harness
corpus surfaced (the R1 `dedup-foreach-walk` and similar skills were
*incomplete* pre-v0.3.0 because foreach-local `$set` couldn't accumulate
across iterations). Spec approved by Perry in memory `442cf4bb`; design
discussion at `44f9a9e3`.

### Added

- **`$append VAR <value>` op.** Single-value append to a list-typed VAR
  that was previously initialized in an enclosing scope (via `$set VAR = []`
  or `# Vars: VAR=[]`). The append mutates the outer-scope binding —
  unlike `$set` which is loop-local inside `foreach`. Value can be a
  literal, a `$(REF)`, or a filtered ref; substituted at runtime before
  append.

  Canonical pattern:

  ```
  walk:
      $set FOUND = []
      foreach M in $(MESSAGES):
          if $(M.id) not in $(FOUND):
              $append FOUND $(M.id)
              ! NEW: $(M.id)
  ```

- **Three tier-1 lint rules** that catch the accumulator foot-guns:
  - `uninitialized-append` — `$append VAR ...` without any `$set` or
    `# Vars:` init in an enclosing scope. Error message teaches the
    pattern: "Add `$set VAR = []` before the `$append`..."
  - `foreach-local-accumulator-target` — `$append VAR ...` where the
    matching `$set VAR = []` is in the same scope as the append (typically
    the same `foreach` body). Each iteration would reset VAR and silently
    lose all data. Lint walks the full enclosing scope chain to detect.
  - `append-to-non-list` — `$append VAR ...` where VAR's static init is a
    non-list value (e.g., `$set VAR = "abc"`). v0.3.0 is list-only.

- **`help({topic: "ops"})`** updated with `$append` entry under the `$` family.
- **`help({topic: "examples"})`** gets a 5th worked example: dedup-walk
  showing the canonical accumulator pattern.
- **`help({topic: "lint-codes"})`** lists the three new lint codes.

### Notes for v0.3.x

- **Mechanical mode** renders `$append` as a "Would append to $(VAR): ..."
  record without actually mutating the binding (per the v0.2.12 Bug 23
  Proxy-placeholder pattern). The placeholder list remains in place for
  downstream refs.
- **`$append` inside a future `parallel foreach`** is a tier-1 error in
  v0.3.0. The decision (forbid permanently vs ship with thread-safe
  accumulation + iteration-order preservation) deferred to whenever
  parallel foreach ships — parallel itself is deferred past v0.3.0 per
  the load-bearing-vs-aesthetic analysis (memory `8876fa1e`).
- **Single-value append only.** `$extend VAR $(OTHER_LIST)` deferred until
  a real use case surfaces. Same for string concat (`$append` on a
  string-typed var fires `append-to-non-list`) and map-shaped
  accumulation.

### Tests
- 20 new tests in `tests/v0.3.0.test.ts` covering parser, the 8 lint
  cases from spec (4 OK + 4 FAIL), runtime dedup + conditional-collect,
  mechanical-mode rendering, and the help-surface additions.
- Total suite: **787 passing** (was 767 at v0.2.12).

### Loc-ceiling
- Narrow core nudged 5200 → 5400. First feature-driven nudge (prior
  nudges were fix-driven); justified by the new op + 3 lint rules with
  scope-tracking walker (~200 LOC across parser/runtime/lint).

### v0.3.x roadmap (per `8876fa1e` analysis)
- **v0.3.1**: forward-reference deferred resolution (demote
  `unknown-skill-reference` + `unknown-template-reference` to tier-2 at
  compile; runtime errors at execute time if still unresolved)
- **v0.3.2**: `|json_parse` filter + `and`/`or` boolean connectives
  (short-circuit semantics explicit)
- **v0.3.3+**: destructuring, arithmetic in `$set`/conditionals,
  parallel — whichever harness rounds surface as needed

## 0.2.12 — 2026-05-23

**Twelve bug fixes from Perry's wild-and-crazy harness Round 2** (memory
`a0be74cd`). Bug 15 is the high-severity silently-broken-skill case the
harness was designed to find; the others span parser polish, lint coverage
extension, mechanical-mode consistency, and docs. Plus the
`skillfile run` deprecation window ended — alias removed.

### Fixed
- **Bug 15 (HIGH): blank line inside nested `else:` branch silently truncated
  the branch.** The parser reset `currentTarget` and `scopeStack` on every
  blank line — by design for separating top-level targets, but it also
  silently dropped everything after a blank line *inside* an indented body.
  Compile passed clean, lint passed clean, the rendered artifact stopped
  mid-body. Fix: blank lines no longer reset state. Target boundary detection
  is handled by the target-header path which re-anchors `currentTarget` on
  any non-indented `target:` line. Same root cause closed the related case
  where a blank line between a target body and a target-level `else:` broke
  the error-handler attach.

- **Bug 16: `# Vars:` URL values fragmented on `https:`.** The v0.2.10
  comma-aware splitter's "IDENT + `:`" boundary heuristic matched `https:`
  as a declaration boundary. Fix: when the lookahead's `:` is immediately
  followed by `//`, treat it as URL-scheme, not declaration delimiter.

- **Bug 17: `# Templates:` refs were not lint-validated.** New tier-1
  `unknown-template-reference` rule mirrors the existing `# OnError:`
  validation pattern. Missing templates fail delivery at runtime; now they
  fail compile.

- **Bug 18: `>` op `limit=$(VAR)` not substituted at render.** The render
  path inlined `p.limit` directly without `substitute()`. Now both `limit`
  and `mode` route through substitution for parity with `query`/`extra`.

- **Bug 19: composition error said "via `&`" when actual op was
  `$ execute_skill`.** The v0.2.11 Bug 7 fix reused the `&` error template.
  Now `collectAmpRefsFromOps` returns `CompositionRef[]` with the op kind
  tagged; diagnostics surface the actual operator.

- **Bug 20: `runtime_capabilities.runtimeVersion` reported stale `0.2.10`.**
  The version was triple-sourced (`package.json`, `cli.ts:VERSION`,
  `mcp-server.ts` default) and one slipped on v0.2.11. New `src/version.ts`
  reads `package.json` at module load; both `cli.ts` and `mcp-server.ts`
  import from it. Added `dogfood-t7` regression assertion that the MCP
  `runtimeVersion` matches `package.json` so this can't slip again.

- **Bug 21: `unsafe-shell-disabled` (new v0.2.11 lint code) was missing from
  `help({topic: "lint-codes"})`.** Now listed.

- **Bug 22: `# Requires: ... (fallback: "value")` retained surrounding
  quotes** in the bound target variable. Other `(fallback: ...)` parse
  sites route through `processSetValue`; the Requires path didn't. Fixed.

- **Bug 23: mechanical-mode `~` op bound a flat string** placeholder,
  breaking dotted field-access on the bound var (`$(HI.outputs.text)`
  erroring with `UnresolvedVariableError`). Now binds a Proxy placeholder
  matching the `$`/`>` mechanical handlers. Ripple fix in the runtime `in`
  operator to treat Proxy placeholders as single-element arrays so
  mechanical-mode `in $(VAR)` checks don't false-error.

- **Bug 26: `unknown-retrieval-arg` lint.** Cold author wrote `since=1h`
  (hallucinated time-window predicate) and the kwarg passed silently. New
  tier-2 warning validates `>` op kwargs against the documented set
  (`mode`/`query`/`limit`/`connector`/`fallback`).

### Added
- **`help({topic: "frontmatter"})` ambient + ref docs (Bugs 24 + 25).**
  Documents the `NOW` / `USER` / `SESSION_CONTEXT` / `TRIGGER_TYPE` /
  `TRIGGER_PAYLOAD` / `ERROR_CONTEXT` bare ambient refs, the full
  `EVENT.*` family auto-populated on cron-fired skills
  (`fired_at` / `fired_at_unix` / `fired_at_plus_{1h,1d,7d}_unix`), and
  the variable reference forms (bare / dotted / indexed / filter).
  Pre-v0.2.12 these were discoverable only by inspecting `final_vars`
  after running.

### Removed
- **`skillfile run` deprecated alias** (shipped in v0.2.11 with a one-release
  deprecation window). Use `skillfile execute` — the alias has been removed
  per the original commitment.

### Fixed (docs)
- **`skill_write` docstring** was stale — it claimed "Skill always lands as
  Draft" but the runtime honors the source body's `# Status:` header. Per
  Perry's resolved-question from R2.

### Tests
- 17 new tests in `tests/v0.2.12.test.ts`. Harness corpus manifest extended
  to 11 stub-needing skills (was 8 in v0.2.11) — Bug 17's lint coverage now
  catches template refs the cold authors invented. Total: 767 passing
  (was 749).

### Loc-ceiling
- Narrow core nudged 5100 → 5200 to accommodate Bug 17 + Bug 19 lint surface.

## 0.2.11 — 2026-05-23

**Six bug fixes + composition docs + MCP-CLI symmetry rename**, all sourced
from Perry's "wild-and-crazy" cold-author harness (thread `b6176e02`,
follow-up memory `2e999f9e`) and now run as a permanent regression corpus
via `tests/harness-corpus.test.ts` (66 skills authored by 6 fresh sub-agents).

### Fixed
- **Bug 4: `unsafe-shell-ambiguous-subst` false-positive on ambient refs.**
  The lint was warning on `$(EVENT.fired_at_unix)` and `$(NOW)` inside
  `@ unsafe` bodies and suggesting cold authors rewrite as `$$(EVENT...)`
  (bash command-sub) — which would just try to execute `EVENT...`. Now
  skips dotted refs (consistent with `undeclared-var`) and bare ambient
  refs (NOW, USER, SESSION_CONTEXT, TRIGGER_TYPE, TRIGGER_PAYLOAD,
  ERROR_CONTEXT).

- **Bug 5: `@ unsafe` compiled clean when runtime had `enableUnsafeShell:
  false`.** Skill would refuse at first fire with `UnsafeShellDisabledError`,
  but compile/lint were silent. New tier-1 rule `unsafe-shell-disabled`
  fires when the caller passes `enableUnsafeShell: false` explicitly
  (`undefined` keeps backwards-compat — only tier-2 `unsafe-shell-op`
  fires). Threaded the flag through `CompileOptions.enableUnsafeShell`
  and the MCP server's `compile_skill` / `lint_skill` dispatchers.

- **Bug 6: `unconfirmed-mutation` keyword list too narrow.** Extended the
  mutating-tool-name pattern with: `archive_`, `prune_`, `deploy_`,
  `expire_`, `consolidate_`, `purge_`, `reset_`, `rotate_`, `move_`,
  `rename_`, `drop_`, `truncate_`, `upsert_`, `overwrite_`, `clear_`,
  `wipe_`, `finalize_`. Perry's harness surfaced a cluster of mutating
  tools that the original `write_/update_/delete_/...` set didn't catch.

- **Bug 7: `$ execute_skill skill_name=<missing>` skipped
  `unknown-skill-reference` lint.** The rule only walked `&` ops.
  `collectAmpRefsFromOps` now also extracts `skill_name=` from
  `$ execute_skill` calls (quoted or bare-identifier form). The harness
  corpus now stubs missing child skills via a new `needs-stub-skills`
  manifest classification — surfacing Bug 7 on 5 cold-author orchestrators.

- **Bug 10: indent-tracker after closing `else:` block.** Filed as a
  separate bug by A-3 against v0.2.9, but already closed by v0.2.10's
  Bug 3 fix (walk-down scope-stack). Added explicit regression tests
  (`backup-rotator` shape; `if/elif/else` chain with sibling op) to lock
  in the behavior.

- **Bug 14: unknown-block-introducer diagnostic.** Hypothetical block
  keywords (`parallel:`, `try:`, `catch X:`, `branch X:`) used to surface
  as a "Mid-block indent change" cascade — confusing for cold authors
  feature-requesting future syntax. Now emits a specific
  `Unknown block-introducer` parse error listing the recognized set
  (`if/elif/else/foreach`) and absorbs indented children into a synthetic
  frame so follow-on errors don't pile up.

### Added
- **`help({topic: "composition"})` topic.** Covers all three composition
  primitives — `& skill-name` (data-skill inline at compile time),
  `& invoke skill-name` (runtime call), `$ execute_skill skill_name="..." -> VAR`
  (in-skill execute with kwarg forwarding). Documents the depth-5
  recursion limit, the lint signals catching missing/disabled refs, and
  when to reach for which primitive.

- **4th example skill in `help({topic: "examples"})`.** `morning-brief-
  orchestrator` — a worked orchestrator using `$ execute_skill` to fan
  out to three child skills with per-call fallbacks and `-> VAR` bindings.

- **`skillfile execute` CLI command (alias for `run`).** MCP-CLI symmetry
  per memory `2e999f9e`: the MCP tool is `execute_skill`, the CLI should
  mirror. `skillfile run` is preserved as a deprecated alias for one
  release with a stderr notice; v0.2.12 will drop it.

### Tests
- 36 new tests in `tests/v0.2.11.test.ts` covering every bug fix + doc
  addition. Total suite: 749 passing (up from 713 at v0.2.10).

## 0.2.10 — 2026-05-23

**Three high-severity bug fixes** from Perry's "wild-and-crazy" cold-author
harness (thread `b6176e02`) — 6 fresh sub-agents, ~60 skills, 8 real bugs
filed. This patch addresses the top three.

### Fixed
- **Bug 1: `-> VAR` binding rendered as `$(<target>.output)` in compile
  artifact** (4 observers). The `$` and `@` op renderers hardcoded the
  target-output fallback even when the op had an explicit `outputVar`.
  Now: `@ echo hi -> GREETING` renders as `bind output to $(GREETING)`;
  bindings without `-> VAR` still fall back to `$(<target>.output)`.

- **Bug 2: `# Vars: LOCATION=Asheville,NC` parsed as two declarations**
  (2 observers). The `splitVarsLine` helper split naïvely on commas; values
  containing commas got cut off. New heuristic: a comma is a declaration
  boundary only when followed by an IDENT then `=`/`,`/`:`/end. Once the
  current segment has `=`, commas stay value-internal unless the next
  IDENT is followed by `=` or `:`. Chains of bare-required vars (`A, B,
  C`) still split correctly. Identifier matcher now accepts hyphens
  (`queue-drain-procedure`) for `# Templates:` parity.

- **Bug 3: Nested control flow broke on elif-with-inner-if-then-else**
  (3 observers across 3 shapes). The `elif`/`else` continuation logic
  only checked the top of the scope stack — when an inner `if` block was
  still open above an outer `elif`, the dedent to the outer if's
  continuation level didn't find the matching frame. Fix: walk DOWN the
  scope stack to find the if/elif frame at the expected continuation
  depth, popping all inner frames as we go. All six nested shapes Perry
  surfaced now parse clean.

### Internal
- Narrow-core LOC ceiling nudged 5000 → 5100 to accommodate the parser
  robustness work (vars-comma + nested-control-flow + render
  disambiguation). Original ERD §1 intent preserved.
- 12 new fixtures in `tests/v0.2.10.test.ts` covering Bug 1+2+3 + Perry's
  exact repros + regression guards.
- 646/646 tests passing. Narrow-core LOC 5006/13.

### Acknowledgments
Perry — the wild-and-crazy harness (A=spec-fed + B=help-only differential)
produced richer signal than any prior validation. Five more bugs queued
for the next patch (lint gaps, ambient-ref false positives, missing
unconfirmed-mutation keywords) plus a v0.3.0 language-design slate
(parallel dispatch, accumulator, retry/backoff).

## 0.2.9 — 2026-05-23

**Patch — fixes the in-skill `$ execute_skill inputs={...}` regression**
Perry caught in v0.2.8 validation (thread `64445b4f`). Composition
primitive now works end-to-end for both kwarg styles.

### Fixed
- **`$ execute_skill skill_name="X" inputs={"K": "V"}` was silently
  dropping the inputs kwarg.** Two root causes, both addressed:
  1. **Parser tokenizer** didn't track `{}` braces alongside `[]`, so
     `inputs={"WHO": "Perry"}` fragmented at the first whitespace inside
     the JSON object. Extended `tokenizeKeywordArgs` to track curly
     braces with the same bracket-depth logic.
  2. **Composition intercept** only treated kwargs as flat
     `key=string-value` pairs. When `inputs` arrived as the literal
     JSON string `{"WHO": "Perry"}`, it was passed as a kwarg named
     `inputs` (which the child ignored). Now: if the `inputs` kwarg
     JSON-parses as an object, it's unpacked into the child's input map.

### Supported styles
Both forms now work and produce identical behavior:

```
# Style 1 — bare kwargs (natural skill grammar)
$ execute_skill skill_name="child" WHO="$(NAME)" -> R

# Style 2 — explicit inputs={...} JSON object (MCP-call parity)
$ execute_skill skill_name="child" inputs={"WHO": "$(NAME)"} -> R
```

### Test coverage
- 3 new fixtures in `tests/v0.2.8.test.ts` covering both styles +
  the tokenizer's JSON-object handling (nested + arrays + brackets-
  in-strings).
- 634/634 tests passing. Narrow-core LOC 4999/13 — tokenizer extension
  was net-zero LOC by combining `[`+`{` and `]`+`}` into one condition
  each.

### Acknowledgments
Perry — caught the bug in the v0.2.8 validation cycle; turnaround under
an hour from bug filing to fix shipped. The minion-battery → ship loop
catches real regressions reliably.

## 0.2.8 — 2026-05-23

**Discovery + composition.** Two new MCP tools per Perry's v0.2.8
kickoff (thread `45c167bc`). Both close real public-runtime gaps:
cold-author bootstrap (`help`) and skill-to-skill composition that
doesn't depend on AMP (`execute_skill`).

### Added
- **`help` MCP tool** — cold-agent language discovery. `help()` returns
  a ~500-token quickstart covering the six minimum-viable questions a
  cold author needs (skill shape, op symbols, result binding, branching,
  iteration, debugging). `help({topic})` returns deeper sections:
  - `ops` — op symbol legend with grammars
  - `frontmatter` — header keys + values
  - `examples` — three canonical worked skills (minimal / threshold /
    LocalModel branching)
  - `connectors` — short explainer + live wired-set summary from the
    registry (delegates dynamic depth to `runtime_capabilities`)
  - `lint-codes` — tier-1/2/3 rule index
- **`execute_skill` MCP tool** — public composition primitive.
  `execute_skill({skill_name, inputs?, mechanical?})`. Symmetric return
  shape with AMP's `amp_execute_skill`:
  `{skill_name, final_vars, transcript, outputs, errors, target_order}`.
  `mechanical: true` previews dispatch without firing `$`/`~`/`@`/`??`
  ops (TestFlight mode); propagates through recursive composition.
  Recursion-depth guard at 10 (configurable via
  `ExecuteContext.maxRecursionDepth`); structured
  `RecursionDepthExceededError` fires on infinite-loop composition.
  Missing-skill returns a structured error rather than crash.
- **In-skill `$ execute_skill skill_name=child` intercept** — the
  runtime recognizes `execute_skill` as a built-in tool name and
  dispatches to the composition helper without requiring an MCP
  connector to be wired. Closes the gap Perry surfaced: prior to v0.2.8,
  the only way to invoke another skill was via AMP's private
  `amp_execute_skill`; a fresh runtime had `mcpConnectors: []` and no
  way to compose.

### Internal
- New `src/composition.ts` module wraps load + compile + execute behind
  a single `executeSkillByName()` function. Both the MCP tool handler
  and the `$` op intercept delegate here. Keeps the runtime's narrow-
  core LOC under the ERD §1 ceiling.
- New `src/help-content.ts` module hosts the static help payload.
- Tool count: 11 → 13. Existing 5 assertions across `mcp-server`,
  `dashboard-server`, `dogfood-t6b`, `v0.2.1`, and `v0.2.3` tests
  updated.

### Test coverage
- 17 new fixtures in `tests/v0.2.8.test.ts` covering: help topic
  surfaces, execute_skill end-to-end against bootstrapped runtime,
  mechanical-mode preview, missing-skill error shape, in-skill
  `$ execute_skill` composition, recursion-depth guard on infinite-loop
  chains, composition without an MCP connector wired.
- 631/631 tests passing. Narrow-core LOC 4999/13 (1 line under the 5000
  ceiling — tight).

### Validation
Perry's new "zero-primer" harness — fresh sub-agent with the Skillscript
MCP tools wired but ZERO system primer or language reference in context.
Task: "write a working skill that does X." Success = compiles clean.
Tests whether `help()` alone is enough to bootstrap authoring.

### Acknowledgments
Perry — kickoff design + minion-validation cadence. Public composition
was the missing piece for "skillscript without AMP."

## 0.2.7 — 2026-05-22

**Runtime ergonomics.** Items 4 + 5 from Perry's v0.2.5 kickoff
(thread `f75477a4`, carried forward to kickoff `2d3d461c`). Two
orthogonal changes bundled: the long-deferred `serve`/`dashboard`
split + persistent imperative-trigger registry.

### Added
- **`skillfile serve` command.** Headless runtime host: scheduler +
  MCP server only, no browser SPA mounted. For production deployments,
  containers, CI environments. Shares the existing `bootstrap()` helper
  with `skillfile dashboard`; differs only in whether the SPA routes
  are wired.
- **`skillfile dashboard` continues to mount the SPA.** No behavior
  change; the CLI now has the explicit choice rather than an implicit
  bundle.
- **Persistent imperative-trigger registry** at
  `$SKILLSCRIPT_HOME/triggers.json`. Imperative registrations (via the
  MCP `register_trigger` tool) write through to disk synchronously and
  hydrate at bootstrap. Survives process restart — register a one-shot
  trigger before lunch, the trigger fires after the runtime reboots in
  the afternoon. Schema-versioned wire format.
- **Boot-time expiry pruning.** Imperative triggers whose `expires_at`
  has passed at hydrate time are dropped from the in-memory registry
  AND the on-disk file. No accumulation of dead rows.
- **`runtime_capabilities` reports two new fields:** `runtimeMode`
  (`"serve" | "dashboard"`) and `triggersFilePath` (string or null).
  Cold agents discovering the runtime can ask which deployment shape
  they've reached and where the persistent registry lives.

### Unchanged
- **Declarative triggers** (parsed from `# Triggers:` headers in skill
  bodies) continue to live-derive from the SkillStore at every boot.
  They are NOT persisted to `triggers.json` — that's reserved for
  imperative registrations whose source-of-truth is the MCP write path.
- `DashboardServer` defaults `mountSpa: true` so existing embedders
  keep working.

### Internal
- `Scheduler` gains an optional `onTriggersChanged` write-through hook
  in its config. `bootstrap()` wires it when `triggersFilePath` is set.
- `Scheduler.registerTrigger` accepts an optional `seedFromPersistence`
  flag for boot-time hydration that preserves the original trigger id
  and suppresses the write-through hook (prevents re-writing the file
  we just read).
- 614/614 tests passing (600 + 14 new fixtures across persistence
  round-trip, boot-time prune, mode reporting, and SPA-mounting
  toggle). Narrow-core LOC unchanged at 4976/13.

### Acknowledgments
Perry — clean carryover from the v0.2.5 kickoff, validated end-to-end
on every patch since.

## 0.2.6 — 2026-05-22

**Language polish — Items 2 + 3 from the v0.2.5 kickoff** (Perry's thread
`f75477a4`). AgentConnector DeliveryPayload now carries full provenance
+ augmenting-context fields; two new frontmatter headers populate them.
Plus a doc + example response to Perry's Signal 1 (`|length` under-
discoverable).

### Added
- **`source_skill?: string` on the `augment` variant** of
  `DeliveryPayload` (was template-only in T7.1). Receiving agents reading
  an augment now know which skill authored it for correlation /
  auditability.
- **`triggered_by?: TriggerProvenance` on both variants.** Threads
  `{source, name, fired_at_ms}` through every delivery so receivers can
  disambiguate cron / session / manual / event fires. Populated from
  `ExecuteContext.triggerCtx` — scheduler-fired skills carry full
  provenance, ad-hoc `execute()` callers without a trigger ctx omit it.
- **`# Delivery-context: <prose>` header.** Routed to the receiving
  agent alongside the augment payload as `delivery_context` so the agent
  knows *why* it's being notified.
- **`# Templates: <name>, <name>, ...` header.** Comma-separated list of
  Template-skill names the receiving agent may fetch as follow-on
  actions. Routed as `templates: string[]`.
- **Tier-2 lint rule `unused-augmenting-header`.** Fires when
  `# Delivery-context:` or `# Templates:` appears on a Headless skill
  (no `prompt-context:` or `template:` output declaration) — those
  fields would never reach a substrate.
- **`examples/queue-length-monitor.skill.md`** — canonical
  "count items via `|length`, compare to threshold" pattern. Closes
  Perry's Signal 1: cold authors weren't reaching for `|length`
  naturally; examples beat spec for discoverability.

### Fixed
- **Stale `(v2)` markers in the language reference's ambient refs table.**
  `TRIGGER_TYPE`, `TRIGGER_PAYLOAD`, `EVENT.*` are all shipped and
  auto-injected at runtime; the "(v2)" suffix incorrectly implied
  "not yet available." Removed; descriptions sharpened to name the
  concrete values.

### Internal
- Added a `RecordingAgentConnector` test fixture in `tests/v0.2.6.test.ts`
  to verify payload threading end-to-end through the runtime dispatch.
- 600/600 tests passing (588 + 12 new fixtures). Narrow-core LOC
  unchanged at 4880/13.

### Validation
Perry's v0.2.5 Item-1 validation pass returned 6/6 regression + 3/3
fresh-minion compile clean. Surfaced Signal 1 (length discoverability —
addressed by the new example) and Signal 2 (lint gap on `$(NOW)` —
verified non-issue; the misread inspired the ambient-table doc fix).

### Acknowledgments
Perry — kickoff scope and validation cadence remains the same one-hour
loop that surfaced bugs A-F across v0.2.2-v0.2.4.

## 0.2.5 — 2026-05-22

**Language polish — Item 1 of 5 from v0.2.5 kickoff** (Perry's thread
`f75477a4`). The "orchestration carve-out" addition: comparison is
orchestration, arithmetic is tool computation. This patch ships the
comparison + counting affordances; items 2-5 follow after Perry's
validation pass.

### Added
- **Comparison operators `<` / `>` / `<=` / `>=`** in `if` / `elif`
  conditions. Both ref-vs-literal (`$(N) > "10"`) and ref-vs-ref
  (`$(A) <= $(B)`) shapes; filters + dotted field access permitted on
  either side, matching the existing `==`/`!=` surface.
- **Numeric coercion at runtime.** Both operands pass through `Number()`;
  non-finite results throw `TypeMismatchError` with structured operands
  + ref description + canned remediation. Silent lexicographic fallback
  (which would mis-compare `"9" < "10"` as false) is explicitly rejected.
- **`|length` filter.** Returns element count when the value JSON-parses
  as an array; returns character count otherwise. Pairs with the new
  comparisons for skills like `if $(ITEMS|length) > "0":`.
- **`TypeMismatchError` class** extending `OpError`. Surfaced via
  `result.errors[]` with `operator`, `lhs`, `rhs`, `refDesc` fields plus
  remediation suggesting `|trim` / `|length` / model-output preprocessing.

### Scope
**In:** comparison operators, `|length` filter, the type-error class.
**Out:** arithmetic (`+`, `-`, `*`, `/`), aggregates (`min`, `max`,
`sum`, `mean`). Those stay in tools. The line: *comparison is
orchestration; arithmetic is computation.*

### Test coverage
29 new fixtures in `tests/v0.2.5.test.ts` covering: parser grammar
acceptance, ref-vs-literal evaluation, ref-vs-ref evaluation, numeric-
vs-lexicographic regression guard, `TypeMismatchError` shape, `|length`
on arrays + strings + JSON objects, end-to-end compile of the canonical
threshold + queue-watch skill shapes. 588/588 total green.

### Acknowledgments
Perry — for the orchestration carve-out framing and the kickoff scope.

## 0.2.4 — 2026-05-22

**Two more parser bugs from Perry's 6-minion battery via `compile_skill`.**
v0.2.3's authoring tools gave Perry the cleanest possible validation
surface — 30 seconds later, she had two new bugs filed (thread `e609a448`).
Both parser-only, both shipped.

### Fixed
- **Bug D (regression from v0.2.2): apostrophe in plain text swallows targets.**
  The v0.2.2 `foldQuotedContinuations` pre-pass tracked single-quotes
  globally — an apostrophe in `# Description: symbol's intraday drops`
  opened an unclosed-string scope that absorbed all subsequent lines,
  leaving zero targets visible and producing a `[no-targets]` lint error.
  Hit by 2/6 cold authors. Fix: limit fold engagement to kwarg-bearing
  op lines (`~ `, `> `, `& `) — the three op kinds where values
  legitimately span newlines. Frontmatter, `!` literals, `@` shell
  bodies, and target labels are now left untouched.
- **Bug F (pre-existing): `(fallback: ...)` after `-> VAR` broke binding
  on `@` and `&` ops.** `$`/`~`/`>` had explicit fallback support in
  their regexes; `@` (parser.ts:1049) and `&` (`AMPERSAND_OP_REGEX`)
  didn't. The trailing `(fallback: ...)` clause prevented the `-> VAR`
  extractor from matching → outputVar never bound → downstream
  `$(VAR)` fired `undeclared-var` diagnostics on variables that
  authors had clearly declared. Hit by 2/6 cold authors. Fix: extend
  both regexes with `(?:\s+\(fallback\s*:\s*(.+?)\))?` and thread
  the captured fallback into the op record. `@ unsafe` variant also
  fixed for parity.

### Validation
Perry's 6-minion compile matrix:

| State | v0.2.3 | v0.2.4 (projected) |
|---|---|---|
| Pass | 3/6 | 6/6 |

(v0.2.4 projection — three minions previously failed on D and/or F;
sed-removing the apostrophe and rewriting the fallback clause cleared
both per Perry's testing. Test fixtures in `tests/v0.2.4.test.ts`
cover both bug repros and regression guards.)

### Acknowledgments
Perry — for the back-to-back minion-battery runs that surface bugs in
single-hour cadence after each ship.

## 0.2.3 — 2026-05-22

**Over-the-wire authoring lifecycle.** v0.2.0–v0.2.2 gave foreign MCP clients
a way to *observe* and *manage* running skills but not to *author* them
— pushing a new skill required filesystem access to the SkillStore root.
v0.2.3 closes that gap with three new MCP tools per Perry's design
(thread `f48b8ef3`).

### Added
- **`lint_skill({source?|name})` — 9th MCP tool.** Read-only. Returns
  diagnostics across tier 1/2/3, plus `passes_tier_1/2/3` booleans for
  cheap pass/fail checks. Accepts a literal source body (inner-loop
  iteration) or a stored skill name (re-validation).
- **`compile_skill({source?|name, inputs?})` — 10th MCP tool.** Read-only.
  Returns the rendered artifact + `target_order` + `resolved_variables`
  + warnings + errors. Compile failures land in the `errors` array
  rather than throwing, so cold authors get a diagnostic surface to
  iterate against instead of opaque tool failures.
- **`skill_write({name, source, overwrite?})` — 11th MCP tool, write.**
  Tier-1 lint runs at write time (SkillStore contract). Returns version
  + content_hash. Always lands as `Draft` — promote to `Approved` via
  the existing `skill_status` tool to enforce explicit-approval discipline.
  `overwrite` defaults to `false`; existing skills with the same name
  reject the write.

### Workflow
The cold-author flow over MCP becomes:
1. `lint_skill({source})` — fast feedback while drafting
2. `compile_skill({source, inputs})` — confirm the artifact looks right
3. `skill_write({name, source})` — commit to SkillStore as Draft
4. `skill_status({name, new_state: "Approved"})` — explicit deploy
5. `register_trigger({skill_name, source: "cron", name: "...")` — fire
6. `health_metrics({skills: [name]})` — observe fires

Six tools, one round-trip each, no filesystem dependency. The integration
test in `tests/v0.2.3.test.ts` exercises the full lifecycle end-to-end.

### Acknowledgments
Thanks to Perry for the three-tool bundle design (thread `f48b8ef3`),
turned around within an hour of the v0.2.2 ship.

## 0.2.2 — 2026-05-22

**Parser fixes from cold-author minion battery.** Perry ran 3 independent
cold-agent SDK authors against the stock-monitor exercise; they converged
on three parser failure modes. All three fixed in this patch — pure parser
changes, no runtime or dispatcher impact.

### Fixed
- **Bug A: `# Triggers:` comma-split breaks cron expressions with commas.**
  Hit by 3/3 cold authors. Cron syntax naturally has commas
  (`30,45 9 * * 1-5` = run at 9:30 and 9:45 on weekdays). The trigger header
  parser split on bare commas, mistakenly treating the cron-internal comma
  as a multi-trigger delimiter. Now splits at source-keyword boundaries
  (cron/session/event/agent-event/file-watch/sensor) instead — single-cron-
  with-commas parses as one trigger; multiple triggers still split correctly.
- **Bug B: Multi-line `~ prompt="..."` strings break the parser.** Hit by
  2/3 cold authors. The line-iterating parse loop treated interior newlines
  inside quoted kwarg values as block separators. Now a quote-aware pre-pass
  folds unclosed-quote continuations into a single logical line, and the op
  regexes (`~`, `>`, `&`) carry the `s` flag so `.` matches across newlines.
  Multi-paragraph LLM prompts now parse cleanly.

### Documented
- **`needs:` keyword forms.** Bug C audit confirmed the parser already
  supports all three syntactic forms (Make-style `target: dep1 dep2`,
  header form `target: needs: a, b, c`, body-line form `needs: dep`). The
  language reference now has a concrete `### Declaring target dependencies`
  example showing all three. v0.2.2 tests document supported syntax so
  future regressions surface.

### Acknowledgments
Thanks to Perry for the 3-minion cold-author battery (thread `a91db2e2`)
that surfaced these bugs in roughly an hour after v0.2.1 shipped.

## 0.2.1 — 2026-05-22

**Imperative-trigger surface fix.** v0.2.0 shipped with `register_trigger`
(via MCP) storing trigger registrations correctly but the scheduler's tick
loop was never armed inside `skillfile dashboard` — so no cron triggers
actually fired. Declarative `# Triggers:` headers had the same dormant
fate. v0.2.1 is the patch that makes the trigger surface load-bearing.
**Upgrade strongly recommended for anyone exercising the trigger APIs.**

### Fixed
- **Scheduler is now started in the dashboard host.** `cmdDashboard` calls
  `scheduler.start()` after wiring the registry, arming the 30s tick loop
  and the SIGINT/SIGTERM session-end hook.
- **Declarative `# Triggers:` headers register at boot.** The dashboard now
  walks the SkillStore at startup, parses each Approved skill, and registers
  every declared `# Triggers:` entry into the scheduler.

### Added
- **`runtime_capabilities` MCP tool** (8th built-in). Read-only discovery
  surface for cold agents — returns the wired connectors per kind
  (`skillStores`, `memoryStores`, `localModels`, `mcpConnectors`,
  `agentConnectors`), plus `shellExecution.mode` (structural-spawn vs
  bash-via-unsafe) and the runtime version. Optional per-category `include`
  filter.
- **`bootstrap()` + `defaultRegistry()` helpers** (`src/bootstrap.ts`).
  Extract the long-lived runtime host wiring — connector registry, scheduler,
  McpServer — into a single shared function so the v0.3 `serve`/`dashboard`
  split becomes a trivial new entry point rather than a refactor.
- **`Registry.list*()` enumeration methods.** `listSkillStores`,
  `listMemoryStores`, `listLocalModels`, `listMcpConnectors`,
  `listAgentConnectors` each return `Array<{ name, instance, ctor }>` for
  `runtime_capabilities` and future introspection use.

### Removed
- **`skillfile register-trigger` / `unregister-trigger` / `list-triggers`
  CLI commands.** These one-shot invocations each constructed a fresh
  in-memory Scheduler that died on process exit, making them no-ops in
  practice. The MCP tools (`register_trigger` / `unregister_trigger` /
  `list_triggers` against a live `skillfile dashboard`) are the canonical
  registration surface.

### Internal
- **CLI command surface tightened from 16 → 13 commands.** Help, dogfood
  fixture, and README updated.
- **`cmdRun`'s `buildRegistry()` collapsed to `defaultRegistry()`** —
  eliminates the duplicate registration logic between the one-shot run
  path and the long-lived dashboard host.
- **Dashboard now records traces by default** (`trace: { mode: "on" }`)
  so `fires` / `health_metrics` reflect the new tick-driven fires.

### Acknowledgments
Thanks to Perry for the cold-client MCP probe that surfaced the
imperative-trigger bug (thread `52f3d3d9-9212-49a9-b180-ae28fd1a7666`),
the structural-coupling diagnosis, and the `runtime_capabilities` design.

## 0.2.0 — 2026-05-21

Initial public release. T7 distribution polish + T7.1 AgentConnector
contract. See README and `docs/language-reference.md` for the v1 surface.

- Five connector contracts: SkillStore, MemoryStore, LocalModel,
  McpConnector, AgentConnector (NoOp default).
- Sixteen CLI commands; seven-tool MCP server; browser dashboard SPA.
- Narrow-core LOC 4738/13 under 5000/20 ceiling (ERD §1).
- Published to GitHub + GHCR (`ghcr.io/sshwarts/skillscript-runtime`).
