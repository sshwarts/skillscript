# Changelog

Each release carries an **Upgrade impact:** line (first in its section) so a bump's requirements are visible at a glance. Tags (closed set): **BREAKING** (a manual change is needed to keep working) · **RE-APPROVE** (secured-mode signature invalidation — skills must be re-approved before they run) · **CONFIG** (`connectors.json` / config edit needed) · **none (additive)** (no action; backward-compatible). Standard from 0.20.0 forward; the pre-0.20 transitions that need action are flagged inline below (0.14.0, 0.18.8, 0.19.0). Full walkthrough: [UPGRADING.md](UPGRADING.md).

## 0.27.0 — 2026-07-06 — runtime: `(fallback:)` now contains a raised throw (uniform trailer semantics)

**Upgrade impact:** none (additive; no re-approval). A `(fallback:)` that previously did nothing against a throw now fires — a skill that used to abort now degrades. No skill breaks; see the one behavior note below.

The 0.26.4–0.26.6 arc surfaced that `(fallback:)` was **inconsistent**: it contained a failure for `shell` / `$` dispatch / `file_read`, but the `execute_skill` and `$ json_parse` **intercepts threw directly, bypassing the trailer** — so a per-leg `(fallback:)` on a throwing `execute_skill` leg did nothing and aborted the whole gather (the 2026-07-05 morning-brief class). 0.26.6 documented that split; **0.27.0 removes it at the source** (Perry decision B, `c052581b`).

- **`(fallback: "…")` now contains ANY failure from every fallible op**, including an `execute_skill` child-throw (e.g. a child whose output template references an unset var) and a `$ json_parse` off-shape input. The intercepts now consult `op.fallback` on their raised throw, mirroring the existing `file_read` path. The author-facing mental model is finally uniform: *a failing op with `(fallback:)` degrades and continues, whatever the failure shape* — no more reasoning about which ops return-empty vs raise.
- **The throw stays diagnosable.** A caught throw records its message in the result's `fallbacks[].reason` (degrade-loud), so it isn't silently erased — it moves from `errors[]` to `fallbacks[]`.
- **Security is unaffected.** A child's own op-level failure — including a policy/security refusal (shell-allowlist, disallowed-tool, fs-deny) — is captured in the child's `result.errors[]` and never escapes as a parent throw, so a parent `(fallback:)` **cannot swallow it** (verified: a child hitting the shell allowlist surfaces in the bound child result, the parent fallback does not fire).
- **One behavior note:** a skill that today aborts *before* a side effect (e.g. `$ json_parse … (fallback:"{}")` followed by a `$ data_write`) will now proceed into that op with the degraded value. This is identical to how `shell`/`$` fallbacks already behave — writing `(fallback:)` opts into continue-with-default. Rule 5 (degrade *loud*) still applies.
- **Docs:** the `help({topic:"error-handling"})` topic + quickstart + server-instructions were re-simplified to the uniform model; `else:` is reframed as target-level **recovery logic** (not the throw-container of last resort), the structural guard as the most-robust **prevention**. (`# OnError:` remains parsed-but-unwired — flagged, tracked separately.)

## 0.26.6 — 2026-07-06 — help: error-handling topic correctness fix (`(fallback:)` does NOT catch a raised throw)

**Upgrade impact:** none (additive; help-content + server-instructions only). No runtime behavior change.

The 0.26.5 `error-handling` topic taught a **broken containment pattern**: its flagship Rule 2 example put a per-leg `(fallback:)` on `execute_skill` legs and claimed it prevents a gather abort. It does not — and shipping it canonicalized the exact pattern that sank the 2026-07-05 morning brief (Perry `c052581b`, verified on the deployed 0.26.5 runtime).

- **Corrected the mental model to two failure shapes → two tools.** A **MISSING VALUE** (dispatch error, `shell` spawn-fail/timeout, empty result, unresolved ref) is contained by `(fallback: "…")` / a `fallback` filter. A **RAISED THROW** (`$ json_parse` on off-shape input; `execute_skill` whose child throws — e.g. the child's output template references an unset var) is **NOT** caught by `(fallback:)` — the throw propagates past the trailer and aborts the target. A raised throw is contained by an `else:` handler, or **prevented** by a structural guard (pre-bind degraded defaults + a `contains`/shape check before the risky op).
- **Every prescription was gate-dogfooded on the runtime before shipping** (the whole bug was a doc that confidently prescribed an unverified mechanism): confirmed `(fallback:)` catches neither an execute_skill child-throw nor a json_parse malformed-throw; confirmed `else:` catches **both**; confirmed the structural guard degrades cleanly. **`# OnError:` was found inert** (its `fallbackSkillExecutor` is never wired in the runtime) and is therefore flagged as not-a-reliable-throw-container rather than prescribed.
- Rule 2 now carries the corrected worked example (a throw-proof `get-weather` child), and the quickstart + server-instructions robustness lines were corrected to the same two-shapes framing.

## 0.26.5 — 2026-07-06 — help: `error-handling` topic (containment playbook on the tool-help surface)

**Upgrade impact:** none (additive). New `help()` topic + expanded server instructions; no behavior change.

- **New `help({topic: "error-handling"})` topic** — the "how do I keep one call from aborting the whole skill" playbook, now reachable through the **tool-help surface an agent author actually uses** (not just the language-ref doc, which agents authoring via MCP never read). Covers the four containment primitives — the `(fallback: "…")` op trailer (the per-call opt-out), the `${REF|fallback:"x"}` pipe filter, the `else:` block, and `# OnError:` — plus the five-rule discipline (fallback every fallible op; fallback each fan-out leg or one failure sinks the rest; `|fallback` position-independence; output-template var safety; degrade **loud**, not silent). Content mirrors the language-ref "Robustness & error containment" section so the two stay in sync.
- **Discoverability wiring:** `error-handling` added to `available_topics`, the `help` tool description's topic list, and the unknown-topic message; the no-arg quickstart now names the `(fallback:)` primitive and points to the topic; the **MCP server instructions** (shown to every agent at session start) gained a one-line robustness note. So an agent meets the containment guidance passively (server instructions), on demand (`help`), and at the quickstart — the surfaces it uses, rather than the docs it doesn't.

## 0.26.4 — 2026-07-06 — lint: `append-structured-to-string` advisory

**Upgrade impact:** none (additive). New tier-3 advisory (info); never blocks compilation.

- **New lint `append-structured-to-string`** (tier-3 advisory) — flags `$append VAR ${REF}` where `VAR` is a **string accumulator** and `${REF}` is a bare `$` op output (a possibly-structured list/object) carrying **no `.field` accessor and no `|json` filter**. Appending a structured value to a string stringifies and fragments it — an array-of-objects comma-splits into a mangled, double-escaped blob. Found dogfooding `enter-project` (`$append DOMAIN_INSTRUCTIONS ${DI}` with `DI` = `amp_list_memories`'s array-of-records; Perry proposal `c052581b`). The fix is pure authoring, which the message points at: project a scalar field (`${REF.detail}`) or serialize explicitly (`${REF|json}`) — **both suppress the advisory**. It's the `$append`-side sibling of `object-iteration-advisory` and reuses the same origin analysis; **advisory, not warning**, because a `$` op's return shape is statically unknowable (a warning would over-fire on legitimate string→string appends). String-target typing reuses `append-to-non-list`'s static-init reasoning.

## 0.26.3 — 2026-07-06 — fix: empty-input zero-iteration now covers the `${V}` brace form

**Upgrade impact:** none (additive). Completes the 0.26.2 #2 fix on the code path it missed; nothing that worked in 0.26.2 changes.

- **`foreach` over an empty/whitespace string now iterates zero times for the `${V}` brace form too**, not just `$(REF)`. The 0.26.2 guard was added inside `resolveListExpr`'s `$(REF)` branch, but the `${V}` brace form (and any expression resolved via substitution) falls through to a different path that still wrapped an empty resolved value as `[""]` → one empty iteration. Since a caller-supplied-list skill typically writes `foreach A in ${V}` and passes `V` as a runtime input, the deployed bug was exactly the case 0.26.2 set out to fix (found by Perry re-verifying on the published runtime, `2db95446`). The empty→zero guard now sits on both paths; `foreach A in ${V}` with `V=""` / `V="   "` iterates zero times, matching `$(V)`, `[]`, and an absent ref. Root cause was a **test-coverage gap** — the 0.26.2 tests all drove the paren form; new end-to-end tests now drive the brace form via `execute`-with-inputs (the real caller path).

## 0.26.2 — 2026-07-06 — foreach/filter ergonomics: empty-input zero-iteration + order-independent `|fallback`

**Upgrade impact:** none (additive). Two cases that previously errored now succeed; nothing that already worked changes behavior.

Both fixes come from Perry dogfooding a list-driven `enter-project` skill (thread 9ed7554b):

- **`foreach` over an empty/whitespace-only string input now iterates zero times** (was: one iteration with an empty element). Passing `RULE_IDS=""` into a skill and iterating it used to run a single pass with `RID=""`, which then blew up downstream (e.g. `amp_get_memory("")`). An empty string is "no items", so it now matches `[]` and an absent ref — both already yielded zero iterations. A JSON-array string and a non-empty scalar are unaffected (still parsed / still wrapped to one iteration).
- **A `|fallback` now rescues an unresolved reference regardless of its position in the filter chain.** Previously only a *lone* `|fallback`, or a `|fallback` placed *first*, rescued an undefined base; any transforming filter ahead of it (`${x|trim|fallback:"d"}`, `${x|length|fallback:"0"}`) threw `Unresolved variable reference` before the fallback could fire. Now an undefined base propagates lazily past intervening filters to the fallback — matching Jinja's `undefined|filter|default` contract, so a chain containing `|fallback` never explodes on a missing ref. **Scoped to `undefined` only:** a value that resolves — including a whitespace string like `"  "` — still flows through every filter unchanged (`${WS|length|fallback:"0"}` with `WS="  "` is still `"2"`, not `"0"`), so no existing behavior shifts. A chain with **no** `|fallback` still throws on an unresolved ref exactly as before.

## 0.26.1 — 2026-06-29 — runtime_capabilities surfaces the filesystem allowlist

**Upgrade impact:** none (additive). New discovery field; no behavior change.

- **`runtime_capabilities` now reports `fsExecution`** — the filesystem allowlist, mirroring the existing `shellExecution`. An author could already discover which shell binaries were permitted but had **no way to learn which filesystem roots `file_read`/`file_write` may touch** short of trial-and-error or asking the operator (adopter finding 35f669cb, hit independently while wiring the file_read attachment skill). `fsExecution.allowlist` lists the allowed absolute roots (or `"(unset — default-deny)"`), with a description covering the three config paths. Because the roots are reported in the **runtime's** filesystem namespace, this also answers the cross-namespace "what's the runtime-side path?" question — an authoring agent in a different namespace (container vs the runtime host) can read the runtime's path vocabulary directly instead of guessing its local alias.

## 0.26.0 — 2026-06-29 — file_read base64 encoding (inline binary attachments)

**Upgrade impact:** none (additive). New optional `encoding` kwarg on `file_read`; existing reads default to `utf8` exactly as before.

- **`file_read(path="…", encoding="base64")`** reads a file's **raw bytes** and base64-encodes them, so a binary file (image, PDF) can be inlined into an API payload — e.g. an `attachments:[{content: "<base64>", …}]` JSON body. This has to be a read-mode, not a pipe filter: the default `utf8` read decodes bytes to text (corrupting non-text bytes with U+FFFD) *before* any filter could run, so base64-ing a binary file after a text read would encode garbage. Reading the raw bytes at read time is the only correct path (adopter request 7130c3bd). Node's base64 emits a **single line** (no 76-column wrapping), which is what inline JSON wants — and needs no `base64` shell binary, so the shell allowlist stays untouched.
  - `encoding` accepts `"utf8"` (default) or `"base64"`; anything else is refused at runtime and flagged tier-2 at compile by the new **`unknown-file-encoding`** lint rule (so a `"bas64"` typo is a lint line, not a failed run).
  - **The filesystem path allowlist still gates every read**, base64 or not — a skill can only base64 a file under an allowlisted root, so this opens no new exfiltration path. (And base64'd file content is *data*, so a file containing literal `{{secret.X}}` text is inert under the v0.25.3 author-template-only secret model — no marker-injection through an attachment.)
  - **Size note:** base64 inflates ~33%, and the encoded blob typically rides inline JSON into a downstream API. The practical wall isn't the runtime — it's the **target API's request-size limit** (e.g. a mail provider's max message size); an oversized attachment fails at that boundary, not in `file_read`.

## 0.25.3 — 2026-06-28 — security: author-template-only secret resolution (closes data-borne injection)

**Upgrade impact:** none (additive) for the documented usage — a `{{secret.NAME}}` marker written literally in a skill's `shell`/`$` op still resolves exactly as before. **Behavior change for an undocumented edge:** a marker that is *not* in the skill source — one assembled at runtime from `${VAR}` data or `$set`/`$append` — no longer resolves (it stays inert literal text). That path was never intended and was a leak; see below.

- **Closes data-borne secret injection (adopter finding).** Resolution used to run on the post-substitution sink string, so a `{{secret.NAME}}` marker that arrived via runtime *data* (a `${VAR}` value containing the literal text) got resolved — e.g. an email body containing `{{secret.AGENTMAIL_KEY}}` would inject the real key into the outbound message. The runtime now resolves **author-template-only**: it masks markers written literally in the op template *before* `${VAR}` substitution, then splices the values in last. A marker arriving through data is never masked, so it can never resolve — it passes through as inert literal text. (This also refines the var-smuggle edge: a marker built via `$set`/`$append` is data-borne and therefore inert, rather than resolving-if-declared.)
- **Sentinel forgery neutralized.** The masking uses a NUL-delimited sentinel; `${VAR}` substitution now strips NUL bytes from every substituted value, so untrusted data can't forge a sentinel to trigger a splice. (NUL is never valid in skill data — `spawn` rejects it — so the strip is loss-free.)
- **Unchanged guarantees:** values never bind/emit/trace; the binary-allowlist gate runs before resolution; errors/traces render the marker, not the value; declare-before-spend (`# Requires`) is enforced on author markers; the three tier-1 lint rules stand. Verified end-to-end across `shell(argv=…)`, `shell(command=…)`, and `$ connector.tool` sinks; the data-borne and forgery paths have regression tests.

Two lint improvements from the same dogfood (both adopter-found):

- **`undeclared-var` now scans `shell(argv=[...])` elements.** A `${VAR}` reference inside an argv element previously escaped the undeclared-var (and unknown-filter, legacy-`$(...)`-shape) checks — the lint's op-text collection skipped `argv`. Now an undeclared `${VAR}` in an argv element is caught at compile, like every other op position.
- **New tier-2 `space-separated-vars`.** `# Vars:` is comma-separated; writing `# Vars: A B C` silently collapsed into one malformed variable named `"A B C"` (the rest lost). The new warning flags any `# Vars:` entry whose name contains whitespace and suggests the comma form.

## 0.25.2 — 2026-06-28 — fix: secret-use-only no longer false-positives on a documented marker

**Upgrade impact:** none (additive). Removes a false positive introduced in 0.25.1; no change to valid skills beyond unblocking them.

- **Regression fix (adopter finding).** The 0.25.1 source-level backstop counted *every* `{{secret.NAME}}` in the raw source — including one written as prose in a `# Description:` line ("…auth via the sealed `{{secret.KEY}}` marker…"). Since a description isn't an executable position, the AST scan didn't account for it, so the backstop saw a surplus and fired `secret-use-only` (tier-1) — **blocking every skill that documents its own secret, including the recommended `shell(argv=[...])` sink form.** The backstop now excludes frontmatter/`#`-header lines from its count (op lines are always indented and never start with `#`), so a documented marker is ignored while a marker in a genuinely-dropped op line (the 0.25.1 bare-`emit` case) is still caught. Verified against the real `perry-inbox-check` / `perry-email-send` shapes.

> **Known issue (fix in progress):** a `{{secret.NAME}}` marker that arrives at a sink via runtime *data* (a `${VAR}` value that happens to contain the literal marker text) is currently resolved — a data-borne injection path. The fix is author-template-only resolution (only markers literally in the skill source resolve; data/var-borne marker text is inert). Until it lands, don't interpolate untrusted input into a secret-bearing sink. Tracked for the next patch.

## 0.25.1 — 2026-06-28 — fix: secret-use-only lint catches markers in malformed/dropped op lines

**Upgrade impact:** none (additive). A lint rule now catches a case it previously missed; no behavior change to valid skills.

- **`secret-use-only` source-level backstop (adopter finding).** The rule walked the parsed op AST, so a `{{secret.NAME}}` marker in a line the parser *dropped* — e.g. a malformed `emit {{secret.X}}` written without parentheses (the valid form is `emit(text="...")`) — slipped through as zero findings, even though the rule's own remediation lists `emit`. (Never a leak: the runtime gate already refuses to resolve a marker outside a sink, so the value never surfaced — this was a missing compile-time *warning*, not an exposure.) The rule now also compares every `{{secret.…}}` in the raw source against the markers the AST scan accounted for; any surplus (a marker in a dropped/unrecognized position) is flagged tier-1. Valid `emit(text=...)`/`$set`/sink placements are unchanged — no double-firing.

## 0.25.0 — 2026-06-28 — secret references: name a credential, use it, never expose it

**Upgrade impact:** none (additive). New opt-in syntax + two new tier-1 lint rules that fire only on skills using the new syntax. Existing skills don't use `{{secret.…}}`, so nothing changes for them. Operators who want to provision a secret add a `SKILLSCRIPT_SECRET_<NAME>` env var.

A skill can now reference an operator-provisioned secret by name — use it at a sink, never read it. This is the durable answer to "my skill needs a bearer token / API key" that doesn't put the credential in the skill source, the transcript, or a trace.

- **Declare + place.** `# Requires: secret.NAME` in the frontmatter declares the secret (an approver sees exactly which credentials a skill can reach before vouching for it). A `{{secret.NAME}}` marker places it. The marker is deliberately distinct from `${VAR}` readable substitution: `${VAR}` resolves the skill's variable scope and **cannot** reach a secret, while `{{secret.NAME}}` resolves *only* at a sink and is never bound to a variable.
- **Use-only, enforced at three layers.** A `{{secret.NAME}}` marker is legal **only** inside a sink — a `shell(...)` op or a `$ connector.tool` dispatch. (1) **Lint (tier-1)** blocks a marker anywhere else (`emit`, `$set`, a condition, an `# Output:` template, a `file_*`/`notify` op, an op `(fallback: ...)`) via `secret-use-only`, an undeclared marker via `secret-undeclared`, and a non-literal/dynamic name (`{{secret.${VAR}}}`) via `secret-dynamic-name`. (2) **`${VAR}` substitution treats a marker as opaque** — it can never reach inside to build a secret name at runtime, so the name is always exactly as authored. (3) **The runtime resolves only at the sink, only for names declared in `# Requires`** (exact-literal match), the instant before spawn/dispatch — the value never binds to a var, emits, or enters a trace (the trace records the marker). Error messages and traces are redacted so a refused or failing op never renders a resolved value. These survive lint-bypass / source-mode execution — the runtime is the authoritative gate, not just lint. (Hardened against a red-team pass that found and closed a dynamic-name bypass and a refusal-error leak before ship.)
- **Provisioning (`.env`).** The bundled `EnvSecretProvider` resolves `{{secret.NAME}}` from the env var `SKILLSCRIPT_SECRET_NAME`. The prefix is intentional — it scopes which environment is secret-reachable, so `{{secret.PATH}}` looks for `SKILLSCRIPT_SECRET_PATH`, never `$PATH`. Secrets are operator-provisioned; a skill author names them but cannot set or read them. Fail-closed: an unprovisioned or undeclared secret aborts the op (it never sends an empty or literal-marker credential to the sink).
- **Vault-ready by construction.** Resolution goes through a `SecretProvider` interface whose `resolve(name, ctx)` already carries the requesting skill's identity, so a future vault-backed provider (per-script sealing, central rotation) drops in with no call-site changes — inject it via `bootstrap({ secretProvider })` or `bootstrapFromEnv`'s `overrides`.
- **Threat model (documented boundary).** A secret you authorize a skill to *use* in a shell, that skill can also *exfiltrate* — e.g. `shell("echo {{secret.X}}") -> OUT` then `emit("${OUT}")`, or a `curl` that POSTs it anywhere. This is inherent to argv injection and is **not** prevented by the runtime; the controls are **approval review** (a human approves the skill before it runs) and **preferring a connector sink** (the connector holds the credential out of band, so it never round-trips through skill-visible stdout). On the shell path the resolved value is also briefly visible in the host process list (`ps`); the vault era closes that with sink-aware injection (0600 temp file / piped env). Use a connector sink for credentials whose exposure you can't accept.

## 0.24.0 — 2026-06-25 — adopter wishlist: bootstrapFromEnv + remote-store polling + connector reaping

**Upgrade impact:** none (additive). All four items are backward-compatible — a new export, an optional contract method, an opt-in tool param, and an internal lifecycle fix. Existing programmatic `bootstrap()` code keeps working; `bootstrapFromEnv()` is an *optional* simplification.

From an AMP-backed remote-store adopter dogfooding the runtime:

- **`bootstrapFromEnv()` — a blessed programmatic entry point.** Most adopters run `skillfile init` once, then operate via the web dashboard. This new exported helper stands that dashboard up from your own code *exactly the way the CLI does*: it loads `$SKILLSCRIPT_HOME/.env` + `skillscript.config.json` + `connectors.json`, resolves the full `SKILLSCRIPT_*` env cascade, calls `bootstrap()`, wires declarative triggers, and assembles the `DashboardServer`. Returns `{ wired, server }` (both unstarted; the caller `start()`s them and calls `wired.registry.disposeAll()` on shutdown). Precedence: explicit option > env > config.json > default. The CLI's `dashboard`/`serve` commands are now thin wrappers over it — closing the silent "every capability the CLI auto-wires had to be hand-assembled programmatically, and each omission failed silently" asymmetry.
- **`SkillStore.version()` — optional change-token kills the skill_list N+1 for remote stores.** Building the `skill_list` catalog loads every skill's body to parse its effectful footprint — free against a local store, but a network round-trip *per skill* against a remote one, so a polling dashboard hammered the substrate. A new optional `version()` returns a cheap store-wide token (no body loads); `skill_list` returns it as `catalog_version` and honors a caller's `if_none_match`, replying `{ not_modified: true }` and skipping the rebuild when nothing changed. The SPA now sends it (and pauses its poll when the browser tab is backgrounded). Bundled stores implement it (FS: per-file mtimes; sqlite: `(name, status, current_version)` in one query). Optional — a store without it just always rebuilds.
- **Connector reaping on shutdown.** `Registry.disposeAll()` (new) disposes connectors holding child processes on runtime shutdown, so a stdio-bridged MCP server child (`RemoteMcpConnector`) is reaped rather than orphaned to a dead parent across restarts. The CLI shutdown handler calls it; `bootstrapFromEnv()` callers should too. (Distinct from 0.23.1's respawn-on-death, which self-heals a child that dies *while running* — this reaps a child on *intentional* shutdown.)

## 0.23.1 — 2026-06-23 — fixes: connector-arg lint advisory + RemoteMcpConnector self-heal

**Upgrade impact:** none (additive).

- **Fix — `RemoteMcpConnector` now respawns a dead child instead of latching a permanent outage (adopter finding).** When the connector's stdio child exited (e.g. an external `SIGTERM`, exit code 143), it latched a terminal error state and **never respawned** — every subsequent dispatch returned `RemoteMcpConnector in error state` until a full runtime restart. A single child death = total connector outage. `start()` now self-heals: a dead prior session is discarded and the next dispatch (or `describeTools` warm) relaunches the child, mirroring a session reconnect. An intentional `dispose()` still blocks respawn (a post-dispose dispatch throws). Independent of what killed the child. Verified with a real spawned child that exits mid-request.
- **Fix — stale tier-3 advisory contradicting connector-arg lint (adopter finding).** The tier-3 `unverified-qualified-tool` advisory ("connector doesn't declare its tool surface statically; can't validate at compile time") co-fired against a connector wired via `describeTools()` but no `staticTools()` — i.e. every `RemoteMcpConnector` — and *contradicted* the 0.23.0 tier-2 connector-arg validation on the **same** op: an author saw "you passed an unknown arg (so I clearly know your schema)" alongside "I can't validate this tool." It now skips an op whose tool is verified by the warmed schema, and still fires only when neither a static nor a warmed dynamic surface is reachable (a truly-opaque connector, or a misspelled tool name not in the fetched surface). Probe-verified against the live ddg `RemoteMcpConnector`.

## 0.23.0 — 2026-06-23 — connector tool-schema discovery + connector-aware lint

**Upgrade impact:** none (additive). One thing to know: the new tier-2 lint can surface a *pre-existing* wrong-arg-name in an existing skill (it was always wrong; it just failed at dispatch before). Tier-2 is a warning — it never blocks compile or execution.

Authoring a skill against an MCP connector tool used to be guess-and-run: the runtime called the connector's `tools/list` but kept only tool *names*, discarding the argument schema. Now it retains the schema and puts it to work — without bloating agent context (schemas are surfaced selectively, never dumped).

- **Connector-aware input lint.** `lint_skill` validates `$ <connector>.<tool> arg=...` argument names against the tool's `inputSchema`: an unknown arg (`$ ddg.search querry=...`) is `unknown-connector-arg` and a missing required arg is `missing-required-connector-arg`, both tier-2. The schema is warmed on demand via a read-only `tools/list` (protocol introspection — not a tool dispatch, so it crosses no effect boundary) with a short timeout; a connector whose schema isn't reachable degrades to today's arg-agnostic behavior (no false positives). Runs entirely server-side — the schema never enters agent context.
- **Selective schema fetch.** `runtime_capabilities({ tool: "<connector>.<tool>" })` returns that one tool's full descriptor (name, description, `input_schema`) on demand. The default response stays the compact menu (tool names) — pull the manual only for the tool you're about to call.
- **`skill_preflight` surfaces tool contracts.** For the connector tools a skill actually calls, preflight now reports each tool's input schema and — once any approved run has dispatched it — its **last-observed output shape** (keys + types), so an author knows what `-> R` binds before running.
- **Observed-output-shape capture.** A `$ connector.tool` dispatch records the shape (keys/types, **not values**) of the value the skill binds, keyed by `connector.tool`, in an operator-local cache under `~/.skillscript/`. Once any approved skill runs a tool, later authors see its return shape. Privacy-first (no values); independent of trace mode.
- **Respects `allowed_tools`.** Every discovery surface honors the per-connector `allowed_tools` gate — a tool the operator gated off is never surfaced or validated against.
- **Adopter note:** custom `McpConnector` classes may implement the optional `describeTools()` method to light up the same discovery + lint; bundled HTTP/remote connectors provide it. A connector without it simply contributes no schema (graceful).

## 0.22.1 — 2026-06-22 — agent-facing allowlist guidance + docs accuracy

**Upgrade impact:** none (additive)

- **Allowlist denial messages now tell agents to escalate, not self-edit.** When a skill hits an off-allowlist shell binary or filesystem path, the runtime's remediation (`ShellBinaryNotAllowedError`, `FilePathNotAllowedError`) and the `shell-binary-not-allowed` lint rule previously read as an operator runbook — *"add it to `SKILLSCRIPT_SHELL_ALLOWLIST` in your `.env`, then restart."* Returned to a connecting agent through the MCP error, that reads as an instruction: the agent edits `.env` to self-grant the capability, defeating the operator boundary. The messages now lead with an agent-facing *"stop — this is a human-operator boundary; ask the operator, don't edit config yourself,"* with the wiring how-to clearly labeled operator-only (and a pointer to `blocked_shell_attempts` as the operator's review surface). Allowlist enforcement itself is unchanged.
- **CLI reference accuracy.** The README + landing-page CLI table dropped three commands removed back in v0.2.1 (`register-trigger` / `unregister-trigger` / `list-triggers`) and a dead `run` alias, added `init` / `list` / `approve` / `reapprove`, and now mirrors the CLI's own command order.
- **Quickstart restructured** around the human/agent division of labor — the human installs, configures, and wires the MCP; the human and agent author the first skill together — and the dashboard step is corrected (it's a blocking foreground server, so the browser is opened separately).
- **`.env.example` trimmed** to what each setting does (the security rationale moved to the adopter playbook), and its example port corrected to `7878`.

## 0.22.0 — 2026-06-21 — operator skill deletion

**Upgrade impact:** none (additive)

Deleting a skill is now a supported operator action. It's **operator-only** — an agent can author and disable a skill, but only a human at the CLI or dashboard can remove one. There is no agent/MCP delete surface.

- **`skillfile delete <name>` + a Delete button on the dashboard skill detail view** expose the SkillStore `delete()` contract operation to operators.
- **Destructive by design — no trash, no restore.** The bundled stores erase: `FilesystemSkillStore` unlinks the skill file + its version sidecar; `SqliteSkillStore` hard-cascades both tables. The name frees up immediately for reuse. The safety is the confirm step plus the reverse-dependency check, not recoverability. An adopter store *may* soft-delete instead — the runtime only requires "remove from normal views," and recovery semantics are the store's concern.
- **Reverse-dependency guard.** Before deleting, both surfaces run a best-effort static scan for other skills that reference the target via `execute_skill(skill_name="…")` / `inline(skill="…")`. The dashboard runs it as a preflight and folds any dependents into a single confirm ("`welcome-flow` references this — permanently delete anyway?"); the CLI aborts and requires `--force`. Literal-name only — a runtime-resolved `name="${VAR}"` reference can't be detected statically, so treat the scan as a heads-up, not a guarantee.
- **Trigger cleanup.** Deleting a skill drops all of its triggers — declarative `# Triggers:` and imperatively-registered alike — from the live scheduler, so a deleted cron/event skill leaves no orphan registration firing or lingering in the Triggers view.

## 0.21.2 — 2026-06-20 — dashboard-approve trigger re-sync fix + docs

**Upgrade impact:** none (additive)

- **Fix: dashboard `/approve` now re-registers a skill's declarative triggers in the live scheduler.** Approving a cron/event skill from the dashboard signed and stored it Approved but did not re-add its `# Triggers:` to the running scheduler. So a skill that was edited (which in secured mode forces it back to Draft, dropping its triggers) and then approved in the browser ended up Approved-but-trigger-less: absent from the Triggers view and silently not firing. The dashboard approve path now syncs declarative triggers the same way the MCP `skill_status` path does, and the scheduler is now wired to the dashboard unconditionally (previously only when `/event` ingress was enabled). Existing approvals are unaffected; the fix applies to subsequent dashboard approvals. (A process restart already re-registered them at startup — that workaround is no longer needed.)
- **Docs:** trimmed the README + landing page of reference-detail that belongs in the deeper docs; corrected the `skillfile audit` CLI signature; and the per-release **Upgrade impact:** convention plus a new [UPGRADING.md](UPGRADING.md) (pre-1.0 transition guide) now ship in the published package.

## 0.21.1 — 2026-06-19 — server-delivered agent instructions (cold-start on-ramp)

**Upgrade impact:** none (additive)

The MCP server now teaches a connecting agent how to use it — no CLAUDE.md
copy-paste, and it works for agents with no shared memory substrate.

- **`initialize` carries an `instructions` field** — the canonical agent-usage
  block (`SKILLSCRIPT_USAGE_INSTRUCTIONS`, a static backend-agnostic string in
  `help-content.ts`). Every connecting agent learns the workflow at session
  start: `skill_list` first → `skill_preflight` before composing → author when
  a routine repeats (lands Draft, a human approves) → `runtime_capabilities`.
- **Capabilities reframed as the author's menu** — the block presents the wired
  connectors / models / shell-allowlist as *what's capturable into a skill*, not
  just a defensive "don't assume a backend" check; if a needed capability isn't
  wired, the agent asks the operator to add it.
- **`docs/adopter-agent-guide` §1 reframed** — the runtime delivers the usage
  contract automatically, so an adopter's agent file can be minimal; the
  paste-block is now a fallback that mirrors the server's authoritative copy.

## 0.21.0 — 2026-06-18 — preflight contract surface + store-agnostic approval closure

**Upgrade impact:** none (additive)

The pre-execution contract is now first-class: an agent reads what a skill takes,
returns, requires, and *touches* before running it, and the human approver sees the
same effect footprint before signing.

- **`skill_metadata` renamed to `skill_preflight`** (clean rename, no alias — pre-
  adoption window). The name teaches the timing: call it BEFORE executing or
  composing. Its response carries the full contract — `vars` / `returns` /
  `requires` + the effectful footprint (connectors, builtins, shell binaries,
  file-write / file-read / unsafe-shell / notify counts) — plus approval-gate
  state and version/lifecycle.
- **The same contract mirrors onto every `skill_list` entry** (`returns`,
  `requires`, `effectful_footprint`), so an agent reads a skill's whole I/O +
  effect contract from one discovery call, no per-skill round-trip. Free — the
  source is already parsed to build the entry.
- **Dashboard "What this skill touches" approver checklist.** The skill detail
  view renders the AST-derived effectful footprint — the same op enumeration the
  capability gate authorizes — right at the approve action, so the operator sees
  the surface they're signing, not a regex guess.
- **Secured-mode approval closure moved to the MCP handler (store-agnostic).** The
  "skill_write / skill_status can't grant approval without a valid signature"
  guard now fires at the handler ingress, regardless of SkillStore substrate — a
  custom adopter store can no longer persist a forged `Approved` status. Closes a
  red-team finding (the per-store guard missed custom stores). The execute gate
  always backstopped it; this stops the *store* from lying.
- **Adopter-finding fixes:** one shared approval-key resolver (provisioning +
  signing can't diverge); a loud stderr boot-log line when secured mode + passcode
  are set but signing is unwired (reaches headless adopters who never open the
  dashboard); gate-aware Skills-view badges; runtime version shown in the dashboard.
- **Workflow-teaching pass across the MCP tool descriptions** — each tool teaches
  where it sits in the author loop (learn → discover → draft → commit → approve →
  run → automate → observe) and what comes next.
- **Docs overhaul:** in-browser approval + footprint checklist in the playbook;
  the approval/secured-mode env-var surface added to the configuration reference;
  retired-v1-token and shipped-strict-filter corrections in the connector-contract
  and sqlite-skill-store references; ARCHITECTURE rewritten to current reality;
  README + index quickstart + default-deny config fixes.

## 0.20.2 — 2026-06-18 — in-browser approval (passcode session-unlock)

**Upgrade impact:** none (additive)

Click-to-approve in the dashboard, without putting standing signing power on the
network surface.

- When `SKILLSCRIPT_APPROVAL_PASSCODE` is set (+ secured mode + a readable key),
  the dashboard mounts `POST /unlock` + `POST /approve` + `GET /signing-status`.
  The approver enters the passcode **once per browser session** to unlock
  signing; the dashboard then signs Approved skills with the operator's key.
- The unlock is **in-memory, session-cookie-bound, and idle-expires (15 min)** —
  the dashboard holds no *standing* signing power, only a live human-entered
  passcode unlocks it. `/approve` without a live unlock returns `needs_passcode`.
- The SPA shows a real **Approve** button (queue + skill detail) when signing is
  wired; clicking prompts for the passcode on the first approval of a session,
  then approves freely. Falls back to the copy-the-`skillfile approve`-command
  UX when signing isn't enabled.
- **Default off** (no passcode → routes 404, dashboard stays review-only).
  SECURITY: enabling this gives the dashboard process read access to the private
  key, so run it operator-side / isolated from the agent (the agent must have no
  network path to it and must not be able to read the passcode). `.env` now;
  vault/encrypted-key custody is the future hardening.

## 0.20.1 — 2026-06-17 — approval-migration UX + dashboard access gate

**Upgrade impact:** none (additive) — eases the 0.20.0 secured-mode transition; introduces no new break.

Follow-ups that make the secured-mode migration legible, plus an optional
access gate for the dashboard.

- **The approval queue now surfaces the legacy corpus.** `skill_list` entries
  carry a `gate_ok` flag (computed from the source already loaded to parse — no
  extra I/O), so the dashboard **Approvals** tab shows not just `Draft` skills
  but every `Approved` skill the gate refuses — i.e. a pre-secured `v1`-stamped
  corpus, badged "re-approval needed." Each drops out of the tab as it's
  re-signed. The tab becomes a migration worklist that empties as you work it.
- **Secured-mode startup warning.** When the runtime starts in secured mode it
  scans the store and warns once if any skill is Approved-but-unsigned, pointing
  at `skillfile reapprove --apply` — so the operator isn't discovering refusals
  skill-by-skill. Best-effort; never blocks startup.
- **Optional dashboard access gate.** `SKILLSCRIPT_DASHBOARD_AUTH_TOKEN` gates
  the dashboard SPA + `/rpc` behind a shared secret — presented via `?token=`
  (browser entry sets a session cookie), the `skillscript_dash` cookie, or
  `Authorization: Bearer`. Default unset → open (localhost bind, as before).
  This is network/casual hygiene for binding beyond localhost; the dashboard
  holds no signing key, so it is *not* an agent-forgery boundary (that remains
  key custody). `/event` keeps its own bearer token.

## 0.20.0 — 2026-06-17 — Gate #7: the approval security boundary

**Upgrade impact:** RE-APPROVE (only if you enable secured mode) — secured mode (`SKILLSCRIPT_SECURED_MODE=true`, default OFF) now enforces Ed25519-signed approval; skills approved the old way carry no valid signature and will not execute until re-signed. Bulk-discover + fix with `skillfile reapprove` (dry-run) → `skillfile reapprove --apply`. Default unsecured installs are unaffected. See [UPGRADING.md §3](UPGRADING.md).

The runtime gains a real, enforced execution boundary. The Draft → Approved
status gate applies in both runtime modes; the mode decides whether an Approved
skill must be **cryptographically keyed**.

- **Secured mode** (`SKILLSCRIPT_SECURED_MODE=true`) — an Approved skill executes
  effectfully only if its body carries a valid **Ed25519** operator signature.
  Asymmetric by design: the private key signs at approve-time and never reaches
  the runtime; the public key verifies on every execution. An unapproved or
  tampered skill cannot perform a single effectful op, regardless of how it's
  dispatched (CLI, cron, `/event`, MCP, in-skill composition).
- **Unsecured mode** (default) — approval is **unkeyed**: a bare
  `# Status: Approved` runs. The trusted-author / single-operator convenience
  posture. (The legacy v1 CRC32 hash-token scheme + the per-version approval
  registry are **retired**.)
- **Three default-deny operator allowlists**, always enforced in both modes:
  shell binaries (`SKILLSCRIPT_SHELL_ALLOWLIST`), MCP connector tools, and
  filesystem paths (`SKILLSCRIPT_FS_ALLOWLIST`, new — gates `file_read`/
  `file_write`, canonicalized against `..`/symlink escape).
- **Approve flow** — `skillfile approve <name>` (review + sign), `skillfile
  reapprove [--apply]` (batch re-bless), and the dashboard **Approvals** queue
  (review surface only — signing happens at the operator's terminal; the
  network-facing runtime never holds the private key). `skill_write` /
  `skill_status` cannot grant approval in secured mode.
- **Bundled examples ship `# Status: Draft`** (no shipped token can validate on
  another install); `skillfile init` locally approves the seeded demos with the
  machine's own authority (secured → provision keypair + sign; unsecured → bare
  Approved). First-run keypair provisioning is automatic; the default key path
  moved to `~/.config/skillscript/` (outside `SKILLSCRIPT_HOME`).
- Enforcement parity across surfaces: CLI by-name dispatch refuses an unapproved
  skill outright (matching scheduler/MCP); by-path stays the ad-hoc escape with
  effects gated. `SqliteSkillStore` reaches secured-mode parity with the
  filesystem store.

## 0.19.16 — 2026-06-16 — adopter-facing doc batch + MCP help-schema fix + event deliver-leg test

Doc batch surfaced by two live-engagement reviews (the skillscript
adopter agent wiring YouTrack + DuckDuckGo, and Perry's v0.19.15 ring
signoff probes) plus one MCP-schema bug that surfaced while reviewing
the new adopter-agent-guide.

### Fixed — MCP help-schema gap

- `src/mcp-server.ts` — `composition` was supported by the `helpResponse()`
  handler since v0.2.11 but never added to the `help` tool's `inputSchema.enum`.
  An agent calling `help({topic: "composition"})` via the MCP wire was
  rejected by schema validation before reaching the handler. Now in the
  enum + description.
- `tests/v0.2.11.test.ts` — added a regression test that exercises the
  MCP-wire path (not just the helpResponse() function in isolation), so
  any future schema-vs-handler drift fails loudly.

### Added — event-trigger deliver-leg test (closes Perry probe `0a42b363`)

- `tests/v1.0-event-trigger-e2e.test.ts` — new test asserts the canonical
  site-distress-relay shape end-to-end: register trigger → `fireEvent` →
  poll the trace store for the returned run_id (= trace_id per v0.19.0
  preMintedTraceId plumbing) → assert the fired skill executed cleanly
  and emitted its declared output. Two test-author gotchas surfaced
  while wiring this: (a) the universal v0.9.0 approval gate refuses
  naked `# Status: Approved` — test skills must `stampApprovalToken(body)`
  before storing; (b) `# Vars:` must declare every name the eventPayload
  supplies, else the lint preflight silently refuses dispatch. Both are
  correct production behavior, but invisible to tests that only assert
  on the synchronous `fireEvent` return value.

### Docs — adopter-facing surfaces aligned with reality

- `docs/adopter-playbook.md` — six findings from the skillscript adopter's
  live YouTrack + DDG engagement:
  - **Gap 1 — `framing: "newline"`** explicit in the stdio `RemoteMcpConnector`
    example, with a one-line cross-link to the configuration.md anchor.
    The legacy `lsp` default silently hangs to `init_timeout` against
    newline-framed servers (mcp-remote + most spec-compliant MCP stdio
    servers). The playbook examples are what adopters copy.
  - **Gap 2 — drop `--sse`** from the `npx mcp-remote` example. The
    bridge auto-negotiates Streamable HTTP first, SSE as fallback;
    `--sse` only when the server explicitly requires it.
  - **Gap 3 — host-PATH prerequisite** for the stdio path. The `command`
    (server binary, `node`/`npx`, `uv`/`uvx`) must be on the runtime
    host's PATH at spawn time; CLI inherits the launching shell's PATH,
    programmatic bootstrap inherits its parent's.
  - **Minor — local install** for the custom-bootstrap path (so `tsx`/
    `node` can resolve `skillscript-runtime` alongside project deps); the
    global install is for the bundled CLI.
  - **§6 Running as a supervised service** (new section) — macOS
    LaunchAgent + Linux systemd unit examples with the load-bearing
    PATH-pinning gotcha (launchd/systemd run with bare PATH, not your
    shell's; the runtime's spawned binaries — `node`/`npx`/`uv`/`uvx`/
    every shell-allowlist binary — must be on the pinned `Environment.PATH`).
    Plus WorkingDirectory + single-supervisor + `.env`-still-loads
    gotchas. Validated live against a `~/Library/LaunchAgents/com.skillscript.adopter.plist`.
  - **§7 Wiring your agent over MCP** (new section) — Claude Code "just
    ask" path + manual HTTP MCP config + stdio bridge via `mcp-remote`,
    with operational notes on port matching + the `/rpc` no-auth/127.0.0.1
    default bind posture.
  - Dated parenthetical scrubbed from §169 per `feedback_playbook_is_timeless`.
- `docs/adopter-agent-guide.md` — `skill_list()` category descriptions
  corrected: `receives` is augmenting-only (`# Output: agent: <name>`),
  not augmenting/template; templates land in `skills` (agent-invokable).
- `src/help-content.ts` — "Return shapes are tool-native" paragraph
  added to the connectors help topic (Perry doc-polish thread `37a0f0b1`
  item 1): contrasts structured-envelope (`youtrack.search_issues -> R`
  → `R.issuesPage[]`) vs pre-formatted-text (`ddg.search -> R` → text
  blob) returns, with the three inspection paths (`runtime_capabilities`
  / probe-run / `compile_skill`).
- `README.md` — quickstart MCP-wiring snippets re-rendered: `json`
  language hint on the code fences, clean 2-space JSON indentation,
  removed the literal `:\` trailing characters, "just ask Claude Code"
  lead-in matching the playbook §7 framing.

No runtime behavior changes. Full suite: 147/147 files, 1984/1988 tests
pass (+2 vs v0.19.15: deliver-leg + MCP-wire composition regression).

## 0.19.15 — 2026-06-15 — v1.0 runtime-semantics test battery (freeze-guard ring)

Closes Perry's `f6b479f5` #2 ask. Existing 1924-test suite is heavy on
parse/compile/lint coverage but light on execute-and-assert-output for
the v0.19.12 frozen-surface primitives — without execution-test backing,
the v1.0 surface freeze holds in docs but not in code.

This release adds 58 execute-and-assert tests across five new lanes:

- **Lane (a)** — `tests/v1.0-runtime-semantics.test.ts` (26 tests): all
  eight filters in `KNOWN_FILTERS` — `|length` (array vs string vs
  object), `|trim`, `|json`, `|fallback:` empty-aware predicate,
  `|contains:`, `|url`, `|shell`, `|isodate`.
- **Lane (b)** — `tests/v1.0-numeric-coercion.test.ts` (9 tests):
  `Number()`-coerced `<`/`>`/`<=`/`>=` comparisons (not lexicographic),
  `if`/`elif`/`else` chain dispatch, `TypeMismatchError` surface.
- **Lane (c)** — `tests/v1.0-event-trigger-e2e.test.ts` (6 tests):
  `Scheduler.fireEvent` happy path, `EventNotFoundError`, strict v1
  param validation (missing + extra), case-insensitive lookup,
  per-fire run_id distinctness.
- **Lane (d)** — `tests/v1.0-composition-runtime.test.ts` (5 tests):
  `$ execute_skill` end-to-end, `# Returns:` filter, `${R.final_vars.X}`
  reach, recursion-depth guard (default limit 10), forward-reference
  resolution.
- **Lane (e)** — `tests/v1.0-output-kinds.test.ts` (12 tests): all five
  output kinds (text/none/agent/template/file), Level-2 `${VAR}` agent
  target substitution, body-text-as-output template (Pin 4) with var
  interpolation + template-vs-emit channel split, three shell call
  shapes (`command=` / `argv=[...]` / `unsafe=true`), `(fallback:)`
  op-trailer fire on empty-stdout + no-fire on success.

Single-command invocation: `pnpm vitest run v1.0` runs all five lanes
in 200ms. Total: 58 tests, 100% pass on first run after the standard
fixture iteration — no runtime changes needed for the freeze to hold.

## 0.19.14 — 2026-06-15 — docs: full language-reference re-render (restores missing Connectors section)

Discovered while re-rendering after v0.19.13: `docs/language-reference.md`
had a pre-existing gap — the entire `## Connectors` section (~17KB,
covering the five connector types, agent_id resolution, PortableMemory
shape, field-access tier rules, and per-call identity overrides) was
present in the authoritative atom-side document anchor (`50fcecc8`,
`skillscript-language-reference`) but never made it into the checked-in
MD. The gap predated v0.19.13 — likely introduced when someone hand-edited
the MD without running `amp_render_document` afterward.

v0.19.13's "Output target resolution" splice also closed with a pointer
to *"the Connectors section (AgentConnector) for the full delivery
contract"* — a dangling cross-reference when that section wasn't in the
MD. This release lands the proper full render and resolves both issues.

Workflow lesson captured: re-rendering the language reference means
running `amp_render_document({slug: "skillscript/skillscript-language-reference"})`
and overwriting the MD wholesale, NOT hand-splicing the delta. Hand-splicing
preserves drift; full render is the only path that keeps the MD == atoms.

## 0.19.13 — 2026-06-15 — pre-v1.0 frontmatter rot cleanup + agent_id resolution chain documented

### Removed (pre-v1.0 surface freeze cleanup)

Two frontmatter headers that shipped as discipline-only-contract
surfaces with no enforcement or downstream consumers — removed
to keep the v1.0 frozen surface honest.

- `# Connectors:` — documented in language-ref atoms but never
  parsed, linted, or read anywhere in the runtime. Doc surface
  claimed per-skill connector selection; implementation had zero
  lines of code matching the claim. Removed from doc atoms; no
  code change needed since nothing referenced the header.
- `# Use when:` — inverse rot: parsed and stored on the AST
  (`ParsedSkill.useWhen`) but with zero downstream readers (no
  `skill_list` surface, no lint, no dashboard render). Parser hook
  and AST field removed; existing skills using the header (if any)
  now silently ignore the line, same as any unrecognized
  `# Foo:` key.

Both were the same shape — surfaces named without wiring — and
the v1.0 surface-freeze commit means every documented header must
be backed by actual behavior. Pre-v1.0 + zero adopter usage =
clean removal, no migration tooling needed.

### Documented — agent_id 2-level resolution chain

`# Output: agent: <target>` and `# Output: template: <target>`
have always resolved through a 2-level chain (explicit literal
+ compile-time `${VAR}` substitution against the resolved inputs
map), but the spec lived only in language-ref atoms — no MD
documentation, no `help()` topic coverage. Skill authors writing
`# Output: agent: ${TEAM}` had to discover the behavior by
trial-and-error or by reading `compile.ts`.

Now documented in:
- `docs/language-reference.md` — new "Output target resolution"
  subsection in the output section (right after Multiple output
  targets).
- `src/help-content.ts` — new "Output target resolution"
  subsection in the `help(topic: "frontmatter")` reference.

No code change; pure documentation completion of the existing
v0.19.12 surface ahead of the v1.0 freeze.

## 0.19.12 — 2026-06-14 — runtime_capabilities accuracy + unified fallback semantics (closes Perry's 7395b8af)

Perry built `pr-review-prep` (a body-template skill calling
`gh pr list`) and hit two real bugs in succession.

### Finding 1 (HIGH) — `runtime_capabilities.shellExecution` was lying

The surface claimed *"any binary on PATH may be invoked"* — written
pre-v0.18.8 and never updated when the default-deny shell allowlist
shipped. Discovery surface contradicted enforcement. Perry twice gave
Scott wrong operator guidance based on reading the false claim.

**Fix**: `shellExecution` now reports the actual `allowlist` (array
when wired, `"(unset — default-deny; no shell ops will run)"`
otherwise) + a description that explains the allowlist-gated reality
and the three wiring paths (`SKILLSCRIPT_SHELL_ALLOWLIST` env,
`shellAllowlist` field in `skillscript.config.json`, programmatic
`bootstrap({shellAllowlist: [...]})`).

### Finding 2a — `|fallback:` template filter wasn't empty-aware

`${PRS|fallback:"No current PRs."}` did NOT fire when PRS bound to
empty string (the canonical `gh pr list` no-results case writes
nothing to stdout). Pre-fix the filter fired only on `undefined`.

**Fix**: aligned with the `$`-op trailer semantic — fires on
empty-string-after-trim OR empty-array OR null/undefined. One
emptiness predicate across both fallback surfaces.

### Finding 2b — `(fallback:)` op-trailer was silently no-oped on `shell()`

`file_read` honors `(fallback:)` on throw (catch error → bind
fallback + record). `shell()` didn't — the trailer parsed but the
runtime ignored it. Perry's "the runtime-intrinsic op-trailer isn't
expected to fire" framing was actually a missing implementation; the
file_read precedent shows it should work.

**Fix**: `shell()` now honors `(fallback: "value")` on throw OR empty
stdout, uniformly across all three forms (`command=`, `argv=`,
`unsafe=true`). Wrapped via a shared `recordShellFallback` helper
that pushes a `fallbacks[]` record (matches file_read's pattern).

### Bonus — closes the buried-root-error case

Pre-fix, when shell threw + a template referenced the unbound var,
the surface error read as `UnresolvedVariableError` on the template;
the root `ShellBinaryNotAllowedError` was buried in `errors[0]`. With
F2b shipped, the canonical case dissolves: shell op catches its error
via the fallback path, binds the fallback value, template renders
cleanly. No buried error.

### What changed

- `src/mcp-server.ts:1116` — `shellExecution` reports `allowlist` field
  + accurate description; drops the false "any binary on PATH" claim.
- `src/runtime.ts:1822` — `|fallback:` filter empty-aware semantic.
- `src/runtime.ts shell case` — try/catch + empty-stdout coverage on
  argv + command= paths; `recordShellFallback` helper closure pushes
  fallback records to `fallbacks[]`.
- `src/help-content.ts` — `shell()` op description includes the
  unified fallback semantic + cross-link to the `|fallback:` filter.
- `tests/v0.19.12-shell-runtime-capabilities-fallback.test.ts` — 11
  regression tests across all three findings (runtime_capabilities
  accuracy with/without allowlist; filter empty-aware on
  undefined/empty/whitespace/non-empty; shell op fallback on throw +
  empty stdout in argv + command= forms; Perry's canonical
  gh-empty-stdout scenario).
- `scripts/loc-ceiling.mjs` — narrow ceiling 11400 → 11500.

1924 total tests (+11 net new).

### Migration

No migration required. The filter change is empty-aware-additive
(values that previously rendered as empty now render as the fallback
arg). The shell op-trailer change is additive (skills with no
fallback continue to throw exactly as before; skills with fallback
now have it honored). The runtime_capabilities change is read-only
surface accuracy.

## 0.19.11 — 2026-06-10 — `shell(argv=[...])` — cold-author-safe arg passing (closes Perry's adc87d52)

Perry's qwen2.5:7b authorability probe surfaced an inverted safety
gradient in `shell()`. The discoverable path for passing args with
spaces was `unsafe=true` (full bash, injection surface, tier-2 lint).
The safe path was an obscure file-roundtrip trick. The cold author
reaches for the unsafe surface, and silent-wrong runtime feedback
(e.g., `say` joining stripped tokens to sound ~right) reinforces it.

For a system whose v1.0 gate IS cold-author-safe-success, that's
backwards.

### The fix — new `argv=[...]` form

`shell(argv=["bin", "arg1", "${VAR}", ...]) [-> R]` — each list
element is exactly one argv token; no tokenization, no quote-stripping,
no shell. `${VAR}` substitutes per element and the result does NOT get
re-split, so an arg with spaces stays one arg. Strictly safer than
`unsafe=true`:

- No shell process spawned (execv-class semantics)
- No metacharacter interpretation (no `;` / `|` / `$()` / etc.)
- No quote-handling ambiguity (there are no quotes)
- Injection-surface zero — adversarial input becomes a literal argv
  element, can't escape

```
shell(command="git status --porcelain") -> STATUS                              # structural; safe for simple args
shell(argv=["say", "-v", "${VOICE}", "-f", "${PATH}"]) -> OUT                  # argv; safe for args-with-spaces
shell(command="echo hi && date +%Y", unsafe=true) -> OUT                       # unsafe; for real shell features
```

### Mutex rules (parse-time errors)

- `shell(argv=[...], command="...")` → parse error. Pick one form.
- `shell(argv=[...], unsafe=true)` → parse error. argv is execv-class;
  there's no bash to opt into.

### Binary allowlist intact

`argv[0]` is the binary by construction. The v0.18.8 shell-binary
allowlist applies identically to `argv` mode and `command=` mode.

### New tier-2 lint — `shell-quoted-var-in-command`

Catches the cold-author foot-gun pattern at authoring time:
`shell(command="echo '${VAR}'")`. Pre-v0.19.11 this passed lint clean
because the structural tokenizer DOES respect quotes during the
original whitespace split — but after `${VAR}` substitution, quotes
inside the substituted value can drift the tokenizer (e.g., `Jamie's`
breaks). The lint message points at the argv alternative as the safer
shape.

Suppressed on argv mode (the safe path) and on unsafe mode (bash
handles quoting). Doesn't fire on literal-quoted args without `${VAR}`
inside (e.g., `'hello world'` is fine).

### Help text updated

The `shell()` topic in `help({topic: "ops"})` now describes all three
forms — structural `command=`, explicit `argv=`, full-shell `unsafe=`
— with the quote-trap warning and inline guidance on which form to use
when.

### What changed

- `src/parser.ts` — accepts `argv=[...]` JSON-array kwarg on `shell()`;
  mutex enforcement against `command=` and `unsafe=true`.
- `src/runtime.ts` — argv path spawns `argv[0]` with `argv.slice(1)`
  directly after per-element substitution. Shell binary allowlist
  applied to argv[0]. Mechanical-mode preview supported.
- `src/lint.ts` — `shell-quoted-var-in-command` (tier-2).
- `src/cli.ts` — `cmdRun` (skillfile execute) now reads
  `SKILLSCRIPT_SHELL_ALLOWLIST` + `SKILLSCRIPT_ENABLE_UNSAFE_SHELL` via
  the existing `resolveRuntimeConfigFromEnv` and threads them into the
  execute ctx. Pre-v0.19.11 CLI execute had a separate code path that
  skipped env wiring — same CLI-auto-vs-programmatic-explicit class as
  the v0.19.1 env-resolver fix (memory `9d969eb1`).
- `src/help-content.ts` — `shell()` op text rewritten for three-form
  surface + quote-trap warning.
- `tests/v0.19.11-shell-argv.test.ts` — 15 regression tests covering
  parser/mutex/malformed/runtime/allowlist/lint paths.

1913 total tests (+15 net new).

### Migration

No migration required. Existing `shell(command=...)` ops work
unchanged. The lint warning fires on the `'${VAR}'` / `"${VAR}"`
patterns inside structural commands — author chooses to rewrite as
`argv=[...]` (recommended) or dismiss (when values are known-simple).

## 0.19.10 — 2026-06-09 — Three dogfood findings closed (Perry's 650c5a9c)

Three real authorability frictions Perry hit while wiring `project-brief`
end-to-end against `youtrack` (RemoteMcpConnector) + `amp`
(HttpMcpConnector). All cold-author-relevant. Closed in severity order.

### Finding 1 (HIGH) — `$ <connector> <tool>` foot-gun + misleading error

`$ youtrack find_projects query="..."` (space-separated, CLI muscle
memory shape) parses as a bare-form dispatch where the FIRST token is
the tool name. Skillscript sent `name: "youtrack"` to the MCP server,
which replied "Tool 'youtrack' not found" — the error sounds like the
**connector is broken**, sending the author to debug `connectors.json`
instead of their syntax.

**Fix**: new tier-1 lint `connector-as-tool` catches the pattern at
authoring time. When a `$` op's body's first token matches a known
connector name AND a second bare identifier follows (not a kwarg key
ending in `=`), the lint fires with explicit remediation:

> `$ youtrack find_projects ...` — `youtrack` is a connector name, not
> a tool. Bare-form dispatch treats the first token as the tool name,
> so this sends `name: "youtrack"` to the server (which replies
> "Tool 'youtrack' not found" — a misdirecting error). Two correct
> forms: `$ youtrack.find_projects ...` (dotted; explicit
> connector.tool) OR `$ find_projects ...` (bare tool; runtime
> resolves to owning connector).

The regex uses `\b` to prevent greedy backtracking onto partial matches
of the legit same-name kwarg shape (`$ data_write content="..."` where
`content=` is a kwarg, not a tool token).

### Finding 2 (MED) — `${R|length}` silent-wrong char-count

Per-MCP-server result shape varies. When `content[0].text` JSON-parses
cleanly, the runtime returns a structured value (HttpMcpConnector +
RemoteMcpConnector both use the same `unwrapToolResult` path). When the
parse fails (prose-wrapped JSON, multi-content responses), the bound
var lands as a string. `${R|length}` then silently returns the string's
char-count instead of the intended element-count — Perry's "1394 open
issues" surprise (real: 5).

**Fix**: tier-3 advisory `remote-result-needs-parse`. Narrow scope:
fires ONLY on `${R|length}` for `R` bound by `$` (the silent-wrong
path), NOT on `${R.field}` (which loudly raises
UnresolvedVariableError). Suppressed when the skill already does
`$ json_parse ${R} -> P` somewhere — author has defended.

Did NOT auto-parse aggressively: the root cause is server-specific
(some servers return JSON-as-text, some prose-wrap, some multi-content);
the runtime's existing JSON.parse path is correct for spec-clean
servers. Auto-strip / multi-content extraction would be risky semantic
changes pending more data on which servers do what.

### Finding 3 (LOW-MED) — emissions over lastBoundVar (silent masking closed)

Pre-v0.19.10, `outputs.text` for a no-template skill with both `emit()`
AND `-> R` (or `$set R`) returned `lastBoundVar` (the internal scratch),
NOT joined emissions. Perry hit this on `project-brief`: the emitted
brief lived only in transcript; `outputs.text` returned the last `-> R`
value (internal scratch from a mid-skill `json_parse` step).

**Fix**: prefer emissions over lastBoundVar in `src/runtime.ts`. When
the author writes `emit()`, emissions ARE the canonical output; `-> R`
is internal scratch. Behavior change for text/file/none output kinds:

```ts
} else if (emissions.length > 0) {
  outputs[key] = emissions.join("\n");  // v0.19.10 — emit-first
} else if (lastBoundVar !== null && vars.has(lastBoundVar)) {
  outputs[key] = vars.get(lastBoundVar);  // compute-and-return pattern
}
```

Compute-and-return pattern (no emit, just `-> R`) preserved — falls to
lastBoundVar when emissions is empty.

### Migration

- **Skills calling `$ <connector> <tool>` space-separated**: tier-1 lint
  now blocks compile. Fix: rewrite as `$ connector.tool` or `$ tool`.
- **Skills with `emit()` + `-> R` relying on outputs.text = R**: behavior
  change. `outputs.text` is now joined emissions. If you need R, use
  `# Returns: R` to export R as `final_vars.R`. Two pre-v0.19.10 tests
  in `v0.5.0-outputs-shape.test.ts` codified the old (incorrect)
  semantic and have been updated to assert the new behavior.

### What changed

- `src/lint.ts` — `connector-as-tool` (tier-1) + `remote-result-needs-parse` (tier-3)
- `src/runtime.ts` — emissions over lastBoundVar in outputs.text path
- `scripts/loc-ceiling.mjs` — narrow ceiling 11250 → 11400
- `tests/v0.19.10-dogfood-findings.test.ts` — 10 regression tests
- `tests/v0.5.0-outputs-shape.test.ts` — updated to assert emit-first semantic
- `tests/v0.19.4-output-template.test.ts` — legacy-shape test updated to
  v0.19.10 string shape
- `tests/v0.2.8.test.ts` — recursion-depth-guard test now uses
  `# Returns: R` for proper error propagation (was relying on the
  closed lastBoundVar leak)

1898 total tests (+10 net new).

## 0.19.9 — 2026-06-09 — connectors.json SECURITY hotfix + scaffold polish + doc renders

Closes adopter `14609652` — two silent-failure footguns on the
declarative connectors.json path, one of them a security-control
bypass.

### Finding 1 (SECURITY) — `allowed_tools` misplaced inside `config:` silently allow-alls

`allowed_tools` is a per-connector security policy parsed at the
connector entry top-level (sibling to `class` / `config`). When an
adopter placed it inside the `config:` block (the natural intuitive
location — it's a per-connector restriction), the loader silently
dropped it and the connector defaulted to allow-all. No lint flag, no
runtime refusal, no warning. A tool the operator had EXCLUDED
dispatched successfully to the remote MCP — security control quietly
nonexistent.

**Fix**: hard parse error on misplacement. The loader refuses to load
the connector with a message that names the misplaced field and shows
the correct shape inline:

```
connectors.json: entry 'youtrack' has 'allowed_tools' inside the 'config:'
block — that placement is silently ignored. 'allowed_tools' is a
per-connector security policy, not connector-class config. Move it to the
entry top-level (sibling to 'class' and 'config'):
  "youtrack": { "class": "...", "config": {...}, "allowed_tools": ["tool1", "tool2"] }
Refused to load to prevent a silent allow-all bypass.
```

Hard-error (not warn) because a security control silently doing
nothing is the worst-case failure mode. The operator wrote an
allowlist with intent to restrict; the loader must refuse rather than
allow-all when the intent is structurally clear but misplaced.

### Finding 2 — RemoteMcpConfig framing default ≠ mcp-remote's wire format

`RemoteMcpConfig.framing` defaults to `'lsp'` (Content-Length-framed).
The `mcp-remote` npm package (and most spec-compliant MCP stdio
servers) speak newline-delimited JSON-RPC. With the wrong framing the
handshake silently hangs to init-timeout — no clear "wrong framing"
signal. The scaffold's `_example_disabled_remote_mcp` (literally an
`mcp-remote` example) omitted `framing` entirely, so a copy-paste
adopter inherited the wrong default + silent hang.

**Fix**:
1. **Scaffold sets `framing: "newline"` explicitly** in the
   mcp-remote example, with an inline comment naming the default's
   historical bias and when to use `"lsp"`.
2. **Init-timeout error message names framing** as a likely cause —
   when `initialize` times out, the error now reports the framing in
   use and points at the alternative as a common fix.
3. Did NOT flip the default (kept `lsp`) to avoid a breaking change
   for adopters who configured `lsp` implicitly. The explicit scaffold
   + clearer error close the immediate footgun; a default-flip can
   ship later with a deliberate audit.

### Bonus — Perry's language-reference atoms rendered

`docs/language-reference.md` re-rendered from Perry's AMP atom set
(authoritative on the v0.19.0 trigger collapse + the v0.19.4-v0.19.8
body-text-as-output template arc). Previously stale on both. +181 /
-159 lines. No code change; doc-only.

### Bonus — connectors.json programmatic-bootstrap callout

Closes the earlier adopter doc-prominence finding (third instance of
the CLI-auto-vs-programmatic-explicit pattern, alongside `.env` and
`SKILLSCRIPT_*` env vars). Case 2 wiring now has a ⚠ callout flagging
that programmatic `bootstrap()` adopters must pass
`connectorsConfigPath` (CLI auto-discovers; programmatic does not).
§"Programmatic bootstrap path" generalized to a 3-surface table.

### What changed

- `src/connectors/config.ts` — misplaced-`allowed_tools` hard-error guard
- `src/connectors/mcp-remote.ts` — init-timeout error names framing
- `scaffold/connectors.json` — sets `framing: "newline"`, demonstrates
  correct `allowed_tools` placement at entry top-level
- `docs/configuration.md` — RemoteMcpConnector framing section + clarified
  `allowed_tools` placement rule
- `docs/adopter-playbook.md` — connectors.json + framing callouts
- `docs/language-reference.md` — re-rendered from Perry's atoms
- `tests/v0.19.9-connectors-gotchas.test.ts` — 5 regression tests
- `tests/v0.4.0.test.ts` — forward-compat test updated (allowed_tools
  is no longer a generic "unknown field" — it's intentionally guarded)

1888 total tests (+5 net new).

### Migration

No migration required for skills. Adopters running pre-v0.19.9
connectors.json with `allowed_tools` correctly at the entry top-level:
no change. Adopters with `allowed_tools` MISPLACED inside `config:`:
the loader will now refuse with a clear message — move the field to
the entry top-level to fix. (If the misplacement was silent allow-all
that the operator intended as restriction, the security posture is
now strictly tighter.)

## 0.19.8 — 2026-06-08 — Template-anywhere (closes Perry's 349a1d49 — bottom-placed templates now parse)

Authors' instinct is **compute first, output last** — every language they
know puts return/print at the end. Perry's qwen authorability test
caught the gap: when finally prompted to add an output template, the
model placed it at the bottom (after `default:`). Pre-v0.19.8 this
parsed as a malformed target with a misdirecting error:

```
# Skill: fetch-page
# Vars: URL=""

get:
    shell(command="curl -s ${URL}") -> FetchedPage
default: get

OUTPUTS: ${FetchedPage}      ← misparsed as `target OUTPUTS with deps`
```

→ `Tier-1 [missing-dependency] Target 'OUTPUTS' depends on '${FetchedPage}'…`

### The fix — Pin 4 applied uniformly

Pin 4 was already the disambiguation rule for the top region. v0.19.8
extends it to all positions:

> **A column-0 `<name>:` line is a TARGET only if it is followed by an
> indented op-block. Otherwise it's template text — regardless of
> position (top, bottom, or both).**

Subsumes the original top-only rule. Position is now free. Bottom-placed
templates parse cleanly: `OUTPUTS: ${FetchedPage}` (no op-block follows)
reads as template prose.

### Multi-region templates — explicit error

If template content appears BOTH before any target AND after all
targets, raise a parse error per Perry's recommendation:

> "Skill has body-text-as-output template content in two places
> (before targets AND after targets). Pick one location: put the
> template either above all targets OR below them, not both.
> Concatenating across regions silently would hide the structural
> ambiguity."

Loud over silent-concat. Forces the author to pick one location.

### What changed

- `src/parser.ts` — removed the `inTemplateRegion` permanent-exit
  state. Template capture now runs on every line and applies Pin 4
  uniformly. Added `recordTemplate` helper + multi-region tracking.
  Blank lines inside target body (Bug 15 whitespace) NOT captured
  as template — only blanks outside any target body. The v0.19.7
  orphan-indented-op guard still fires for indented lines past any
  target (preserves the silent-drop fix).

- `tests/v0.19.4-output-template.test.ts` — 8 regression tests:
  bottom template parsing + compile + execute, Perry's qwen
  `OUTPUTS:` case rendering clean, multi-region parse error,
  top-only / bottom-only individually, Bug 15 target-body blanks
  not contaminating template, full bundled-corpus regression.

1883 total tests (+8 net new).

### Migration

No migration required. Top templates continue to work unchanged.
Authors may now write the template at the bottom of a skill as
their language instincts suggest.

### Note: `bdf760f4` (tier-3 advisory) deferred

Perry's companion finding — a tier-3 "no explicit output" advisory
that fires when a skill binds vars but writes no template / emit —
was deferred per her own sequencing note: "the template-anywhere
change reduces this one's urgency — once authors can put the
template where instinct says (the bottom), the 'forgot it entirely'
rate should drop. So I'd sequence this after the position fix
and re-measure." Watching the next dogfood rung before deciding.

## 0.19.7 — 2026-06-08 — HOTFIX — Silent-drop guards (closes Perry's 9a62c1f2 minion-test finding)

The worst authorability failure mode: parser silently swallows a real
directive, author/agent gets zero signal that their logic was discarded.

Perry ran qwen authorability rungs against v0.19.6 and surfaced a real
case. Qwen wrote:

```
# Skill: greet
# Vars: WHO=world

Hello ${WHO}.

default: stamp
    shell(command="date +'%Y-%m-%d'") -> TODAY
```

(Ops written directly under `default: stamp` instead of declaring a
`stamp:` target first, then `default: stamp` separately.)

Pre-v0.19.7: compiled cleanly. Zero errors, zero warnings, zero
advisories. Template-only output: `"Hello world."` — the entire shell
op silently vanished. `entryTarget` got set to `"stamp"` (a target that
doesn't exist). Both forms of silent-drop are now loud errors.

### The fix — two new parser errors

1. **Orphan indented op** — an indented op line with no enclosing
   target body raises a tier-1 parse error. Message guides the author
   to declare the target first.
2. **Entry target referencing missing target** — `default: <name>`
   where `<name>` isn't in `parsed.targets` raises a tier-1 parse error
   with the declared-targets list to help the author self-correct.

Both fire at parse time, so lint preflight + compile both surface them
loud.

### What changed

- `src/parser.ts` — orphan-indented-op guard at the silent-skip site
  (was `if (!currentTarget) continue` — now pushes a parseError);
  entry-target-existence check after target collection.
- `tests/v0.19.4-output-template.test.ts` — 5 regression tests pinning
  parser + compile rejection of the malformed shape Perry's qwen
  produced, plus positive tests confirming well-formed skills still
  parse cleanly.

### Bug-class lesson

Silent-drop is asymptotic worst-case authorability — the author has no
signal to self-correct, can't get unstuck, just gives up. For the
"agents author skills" thesis where the agent is a small model that
sometimes gets structure wrong, every silent-drop is a give-up
trigger. Worth a permanent discipline rule: a parser path that drops
content unconditionally is a bug. `if (X) continue` with no error
push is the structural smell.

This is the second discipline lesson banked this v0.19.x series
alongside `69e0f91d` (audit all consumers when adding a typed field)
and the v0.19.5 lesson (test the simplest-case shape the design
promises). Three lessons across four hotfix rings.

## 0.19.6 — 2026-06-08 — Clean ship of the v0.19.5 hotfix (CI-only path fix in the regression test)

v0.19.5 tag was pushed but the release pipeline failed: the new
regression test for the bundled `hello-world.skill.md` had a hardcoded
absolute path (`/Users/scotts/Development/skillscript/...`) that
worked locally but ENOENT'd in CI. No artifact shipped (no npm publish,
no GHCR push).

Fix in v0.19.6: same regression test, now using `REPO_ROOT`-relative
resolution (`fileURLToPath(import.meta.url)`-derived). All other
v0.19.5 fixes carry forward unchanged.

Lesson: CI-only path failures slip past local probes. Worth pinning a
test for the test surface itself — but the simpler discipline is "never
hardcode an absolute path in a test." Sibling to v0.19.5's own banked
lesson.

## 0.19.5 — 2026-06-08 — HOTFIX — Template-only skills now valid (closes Perry's 9d0a5e7d dogfood finding)

v0.19.4 shipped a contradiction: the c7ddfc50 design intent was *"strip
the compute block → still a valid skill that emits the template,"* but
three sites in the codebase rejected zero-target template-only skills:

1. **`no-targets` lint** (tier-1) — fired unconditionally when
   `parsed.targets.size === 0`, regardless of whether a template was
   present.
2. **`compile.ts` zero-targets guard** — threw `"Skill parsed with zero
   targets"`.
3. **`compile.ts` no-entry-target guard** — threw `"Skill has no entry
   target"` (entryTarget is null when there are no targets).

Result: the simplest authorability case — `hello-world` with `# Vars: WHO=world`
and just `Hello, ${WHO}!` as the body — failed to compile. Authors hit
the contradiction immediately, and the v0.19.4 migrated `hello-world`
itself had a `$set _ = "noop"` workaround I'd unconsciously added to
make the corpus compile — exactly the ceremony the feature was meant
to remove.

Perry's dogfood (rewriting `hello-world` and `perry-ping` against the
shipped v0.19.4 runtime) caught it. Reported in `9d0a5e7d`.

### The fix

A skill is valid if it has **at least one of**:
- A target with ops, OR
- A non-empty body-text-as-output template.

All three rejection sites updated to honor this. Runtime path was
already correct — `execute()` walks an empty target list cleanly and
renders the template at the end as canonical output.

### What changed

- `src/lint.ts` — `no-targets` rule updated to require BOTH targets
  empty AND template null before firing.
- `src/compile.ts` — zero-targets guard now allows `outputTemplate !== null`;
  no-entry-target guard scoped to `targets.size > 0` (entryTarget being
  null is correct for template-only skills); `toposort` skipped when no
  targets.
- `examples/skillscripts/hello-world.skill.md` + `scaffold/skills/hello-world.skill.md`
  — removed the `$set _ = "noop"` ceremony. Now pure template:

```
# Skill: hello-world
# Vars: WHO=world

Hello, ${WHO}!
Your install is healthy. Try skill-store-roundtrip + data-store-roundtrip next to verify substrate wiring.
```

- `tests/v0.19.4-output-template.test.ts` — 6 new regression tests
  covering parser + lint + compile + runtime + bundled corpus for the
  template-only path.

1870 total tests (+6 net new).

### Migration

No migration required. Pre-v0.19.5 skills (with or without templates,
all of which had at least one target) continue to work unchanged. The
fix unlocks the simplest case — template-only skills — which v0.19.4
rejected.

### Bug-class lesson

v0.19.4 was the canonical "design intent → implementation contradiction
shipped" case. My v0.19.4 unit tests all had at least a `$set _ = "noop"`
target; I never tested the template-only shape the design promised.
Perry's dogfood (live re-test against shipped runtime) flushed it. The
test surface added in v0.19.5 closes the gap. See banked discipline
memory `69e0f91d` — "when adding a typed field to a shared type, audit
ALL consumers." The simplest-case test for any new shape is also worth
explicitly pinning.

## 0.19.4 — 2026-06-08 — Body-text-as-output template (declarative output, no emit ceremony)

A skill's body text — the prose between the frontmatter and the first
target — is now its declarative output template. The runtime interpolates
`${VAR}` references against final vars and publishes the rendered string
as the skill's canonical output. Per Scott + Perry's c7ddfc50 design lock
+ 920078c8 / ad0b868e sign-off.

### Why

The `emit(text="${SUMMARY}")` ceremony for what is structurally just
"render this template and output it" was the highest-leverage authorability
tax on the most common operation. From Perry's c7ddfc50:

> Author writes the sentence they want; the compute block fills in the
> holes. The same skill stripped of its compute block still emits the
> template with whatever defaults `# Vars:` declares.

Wins:
- Declarative output (author writes the sentence they want)
- No throwaway `${SUMMARY}` var ceremony
- Branch resolved into vars; template stays single-shape
- Strip the compute block → still a valid skill that emits the template

### What's new

**Parser** (`src/parser.ts`):
- `ParsedSkill.outputTemplate: string | null` — the captured template
  (null when none authored). Internal blanks preserved; leading/trailing
  blanks trimmed.
- Pin 4 disambiguation rule (`nextNonBlankLineIsIndented` lookahead): a
  target is `<name>:` with an indented op-block on the next non-blank
  line. Content-after-colon (`Summary: hot today`) without an op-block
  is template text. Bare `<word>:` alone with no op-block in the template
  region is captured AND recorded as ambiguous for lint.
- `ParsedSkill.templateAmbiguousLines: number[]` — line numbers for the
  tier-2 lint surface.

**Runtime** (`src/runtime.ts`):
- When `parsed.outputTemplate !== null`, render once via `substituteRuntime`
  with the final vars map; the rendered string owns `outputs[key]` across
  all `# Output:` kinds. Legacy emit-only path (no template) preserved
  byte-equivalent — `outputs.text` falls back to `emissions.slice()` /
  `lastBoundVar` exactly as before.
- Complementary channels: `emit()` continues to populate `emissions[]`
  (transcript) independently. Template = canonical output; emit =
  transcript. No competition.

**CLI** (`src/cli.ts`):
- `skillfile execute` now prints the rendered template when one is
  authored (matching the canonical-output channel). Emit-only skills
  continue to print emissions exactly as before.

**Lint** (`src/lint.ts`) — four new rules:
- `unset-template-var` (tier-1, error) — every `${VAR}` in the template
  must resolve to a `# Vars:` input, ambient ref, or `$set`/`->` binding
  somewhere in the skill body. Tier-1 because an unbound ref renders
  empty silently.
- `template-looks-like-target` (tier-2, warning) — bare `<word>:` alone
  in the template region, no following op-block. Reads ambiguously;
  author should disambiguate.
- `body-template-detected` (tier-3, info) — template captured but has
  no `${...}` interpolations AND no text-consuming `# Output:`. Suggests
  "I wrote prose; it became template by accident."
- `emit-with-template` (tier-3, info) — skill has both a template AND
  `emit(text=...)` calls; confirms the channel-shift is intentional
  (template owns canonical output; emit goes to transcript).

### Migration

Additive — emit-based skills work unchanged. Bundled corpus verified
clean (13 skills; no body-template content; all produce
`outputTemplate: null`).

The lookahead disambiguation rule is stricter than the pre-v0.19.4
target detection: a line at column 0 matching `<identifier>:` parses
as a target only when the next non-blank line is indented. Every real
target has an op-block under it, so no observed corpus skill regresses.

The legacy `target: dep_a dep_b` deps-form is preserved (lookahead sees
the indented op-block and confirms target intent). The explicit
`needs: dep_a dep_b` keyword form is recommended for new skills.

### Docs

- README quickstart + canonical autonomous skill updated to use the
  template shape; new "fourth thing to notice" callout in the autonomous
  example.
- `docs/adopter-playbook.md` gains a new "Output template — body text IS
  the output" section covering the shape, complementary channels,
  output kinds, target syntax rules, and the four lints.

### Tests

- `tests/v0.19.4-output-template.test.ts` — 34 tests: parser extraction
  + Pin 4 disambiguation + migration safety + runtime render + output-kind
  matrix + complementary channels + 4 lints (positive + negative) + e2e
  (compile + execute + lint preflight blocking).
- Live HTTP probe + idempotent twice-run + edge cases (multi-line, special
  chars, lint preflight, emit + template).

1860 tests total (+34 net new). Narrow-core LOC ceiling bumped
11100 → 11250 per the signal-not-budget rule (clear code wins).

## 0.19.3 — 2026-06-07 — Real SPA render coverage (closes the test gap that let v0.18.9–v0.19.1 ship broken)

The v0.19.2 hotfix patched the specific syntax bug; v0.19.3 closes
the **class of bug** with a real end-to-end test surface. Per Scott:
"tests should test web dashboard moving forward."

### Why a new test surface

v0.18.9 shipped a broken SPA through THREE releases (v0.18.9 / v0.19.0
/ v0.19.1) because the test discipline had a hole:

- TypeScript compiler accepted the TS-style syntax (TS-valid)
- Unit tests didn't load `app.js` in a JS runtime
- Build script copies `src/dashboard/spa/*` verbatim to `dist/` (no transpile)
- Live dev probes during recent rings were CLI-side (curl POST /event);
  SPA was never opened in a browser as part of any ring's verification

The v0.19.2 hotfix added a `node --check` syntax guard — necessary but
not sufficient. Many other render-time failure modes aren't syntax errors:

- Runtime exceptions inside render functions
- DOM expectations that drift (`getElementById` returns null, etc.)
- Response-shape misreads (canned data has wrong field name —
  exactly the case v0.19.3's first run caught itself)
- Missing event handlers / stale state references
- Silent fall-through where polls fail and content stays blank

### What v0.19.3 ships

**`tests/v0.19.3-spa-render-coverage.test.ts`** — happy-dom-based
test suite that:

1. Loads `index.html` into a real DOM
2. Loads `app.js` in a JS runtime (happy-dom env, ~lightweight)
3. Mocks `fetch` to route `/rpc` calls to canned MCP responses
4. Drives `refresh()` + view changes via the hash router
5. Asserts rendered HTML per view contains expected content

10 tests covering:
- Smoke: SPA loads + executes without throwing; first render produces
  non-empty content (the exact symptom v0.18.9 missed)
- Each top-nav route: `#overview` / `#skills` / `#triggers` /
  `#connectors` / `#security` renders with canned state
- Unknown hash falls through to empty-state
- Graceful degradation: `#security` shows "unavailable" when the
  `blocked_shell_attempts` tool isn't exposed (pre-v0.18.9 runtime)
- Skill detail view: security-signals panel + source highlighting
  actually execute against a real risky-skill body (the exact code
  path that broke in v0.18.9)

### Self-validation note

First test run caught a real bug in v0.19.3 ITSELF — canned data had
`className` where the SPA expected `implementation`. Fixed before
commit. The test surface is doing its job: it catches response-shape
drift between canned mocks + actual SPA expectations the moment a
test is added.

### What this catches that the v0.19.2 guard didn't

| Bug class | v0.19.2 guard | v0.19.3 tests |
|---|---|---|
| TS syntax in JS file | ✓ (`node --check`) | ✓ (load fails) |
| Runtime errors in render funcs | ✗ | ✓ |
| DOM expectation drift | ✗ | ✓ |
| Response-shape misreads | ✗ | ✓ |
| Missing event handlers | ✗ | ✓ |
| View-specific blank renders | ✗ | ✓ per-view |

Future SPA changes extend the test file with new per-view assertions.
The `loadSpa()` + `mockFetch` infrastructure is persistent test
surface.

### Tests + deps

1826 tests total (10 new in v0.19.3). New devDependency: `happy-dom`
(~8MB, devDep only, NOT shipped to adopters per the package `files`
list). Typecheck clean.

No code changes outside tests + devDep + package.json version bump +
CHANGELOG.

### Banking note

Three-release broken-SPA window is the dogfood-discipline lesson —
"build + probe end-to-end before claiming done" needs to include the
SPA when SPA code changed. The v0.19.3 test surface enforces this at
test time so the discipline doesn't depend on remembering to open a
browser.

---

## 0.19.2 — 2026-06-07 — HOTFIX — Dashboard SPA SyntaxError prevented content from rendering

**Adopter-impacting regression** since v0.18.9. The dashboard SPA's
`app.js` contained TS-style non-null assertions (`shellMatch[1]!.trim()`)
copy-pasted from TS source. Plain JavaScript runtimes (the browser)
hit `SyntaxError: Unexpected token '!'` while parsing the script →
the entire module never loaded → no event listeners attached → only
the static HTML nav rendered, main content stayed empty.

Symptom from the adopter: "menu renders but contents are blank."

### Why it wasn't caught earlier

- TypeScript compiler accepts the syntax (it's TS-valid in TS files)
- Unit tests don't load `app.js` in a JS runtime; they invoke the MCP
  handlers directly
- The build script copies the file verbatim from `src/dashboard/spa/`
  to `dist/dashboard/spa/` — no transpile step that would have caught it
- Live dashboard probes during v0.18.9 / v0.19.0 / v0.19.1 development
  were CLI-side (curl POST /event) — the SPA was never opened in a
  browser as part of the ring

### Fix

Removed the two `!` non-null assertions in `collectSecuritySignals()`
(the function added in v0.18.9 to power the skill-detail "Security
signals" panel). The values are already null-guarded by the
surrounding `if` checks; the TS-style assertions were redundant noise
that compiled fine in TS but broke at runtime in plain JS.

### Regression guard

`tests/v0.19.2-spa-syntax-guard.test.ts`:
- `node --check src/dashboard/spa/app.js` — parses the SPA under V8's
  normal-JS rules (same as the browser). Catches the syntax mismatch
  at test time so the SPA never ships unparseable again.
- Explicit grep for `]!.` / `]!(` / `)!.` patterns as a belt-and-
  suspenders check.

Future SPA files extend the same test. Bug class closed: any TS-only
syntax in a `*.js` file under `src/dashboard/spa/` now fails CI.

### Affected versions

v0.18.9, v0.19.0, v0.19.1 — all shipped with the broken SPA. Adopters
on any of these versions running `skillfile dashboard` saw the blank-
content symptom. Upgrade to v0.19.2 immediately; no other action
needed.

### Banking lesson

`src/dashboard/spa/*.js` is plain JavaScript loaded by the browser
verbatim. Treat it as a non-TS surface — don't copy-paste expressions
from TS source. The new node --check test ensures this constraint is
enforced structurally going forward.

1816 tests total (2 new in v0.19.2 guard). Typecheck clean.

---

## 0.19.1 — 2026-06-07 — Env-resolver unification + dynamic trigger registration + imperative param derivation

Post-v0.19.0 friction patches. Three convergent fixes from live-test
signal:

### A. Shared `resolveRuntimeConfigFromEnv()` — structural cleanup

**Closes adopter CR `f2549ddf` + follow-up `aeccddac`.** Pre-v0.19.1
each env→option translation lived inside the CLI cascade — so
programmatic adopters using `bootstrap()` or `DashboardServer`
directly hit silent default-off behavior on every SKILLSCRIPT_* knob.
v0.18.9 patched the shell allowlist instance feature-specifically;
v0.19.0 immediately reproduced the same bug with two new env vars
(`SKILLSCRIPT_EVENT_INGRESS_ENABLED` + `SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN`).

The structural fix: a shared `resolveRuntimeConfigFromEnv()` resolver
in `src/runtime-env-resolver.ts` covering ALL SKILLSCRIPT_* knobs:

```
port / host
mcpCallerIdentityHeader
enableUnsafeShell
forceAlwaysDraft
pollIntervalSeconds
absoluteTimeoutMs
maxRecursionDepth
shellAllowlist
eventIngressEnabled
eventIngressAuthToken
```

Both `bootstrap()` and `DashboardServer` call it. New SKILLSCRIPT_*
knobs added to the resolver inherit env support across CLI +
programmatic paths automatically — the bug class closes, not just
this instance.

**Perry's explicit-wins guard (from `42de3d72`) generalized**:
- `opts.X === undefined` → fall back to env
- `opts.X === any defined value` (including `false`, `0`, `[]`, `""`)
  → authoritative; env does NOT widen

Adopters who explicitly pass `shellAllowlist: []` or
`eventIngressEnabled: false` to assert specific posture get exactly
that, regardless of ambient env. Security-load-bearing.

### B. Dynamic declarative-trigger registration

**Closes Perry F1 (`f68eb84d`) + adopter Finding 2 (`d538f7df`).**
Pre-v0.19.1, declarative triggers (`# Triggers: cron|event:`) only
wired at boot via `wireDeclarativeTriggers`. Skills authored
mid-session via `skill_write` weren't live until next restart —
contradicted the "POST /event accepts the new event_name now"
expectation external POSTers have.

`skill_write` + `skill_status` MCP handlers now call a new
`Scheduler.syncDeclarativeTriggersForSkill(name, parsedTriggers,
parsedVars, status)` that:
- Drops prior declarative triggers for the skill
- Re-registers them from the new parsed source IF status === Approved
- Status transitions Approved→Disabled drop; Disabled→Approved restore

Author skill → /event accepts immediately. No restart.

### C. Imperative `register_trigger` derives params from `# Vars:`

**Closes Perry F2 (`f68eb84d`).** Declarative wiring derived event-
trigger params from the skill's `# Vars:` (v0.19.0 feature); imperative
MCP `register_trigger` didn't apply the same derivation. Result: POST
/event with params for an imperatively-registered event 400'd with
"unknown params" because `registration.params = []`.

`register_trigger` handler now loads the named skill, parses, derives
params from `# Vars:` for event-source registrations. Cron registrations
unchanged (cron has no params).

### D. Schema enum trim regression guard

**Closes Perry F3 (`f68eb84d`).** v0.19.0 already trimmed the MCP
`register_trigger` / `list_triggers` `source` enums to `["cron",
"event"]` in source + dist; Perry's live test likely hit a stale
cached state. v0.19.1 adds explicit regression tests asserting the
enum literals so future trigger-source changes can't silently
desynchronize the schema and the parser.

### E. Doc add: `# Autonomous: true` for event/cron mutation skills

**Closes adopter Finding 1 (`d538f7df`).** Not a v0.19.x regression
— it's the pre-existing v0.14.x mutation gate. But event-fired skills
are a new category where adopters first discover this. Adopter-playbook
"Trigger model" section now has an explicit subsection with worked
examples covering:

- Skill-level `# Autonomous: true` for cron/event-fired mutation skills
- Per-op `approved="<reason>"` kwarg as an alternative
- Why `??` / `ask()` doesn't apply (no interactive author in cron/event
  contexts)

### Tests

23 new tests in `v0.19.1-dynamic-registration-and-env-resolver.test.ts`:
- 7 env-resolver parse cases (every SKILLSCRIPT_* knob; invalid values
  fall through; explicit false stays false; empty allowlist string;
  whitespace trim)
- 4 bootstrap env-fallback cases (env populates Scheduler config;
  explicit opts win over env including `[]` deny-all + `false`)
- 4 DashboardServer env-fallback cases (event ingress + port + host +
  auth token from env)
- 4 dynamic-registration cases (skill_write registers immediately;
  Draft → no registration; Approved → Disabled drops; Disabled →
  Approved restores)
- 2 imperative-param-derivation cases (event derives from #Vars; cron
  doesn't)
- 2 schema-enum regression cases (register_trigger + list_triggers
  source enum is `["cron", "event"]`)

Plus 1 existing test updated (`dogfood-t6b.test.ts` test 6) to reflect
the new dynamic-registration semantics (heartbeat's declarative cron
trigger registers immediately on Approved → list_triggers shows 2
entries after the test 6 imperative-register, not 1).

1814 tests total; typecheck clean.

### Banking note (feedback memory `9d969eb1`)

"Operator-controllable knobs ALL flow through a shared env resolver;
never patch the env→option translation per-feature." Two-release thrash
(v0.18.8 → v0.18.9 patch → v0.19.0 reintroduces → v0.19.1 generalizes)
is the structural-vs-per-feature lesson. Future SKILLSCRIPT_* knobs
extend the resolver; the bug class is closed.

### Docs

- `docs/adopter-playbook.md` — new "`# Autonomous: true` for event/
  cron skills" subsection under "Trigger model"
- No other doc changes; existing trigger-model + env-var docs already
  cover the surfaces

No breaking changes (v0.19.0's removal of session/agent-event/file-watch/
sensor sources stands; v0.19.1 doesn't change parser behavior).

---

## 0.19.0 — 2026-06-07 — **BREAKING** — Simplified trigger model: cron + event only; new `POST /event` HTTP ingress

**Upgrade impact:** BREAKING — the trigger model collapsed to `cron` + `event`; skills declaring removed sources (`session` / `webhook` / `file-watch` / `sensor`) fail to parse. Rewrite those `# Triggers:` as `cron`, or drive them by having an external adapter `POST /event`.

Closes the locked Scott + Perry decision (memory `ceaf4579`): collapse
triggers to two primitives. Time-based (`cron`) + external-signal
(`event` via HTTP POST). Everything else is an external adapter that
POSTs to `/event`.

### BREAKING

**Trigger source axis trimmed.** Pre-v0.19.0 the runtime accepted 6
sources (`cron` / `session` / `event` / `agent-event` / `file-watch` /
`sensor`); 4 of those were parse-only stubs that never functionally
fired. v0.19.0 keeps only `cron` and `event`. Skills declaring removed
sources fail to parse with a tier-1 parse error.

Migration: run `skillfile lint` against your corpus pre-upgrade to
find skills with removed sources. Each removed source has a
documented replacement pattern (external adapter POSTs to `/event`) —
see `docs/adopter-playbook.md` § "Trigger model".

**DeliveryMeta `trigger_kind: "session"` removed from the enum.** The
v0.9.6-locked receiver contract drops `"session"` from
`origin.trigger_kind`. Per Scott's call: the value was a non-feature
(session triggers never functionally emitted), and pre-v1.0 makes the
cleanup cheap. Adopter substrates handling DeliveryMeta payloads with
literal "session" trigger_kind will get a TypeScript narrowing error
on rebuild — drop the dead case.

**`scheduler.fireSessionPhase` removed.** Boot/shutdown session
dispatch is gone. Adopters wanting boot-time orchestration POST to
`/event` from their startup script.

### New surfaces

**`event_name` trigger primitive.** Skills declare event triggers via
`# Triggers: event: <event_name>` (case-insensitive). External
posters address the `event_name` (the public contract); the
`skill_name` is private impl. 1:1 — exactly one skill per
`event_name`; cross-skill rebind allowed but audit-logged
(`event_name 'X' rebound: skill A → skill B`). Same-skill re-register
is silent upsert (declarative re-save path).

**`POST /event` HTTP ingress** on `DashboardServer`. Off by default
(`SKILLSCRIPT_EVENT_INGRESS_ENABLED=true` to opt in). Shares the
dashboard port — no separate port. Localhost-only by default; explicit
opt-in for `0.0.0.0`. Optional bearer-token auth via
`SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN`. Wire contract:

```
POST /event HTTP/1.1
Authorization: Bearer <token>   # if configured
Content-Type: application/json

{ "event_name": "ping", "params": { "NAME": "world" } }

→ 200 { "run_id": "<uuid>", "durability": "in-process" }
  404 unknown event_name | route disabled
  400 missing/extra params | malformed body
  401 missing/wrong auth
  405 wrong HTTP method
```

**Strict param validation (v1)**: every declared param must be
present; no unknown params accepted. Per Perry's spec: no defaults,
no type coercion in v1 (JSON carries types; type mismatches fail
inside consuming ops with real errors). Defaults + types deferred to
v2 if real adopter need surfaces. Params are auto-derived from the
skill's `# Vars:` declaration for event triggers.

**`run_id = trace_id`** (preMintedTraceId plumbed through). The
synchronous `run_id` in the 200 response matches the `trace_id` the
runtime writes to the trace store — paste `run_id` into the dashboard
or query via the trace store to look up completion status.

**Self-describing durability**: every successful response includes
`durability: "in-process"`. Honest contract: 200 = accepted into
THIS process's in-memory queue; best-effort / at-most-once / NOT
durable across restart. Durable queueing is a v2 follow-up.

### Operator surfaces

Two new env vars (config-cascade-aware per existing pattern):

| Env var | Effect | Default |
|---|---|---|
| `SKILLSCRIPT_EVENT_INGRESS_ENABLED=true` | Mount `POST /event` route | `false` |
| `SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN=<token>` | Bearer-token auth (when set, required on every POST) | unset (open-internally) |

### Tests

21 new tests in `v0.19.0-trigger-event-ring.test.ts`:
- `Scheduler.fireEvent` (6): happy + 404 + case-insensitive + missing + extra + no-params
- Registration (2): same-skill silent upsert + cross-skill audit log
- `POST /event` HTTP (11): disabled-404, GET-405, 200-with-run_id-durability, unknown-404, missing-400, extra-400, malformed-400, empty-event_name-400, 401-no-auth, 401-wrong-token, 200-correct-token
- Config validation (1): throws if enabled without scheduler
- MCP register_trigger (1): cron + event accepted

Plus 4 existing test files updated to v0.19.0 enum (cron+event only) +
new parse-error tests for removed sources. 1791 tests total; typecheck
clean.

### Live HTTP probe verified end-to-end

Built dist, ran `skillfile serve` with event ingress enabled, POSTed
real curl requests:
- Valid POST → 200 + run_id matching the trace file written to disk
- 404 / 400 / 401 responses all match the spec
- run_id `f3495f73-...` written to `traces/event-probe/f3495f73-....json`

Probe caught two gaps the unit tests didn't surface:
- Event triggers needed `params` auto-derived from skill `# Vars:`
  (declarative wiring path)
- `dispatchSkill` needed to thread event params into compile-time
  inputs (required-var check fired pre-execute)

Both fixed in the same ring; banking-worthy reminder of "build + probe
end-to-end before claiming done" discipline.

### Docs

- `docs/adopter-playbook.md` — new "Trigger model (v0.19.0 — BREAKING)"
  section: removed-source migration patterns + `event` primitive shape
  + wire contract + `event_name` semantics + enabling + durability
  honesty
- `docs/configuration.md` — env-var table extended with
  SKILLSCRIPT_EVENT_INGRESS_*
- `scaffold/.env.example` — new "Event-trigger HTTP ingress" section;
  clarifies SKILLSCRIPT_PORT is shared with the dashboard
- `README.md` — MCP tool surface mentions `POST /event` opt-in

Language-reference rewrite is Perry's atom (forward-banner in place
since `05f24be0`); landed when the v0.19.0 ring shipped clean.

### What's NOT in v0.19.0 (future / deferred)

- File-watch / sensor reference adapter stubs — scope-cut per Scott's
  call (memory `b9fd8e17`). Replaced by canonical "calling /event"
  example in Perry's upcoming language-reference rewrite.
- Param defaults + type validation — deferred to v2 per Perry's spec.
- Durable / at-least-once event queue — v2 if real adopter need
  surfaces; in-memory v1 self-describes via `durability` field.
- `c7ddfc50` body-text-as-output template ring — design-locked, queued
  for v0.19.1+ after trigger ring stabilizes.

---

## 0.18.9 — 2026-06-07 — Human-reviewer observability (dashboard) + adopter CR (bootstrap env fallback)

v0.18.8 shipped the shell-allowlist data plumbing but only half the
dashboard surface. v0.18.9 closes that and adds skill-viewer security
highlighting + folds in the adopter's `f2549ddf` CR for programmatic-
bootstrap adopters who hit silent default-deny on the env path.

### A. Dashboard "Security" view

New top-nav route `#security`:
- **Blocked shell attempts** panel — cross-skill list of refused
  `shell(...)` calls from the trace store, filtered by
  `blocked_reason: "binary-not-allowed"`. Aggregated by binary (count +
  skills + last attempt) plus a recent-attempts table with
  `{when, skill, target, binary, body}` per row.
- Closes the observe→promote loop Scott + Perry called out in the
  v0.18.8 requirement (memory `7aab6f3f`).
- Graceful degrade against pre-v0.18.9 runtimes — the SPA shows an
  "upgrade to v0.18.9+" note when the new MCP tool isn't found.

Backed by a new MCP tool `blocked_shell_attempts` (cross-skill trace
query; flat list with `{skill_name, target, binary, body, fired_at_ms}`).
Tool count: 16 → 17.

### B. Skill-detail security highlighting

Each skill detail view now shows:

**"Security signals" summary panel** at the top — aggregated counts:
shell ops + binaries used, unsafe-shell count, `# Autonomous: true`,
per-op `approved="..."` authorizations, mutation ops
(`$ skill_write` / `$ data_write` / `file_write`), wake-class
`@session` deliveries, cron triggers.

**Inline source-body tinting**, two tiers:
- **Orange (HIGH)** — `unsafe=true`, `# Autonomous: true`,
  `approved="..."`, mutation ops. These bypass human-in-loop OR have
  unbounded blast radius.
- **Yellow (MEDIUM)** — `shell(...)` calls, `notify(agent="X@session", ...)`
  wake-class deliveries. Touch OS / live-session surfaces.

Soft tints (low alpha) so prose stays readable; summary tells you
WHAT, highlights tell you WHERE.

### C. Adopter CR — bootstrap env fallback for shell allowlist

Closes adopter CR `f2549ddf` + Perry's signoff `42de3d72`:
programmatic-`bootstrap()` adopters hit silent default-deny when
their `.env` set `SKILLSCRIPT_SHELL_ALLOWLIST=curl` — the env var
was honored on CLI but ignored on programmatic path.

**`bootstrap()` now reads `SKILLSCRIPT_SHELL_ALLOWLIST` from
`process.env`** when `opts.shellAllowlist === undefined`. Comma-split,
trimmed, empties dropped. Mirrors existing `OLLAMA_BASE_URL`
env-reading pattern in `bootstrap.ts`.

**Perry's required guard (security-load-bearing)**: explicit
`shellAllowlist` opt — including explicit `[]` deny-all — is
**authoritative** and **env does NOT widen it**. Critical: `undefined`
and `[]` are NOT collapsed into a single falsy check. An adopter who
passes `shellAllowlist: []` to assert lockdown gets lockdown
regardless of ambient env.

| `opts.shellAllowlist` | `SKILLSCRIPT_SHELL_ALLOWLIST` env | Effective |
|---|---|---|
| `undefined` (omitted) | unset | undefined → default-deny |
| `undefined` (omitted) | `"curl,jq"` | `["curl", "jq"]` (env fallback) |
| `["curl"]` | anything | `["curl"]` (explicit opt wins) |
| `[]` (explicit) | `"ssh,kubectl"` | `[]` (explicit deny-all; env does NOT widen) |

**`.env` auto-loading remains CLI-only** — by design + adopter
recommendation. Programmatic adopters either `process.loadEnvFile()`
themselves or set env in their launch environment. Documented as the
one line `(a)` can't collapse to.

### D. ShellBinaryNotAllowedError — all three wiring paths

Adopter CR (c): error remediation now names env + config +
`bootstrap({ shellAllowlist })` so the message is actionable for all
adopter shapes, not just CLI. "The error message IS the remediation
doc" property (Perry's v0.18.8 framing) extends to programmatic
adopters.

### Tests

23 new tests across two files:
- `v0.18.9-dashboard-security-surfaces.test.ts` (15): MCP tool returns
  empty/surfaces-blocked/identifies-bash-on-pipeline/respects-limit;
  security-signal regex correctness (8 cases); highlighting-regex
  spot checks (3 cases).
- `v0.18.9-shell-allowlist-bootstrap-env.test.ts` (8): env fallback
  populates; trimming + empties dropped; empty env string → explicit
  `[]`; Perry's required guard (explicit `[]` resists env, explicit
  list resists env, omitted opt falls through to env); error message
  names all three wiring paths.

1768 tests total; typecheck clean; LOC budget holds.

### Docs

- `docs/adopter-playbook.md` — new "Programmatic bootstrap path"
  subsection with precedence table; new "Dashboard observability
  (v0.18.9)" subsection describing Security view + skill-detail
  highlights.
- `docs/configuration.md` — env-var table extended with cascade
  showing `bootstrap()` opt wins.
- `README.md` — MCP tool count 16 → 17 with `blocked_shell_attempts`
  in Observability row.

No language-reference changes (skill syntax unchanged); that doc is
Perry's atom surface.

---

## 0.18.8 — 2026-06-06 — **BREAKING** — default-deny shell binary allowlist

**Upgrade impact:** BREAKING, CONFIG — `shell(...)` ops are now default-deny; they refuse until you allowlist the binaries via `SKILLSCRIPT_SHELL_ALLOWLIST` (run `skillfile shell-audit` to list what your corpus needs, then paste).

**This is a breaking change.** Default behavior changes from "any
binary on `PATH` reachable via `shell(...)`" to "only operator-
allowlisted binaries reachable; default-deny when unset." Existing
deployments using `shell()` must set `SKILLSCRIPT_SHELL_ALLOWLIST` in
their `.env` before upgrade, or `shell()` ops will refuse at first
dispatch with `ShellBinaryNotAllowedError`.

### Migration — run BEFORE upgrade

```bash
skillfile shell-audit
```

Scans `$SKILLSCRIPT_HOME/skills/` for `shell()` ops, emits the union
of binaries used, and prints a ready-to-paste `SKILLSCRIPT_SHELL_ALLOWLIST=...`
line. Paste into `.env`, review/narrow, THEN upgrade. Per Perry's
pre-upgrade-not-post-break framing.

### Why default-deny

Per Scott + Perry decision (memory `7aab6f3f`, 2026-06-06): skill
authors are agents → weak trust anchor (hallucination, prompt-
injection, no human-in-loop at scale). Default-open shell relies on
author trust, which doesn't hold for agent-authored skills. Default-
deny converts a discipline-only control ("a human reviews every skill")
into an enforced constraint at the language level. *The constraint
IS the safety story.*

Pre-v0.18.8 deployments had no operator-side binary scope: any
`shell(command="rm -rf /")` in a `# Autonomous: true` skill ran
unchallenged. This ring closes that gap.

### Two independent axes

| Operator switch | Controls |
|---|---|
| `SKILLSCRIPT_SHELL_ALLOWLIST` (new) | Which binaries are reachable (binary scope) |
| `SKILLSCRIPT_ENABLE_UNSAFE_SHELL` (existing) | Whether bash interpretation is permitted (syntax scope) |

Per Perry's two-axes-decoupled rule: do NOT overload `unsafe`. An
off-list binary refuses regardless of `unsafe`. An on-list binary +
unsafe syntax requires BOTH gates to pass.

### Unsafe path is all-or-nothing

For `shell(..., unsafe=true)`, the runtime invokes `bash -c <body>`;
the literal first token is `bash`. So permitting any unsafe shell at
all requires `bash` on the allowlist (in addition to
`ENABLE_UNSAFE_SHELL=true`). Per-binary scope within unsafe-mode bodies
is **not implemented and will not be** — parse-based enumeration is
unsound against agent-author threat model (`e=curl; $e ...`,
`$(printf cur)l`, `eval`, `xargs` all defeat it). The proper layer for
binary-scope on unsafe shell is OS-level (restricted PATH,
execve/seccomp, container) — documented in `docs/adopter-playbook.md`
§ "Shell binary allowlist."

### Enforcement layers

- **Runtime** (authoritative) — refuses off-list binaries at dispatch.
  Throws `ShellBinaryNotAllowedError` with actionable remediation:
  names the binary, names the env var, points at `skillfile shell-audit`.
- **Lint** (local advisory) — new tier-1 rule `shell-binary-not-allowed`
  fires when `LintOptions.shellAllowlist` is supplied. Author env may
  differ from production; lint is for immediate authoring feedback,
  not the boundary. Skips silently when allowlist not supplied.
- **Trace observability** — refused ops emit `blocked_reason:
  "binary-not-allowed"` on the trace record for dashboard filtering
  (operator's observe→promote loop: "what binaries did skills try to
  invoke off the allowlist; do I want to add any?").

### What landed

- `SKILLSCRIPT_SHELL_ALLOWLIST` env var + `shellAllowlist?: string[]`
  config field + `BootstrapOpts.shellAllowlist` + Scheduler threading
  + `ExecuteContext.shellAllowlist` (CLI cascade: env > config > default-deny)
- Runtime gate in `runtime.ts` case "shell" — applies to both safe
  and unsafe paths
- New `ShellBinaryNotAllowedError` (OpError subclass)
- New tier-1 lint rule `shell-binary-not-allowed`
- New `TraceOpRecord.blocked_reason` field
- New CLI command `skillfile shell-audit` (pre-upgrade migration helper)
- `.env.example` documentation
- `docs/adopter-playbook.md` new "Shell binary allowlist" section with
  full migration walkthrough + trust model + scope caveat (don't oversell)
- `docs/configuration.md` env-var table extended

### Tests

16 new in `v0.18.8-shell-allowlist.test.ts` (runtime safe/unsafe gates
+ lint rule + trace observability). 1745 tests total; typecheck clean.
Narrow-core LOC ceiling 10800 → 11100.

Pre-existing tests using `shell()` were updated to declare
`shellAllowlist` in their test ctx — the canary for adopter-side
migration discipline.

### Future direction (NOT in this ring)

Per-skill capability declaration: `# Shell: curl, jq` frontmatter
where operator policy validates `declared ∩ allowlist`. Makes each
skill's shell footprint self-documenting + auditable. Slated for a
future ring once chokepoint + observability surfaces ship.

---

## 0.18.7 — 2026-06-06 — three previously-hidden operator knobs surfaced via env cascade

Closes a discoverability gap noticed during a `.env` audit: three
operator-controllable behaviors were programmatic-only or config-only
without a `.env`-natural path, so operators tuning prod or test
environments had to write code (or a JSON config) to change them.
v0.18.7 surfaces all three through the standard cascade (CLI flag >
env > config > default).

### Three knobs surfaced

| Knob | Env var | Was | Now |
|---|---|---|---|
| Scheduler poll interval | `SKILLSCRIPT_POLL_INTERVAL_SECONDS` | config + bootstrap | + env path |
| Runtime absolute timeout | `SKILLSCRIPT_ABSOLUTE_TIMEOUT_MS` | programmatic-only (`ctx.absoluteTimeoutMs`) | + config + env + bootstrap opt |
| Composition recursion depth ceiling | `SKILLSCRIPT_MAX_RECURSION_DEPTH` | programmatic-only (`ctx.maxRecursionDepth`); hardcoded 10 | + config + env + bootstrap opt |

`absoluteTimeoutMs` defaults to 300_000ms (5 minutes); `maxRecursionDepth`
defaults to 10 (`DEFAULT_MAX_RECURSION_DEPTH`); poll interval defaults
to 30 seconds. All values flow through `BootstrapOpts` → `Scheduler`
config → per-dispatch `ExecuteContext`.

### Tests

10 new tests in `v0.18.7-operator-knobs.test.ts`:
- Config schema accepts each new field with positive-integer validation
- Rejects 0 / negative / non-integer / non-numeric values for both
- All three knobs co-set in one config + omission preserves defaults
- Scheduler accepts the two new fields and constructs cleanly

1729 tests total; typecheck clean; LOC budget holds.

### Docs

- `scaffold/.env.example` — new "Runtime tuning" section documenting all
  three vars with use-case framing + defaults
- `docs/configuration.md` — env-var precedence table extended; field
  docstrings on `SkillscriptConfig` interface explain cascade

### Adopter migration

None — all changes are additive and backward-compatible. Adopters
relying on the old programmatic-only paths (passing `ctx.absoluteTimeoutMs`
directly to `execute()`) continue to work; the new layers just add
operator surfaces below them. Default behavior preserved when env vars
are unset.

---

## 0.18.6 — 2026-06-05 — author surfaced on skill discovery (skill_list filter + entry field)

Closes Perry's spec request (thread `1f278e5e`): an optional, generic,
connector-implemented `author` field on the skill discovery surface
plus an `author` filter on `skill_list`. Use case: "here's your
toolbox" session-start context limited to the agent's own skills.
Substrate-neutral — populating + filtering is the connector's job;
adopters with no authorship concept get graceful degradation.

### A. SkillEntry.author on catalog output

`buildSkillCatalog()` now surfaces `SkillMeta.author` on each `SkillEntry`.
Bundled stores already track author (`FilesystemSkillStore` reads from
`os.userInfo().username`, `SqliteSkillStore` stores at write time);
adopter substrates that don't track authorship surface `null` per the
contract's graceful-degradation rule.

### B. skill_list filter.author

`SkillListFilter.author` AND-composes with the existing filters
(audience/status/trigger_kind/domain_tags/name_prefix). The catalog
layer threads the filter through to `SkillStore.query({ author: ... })`
so substrates that honor it natively can narrow at the substrate
layer; the catalog ALSO applies the filter in-memory against
`meta.author` so substrates that ignore the filter still produce the
right result (graceful degradation).

`SkillFilter.author` was already a declared field on the contract;
v0.18.6 wires the catalog + MCP surface to actually thread it through.

### Tests

6 new tests in `v0.18.6-author-discovery.test.ts`:
- Author surfaced on entries
- filter.author narrows correctly + entries carry matching author
- Empty result on no match (no error)
- AND-composes with name_prefix
- Graceful degradation: substrate ignores filter, catalog narrows
- author === null when substrate doesn't populate (mock store)

1719 tests total; typecheck clean. No LOC ceiling bump needed
(catalog edits absorbed within budget).

### Docs

- `mcp-server.ts` skill_list tool docstring lists the new filter +
  documents graceful degradation
- `docs/connector-contract-reference.md` SkillStore conventions section
  adds author-field convention + filter passthrough rule

### Adopter-side action (substrate-author backfill — out of scope)

Connectors backed by substrates with an existing authorship concept
need to either honor the new `filter.author` in their `query()` natively
(better performance) or rely on the catalog-layer in-memory filter
(works out of the box). Substrates with legacy data missing author tags
(e.g., skills predating identity-stamping) need data-side backfill —
substrate-author work, not a language change.

---

## 0.18.5 — 2026-06-05 — Address-routed notify() + lifecycle hooks (skills can wake a session)

Closes the last skill-author-surface gap from the Phase 8 substrate-author
adoption: skills can now wake a specific live session, not just deliver
to an agent's mailbox. The `@session` suffix on an agent address IS the
wake signal — no separate `wake=true` kwarg, no separate `wake()` op.
Per Perry's design call (thread `c453afa2`): "the address encodes
delivery class." Same convention as the broader `waiting_on` / mailbox
/ broker semantics.

### A. Address-routing rule (uniform across surfaces)

| Skill-author syntax | Address shape | Routes to |
|---|---|---|
| `notify(agent="perry", …)` | bare | `AgentConnector.deliver()` |
| `notify(agent="perry@kitchen-terminal", …)` | composite | `AgentConnector.wake()` |
| `# Output: agent: perry` | bare | `AgentConnector.deliver()` |
| `# Output: agent: perry@kitchen-terminal` | composite | `AgentConnector.wake()` |
| `# Output: template: perry@browser-tab-3` | composite | `AgentConnector.wake()` |

For wake-routed dispatches, the skill's content (notify message or
joined emissions) rides as `WakeOpts.context`. Substrate sees the FULL
composite on `wake()` and decomposes per the v0.18.2 contract.

Why not a `wake=true` kwarg? Perry's discipline: the address already
encodes the dispatch class; a kwarg duplicates the signal and breeds
contradictory combinations (`notify("cc@session", wake=false)` — wake
a session but don't?). Two ways to say "wake" is the divergence to cut.

### B. AgentWakeReceiptRecord + WakeReceipt.warnings

New parallel record on `ExecuteResult.agentWakeReceipts` (wire field
`agent_wake_receipts`). Carries `WakeReceipt` from address-routed
lifecycle-hook dispatches. Mid-skill `notify()` continues to
self-contain via its `ACK.dispatched[].route` field (matches the
existing pattern where notify() ACKs don't promote receipts).

`WakeReceipt.warnings?: string[]` (symmetric with v0.18.4
`DeliveryReceipt.warnings`) — substrate signals non-fatal notes about
the wake. Runtime also uses this field to prepend a routing-note
("@session present → routed to wake-class") for discoverability:
inspectors of recorded wake receipts see WHY the runtime routed here
without needing to grep skill source. Per Perry's discoverability
requirement.

### C. Tier-3 informational lint: `address-routed-wake`

Author-time surfacing: `notify(<X@session>)` and `# Output: agent:
X@session` fire `severity: info` findings making the implicit
address-routing visible without a redundant `wake=true` kwarg. Pure
informational — runtime works either way; the lint just teaches the
shape.

### Tests

13 new tests in `v0.18.5-address-routed-notify.test.ts`:
- Lint (5): notify-suffix, bare-no-fire, lifecycle-agent, lifecycle-template, multi-surface
- Runtime (6): bare-deliver, suffix-wake, content-less wake; lifecycle bare-deliver, lifecycle suffix-wake, template suffix-wake
- Discoverability (1): lifecycle-hook wake receipt carries routing-note warning
- E2E (1): MCP /rpc execute_skill with notify@session calls connector.wake() not deliver()

1713 tests total; typecheck clean. Narrow-core LOC ceiling 10600 →
10800.

### Docs

- `docs/language-reference.md` — `notify()` + `# Output: agent:` /
  `template:` docs updated with address-routing rule; `route` field
  added to ACK shape
- `docs/connector-contract-reference.md` — new "Address-routed
  dispatch" subsection under `agent@session targeting`; use-site
  cross-reference table updated with bare-vs-composite rows
- `docs/adopter-playbook.md` — Pattern 1 updated: runtime address-routes;
  substrate honors what arrives

### Contract diff for adopters writing impls

No interface changes — same `deliver()` / `wake()` signatures from
v0.18.2. The change is in which method the runtime calls based on
address shape. Substrates already implementing wake() correctly
(graceful degradation, session-honest) handle the new traffic
automatically. Adopters who hadn't implemented wake() yet (NoOp
fallback) continue to no-op gracefully via the existing degradation
path; lifecycle-hook wake receipts carry `wake_skipped: true` in that
case.

---

## 0.18.4 — 2026-06-05 — Caller-identity threading + DeliveryReceipt.warnings

Closes the architectural gap surfaced by the substrate-author's Phase 8
adoption finding (Perry's Q5a): MCP `/rpc` callers identified via the
configured `X-Agent-Id` header were not reaching
`DeliveryMeta.origin.caller_agent_id` on the resulting notify/deliver
envelope. The runtime had been reading `ctx.agentId` (skill *owner*,
used for outbound substrate scoping) instead of the authenticated
caller. This shipped half-pieces across v0.16.8 (owner threading) and
v0.17.0 (MCP-boundary capture); v0.18.4 separates the two semantics
cleanly so both work without conflict.

### A. ExecuteContext gets `callerAgentId`

New optional field — the authenticated caller who fired the dispatch.
Distinct from `agentId` (owner). When agent `cc` invokes a skill owned
by Alice, `ctx.agentId="alice"` (outbound connector scoping) and
`ctx.callerAgentId="cc"` (DeliveryMeta attribution). Per Perry's Q5a:
notifications author as the authenticated caller, NOT the skill's
owner.

`DeliveryMeta.origin.caller_agent_id` now reads from
`ctx.callerAgentId`. Cron / session / cli / dashboard / inline triggers
leave it undefined (no human caller); the owner is NOT promoted as a
fallback.

### B. MCP boundary threads callerIdentity → ctx.callerAgentId

`execute_skill` handler now accepts `McpRequestCtx` and threads
`callerIdentity` (captured from the configured `mcpCallerIdentityHeader`
at the `/rpc` boundary) into `ctx.callerAgentId`. Existing
`ctx.agentId` plumbing (skill author from SkillStore.metadata) stays
intact for outbound scoping. Adopters with `mcpCallerIdentityHeader`
configured get the correct DeliveryMeta attribution with no
configuration changes.

### C. Composition preserves callerAgentId; scheduler leaves it unset

Composition (`composition.ts`) spreads parent ctx into child unchanged
— the caller IS the chain originator regardless of composition depth.
Owner (`ctx.agentId`) still flips per child's `metadata.author` (the
v0.16.9 cross-author behavior is preserved).

Scheduler (`scheduler.ts`) never sets `callerAgentId` — cron / session
/ event triggers have no human caller; the timer fired them. Resulting
envelope is `caller_agent_id: undefined`.

### D. DeliveryReceipt.warnings — additive contract field

```typescript
interface DeliveryReceipt {
  // ... existing fields ...
  warnings?: string[];
}
```

Substrate signals non-fatal notes about a delivery (e.g.,
`"stripped @session suffix — deliver is mailbox-class"`, `"rate-limit
hint: backoff 5s"`, `"fan-out: delivered to 3 sessions"`). Runtime
echoes onto `AgentDeliveryReceiptRecord.receipt.warnings`; dashboards
+ observability surfaces render them instead of substrate-side stderr
noise. Distinct from `delivery_skipped` (accepted-not-pushed) and
thrown errors (delivery failed) — warnings are advisory: the delivery
succeeded; the substrate just has commentary.

### Tests

10 new tests in `v0.18.4-caller-identity-threading.test.ts`:
- `ctx.callerAgentId` set → `caller_agent_id` reflects caller
- `ctx.agentId` set, callerAgentId unset → `caller_agent_id` undefined
  (owner is NOT fallback)
- both set → `caller_agent_id` is the caller (owner never wins this)
- neither set → undefined
- `# Output: agent: X` lifecycle hook honors callerAgentId
- end-to-end MCP `/rpc` repro: `skill_write` with `X-Agent-Id: alice` +
  `execute_skill` with `X-Agent-Id: cc` → `caller_agent_id: cc`
- MCP without callerIdentity → undefined (no owner fallback)
- composition preserves callerAgentId across owner-flip
- scheduler-fired (triggerCtx.source=cron) → undefined
- `DeliveryReceipt.warnings` rides through to
  `agent_delivery_receipts[].receipt.warnings`

1700 tests total.

### Docs

- `docs/connector-contract-reference.md` — `caller_agent_id` field
  semantics clarified (authenticated caller, NOT owner; owner is NOT
  fallback); `DeliveryReceipt.warnings` documented
- `docs/adopter-playbook.md` — two new patterns in the AgentConnector
  section: pattern 4 (read `caller_agent_id` for attribution, not
  scope) + pattern 5 (surface non-fatal notes via warnings)

No language-guide changes — skill syntax unchanged. The fix is in
who-is-attributed at the dispatch boundary, not in how skills are
authored.

---

## 0.18.3 — 2026-06-05 — AgentConnector docs catchup for substrate-author adoption

Docs-only ring. The v0.18.1 declarative-wiring symmetry and v0.18.2
contract robustness landed without updates to the adopter-facing
surfaces; substrate-authors reading the playbook saw stale information
about the wake-shape, no `agent@session` convention, and no
graceful-degradation rule. This ring closes that gap so the adopter
walking up to v0.18.x sees a coherent picture across configuration,
contract, playbook, and worked example.

### What changed

- **`docs/configuration.md`** — substrate slot table covers
  `agent_connector` (short-form `"noop"`, per-type config row,
  null-explicit example). Programmatic-opts precedence section names
  the four slots symmetrically. Custom-form section shows
  AgentConnector alongside SkillStore.
- **`docs/connector-contract-reference.md`** — AgentConnector section
  documents:
  - `DeliveryReceipt.session_id?` field
  - New `WakeOpts` + `WakeReceipt` subsection with `woken: boolean`
    required + `session_id?` echo
  - `agent@session` targeting convention with Form A (composite in
    `agent_id`) + Form B (structured `WakeOpts.session_id`)
  - Graceful-degradation table distinguishing capability-gap
    (degrade) from operational-fault (throw)
  - Implementation-checklist item 3 (`wake`) updated for degradation
    + session honoring
- **`docs/adopter-playbook.md`** — new "Wiring the AgentConnector"
  section: two wiring paths (programmatic + declarative),
  precedence rules, worked example pointer, three copy-when-forking
  patterns (`agent@session` opaque composite, graceful wake
  degradation, session echo on receipts), fork-vs-write-fresh
  guidance.
- **`examples/connectors/HttpWebhookAgentConnector/README.md`** —
  `wake_url` config field updated for degradation behavior,
  `DeliveryReceipt` inbound shape includes `session_id`, new
  "Wake — capability gap vs. operational fault" table, new
  "`agent@session` targeting" section with cross-link to the
  contract reference.

No code changes; package-shipped docs (`files` array) auto-include
the updates on next publish.

### Why a docs-only ring

The contract+impl are done. The block was discoverability: substrate-
author writing an AgentConnector against v0.18.2 without updated
adopter docs would either miss the new requirements or have to read
the diff. Per Phase-1-briefing-scope discipline: docs are part of the
adoption-readiness atom, not a follow-up.

---

## 0.18.2 — 2026-06-05 — AgentConnector contract robustness: session-granular targeting + graceful wake degradation

Closes Perry's two requirements on the AgentConnector contract before
substrate-author wires their adopter-side impl. The verbs were already
well-generalized (his endorsement: `list_agents` / `deliver` / `wake`
maps cleanly across Slack / Discord / tmux / webhook / email / queue —
nothing substrate-specific leaks in). v0.18.2 bakes in the two robustness
properties that keep the contract substrate-neutral as adoption grows.

### A. `WakeReceipt.woken: boolean` — explicit honesty signal

New required field on the wake receipt. Wake-capable substrates set
`woken: true`; passive substrates that can't interrupt (webhook,
file-drop, store-only) degrade gracefully — return `woken: false`
instead of throwing. Per Perry's degradation requirement: "conform by
degrading, never by erroring."

Callers reading the receipt distinguish interrupted-them from
delivered-only without per-substrate knowledge. The pattern mirrors
`DeliveryReceipt.delivery_skipped` (v0.9.6 — adopter signals
accepted-but-not-pushed).

`NoOpAgentConnector.wake()` now returns `{woken: false, ...}` (it
can't actually interrupt anything).

`HttpWebhookAgentConnector` example: when no `wake_url` configured for
an agent, returns `{woken: false}` instead of throwing. Real HTTP
failures (POST to configured wake_url returns 4xx/5xx) still throw —
distinct from the substrate-capability case.

### B. Session-granular targeting — `agent@session` composite

`agent_id` parameter on `deliver` and `wake` now documented as opaque
composite the substrate decomposes. Bare identifier (Slack `@user`,
email address) and composite (`perry@kitchen-terminal`,
`alice@browser-tab-3`) both supported — substrate parses if it tracks
sessions, ignores the suffix if it doesn't.

`WakeOpts.session_id?: string` — structured alternative for callers
with the session already separated (e.g., dashboard's per-session
"wake this terminal" action). Substrate impl chooses which signal to
honor when both are present.

`DeliveryReceipt.session_id?: string` — symmetric reflection: when
delivery routed to a specific session, the receipt names it.

Per Perry: "One-identity-many-live-sessions isn't an AMP quirk — it's
general (multiple terminals, multiple chat sessions). If the contract
only knows bare agents, it can't express the wake-class targeting we
just built."

### Tests

8 new tests in `v0.18.2-agent-contract-degradation.test.ts`:
- `WakeReceipt.woken` honest across NoOp + HttpWebhook
- Caller misconfiguration still throws (distinct from
  substrate-can't-wake case)
- `agent@session` composite parsing through a CompositeAwareConnector
  test impl
- `WakeOpts.session_id` structured form wins over embedded suffix
- Bare `agent_id` (no `@`) still works

1690 tests total. Narrow-core LOC ceiling 10500 → 10600.

### Contract diff for adopters writing impls

Existing impls compile but won't typecheck without the new required
`WakeReceipt.woken` field. Per the pre-adoption rule, this is a cheap
breaking change — the only known impl-in-flight (substrate-author's
AmpAgentConnector) is being written against this contract.

---

## 0.18.1 — 2026-06-05 — AgentConnector declarative-wiring symmetry

Closes the long-standing asymmetry across the four substrate slots.
Pre-v0.18.1, SkillStore / DataStore / LocalModel each had `connectors.json`
substrate-section support, but AgentConnector was programmatic-only —
the bootstrap.ts comment explicitly read "agent_connector → null
(adopter wires explicitly)." v0.18.1 brings the slot to parity.

### What landed

- New `agent_connector?: SubstrateChoice | null` field in
  `SubstrateConfig` (`connectors/config.ts`)
- New `"noop"` built-in type — explicit declaration of the no-op
  posture (equivalent to omitting the slot; the Registry's
  `getAgentConnectorOrDefault` returns NoOpAgentConnector either way,
  but `"noop"` makes the intent visible in `connectors.json`)
- `"custom"` type accepted at parse time, errors at bootstrap with a
  clear message pointing at the programmatic path (mirrors the
  sync-bootstrap limitation on the other three slots)
- New `agentConnector?: AgentConnector` field in `BootstrapOpts` +
  `DefaultRegistryOpts` — programmatic surface for adopters supplying
  an instance (matches the existing `skillStore?` / `dataStore?` /
  `localModel?` symmetry)
- `bootstrap()` precedence: programmatic opt > declarative substrate >
  default unset (Registry NoOp fallback)
- `bootstrap()` calls `registry.registerAgentConnector("primary", ...)`
  with the resolved instance (async; health_check fires at registration
  per existing contract)

### Scaffold + adopter guidance

`scaffold/connectors.json` adds `"agent_connector": null` with the same
`_example_*` documentation pattern as the other slots. Examples show
both the noop short-form and the custom object-form (with a comment
linking to `examples/connectors/HttpWebhookAgentConnector` as a
reference impl).

### Tests

11 new tests in `v0.18.1-agent-connector-wiring.test.ts` covering:
parse of noop / custom / null forms, unknown-type rejection,
short-form-custom rejection, BootstrapOpts wiring, substrate-config
wiring, precedence (opts beats config), custom-via-config error
pointing at programmatic path, fallback to NoOp when neither slot nor
opt supplied.

1682 tests total. Narrow-core LOC ceiling unchanged at 10500.

### Adopter-side: substrate-mediated AgentConnector impl

For adopters with a memory-store routing layer or shared agent
inbox/wake substrate: implement the `AgentConnector` contract
(`deliver` / `wake` / `list_agents` / `health_check` /
`request_response`) mapping to the substrate's primitives, then wire
via `bootstrap({ agentConnector: new MyAgentConnector(...) })`. See
`examples/connectors/HttpWebhookAgentConnector` for the reference
shape — 320 LOC, end-to-end working, with tests + README.

---

## 0.18.0 — 2026-06-05 — Dashboard composition contract expansion + SkillMeta surface completion

Reviewer-friendly approval UX. When a human opens a composing skill in
the dashboard to review-and-approve, the body shows
`execute_skill(skill_name="get-weather") -> R` and `inline(skill="voice-rules")`
references — but to understand "the whole picture" they previously had
to leave the page and pull up each called skill manually. v0.18.0
collapses that into an inline expansion: click the call site, see the
called skill's contract (Description + Vars + Returns) without leaving
the page.

### A. `SkillMeta` surface completion (prerequisite)

Closes a long-standing gap: `SkillMeta` declared `vars?: string[]`
since v0.7, but `FilesystemSkillStore.buildMeta()` only populated
`description`. The dashboard composition expansion needs the full
contract (description + vars + returns) — and now everyone calling
`skill_metadata` MCP gets it.

- Added `returns?: string[]` to `SkillMeta` interface (matches the
  existing `vars?: string[]` shape)
- `FilesystemSkillStore.buildMeta()` now parses the source and
  populates `vars` + `returns` from `parsed.vars` / `parsed.returns`
- `SqliteSkillStore.metadataRowToMeta()` mirrors — source is already
  selected by `skillRow()`, no extra DB roundtrip
- `skill_metadata` MCP tool surfaces them naturally (no MCP-server
  change needed; the interface returns SkillMeta as-is)

### B. Dashboard composition expansion (the headline)

New "Composes" section in the skill detail view, between Source and
Triggers. Client-side regex over the skill source finds every
`execute_skill(skill_name="X")` and `inline(skill="X")` reference,
deduplicated by `(kind, name)`. Each ref renders collapsed as
`→ execute_skill: get-weather (runtime invocation)` or
`→ inline: voice-rules (compile-time data inline)`.

Click to expand — lazy-loads the called skill's metadata via
`skill_metadata` MCP and renders a contract panel:
- `# Description:` — intent
- `# Vars:` — inputs (the parameter list)
- `# Returns:` — outputs (the return signature)
- Author badge + "Open in detail view →" drill link

For `inline` (data-only): also fetches the body via `skill_read` and
renders it under a "Inlined body (bakes at compile)" collapsible —
since the data skill's body literally lands in the host's compiled
artifact at compile time, the reviewer sees what gets baked.

Lazy-load is cached inline (re-collapsing preserves the rendered
panel; re-opening is free). Recursive — each expanded panel can
itself expand its compositions.

Implementation: vanilla JS + native `<details>` disclosure, no
state framework. Toggle event listener via capture-phase document
delegation since `toggle` doesn't bubble natively.

### Tests

7 new tests in `v0.18.0-skillmeta-surface.test.ts` covering: description
populated, vars populated (with parser quirk note for bare names in
mixed lists), returns populated, all-three together, omitted-when-absent,
`query()` per-skill surface. Dashboard SPA logic verified via build +
e2e probe (visual smoke-check on the served app).

1671 tests total. Narrow-core LOC ceiling unchanged at 10500.

---

## 0.17.5 — 2026-06-04 — Returns at top level of R + reserved-name guard + lint catches top-level pattern

Closes Perry's `0cd2bd5a` lint-question finding, which surfaced a
spec/impl gap underneath the regex limitation he initially flagged.
Three coordinated bugs in a row: spec said canonical access was
`${R.SUMMARY}` (top-level), impl put declared returns inside
`R.final_vars`, lint regex only caught the explicit `${R.final_vars.X}`
path. Together: `${R.BOGUS}` resolved to empty at runtime AND wasn't
flagged by lint. Perry's `e01f4148` ack confirmed direction (A) with
one non-optional condition: reserved-name guard against envelope
collisions.

### (A) Declared returns spread onto R's top level

`composition.ts` now spreads the filtered `# Returns:` surface onto
the result envelope's top level alongside `outputs`/`transcript`/etc.
`${R.SUMMARY}` is the canonical named-access path per spec. The
existing `R.final_vars` map kept populated as the iteration-view of
the same filtered data:

- `${R.SUMMARY}` — canonical named access (what authors reach for)
- `${R.final_vars}` — full filtered map for `foreach K in ${R.final_vars}` introspection

Both paths address the same data — named is documented canonical,
map is for iteration. Per Perry: "skill is a function; declared
returns ARE the result. `final_vars` is an implementation name —
exposing it is an abstraction leak."

### (B) Reserved-name guard at parse time

New `RESERVED_ENVELOPE_FIELDS` set in `parser.ts` enumerates the
envelope fields a caller's `R` always exposes: `skill_name`, `outputs`,
`transcript`, `errors`, `target_order`, `fallbacks`,
`agent_delivery_receipts`, `final_vars`. Declared returns colliding
with these are rejected at parse time with a clear error citing the
full reserved set. Without this guard, `# Returns: outputs` would
silently shadow the envelope field — exactly the silent-wrong class
this whole ring exists to kill. Per Perry's non-optional condition:
"treat the guard as part of the fix, not a follow-up."

`RESERVED_ENVELOPE_FIELDS` is exported so adopters can introspect /
align downstream tooling. Same source-of-truth aligned with
composition.ts envelope structure — keep in sync if either grows.

### (C) Lint regex extended to catch top-level pattern

`unexported-final-var-access` now scans for both:
- `${R.final_vars.X}` (the v0.17.4 explicit path)
- `${R.<X>}` top-level — the canonical access path Perry's repro tested

Top-level matches skip envelope-field sibling access
(`${R.outputs.text}`, `${R.transcript}`, etc.) and bare iteration
access (`${R.final_vars}` without further descent). Findings include
an `extras.access_path` discriminator (`"top-level"` vs `"final_vars"`)
so adopters with cross-skill tooling can distinguish the surfaces.

### Test coverage

20 new tests in `v0.17.5-returns-top-level.test.ts` covering:
- All 8 reserved-name parse-time rejections
- Mixed-declaration partial-acceptance (good names land, reserved names rejected)
- `RESERVED_ENVELOPE_FIELDS` export shape
- Runtime: top-level `${R.X}` resolves, `R.final_vars.X` still works (both paths)
- Runtime: undeclared scratch never appears at R top level
- Lint: top-level `${R.BOGUS}` fires, `${R.ALPHA}` silent, envelope-field
  access silent, `${R.final_vars}` bare access silent
- Lint: existing v0.17.4 `${R.final_vars.X}` behavior preserved
- Lint: both paths fire when both used in same skill (no double-report on same ref)

1664 tests total. Narrow-core LOC ceiling unchanged at 10500.

---

## 0.17.4 — 2026-06-04 — `unexported-final-var-access` lint + `forceAlwaysDraft` adopter wiring (env + .env + config) + language reference re-render

Three coordinated pieces, all under the v0.17 line theme of closing
identity/approval surfaces:

### A. `unexported-final-var-access` (tier-2 advisory)

Sibling consumer-side rule to v0.17.3's tier-1 `unknown-returns-ref`
(declaration-side). Closes the symmetric gap: when a caller writes
`${R.final_vars.X}` and X isn't in the called skill's `# Returns:`,
the runtime filter drops the value silently — substitution renders
empty. This lint catches the asymmetry at author time so the silent
empty doesn't survive into trace inspection.

### What landed

- `unexported-final-var-access` (tier-2 advisory) — catches
  `${R.final_vars.X}` (and `$(R.final_vars.X)`) where R was bound by
  `$ execute_skill skill_name="<child>" -> R` and X isn't in
  `<child>`'s declared returns.
- Forward-reference deferred: missing child skills are still flagged
  by `unknown-skill-reference` (tier-2); this rule skips them so we
  don't double-report.
- Skips when SkillStore isn't provided (lint surface that can't
  resolve references stays silent).
- Per-(target, ref) dedup — one finding per unique reference per
  target, not per call site.

### B. Env-cascade for operator-config switches

Five operator/installer-relevant config fields now have an env-var
surface alongside CLI flags (where applicable) and JSON config:

| Env var | Effect | Cascade precedence |
|---|---|---|
| `SKILLSCRIPT_FORCE_ALWAYS_DRAFT=true` | Force outside-MCP `skill_write` to Draft; closes agent-self-approval path | env > config > default `false` |
| `SKILLSCRIPT_ENABLE_UNSAFE_SHELL=true` | Permit `shell(unsafe=true)` ops | env > config > default `false` |
| `SKILLSCRIPT_PORT=8080` | Dashboard / serve HTTP port | `--port` flag > env > config > default `7878` |
| `SKILLSCRIPT_HOST=0.0.0.0` | Bind address | `--host` flag > env > config > default `127.0.0.1` |
| `SKILLSCRIPT_MCP_CALLER_IDENTITY_HEADER=X-Agent-Id` | v0.17.0 inbound caller-identity header name | env > config > default unset |

The `forceAlwaysDraft` policy lever existed inside McpServer since
v0.16.8 but wasn't reachable through the adopter surface; this ring
closes that gap and extends the pattern across the four siblings.
`BootstrapOpts.forceAlwaysDraft` + `SkillscriptConfig.forceAlwaysDraft`
also wired for programmatic + JSON-config use.

When `forceAlwaysDraft` is true, outside-MCP `skill_write` rewrites the
body's `# Status:` header to `Draft` before persisting. In-skill
`$ skill_write` was already Draft-default unconditionally (v0.15.0
bridge); this is the symmetric outside-MCP path.

### C. `.env` file auto-loader

New `src/dotenv-loader.ts` reads `$SKILLSCRIPT_HOME/.env` at CLI
startup and populates `process.env` with `KEY=value` pairs. Shell-set
vars take precedence (standard dotenv contract). Drop a `.env` next to
`skillscript.config.json` and posture switches like
`SKILLSCRIPT_FORCE_ALWAYS_DRAFT=true` are picked up at next restart —
the installer-friendly "drop a file, restart, done" UX.

Hand-rolled parser (no npm dep) supports: `KEY=value`, quoted strings
(double + single), comment lines (`#`), blank lines, embedded equals
signs in values. Rejects: malformed entries (no `=`), invalid key names
(must match identifier regex). Missing file → no-op (graceful).
Multi-line values + variable interpolation deliberately not supported.

The loader also benefits indirect env-var consumers: `${VAR}`
substitution in `skillscript.config.json` and `connectors.json` reads
`process.env`, so `.env`-set values flow into those configs too.
Practical adopter pattern: secrets + endpoints in `.env`, declarative
config in JSON.

### D. `scaffold/.env.example` seeded by `skillfile init`

New scaffold file documents every env var the runtime recognizes —
posture switches, network bind config, multi-agent identity header,
LocalModel endpoint, and the indirect `${VAR}` substitution pattern
for `connectors.json` (the common AMP_TOKEN / API_TOKEN case). Copied
to `$SKILLSCRIPT_HOME/.env.example` by `skillfile init`. Adopters copy
to `.env` and edit. Re-running init is idempotent — only writes the
`.env.example` template, never overwrites an operator-edited `.env`.

### E. `docs/configuration.md` env-var section

New "Environment variables + `.env` file" section near the top of
the configuration doc. Covers: full table of direct env-var reads
with cascade precedence, indirect `${VAR}` substitution in JSON
configs, `.env` file format + supported/unsupported syntax,
precedence summary (CLI flag > env > .env > JSON > default),
`skillfile init` seeding behavior, and credential discipline. Closes
the docs gap where these surfaces existed in code but adopters had
no canonical reference.

### Test coverage

35 new tests in three files:
- `v0.17.4-unexported-final-var-access.test.ts` — 9 lint tests
- `v0.17.4-force-always-draft-wiring.test.ts` — 8 cascade tests
- `v0.17.4-dotenv-loader.test.ts` — 14 loader tests (quotes, comments,
  blanks, malformed, precedence, missing file, embedded equals, etc.)

1644 tests total. Narrow-core LOC ceiling bumped 10400 → 10500 (the
unexported-final-var-access rule is ~90 lines of substitution-pattern
parsing + cross-skill resolution; per the signal-not-budget rule,
clear code wins).

### Language reference re-rendered

Picks up Perry's atom updates to the AMP doc tree
(`skillscript-language-reference`, 15 sections). Substantive content
this re-render brings local-side:

- New "Return contract: `# Returns:`" section in Composition — worked
  example, always-exported set spelled out, per-level contract
  explanation, top-level MCP filter note (substrate-author's
  `52ab738f` nit on the v0.17.3 thread now documented), both new
  lint rules cited.
- Inline section refined: "Data-only — not executable composition."
  The reader can no longer plausibly think `inline()` runs procedural
  code; the contrast with `execute_skill` is explicit. Closes the
  spec/impl mismatch flagged in v0.17.2's CHANGELOG.
- Header metadata list updated to mention `# Returns:` alongside
  `# Vars:` as the output-side mirror.
- New "Pipes need unsafe" caveat in the shell section (composition-in-
  tools pattern, sandboxed multi-call temp-file alternative).

---

## 0.17.3 — 2026-06-04 — `# Returns:` frontmatter: declared export surface for execute_skill composition

Closes Perry's `1ea3d625` Finding 2 (`execute_skill` leaks full child
`final_vars` into the parent — 252KB MCP-response blowup on a 2-line
emit). Substrate-author's `6fb6ac1c` empirical pre-flight (0/16 skills
reach `${R.final_vars.X}`) confirmed the migration-free cut. Three-way
convergence: Perry's design ack (`8ffa16d6`) + substrate-author's
pre-flight (`6fb6ac1c`) + Perry's discipline-corrected catch
(`5a7e4041`) shaped the final scope.

### Skills are functions — declare what you return

New `# Returns: X, Y, Z` frontmatter header declares the export surface
for `execute_skill` composition. The runtime filter at the composition
boundary (`src/composition.ts:filterFinalVarsByReturns`) drops every
`final_vars` entry whose name isn't in the declared list. Internal
scratch (large JSON, intermediate computations, debug values) stays
local to the child execution — never serialized into the caller's `R`
or the top-level MCP `execute_skill` response.

**Concrete shape:**

```
# Skill: get-weather
# Vars: LOCATION=Valdese
# Returns: SUMMARY, TEMP_F, CONDITIONS

fetch:
    shell(command="curl -s 'wttr.in/${LOCATION|url}?format=j1'") -> RAW
    $ json_parse ${RAW} -> PARSED

shape: fetch
    $set TEMP_F = ${PARSED.current_condition.0.temp_F}
    $set CONDITIONS = ${PARSED.current_condition.0.weatherDesc.0.value}
    $set SUMMARY = "${LOCATION}: ${TEMP_F}°F and ${CONDITIONS}"
    emit(text="${SUMMARY}")
default: shape
```

Caller binding `-> R` gets `R.final_vars = {SUMMARY, TEMP_F, CONDITIONS}` —
NOT `RAW` or `PARSED`. Always-exported (no declaration needed): `outputs`,
`transcript`, `errors`, `target_order`, `fallbacks`, `agent_delivery_receipts`.

### Default: no Returns → no final_vars exported

Skills without `# Returns:` export nothing from `final_vars`. Caller still
sees `outputs` + `transcript` + execution metadata — the natural pattern
substrate-author's audit found in 100% of existing composers.
Pre-adoption rule (per `project_pre_adoption_rule`) makes the breaking
cut cheap; the migration is free for the canonical `${R.outputs.text}`
pattern.

### New lint: `unknown-returns-ref` (tier-1)

Fires when a name in `# Returns:` isn't bound anywhere in the skill body
(not in `# Vars:`/`# Requires:`, not output-bound, not a foreach iterator).
The skill claims to return something it never produces — structurally
broken, hard-blocked at compile.

### Watch-items (not built, documented)

- **`transcript` nests across composition depth.** When A calls B calls C,
  A's `R.transcript` holds B's emissions; B's `R.transcript` (visible via
  declared returns or transcript-of-transcript chains) can hold C's.
  Bounded by intended emits per child; additive across siblings. Per
  Perry's `5a7e4041` discipline-corrected catch — fix-ahead-of-need not
  warranted today; revisit if deep-composition-with-large-emits bites.
- **`unexported-final-var-access` (tier-2 advisory)** — deferred to
  v0.17.4. Would catch `${R.X}` where X isn't in the called skill's
  `# Returns:`. Requires cross-skill resolution + accessor-pattern
  parsing; warrants its own ring.

### Test coverage

16 new tests (parser: 6, lint: 5, runtime: 5). Three-test discipline per
`feedback_three_test_discipline_per_dispatch_shape`. Full suite: 1613
tests pass.

### Migration

Bundled examples + scaffold skills: zero changes needed. None reach
`${R.final_vars.X}` today (verified by substrate-author's audit). When
adopters want structured access to a composed child's results, they
add `# Returns: X` to the child skill.

---

## 0.17.2 — 2026-06-04 — Parser: strip one layer of matched surrounding quotes from `# Vars:` defaults

**Composition dogfood fix.** Perry's morning-brief dogfood (`1ea3d625`)
surfaced a silent quote-leak: `# Vars: LOCATION="Valdese"` bound the
literal 9-char string `"Valdese"` (quotes included), not the 7-char
`Valdese`. URL-encoded with the quotes downstream, broke wttr.in
lookup (IP-geolocation fell back to Berlin instead of Valdese).

### What landed

Parser strips exactly one layer of matched surrounding quotes from
`# Vars:` default values at parse time:

- `LOCATION="Valdese"` → `Valdese` (the load-bearing case)
- `MSG="hello world"` → `hello world` (quotes were doing real
  whitespace-delimiting work; one-layer strip preserves the space)
- `WHO=world` → `world` (bare, unchanged)
- `LOCATION=""` → empty string (two literal quote chars previously)
- `Q='"x"'` → `"x"` (one-layer-only, not recursive)
- `X="x'` → `"x'` (mismatched quotes pass through unchanged)
- JSON literals (`TAGS=["a","b"]`, `CFG={"k":"v"}`) untouched —
  square brackets / curly braces aren't quotes.

### Back-compat-positive

Existing skills get more correct, not less. The bundled example
`HttpWebhookAgentConnector/README.md` uses `CHANNEL="slack"` — pre-fix
that bound the 7-char `"slack"` (literal quotes); post-fix it binds
`slack`, which is what the example always meant. No skill breaks; a
few quietly start working right.

### Known issue noted

Perry's same dogfood (`1ea3d625` Finding 2) surfaced a separate
`execute_skill` composition issue: `-> R` binding propagates the
child's full `final_vars` into the parent, including internal scratch
vars. His morning-brief blew the MCP token budget (252KB result) on a
trivial 2-line emit. Workaround until v0.17.3+: prefer
`${R.outputs.text}` over `${R.final_vars.X}`; design conversation on
the right shape (explicit `# Returns:` surface vs size-cap vs MCP
trim) deferred to a separate ring.

---

## 0.17.1 — 2026-06-03 — Docs ring: adopter playbook identity-propagation + authoring posture; language reference re-render

**Docs-only ring.** Two artifact updates bundled — the playbook gains
two new sections covering v0.17.0's adopter surface, and the language
reference resyncs from its canonical AMP document tree. No code, no
language-surface changes.

## Adopter playbook

Closes two docs gaps v0.17.0's CHANGELOG flagged as "forthcoming." Per
`feedback_playbook_is_timeless` — playbook describes what IS, not
version history; the new sections are framed in present-state language
with no v0.17.0 retrospective parentheticals.

### 1. New `Identity propagation — for multi-agent hosts` section

Adopter-facing docs for v0.17.0's `mcpCallerIdentityHeader` config —
the surface that previously had only a CHANGELOG entry. Covers:

- Lead with the framing memory: skip this section if you're
  single-user / single-tenant. The v0.16.8 default (`SkillStore`-side
  author capture) handles those cases without configuration.
- The MCP boundary's structural gap: JSON-RPC carries no standard
  caller-identity field, so multi-agent hosts need a convention.
- Opt-in config example (`dashboard.mcpCallerIdentityHeader: "X-Agent-Id"`)
  with the inbound request header shape adopters need to inject.
- Trust model: bilateral — host authenticates, runtime trusts header
  attestation. Not for untrusted-network deployments.
- Inbound vs outbound `X-Agent-Id` — same name, two layers, two
  semantics, bridge meets at `SkillMeta.author`. Critical setuid-hazard
  warning: never forward inbound→outbound; outbound is always derived
  from author at dispatch.
- Verification smoke test (cURL + jq pattern).

### 2. New `Authoring posture` section

Three authoring paths surveyed, with the direct-write Draft→promote
pattern documented (closes Perry's Gap 2 doc-side per substrate-author's
`a4826b2a` clarification):

- CLI / dashboard / direct programmatic API → SkillStore default
  author capture.
- MCP `skill_write` single-tenant → defaults apply, skip the
  multi-agent section.
- MCP `skill_write` multi-agent → see new identity-propagation section.

Plus the **direct-write authoring path** (write substrate record
directly without going through `skill_write`):

1. Write with `# Status: Draft` (captures `SkillMeta.author` from
   substrate writer identity).
2. `skill_status({new_state: "Approved"})` stamps the hash token and
   preserves the captured author.

Write-Approved-without-stamp fails at execute time with
`ApprovalRejectedError` — gotcha worth calling out so adopters using
substrate-direct authoring don't hit the wall Perry hit in dogfood.

## Language reference

Resynced `docs/language-reference.md` from the canonical AMP document
tree (`skillscript-language-reference`, 15 sections). Picks up content
Perry authored / refined since the last local render.

- **`|contains:` filter semantics** — full type-aware resolution
  branches (list, JSON-string-list, string, fallback); symmetry with
  `in` / `not in` operators.
- **Triple-quote multi-line strings** — `"""..."""` literal type with
  `textwrap.dedent` semantics; dedent runs before `${VAR}`
  interpolation; literal type any kwarg accepts (not emit-specific).
- **Identity semantics, two layers:**
  - `inline()` — host-skill identity (compile-time paste, no runtime
    boundary). Bringing code in via inline is an act of taking
    responsibility for it. (Spec-aspirational for procedural inline;
    current impl handles data-typed only — procedural inline still
    throws at runtime per `src/runtime.ts:692`.)
  - `execute_skill` — called-skill author identity (`SkillMeta.author`).
    Each skill is its own identity unit; dispatcher does not loan its
    identity to the callee. Cross-author delegation deferred.
- **Third principle for skill authors** — "Comparison is orchestration;
  computation goes in tools." Includes the shell+jq universal
  computation escape pattern, the stopping rule, and common shells of
  the pattern (jq for aggregation, awk/sed for fields, date/python for
  date math).
- **`RuntimeCapabilitiesConformance` auto-coverage gate** — capability
  flags spanning multiple layers (`supports_identity_propagation`) gate
  via adopter-supplied Level-1 + Level-2 probes; declaring the flag
  true without probes fails before runtime accepts the claim.
- **Restructured "Not yet implemented, but planned"** section —
  consolidates pipe-filter extensions, removes shipped items.

### Spec/impl gap flagged

The language reference describes `inline()` as "compile-time paste
makes the inlined ops part of the host body" — applies cleanly for
data skills today, but procedural-skill inline still throws
`MissingSkillReferenceError` at runtime. The spec is aspirational here;
runtime-procedural inline is a future-ring code item.

---

## 0.17.0 — 2026-06-03 — MCP-caller identity propagation: host-attested caller → SkillMeta.author + adopter playbook docs

**Opens v0.17 line.** Closes the write-side gap that mirrored v0.16.9's
read-side fix: when an agent calls `skill_write` via the MCP transport,
the calling agent's identity now reaches the runtime's handler and
stamps `SkillMeta.author`. Combined with v0.16.9's owner-as-default
dispatch, MCP-authored skills execute under the calling agent's
substrate scope.

Charter: Perry's `3f47b16e` Gap-1 finding + warm-adopter's `6ce97894`
prototype (validated against live AMP: caller=perry→author=perry
distinct from caller=alice→author=alice through the HTTP/MCP boundary)
+ Perry's `2a9c234a` 4-point spec ack. Same `substrate-author-prototype-in-parallel`
pattern as v0.16.8/9; the prototype's measured shape became the runtime
spec verbatim.

### 1. Inbound caller-identity threading (the load-bearing fix)

`DashboardServer` reads a configured HTTP header (e.g. `X-Agent-Id`)
on every `/rpc` request, captures it as `McpRequestCtx.callerIdentity`,
threads it into `McpServer.handle(req, ctx)`. The `skill_write` handler
uses it as `store({author})`. Header lookup is case-insensitive (Node
lowercases inbound header names).

**New types:**
- `McpRequestCtx` — request-scoped ctx passed from transport into
  `McpServer.handle()` and through to tool handlers. Inbound mirror of
  v0.16.9's outbound `McpDispatchCtx`, one layer up. Re-exported from
  the package index.
- `DashboardServerConfig.mcpCallerIdentityHeader?: string` — opt-in
  header name. Default unset; existing v0.16.8 behavior preserved.
- `McpServerDeps.mcpCallerIdentityHeader?: string` — companion field
  for non-DashboardServer embeddings.
- `SkillscriptConfig.dashboard.mcpCallerIdentityHeader?: string` —
  configurable via `skillscript.config.json`.

### 2. Opt-in for multi-agent hosts; invisible to simple-substrate adopters

Header unset = existing v0.16.8 behavior. Single-user CLI, single-tenant
deployments, hobby installs — none configure this surface. The
`SkillStore.store()` author fallback (e.g. `userInfo().username` for
`FilesystemSkillStore`) continues to capture the right author for these
deployments. Multi-agent hosts (where one runtime serves multiple
authenticated agents via MCP) configure the header.

### 3. Inbound vs outbound `X-Agent-Id` — two layers, two semantics

Same header name as v0.16.9's outbound `HttpMcpConnector.identityHeader`
by convention. They are NOT the same value in general:
- Inbound (this ring) = request-scoped caller (current caller of the runtime)
- Outbound (v0.16.9) = dispatch-scoped owner (derived from `SkillMeta.author`)

They MEET at `SkillMeta.author` — that's the bridge. Forwarding inbound
straight to outbound would be a setuid hazard (anyone invoking alice's
skill would dispatch as the caller, not alice). The runtime keeps them
separate; outbound is always derived from author at dispatch.

### 4. Three-test discipline + multi-agent empirical lane

- Runtime unit: `McpServer.handle(req, ctx)` threads `callerIdentity` to
  `skill_write` → `store({author})`. First-write-locking still wins.
- E2E: `DashboardServer` reads header end-to-end; case-insensitive lookup;
  absent header → fallback; non-configured runtime ignores the header.
- Multi-agent lane: two callers with distinct `X-Agent-Id` values →
  distinct stored authors (the test (C) per-host couldn't pass).

### 5. Docs ring (bundled from v0.16.9)

- `docs/adopter-playbook.md` HttpMcpConnector section now documents
  `identityHeader` + `maxPoolSize` config (v0.16.9 surfaces that lacked
  adoption docs).
- New section forthcoming on the multi-agent inbound-identity setup.
- `examples/skillscripts/skill-store-roundtrip.skill.md` +
  `youtrack-morning-sweep.skill.md` — dropped stale version-history
  parentheticals per `feedback_playbook_is_timeless`.
- `examples/connectors/McpConnectorTemplate/McpConnectorTemplate.ts` —
  expanded `supports_identity_propagation` comment to point at the
  Level 1 + Level 2 probe-keying convention so adopters who flip the
  flag don't hit the v0.16.9 auto-coverage gate empty-handed.

### Operational note

Existing skills authored via the old write path (e.g., authored as the
runtime's own identity rather than the calling agent's) stay attributed
to the runtime until they're re-written via `skill_write` under the new
header convention, OR until an adopter-side admin operation transfers
ownership. The first-write-locking discipline still holds: subsequent
overwrites by a different caller don't re-author.

---

## 0.16.9 — 2026-06-03 — End-to-end identity propagation: per-identity sessions + owner-as-default + conformance probe

**Cluster ring.** Four items closing the identity-propagation surface
opened in v0.16.8. v0.16.8 landed `SkillMeta.author` capture +
`HttpMcpConnector` per-call header (Level 1 — identity reaches
transport) but honestly declared `supports_identity_propagation: false`
because per-call headers don't propagate end-to-end against
session-pinning substrates (warm-adopter's `1e1c9305` finding). This
ring lands the structural close: per-identity session keying achieves
Level 2 (distinct `ctx.agentId` → distinct observable substrate scope),
owner-as-default for all dispatch paths, and a conformance probe that
gates the `true` claim on probe-wired evidence.

Charter: Perry's `9af842f7` ack + `33fefa0f` go-ahead. Empirically
validated against live AMP via warm-adopter's `299c0d20` reference
prototype before charter commit.

### 1. Overwrite-status preservation in `FilesystemSkillStore`

`store()` now reads the last version's persisted status before write
and preserves it on overwrite. Body's `# Status:` header is rewritten
to match preserved status via existing `rewriteStatusHeader`. Explicit
`metadata.status` overrides the persisted value (authority bypass for
substrate operations).

Closes the sibling-class issue to v0.16.8 item 1's author-locking:
the SkillStore IS the trust boundary for both author identity AND
approval state — body-declared status on overwrite was bypassing the
boundary. Now: body declares, store records, persisted state wins on
overwrite, body rewritten to match.

### 2. Per-identity session keying in `HttpMcpConnector`

Connector rewrite per warm-adopter's `IdentityAwareAmpConnector`
reference impl pattern. Each distinct `ctx.agentId` gets its own
session, pinned to that identity at server-side `initialize` time.
`Map<identity, SessionEntry>` with insertion-order LRU eviction
(`maxPoolSize` config field, bump-on-access for MRU promotion).
`StaleSessionError` triggers one bounded re-init + retry. Per-identity
pooling activates ONLY when `identityHeader` is configured — adopters
who don't thread identity get substrate-neutral default-session
behavior.

`supports_identity_propagation: true` flag flipped on — both Level 1
AND Level 2 achieved against session-pinning substrates including AMP.

### 3. `RuntimeCapabilitiesConformance` auto-coverage probe (Level 1 + Level 2)

The flag claim is now gated on adopter-supplied probe evidence. When
ANY registered McpConnector declares
`supports_identity_propagation: true` in `staticCapabilities()`, the
conformance suite auto-generates a coverage test that requires BOTH
probes via `flagProbes`:

- `mcpConnectors.<name>.supports_identity_propagation.level1` —
  identity reaches transport (substrate-independent)
- `mcpConnectors.<name>.supports_identity_propagation.level2` —
  distinct `ctx.agentId` yields distinct observable substrate scope
  (substrate-coupled; adopter pattern: identity-pinned mock or live
  substrate)

Closes the structural-honesty gate per `33fefa0f`: declaring the flag
without probes is a discipline-only-contract instance. The probe
catches the false-positive scenario warm-adopter flagged — per-call
headers pass Level 1 while silently failing Level 2.

### 4. Owner-as-default for all cross-author dispatch paths

`execute_skill` MCP tool already populated `ctx.agentId` from
`SkillMeta.author` in v0.16.8. This ring generalizes to the two
remaining dispatch paths:

- `executeSkillByName()` in `src/composition.ts` — when a skill inlines
  another via `! call`, the child `ctx.agentId` is set to the called
  skill's author (cross-author = called-skill-author default per
  Perry's `fd18e3f7`: identity follows the skill).
- `dispatchSkill()` in `src/scheduler.ts` — trigger-fired dispatch
  populates `ctx.agentId` from the loaded skill's metadata.

Dual-identity delegation (caller + callee both threaded) deferred to
v0.17+.

---

## 0.16.8 — 2026-06-03 — Identity foundation: SkillMeta.author + connector honesty + approval posture

**Cluster ring.** Six items on the SkillStore metadata + connector honesty
layer per the consolidated v0.16.8 charter (`9af842f7`). Foundation for
v0.16.9+ identity propagation work; this ring lands the capture + the
honesty fixes without claiming end-to-end propagation (that requires
per-identity session keying against session-pinning substrates — target
later ring).

Two cross-agent inputs shaped the ring:
- Perry's `c497b479` finding (parser bug + lint false-positive) and
  `787b6b95` approval-posture playbook ask
- Warm-adopter's `1e1c9305` substrate-author findings + `299c0d20`
  prototype validation against live AMP

### 1. `SkillMeta.author` populated at SkillStore write

The SkillStore IS the trust boundary — whoever's authenticated to write
IS the owner. First-write captures the writer identity into the
existing `SkillMeta.author` field (warm-adopter's `1e1c9305` revision —
reuses the contract field rather than adding `metadata.owner`).

**Locked at first-write** per Perry's `9d9aef14` — subsequent `store()`
calls preserve the original author silently; an explicit
`metadata.author` that disagrees throws `StorageConflictError`.
Transfer of ownership is a substrate-specific privileged operation,
not a side-effect of an authoring rewrite.

`FilesystemSkillStore` defaults the author to `os.userInfo().username`
when `metadata.author` is not supplied — trust-boundaried by FS perms,
FS user IS the identity. Adopter stores capture from their auth header
/ session via the `metadata.author` argument.

Persistence via the existing versions log — first version's
`changed_by` IS the canonical author. `buildMeta()` reads it on every
`metadata()` / `query()` / `load()` call.

### 2. `McpServerDeps.forceAlwaysDraft` flag

Per Perry's `787b6b95` Option A. Strict approval posture for adopters
who want "every skill needs explicit human promotion regardless of body
declaration." Default `false` — preserves the v0.9.1 auto-stamp
behavior (Tradita's current posture).

When `true`: the outside-MCP `skill_write` handler rewrites the body's
`# Status:` header to `Draft` before persisting, then `SkillStore.store()`
records `status: Draft` in the VersionInfo. Body and persisted state
agree. Same `forceDraftStatus` helper as the in-skill bridge's v0.15.0
Draft-by-default discipline (now exported from `skill-store-mcp` for
reuse).

The in-skill bridge dispatch (`SkillStoreMcpConnector`) remains
Draft-by-default regardless of this flag — that's a separate v0.15.0
trust boundary.

### 3. `HttpMcpConnector` ctx-reading + identity header (honesty fix)

v0.16.5 shipped `HttpMcpConnector` declaring
`supports_identity_propagation: true` but the impl ignored `ctx`
entirely. Warm-adopter's `1e1c9305` empirical finding flagged this as
false-advertising — same discipline-only-contracts pattern as
`model=`/`|json`/etc bugs.

**v0.16.8 changes:**
- New `identityHeader?: string` config field. When set + `ctx.agentId`
  supplied, the configured header is emitted per-call (e.g.
  `identityHeader: "X-Agent-ID"` → requests carry
  `X-Agent-ID: <ctx.agentId>`).
- Adopter-configurable, empty default per substrate-neutrality
  (`845bfab7` — no AMP-specific header conventions in bundled
  defaults; adopters configure per their substrate's auth model).
- **`supports_identity_propagation` flag flipped to `false`.** Per
  warm-adopter's session-pinning finding: per-call header doesn't
  propagate end-to-end against substrates that pin sessions per-
  identity (which is the common case for Streamable HTTP MCP servers
  including AMP). Real end-to-end propagation needs per-identity
  session keying — that's v0.16.9+ work. The flag stays false until
  it's honest.

### 4. `execute_skill` ctx populates `agentId` from `SkillMeta.author`

Class-sibling close to v0.15.4 `enableUnsafeShell-in-ctx` (Perry's
`adf47c0b`). `ExecuteContext.agentId` field has existed since v0.x but
was never populated at the `execute_skill` MCP entry — runtime threads
`ctx.agentId` through to `McpDispatchCtx.agentId` at dispatch time
(`runtime.ts:1026`), but with no source for agentId here, the
connector dispatched under runtime identity regardless of skill owner.

v0.16.8: named-skill `execute_skill` invocations look up the skill's
`SkillMeta.author` from the SkillStore and populate `ctx.agentId`. The
runtime threading was already wired; this lands the population path.

Source-form `execute_skill` (no skill name → no SkillStore lookup
possible) leaves `ctx.agentId` undefined — the caller is responsible
for supplying it via other `ExecuteContext` paths (v0.16.9+).

### 5. `object-iteration-advisory` wording softened + adopter-configurable suppression

Per Perry's `c497b479` finding 2. Pre-v0.16.8 the advisory prescribed
`.items` access specifically; authors trusting it against bare-array-
returning tools got runtime "Unresolved variable reference" failures.
Asymmetric failure mode: ignoring was invisible-success, trusting was
silent-breakage.

**v0.16.8:**
- Wording acknowledges shape ambiguity ("the tool may return a bare
  array OR an envelope shape — verify against the tool's actual
  response"). No prescriptive field name.
- New `LintOptions.bareArrayReturnTools?: string[]` config field —
  adopter-configurable suppression list. Default empty
  (substrate-neutral per `845bfab7` — no AMP-specific names in bundled
  defaults).
- Lint finding's `extras.tool_name` captures the source tool name for
  audit / config-targeting.

Tradita's bootstrap configures the AMP tool names post-ship (Perry's
followup, not v0.16.8 scope).

### 6. Playbook approval-posture section

Atom-level documentation — Perry owns the playbook atom per the agreed
split (`9af842f7` Q5). Covers Option A (this ring's `forceAlwaysDraft`
flag) + Option B (subclass override) with the tradeoffs Perry laid out
in `787b6b95`. Lands in the next playbook atom re-render.

### Internal

- `src/connectors/types.ts` — `SkillMeta.author` doc expanded; `SkillStore.store()` contract documented re: author capture + locking.
- `src/connectors/skill-store.ts` — `os.userInfo()` import; `readFirstVersionAuthor()` helper; `buildMeta()` populates author from versions log; `store()` enforces first-write-locks discipline.
- `src/connectors/skill-store-mcp.ts` — `forceDraftStatus` helper exported (reused by outside-MCP handler).
- `src/connectors/http-mcp.ts` — `identityHeader` config; `call()` reads ctx; `post()` accepts `extraHeaders`; `supports_identity_propagation: false`.
- `src/mcp-server.ts` — `McpServerDeps.forceAlwaysDraft` field; `skillWrite()` honors the flag via `forceDraftStatus`; `executeSkill()` populates `ctx.agentId` from named skill's metadata.
- `src/lint.ts` — `BindingOrigin.toolName` field; `LintOptions.bareArrayReturnTools`; advisory wording rewritten; suppression check.
- LOC ceiling nudged 10000 → 10100 (v0.16.8 cumulative additions).
- +34 tests across `tests/v0.16.8-*.test.ts`. 1551 passing total (was 1517).

### What's NOT in v0.16.8

- Per-identity session keying (the actual end-to-end propagation fix
  for session-pinning substrates) → v0.16.9 alongside warm-adopter's
  prototype reference impl.
- `# Identity: runtime` opt-OUT header → v0.16.9+.
- RuntimeCapabilitiesConformance probe for both Level 1 + Level 2 →
  v0.16.9 (no claim to gate in v0.16.8 since `supports_identity_propagation: false`).
- `execute_skill` cross-vault identity semantic (the harder
  setuid-shaped question) → deferred design discussion.

### Counting

15th instance of the discipline-only-contracts class closed since
`d0fb1375`. HttpMcpConnector `supports_identity_propagation: true`
being a lie was the same shape as model=/|json/etc bugs — class-sibling
close.

## 0.16.7 — 2026-06-03 — Triple-quote parser: splitTopLevelCommas string-aware

**Parser bug fix.** Triple-quote bodies containing a quoted phrase with
an inner comma broke the function-call kwarg parser. Empirical repro
from Perry's `stop-rule-check` skill (`c497b479` finding 1):

```
emit(text="""
    Test 3: phrase ending with "comma inside, here".
    Test 4: "more native spelling pending," with the exact failing literal.
""")
```

→ `[malformed-op-grammar] Malformed function-call arg 'here". Test 4:
"more native spelling pending' in 'emit(...)' — expected name=value.`

**Root cause.** `splitTopLevelCommas` in `src/parser.ts` tracked
single/double-quote state and bracket-nesting depth, but NOT
triple-quote state. When the triple-quote body contained an odd-count
of embedded `"` chars (which happens naturally with mid-body quoted
phrases), the `inQuote` toggle accumulated to an unbalanced state.
Top-level commas inside the body then split args mid-content; the
closing `"""` landed as malformed kwargs.

`tokenizeKeywordArgs` and `extractParenBody` had `inTriple` state
tracking discipline since the original triple-quote work;
`splitTopLevelCommas` was missing the same discipline.

**Fix.** Extended `splitTopLevelCommas` to mirror the `inTriple`
discipline from its sibling tokenizers. Inside a triple-quote body,
embedded single `"` chars are literal content; commas are content;
only the closing `"""` exits the state. Bounded change, no other
parser paths affected.

### Internal

- `src/parser.ts` — `splitTopLevelCommas` gains `inTriple` state +
  the triple-quote OPEN/CLOSE branches (mirrors `tokenizeKeywordArgs`)
- +6 tests in `tests/v0.16.7-triple-quote-tokenizer.test.ts` covering
  Perry's verbatim repro + 5 adjacent shapes (odd-count quotes, multi-
  comma-inside-quoted, mid-body comma right before closing `"""`,
  multi-kwarg with triple-quote + post-`"""` top-level comma, nested
  `execute_skill` kwarg with embedded triple-quote)
- 1517 passing (was 1511)

### Deferred to v0.16.8

The second finding from `c497b479` (`object-iteration-advisory`
false-positive on bare-array-returning MCP tools) needs an adopter-
configurable suppression list + softened advisory wording. Per Perry's
sign-off on the substrate-neutrality concern, bundled defaults stay
empty (no AMP-specific names in the public runtime); Tradita bootstrap
configures its tool set.

## 0.16.6 — 2026-06-02 — `|contains:` filter + triple-quote `textwrap.dedent`

Two pure-language additions per Perry's `98d6b60b` directive. Both
small, both high author-UX value, both no design tension with existing
carve-outs.

### 1. `|contains:"X"` filter

Boolean substring/membership check for use in conditionals. Returns
`"true"` on match, `""` (empty string) on miss — matches the
`isTruthy` convention in runtime so `if ${R|contains:"X"}:` evaluates
the way the syntax suggests.

**Type-aware with JSON-string tolerance.** Mirrors the `in` / `not in`
conditional operators per Perry's `4235ef2b` pushback during checkpoint:

- LHS resolves to a JSON-parseable array → element membership (each
  element stringified, compared against arg)
- LHS resolves to anything else → substring match on the resolved
  string form

Without type-awareness, `${LIST|contains:"a"}` against `["alphabet"]`
would silently match (substring "a" inside the stringified
`'["alphabet"]'`) — the discipline-only-contracts shape we've been
closing. Type-aware semantics catch the structural mismatch instead.

Cognitive symmetry: `if ${A} in ${L}:` and `if ${L|contains:"a"}:`
return the same answer when `${A}` resolves to `"a"`. **First filter
to operate on structured types** because the conditional primitives
already do; filter-as-conditional-primitive is the design line.
Other filters (`|trim`, `|json`, `|fallback`, etc.) stay string-only.

Common authoring pattern:

```
$ llm prompt="Reply with 'urgent' if any items are urgent" -> VERDICT
if ${VERDICT|contains:"urgent"}:
    notify(agent="oncall", message="paged")
```

Replaces the today-fragile shape `if ${VERDICT|trim} == "urgent":`
which forces the prompt to over-constrain ("EXACTLY one word") just
to fit the equality grammar.

### 2. Triple-quote `textwrap.dedent` pattern

Triple-quote literal extraction (parse, escape interpretation,
multi-line spanning, embedded single quotes, `${VAR}` interpolation
preservation) was already shipped in the earlier triple-quote work.
This ring adds the missing piece: Python `textwrap.dedent` whitespace
discipline.

**What changes:** authors writing multi-line bodies indented inside
the call site (the natural shape) get the common leading whitespace
stripped automatically:

```
deliver:
    emit(text="""
    Follow these directions exactly,
    step by step,
    without skipping any steps.
    """)
```

Renders as:

```
Follow these directions exactly,
step by step,
without skipping any steps.
```

Three passes:

1. Strip a leading whitespace-only line (the natural `"""\n  body\n  """`
   shape leaves one immediately after the opening delimiter)
2. Strip a trailing whitespace-only line (same shape leaves one before
   the closing delimiter)
3. Compute the common leading-whitespace prefix across non-empty lines,
   then strip that prefix from each line. Blank-or-whitespace-only lines
   don't constrain the calculation — their indentation is flexible.

**Dedent runs BEFORE `${VAR}` substitution** per the directive's Q1
answer. Authors who substitute multi-line values into a triple-quote
template keep the substituted value's own whitespace; only the
template's literal-body indent gets stripped.

**Single-line triple-quote literals pass through unchanged** — dedent
only fires when there's actually a newline in the body.

### Internal

- `src/filters.ts`: `contains` added to `KNOWN_FILTERS`. `applyFilter`
  signature extended with optional `arg` parameter (the existing
  `fallback` filter consumes its arg upstream, so no other filter
  needed it before).
- `src/runtime.ts`, `src/compile.ts`: call-site updates to thread
  `spec.arg` through to `applyFilter`. Compile-time substitute regex
  extended to capture the arg.
- `src/parser.ts`: `dedentTripleQuoteBody` helper added; applied in the
  triple-quote literal extract branch of `processSetValue`. Exported
  for direct testing.
- `src/help-content.ts`: `contains:` row added to Pipe filters table;
  triple-quote multi-line row added to Kwarg value grammar table;
  dedent semantics example added.
- LOC ceiling nudged 9900 → 10000 to absorb the v0.16 series cumulative
  additions (kwarg lints, manifest exposure, `|contains:` filter, dedent
  helper, bare-form detection branches). Per Scott's "LOC ceiling is a
  signal not a budget" rule.
- +14 tests in `tests/v0.16.6-contains-filter.test.ts` (unit + condition
  context + lint integration). +13 tests in
  `tests/v0.16.6-triple-quote-dedent.test.ts` (unit on the helper +
  end-to-end via `emit(text=...)` + backward-compat with single-line).
  1511 passing total (was 1484).

### Docs

Atom-level updates to the language reference happen separately (owned
by Perry: `c6224b7d` Ops atom, the Pipe Filters atom, the Planned
section). This ring touches only `src/help-content.ts` on the runtime
side per agreed split.

## 0.16.5 — 2026-06-02 — HttpMcpConnector + RuntimeCapabilitiesConformance + sibling kwarg lints

**Catchup ring.** Three queued items per Perry's `934fc9d8` sign-off had
been carrying since v0.15.6 (the original two-stage proposal in
`0b35bd70`) — HttpMcpConnector + contract-test fixture + sibling kwarg
lints. v0.16.4 shipped one (the `unknown-llm-model` lint) and silently
punted the other three. Warm-adopter flagged "2 releases late" on the
carry-forwards. This ring closes all four.

### 1. `HttpMcpConnector` — bundled generic Streamable HTTP MCP connector

Speaks JSON-RPC over HTTP + Server-Sent Events directly — no subprocess
(unlike `RemoteMcpConnector` + `mcp-remote`). Substrate-neutral by
design: works against any MCP server speaking the Streamable HTTP spec
(Anthropic's hosted MCP, GitHub MCP, Linear MCP, AMP, etc.) via the
same connector class with different `endpoint` + `headers` config.

Adopters declare instances in `connectors.json`:

```json
{
  "my_remote": {
    "class": "HttpMcpConnector",
    "config": {
      "endpoint": "https://mcp.example.com/",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}",
        "X-Agent-ID": "${AGENT_ID}"
      }
    },
    "allowed_tools": ["search", "fetch"]
  }
}
```

**Implementation details** (per the lift checklist in warm-adopter
memory `41fedec6`):

- `initialize` handshake captures `mcp-session-id` response header,
  echoes on every subsequent request
- `notifications/initialized` sent after `initialize`, before any
  `tools/call` (protocol-mandatory)
- SSE response parsing handles multi-frame replies (trailing
  notification frame can masquerade as the reply; we take the terminal
  data frame)
- Configurable static auth/identity headers passed through verbatim
- Result unwrap: when `content[0].text` is JSON-shaped, parse it;
  fallback to raw text or full result block
- `staticTools()` returns `null` (runtime-discovered);
  `manifest()` populates `tools_available` via `tools/list`
- Concurrent first-callers share a single handshake (single-flight
  initialization promise)

**Source attribution.** Lifted + generalized from a warm-adopter's
direct-HTTP MCP client at commit 844a19e in the adopter's tree, per
Perry's `934fc9d8` sign-off. Substrate-specific bits (adopter's tool-
name normalization convenience) stayed adopter-side; only the wire-
layer code was lifted. Generalized substrate-specifics out at the
lift boundary.

### 2. `RuntimeCapabilitiesConformance` — discovery-surface contract test

Per Perry's `adf47c0b`. Closes the long-running discipline-only-
contracts pattern: every flag in `runtime_capabilities` must have a
matching execution-path probe test. Forces adopters to wire BOTH the
capability declaration AND the dispatch-path probe in lockstep —
without it, the "lint passes, runtime fails" multi-layer-promise
failure mode keeps recurring (5 instances counted pre-v0.15.4 alone).

Exported from `skillscript-runtime/testing` alongside the existing
five `*Conformance` objects. Adopters wire it against their runtime:

```ts
import { RuntimeCapabilitiesConformance } from "skillscript-runtime/testing";

const fixture = {
  buildRuntime: async () => ({ mcpServer: myWiredRuntime.mcpServer }),
  flagProbes: {
    "shellExecution.unsafe_enabled": async (runtime) => {
      // Probe that unsafe shell ops respect the unsafe_enabled config.
    },
    "localModels[].features.supports_streaming": async (runtime) => {
      // Probe that streaming dispatch is honored when declared.
    },
  },
  requiredFlags: ["shellExecution.unsafe_enabled"],
};

const tests = RuntimeCapabilitiesConformance.buildTests(fixture);
for (const t of tests) it(`[${t.category}] ${t.name}`, t.run);
```

The suite generates 6 schema tests (3-state manifest validation
across all 5 substrate slots, AgentConnector `manifest_unsupported`
correctness, etc.) + one test per supplied probe + one coverage
test that fails if any `requiredFlags` entry has no probe (the
load-bearing close).

### 3. `unknown-llm-arg` + `unknown-data-read-arg` — sibling kwarg lints

Tier-2 warnings sibling to v0.16.4's `unknown-llm-model`. Catch
provider-API kwargs leaking through the bridge — e.g.
`$ llm prompt="..." temperature=0.7` silently dropped by
`LocalModelMcpConnector` because `LocalModel.run()` only consumes
`{maxTokens, model}`. Closed kwarg surfaces:

- `$ llm`: `prompt` / `maxTokens` / `model` / `timeout` / `approved` / `fallback`
- `$ data_read`: `mode` / `query` / `limit` / `connector` / `fallback` / `domain_tags` / `filters` / `min_confidence`

Same per-rule structure as `unknown-llm-model`: silent without
context, dedupe by `target:kwarg`, off-target ops skipped via the
first-token / `op.mcpConnector` discrimination from v0.16.4.

### 4. Docs — playbook §Case 2 + onboarding-scaffold + McpConnectorTemplate

- `docs/adopter-playbook.md` §Case 2 path (b) now points at the
  bundled `HttpMcpConnector` as the default for Streamable HTTP MCP
  servers; path (c) covers the forked-template case for adopters who
  need behavior the bundled connector doesn't expose.
- `examples/onboarding-scaffold/connectors.json` includes an
  `_example_http_mcp` alongside the existing `_example_remote_mcp`,
  showing both shapes.
- `examples/connectors/McpConnectorTemplate/README.md` rewrites the
  bundled-impls table to lead with `HttpMcpConnector` + drops the
  "near-term roadmap" disclaimer.

### Internal

- `src/connectors/http-mcp.ts` — new class + `fromConfig` factory.
  Registered in `KNOWN_CONNECTOR_CLASSES`. Re-exported from package
  root + `/connectors` subpath.
- `src/testing/conformance.ts` — `RuntimeCapabilitiesConformance`
  suite + types. Re-exported from `/testing`.
- `src/lint.ts` — `UNKNOWN_LLM_ARG` + `UNKNOWN_DATA_READ_ARG` rules
  + closed-surface constants. Registered in `RULES` tier-2 alongside
  v0.16.4's `UNKNOWN_LLM_MODEL`.
- +19 tests in `tests/v0.16.5-http-mcp.test.ts` (real local HTTP
  server, exercises full session-handshake + SSE-parsing flow).
- +10 tests in `tests/v0.16.5-runtime-capabilities-conformance.test.ts`
  (validates the conformance suite itself against bundled bootstrap).
- +11 tests in `tests/v0.16.5-sibling-kwarg-lints.test.ts`.
- 1484 tests passing (was 1444 at v0.16.4 — 40 new total this ring).

### Process notes

**Resolved-thread blind spot.** v0.16.4 underdelivered against Perry's
`934fc9d8` sign-off because that thread was resolved + sibling to the
v0.16.3 ring I was working on — never appeared in my pending-response
mailbox sweep. Banked the refinement to the cold-pickup checkpoint
discipline: query resolved threads addressed to self in the recent
past, scan for forward-looking commitments still owed.

**Discipline-only-contracts class count.** 12 instances closed since
`d0fb1375`. v0.16 series alone: 7 (canonicalization /
trust-boundary / parity / bridge-routing / manifest-exposure /
unknown-llm-model / this ring's three closures: HttpMcpConnector
making the "fork or rebuild" gap structural, RuntimeCapabilitiesConformance
making the multi-layer-promise pattern lockstep, sibling kwarg lints
closing the documented-but-unenforced kwarg surface).

## 0.16.4 — 2026-06-02 — `unknown-llm-model` lint (substrate-aware typo-catch)

**Lint addition.** Closes the documented-but-unenforced surface from
v0.16.2's `model=` routing: a typo like `$ llm prompt="..." model="qwen2.5"`
(intending the upstream Ollama tag `qwen2.5:7b` or the runtime alias
`qwen`) would either error at dispatch or silently fall through to the
default model — neither visible at compile time. Lint warning now fires
at parse time.

**Substrate-aware via v0.16.3 manifest exposure.** With each registered
LocalModel's `manifest()` now folded into `runtime_capabilities`, the
lint has two sources of truth to validate against:

1. **Registry alias names** (`registry.listLocalModels().map(e => e.name)`) —
   what skills typically reference (`model="qwen"`).
2. **Underlying `models_available`** (union of each LocalModel's
   `manifest().manifest.models_available`) — what the substrate exposes
   as serveable. Authors writing the underlying tag directly
   (`model="qwen2.5:7b"`) lint clean because the manifest reports it as
   available.

A model string matching either source passes. A complete typo
(`model="qwen2.5"`, neither an alias nor in any substrate's
`models_available`) fires the warning with a remediation pointing at
`runtime_capabilities()`.

### Behavior matrix

| `model=` value | Result |
|---|---|
| Registered alias (`"qwen"`) | Silent |
| Any registered LocalModel's `models_available` entry (`"qwen2.5:7b"`) | Silent |
| Variable substitution (`"${MODEL_TAG}"`) | Silent (runtime-resolved) |
| Typo / unknown literal (`"qwen2.5"`) | Warning |
| No registry supplied to `lint()` | Silent (caller doesn't know what's wired) |

### Graceful degradation

- **Throwing `manifest()`** — per-instance try/catch in the helper;
  silently degrades that instance to alias-only validation rather than
  failing the lint. Substrate unreachability at lint time doesn't gate
  parse-time validation.
- **No `models_available` in manifest** — the contract permits absence;
  alias-name check still fires.
- **`lintSync()` path** — async manifest probe isn't available; the lint
  uses alias names only. Authors writing the underlying tag under
  `lintSync()` (e.g., `model="qwen2.5:7b"` against alias `"qwen"`) will
  see the warning unless they pass `localModelsAvailable` explicitly.

### Internal

- `src/lint.ts`: `UNKNOWN_LLM_MODEL` rule (tier-2 warning) +
  `collectLocalModelInfoFromRegistry` (async, manifest-probing) +
  `collectLocalModelAliasesFromRegistry` (sync, alias-only).
  `localModelAliases` / `localModelsAvailable` added to `LintOptions`
  and `LintContext`. Bare-form `$ llm` op detection via first-token
  match on `op.body` (parser puts the connector name there for bare
  dispatch; named-form `$ llm.run` would set `op.mcpConnector`
  separately, and the rule handles both shapes).
- `tests/v0.16.4-unknown-llm-model.test.ts`: 10 tests covering the
  matrix above + dedup, off-target rule scoping, and manifest-throw
  graceful degradation. Three-test discipline applied via the existing
  `tests/local-model-mcp-model-routing.test.ts` (runtime layer) and
  `tests/v0.16.3-manifest-exposure.test.ts` (e2e layer); this file is
  the lint layer of the per-dispatch-shape coverage.
- 1444 tests passing (was 1434 at v0.16.3).

### Counting

11th instance of the discipline-only-contracts class closed since
`d0fb1375`. The pattern continues — naming a kwarg surface in vocabulary
(here: `model=` documented in v0.16.2 release notes) without lint
enforcement is itself a discipline-only contract; this ring mechanically
closes it.

## 0.16.3 — 2026-06-02 — Substrate-general manifest exposure on `runtime_capabilities`

**Discovery surface fix.** Closes the structural-half of v0.16.2's P0 (the
routing fix shipped without the discovery half: `runtime_capabilities`
returned byte-identical entries for distinct LocalModel instances, so
adopters had no way to inspect which underlying model each alias was
bound to). Empirically scoped via warm-adopter audit: the discovery-
opacity pattern was uniform across **every** substrate slot, not just
LocalModel. SkillStore/DataStore/LocalModel/McpConnector all exposed only
their static capabilities; the dynamic `manifest()` payload — endpoint,
default_model, supported_filters, root_dir, tools_available, etc. — was
unreadable from `runtime_capabilities`.

**Fix:** `runtime_capabilities` now folds each registered connector
instance's `manifest()` payload into its entry, alongside the existing
`features` field. One structural fix, applied uniformly across all
slots.

**Three observable states per entry:**

1. **Working** — `manifest: {capabilities_version, manifest:{...}}`
   probed via `instance.manifest()`.
2. **Runtime failure** — `manifest: null, manifest_error: "<message>"`
   when `instance.manifest()` throws (substrate unreachable, parse
   error, etc.). Distinct from #3 so dashboards can differentiate
   "instance broken, ping operator" from "by design".
3. **Structural absence** — `manifest: null, manifest_unsupported: true`
   for AgentConnector entries. The v0.9.6 audit excluded `manifest()`
   from the `AgentConnector` contract; the type system enforces this
   (`ManifestInfo` is `Exclude<ConnectorType, "agent_connector">`).
   Separate sentinel preserves the structural-absence vs. runtime-
   failure distinction.

**Bridge wraps convention rides through.** The bundled bridge connectors
(`LocalModelMcpConnector`, `DataStoreMcpConnector`, `SkillStoreMcpConnector`)
already implement a `manifest().wraps` convention that re-exposes the
underlying substrate's full manifest. Capabilities now reads this — a
bridge entry's `manifest.manifest.wraps` carries the full inner-substrate
manifest. Adopters writing custom bridges get this automatically by
returning `{kind, wraps: await innerSubstrate.manifest()}` from their
`manifest()`.

### Why this scope vs. a LocalModel-only patch

The warm-adopter audit (`bfd776a9`) ran the manifest-vs-capabilities
diff across all four supported substrate slots and found the same
discovery-opacity pattern in every one. Patching LocalModel only would
have left three substrate slots opaque + introduced a "fix-one-then-
retrofit-three" pattern. The structural fix closes all of them in one
pass.

### Internal

- `describeEntry` in `src/mcp-server.ts:885` becomes async + probes
  `instance.manifest()` per entry with try/catch error handling. Five
  call sites in `runtimeCapabilities()` lines 837-857 awaited.
- `manifest`/`manifest_error`/`manifest_unsupported` typed in new
  `DescribeEntryResult` return shape; AgentConnector entries get the
  `manifest_unsupported:true` sentinel via the runtime check on
  `entry.instance.manifest` not being a function (the type system
  already enforces the absence on `AgentConnector`).
- `src/index.ts` re-exports bridge classes (`LocalModelMcpConnector`,
  `DataStoreMcpConnector`, `SkillStoreMcpConnector`) from root so the
  `examples/custom-bootstrap.example.ts` reference comment resolves
  without a sub-path import. Adopter-facing first-touch carry-over from
  `e152851e`.
- `examples/onboarding-scaffold/bootstrap.ts` + `examples/custom-bootstrap.example.ts`
  thread `Registry` into the `LocalModelMcpConnector` constructor +
  comment-document the registry-alias resolution.
- +8 tests in `tests/v0.16.3-manifest-exposure.test.ts` covering all
  three states across every substrate slot. 1434 tests passing
  (was 1426 at v0.16.2).

### Counting

This is the 10th instance of the discipline-only-contracts class closed
since `d0fb1375`. v0.16 series total: 5 closures
(canonicalization / trust-boundary / parity / bridge-routing / manifest-exposure).

### Process note — checkpoint-before-code

This ring validated the cold-pickup checkpoint discipline. Prior session
ran out of context with v0.16.3 scoped but uncoded; this session
reconstructed the plan from durable banks + filed it back for sign-off
before any code. Surfaced two contract details that would otherwise have
shipped wrong-shape: (a) AgentConnector has no `manifest()` per v0.9.6,
which invalidated the original "include 5 slots for symmetry" sign-off
assumption; (b) field-shape decision (separate `manifest_unsupported`
sentinel vs. unified `manifest_error`) needed an explicit choice for
dashboard consumers. Banked as a feedback memory; pattern continues to
earn its keep.

## 0.16.2 — 2026-06-02 — P0 fix: `$ llm model=X` registry-alias resolution

**P0 bug fix.** v0.16.1 documented `$ llm prompt="..." model="X"` as the
way to dispatch to a non-default LocalModel, but the bridge silently
ignored `model=` and routed every call to the default LocalModel
regardless of value. Empirically caught by the warm-adopter dogfood —
`/api/ps` showed gemma2:9b handling a request explicitly marked
`model="qwen"`. Worst case is dangerous in combination with a
fast-fragile default model: production skills that explicitly chose a
larger/slower model for accuracy silently downgrade to the default with
no error.

**Root cause:** `LocalModelMcpConnector` constructor took one
`LocalModel` instance reference (the default), then forwarded
`opts.model` to that single instance's `.run()` — the LocalModel
backend (Ollama in the bundled case) interpreted `model=` as its own
upstream model tag, not as a skillscript-registered alias. Bridge had
no Registry handle, so it couldn't dispatch to a different registered
LocalModel.

**Fix:** thread `Registry` through the bridge constructor as an optional
second argument. When the Registry is available, `model=X` resolves to
`registry.getLocalModel(X)` and dispatch goes through THAT instance
(with `model=` NOT forwarded — the resolved LocalModel is the target,
not a hint). Fallthrough when X doesn't resolve: pass `model=X` as an
upstream hint to the default LocalModel's `.run()` (back-compat for
Ollama-tag-style usage). Bootstrap now threads the Registry into the
default bridge construction.

**Three-test discipline applied** per the warm-adopter framing:
- Runtime test: `$ llm model="qwen"` against a registered `qwen`
  LocalModel dispatches to qwen, not default.
- E2E test: model-distinguishing observable (each test LocalModel
  returns its own identity in the response) confirms which instance
  handled the request.
- Lint coverage (`unknown-llm-model`) deferred to v0.16.3 alongside the
  rest of the typed-contract kwarg lints — model-name typos vs.
  routing correctness are independent failure modes.

### Internal

- `LocalModelMcpConnector` constructor: second `Registry?` arg
  (optional for back-compat — existing test fixtures and adopter forks
  constructing with one arg continue working unchanged).
- `bootstrap.ts:207` threads `registry` into the auto-wired `llm`
  bridge.
- +6 runtime tests in `tests/local-model-mcp-model-routing.test.ts`
  covering: alias resolution, default fallthrough, no-forward when
  resolved, fallthrough as upstream hint on unresolved name, back-compat
  no-registry path, kwarg pass-through with `maxTokens`.
- 1426 tests passing (was 1420 at v0.16.1).

### Counting

This is the 9th instance of the discipline-only-contracts class closed
since `d0fb1375`. Pattern continues — the documented `model=` surface
was named in vocabulary but unenforced in code. The runtime mismatch
surfaced empirically through Perry's warm-adopter probe.

## 0.16.1 — 2026-06-02 — Trust-boundary discipline + parser hardening

Theme: closes the 7-finding code-smell audit banked in v0.16.0's §32
charter. Each finding is now structurally enforced — boundaries that
were named in vocabulary now have guards that exercise the actual
attack shapes. Plus housekeeping carried over from v0.16.0: timeless
adopter-facing docs, envelope-empty fallback semantics clarification
(per Perry's adopter dogfood finding `a214ef51`).

### Trust-boundary discipline (audit findings #1–#5)

- **`safePathJoin` helper** + `InvalidPathError` class. `trace.ts`
  write/get/query/`_traceFilePathFor` now route through path-validated
  joins. Closes #1 (`traceId` path-traversal via
  `skill_metadata({name: ".."})` MCP arg) + #2 (`sanitize()` whitelist
  left `.`/`..` intact). The old `sanitize()` function is gone.
- **`RemoteMcpConnector.manifest()` redaction.** Returns
  `args_count` + `args_redacted: true` instead of the literal `args`
  array. Closes #3 — secrets substituted into args at wire-time no
  longer leak through `runtime_capabilities` to MCP callers.
- **Broader `credential-in-args` lint.** Walks all op kinds (not just
  `$`), scans `# Vars:` defaults, recognizes `:`-separated key shape
  (`Authorization: Bearer ...`), recognizes value-shape patterns
  (Bearer 20+/`sk-`/`ghp_`/JWT triple). Demoted to tier-2 (warning) —
  broader patterns trade fewer false negatives for some false positives.
  Closes #4.
- **New `unsafe-shell-unescaped-subst` tier-2 lint.** Fires when an
  `unsafe=true` shell body interpolates a declared variable without the
  `|shell` escape filter. Sibling to existing `unsafe-shell-ambiguous-subst`
  (which catches the opposite case: undeclared refs colliding with bash
  command-sub syntax). Closes #5.

### Parser hardening (audit findings #6–#7)

- **`$set` malformed explicit parse errors.** No-`=`, dotted target,
  numeric-leading-ident, and bare-`$set` shapes each get a distinct
  diagnostic instead of silent-drop. Closes #6 — adopters see the
  cause directly instead of downstream `undeclared-var` blaming the
  symptom.
- **Parser resource caps.** `MAX_CONDITION_LENGTH = 4096` +
  `MAX_CONDITION_DEPTH = 64`. Length cap upstream of REF_PATTERN
  regex application closes the practical ReDoS vector with smaller
  risk than a regex rewrite (REF_PATTERN refactor deferred). Depth cap
  bounds recursion in `validateCompoundCondition` against
  stack-overflow on deeply-chained `AND`/`OR`. Closes #7. Parser
  returns cleanly on adversarial input rather than throwing — preserves
  the "never throws" contract under resource pressure.

### Envelope-empty fallback clarification (Perry's adopter finding)

Per `a214ef51`: `$ data_read mode="..." query="..." -> R (fallback: "...")`
binds `R` to `{items: []}` on empty matches; fallback does NOT fire
because the envelope object is non-empty. Strict reading of the v0.16.0
parity-fix contract is consistent ("fires on empty bound value"), but
the UX surprise was real. Doc clarification lands in `help()` ops
topic: "The fallback fires on dispatch throw OR empty bound value...
An envelope object like `{items: []}` is a non-empty object even when
the contained array is empty, so the fallback does NOT fire. To handle
envelope-empty downstream, either test the contained collection
(`if ${R.items|length} == "0":`) or apply a filter
(`${R.items|fallback:[]}`)." Part 2 (envelope-shape-fallback lint
advisory) deferred — needs typed-contract return-shape registry that
doesn't exist yet, and the existing `object-iteration-advisory` already
catches the related foreach-on-envelope shape.

### Timeless adopter-facing docs

- `help()` content swept of all `v0.X.Y` version references (was 66
  occurrences, now 0).
- Onboarding-scaffold examples (`openai-local-model.ts`,
  `tmux-shell-agent-connector.ts`, `file-data-store.ts`, `bootstrap.ts`,
  `custom-bootstrap.example.ts`, `examples/README.md`) swept of stale
  version-stamped commentary.
- Adopter-facing connector templates (`McpConnectorTemplate.ts`,
  `SkillStoreTemplate.ts`) swept.

Help content + adopter templates now describe what IS, not version
history — per `feedback_playbook_is_timeless`. The full language-guide
re-render (atom `50fcecc8`) is the v0.16.2 followup.

### Internal

- +6 new test files, +84 new tests (was 1336 at v0.16.0 baseline, now
  1420). Coverage of: path-traversal boundary, manifest redaction,
  broader credential patterns, unsafe-shell-unescaped-subst, $set
  malformed shapes, parser resource caps under adversarial input.
- Narrow core LOC 9423/9900 (+87 from v0.16.0).
- All 7 audit findings closed → §32 charter v0.16.3 + v0.16.4 work
  pulled forward into this ring.
- Filed forward to v0.16.2: HttpMcpConnector (bundled, generic) +
  language-guide regen + typed-contract kwarg lints
  (`unknown-llm-model` / `unknown-llm-arg` / `unknown-data-read-arg`
  per memory `9254a648`) + `runtime_capabilities` contract-test
  fixture (Perry's `adf47c0b`).

## 0.16.0 — 2026-06-02 — Language-surface canonicalization

Theme: structural discipline applied to source-level dispatch surfaces. Two
classes of dual-surface ambiguity collapsed simultaneously so downstream
audit + maintenance work has a single canonical surface to reason about.

### Breaking changes (pre-adoption window — no external adopters)

**Sub-charter A: bare-form / named-form discipline for MCP dispatch.** Bare
`$ <tool>` no longer falls back to the `primary` connector. Bare form is
reserved for runtime intrinsics (`execute_skill`, `json_parse`) and the
typed-contract name-match pattern (`$ <name>` where `<name>` matches a
wired MCP connector, e.g. `$ llm prompt=...` against the `llm` bridge).
Substrate-specific MCP dispatch now requires named form `$ <connector>.<tool>`.

This closes the silent-failure mode where cron-fired skills using bare-form
substrate-specific tools (`$ amp_olsen_task`, `$ github_create_issue`)
errored at dispatch time because `primary` wasn't registered — no transcript,
no fallback, just a missing-connector error. With v0.16.0, the lint surface
and runtime error both direct adopters to named form with explicit
remediation copy.

**Sub-charter B: legacy symbol-form ops eliminated.** The six legacy symbol
forms (`~`, `>`, `@`, `!`, `??`, `&`) now produce parse errors with
canonical-form remediation. Only the function-call canonical surface
survives at source level. AST kinds renamed in lockstep
(`!`→`emit`, `@`→`shell`, `&`→`inline`); the legacy
`~`/`>` AST kinds + their dedicated runtime paths deleted entirely (the
canonical replacements `$ llm` and `$ data_read` dispatch through the
LocalModelMcpConnector + DataStoreMcpConnector bridges).

**Sub-charter C: `ask` runtime-intrinsic removed.** `ask(prompt="...")` was
removed entirely (not renamed). The op conflated two unrelated concerns:
(1) user-surfacing, which requires an interactive channel the runtime
can't guarantee for cron/event-fired skills, and (2) mutation-gating,
which is already covered by per-op `approved="reason"` kwarg +
skill-level `# Autonomous: true`. The mutation-gate "preceding `ask`
authorizes following mutations" rule (`sawConfirm` path) is retired —
authorization now flows only through `approved=` and `# Autonomous:`.
For input-collection workflows, use `emit(text="...")` and have the
caller handle the round-trip. `InteractiveOpInAutonomousModeError` class
deleted (now unreachable).

The `deprecated-symbol-op` lint rule, the `unknown-retrieval-arg` lint rule,
the `model-contention` lint rule, and the `sourceForm` AST marker were
deleted as part of this collapse — all served the grace-period machinery
that no longer applies.

### Parity fix: `$` dispatch closes the discipline-only-contract gap

While analyzing the legacy elimination, we surfaced that the canonical
`$ llm` and `$ data_read` dispatch paths had been declared as parity
replacements for legacy `~` and `>` but lacked two semantics the legacy
forms supported:

- **Per-op `timeout=N` kwarg** — legacy `~` accepted `timeoutSeconds=N`
  in its structured-params bag; the generic `$` dispatch had no equivalent.
  v0.16.0 adds `timeout=N` as a reserved op-level kwarg on every `$` op
  (intercepted at runtime before forwarding to the connector).

- **Fallback-on-empty** — the doc at `parser.ts:84-91` claimed `$` fallback
  fires "on throw or empty result", matching legacy `~`/`>` semantics, but
  the code only handled throw. v0.16.0 fixes the code to match the doc:
  fallback fires on empty string (after trim), empty array, or
  `null`/`undefined` result in addition to throw.

These were latent gaps since v0.7.2. Adopters who migrated from `~`/`>` to
`$ llm`/`$ data_read` lost per-op timeout + empty-result fallback silently —
v0.16.0 makes the canonical surface match the documented contract.

### Migration mapping (mechanical)

| Legacy (parse error) | Canonical |
|---|---|
| `! text` | `emit(text="text")` |
| `?? "prompt" -> R` | (removed — `ask` op deleted; use `emit(text="...")` + caller round-trip, or `approved="reason"` for mutation gating) |
| `@ cmd args` | `shell(command="cmd args")` |
| `@ unsafe cmd` | `shell(command="cmd", unsafe=true)` |
| `& skill-name` | `inline(skill="skill-name")` |
| `~ prompt="..." -> R` | `$ llm prompt="..." -> R` |
| `> mode=... query=... -> R` | `$ data_read mode=... query=... -> R` |
| Bare `$ <substrate_tool>` | `$ <connector>.<substrate_tool>` |

### Bundled examples + docs updated

`hello-world.skill.md`, `skill-store-roundtrip.skill.md`, and
`data-store-roundtrip.skill.md` use canonical function-call syntax
throughout. Help content + lint code references swept for legacy-form
mentions.

### Internal

- ~550 LOC removed from narrow core (parser + lint + runtime shrink)
- `OpKind` type union narrows from 14 to 11 (delete `~`, `>`, `ask`; rename three)
- `SkillOp` interface drops `localModelParams`, `retrievalParams`,
  `sourceForm` fields
- `RUNTIME_INTRINSIC_FN_NAMES` shrinks to 7 (delete `ask`)
- `MutationAuthState.sawConfirm` field removed; mutation gate now relies
  solely on `op.approved` + `skillAutonomous`
- `InteractiveOpInAutonomousModeError` class deleted
- LocalModelMcpConnector bridge auto-wired as `llm` connector unchanged

## 0.15.7 — 2026-06-01 — `|json` filter idempotent on already-JSON strings

One-rule fix in `src/filters.ts`. Phase 6 cold-adopter finding surfaced
that `|json` double-encodes structured values: a skill body like
`emit(text="result: ${R|json}")` where `R` is bound from a `$ amp.<tool>`
dispatch produced `"\"{\\\"id\\\":\\\"abc\\\"}\""` (escaped twice)
instead of `'{"id":"abc"}'` (cleanly serialized once).

Root cause is structural. `applyFilter(value: string, filter: string)`
receives all values as strings — `substituteRuntime` serializes
structured JS values upstream of the filter chain. So `|json` was
operating on a string that was already a valid JSON representation,
and `JSON.stringify` re-quoted it.

### Fix

`|json` now tries `JSON.parse` first. If the input parses cleanly,
pass through (already valid JSON). If parse throws, stringify once
(preserves the v0.3.x behavior for plain-string inputs).

```ts
case "json":
  try { JSON.parse(value); return value; }
  catch { return JSON.stringify(value); }
```

### Behavior matrix

| Input | v0.15.6 → | v0.15.7 → |
|---|---|---|
| `'{"id":"abc"}'` (already JSON) | `'"{\\"id\\":\\"abc\\"}"'` (double-encoded) | `'{"id":"abc"}'` (pass through) |
| `'[1,2,3]'` (already JSON array) | re-encoded | pass through |
| `'hello world'` (plain string) | `'"hello world"'` | `'"hello world"'` (unchanged) |
| `'he said "hi"'` (needs escaping) | `'"he said \\"hi\\""'` | `'"he said \\"hi\\""'` (unchanged) |
| `'null'` / `'true'` / `'42'` (scalar JSON literals) | `'"null"'` / `'"true"'` / `'"42"'` (re-quoted) | `'null'` / `'true'` / `'42'` (pass through) |

The common case — `${OBJ|json}` after `$ <tool> -> OBJ` — is fixed. The
edge case where an author literally wanted to JSON-encode the string
`"null"` (producing `"\"null\""`) hits a behavior change; documented
here but probably never the actual intent.

### Tests

`tests/v0.15.7-json-filter-idempotent.test.ts` — 18 cases covering the
matrix: structured-pre-stringified inputs (object/array/nested/empty/
escaped-quotes), plain-string inputs (simple/multi-word/internal-quotes/
newlines/empty), scalar JSON literals (null/true/false/numerics/quoted),
and regression cases ensuring non-JSON-shape strings still stringify.

### Phase 6 finding history

The originally-reported "read vs write asymmetry" was retracted by the
warm adopter after deeper investigation — root cause was test
contamination plus this `|json` double-encoding artifact, not actual
asymmetric binding in the connector or runtime layers. The
`HttpMcpConnector` path is clean: read and write tool results both
bind as structured objects per `unwrapToolResult` (runtime.ts:1617);
`$ amp.<tool> -> R` then `${R.field}` is the canonical pattern.

This finding validates that the v0.16.0 bundled `HttpMcpConnector`
doesn't need response-shape normalization for cross-tool-type
symmetry — the wire layer already handles MCP responses uniformly. The
v0.16 charter scope shrinks slightly; the structural-discipline framing
stays the same (HttpMcpConnector + `runtime_capabilities` contract-test
fixture).

### Files changed

- `src/filters.ts` — `|json` case rewritten with try-parse-first.
- `tests/v0.15.7-json-filter-idempotent.test.ts` (NEW) — 18 cases.
- `package.json` — version 0.15.6 → 0.15.7.
- `tests/dogfood-t7.test.ts` — version assertion.
- `CHANGELOG.md` — this entry.

## 0.15.6 — 2026-06-01 — Pre-v0.16 doc prep: MCP-over-HTTP transport articulation

Doc-only patch preparing the ground for v0.16's bundled `HttpMcpConnector`
class. No code change; three documentation surfaces updated to acknowledge
MCP-over-HTTP (Streamable HTTP + SSE) as a first-class transport option
alongside the stdio path that `RemoteMcpConnector` covers today.

Per Perry sign-off on the v0.16.0 charter (thread `0b35bd70`): two-stage
ship is right — doc fix has value today, don't fold into v0.16.0.

### `docs/adopter-playbook.md` §Case 2

Pre-v0.15.6, the section implied `RemoteMcpConnector` (stdio) was THE
MCP path. Rewritten to articulate transport as a separate concern from
the wire protocol: stdio (`RemoteMcpConnector` for community servers
like YouTrack, GitHub, Linear) vs. HTTP (Anthropic's hosted MCP, AMP,
spec-compliant HTTP servers). For HTTP, two sub-paths with their
tradeoffs: stdio-bridge via `mcp-remote --sse` (works today, adds
subprocess) vs. direct HTTP connector class (lower overhead, requires
implementation).

### `examples/onboarding-scaffold/connectors.json`

New comment on the `_example_remote_mcp` entry: explicitly notes that
the same `mcp-remote --sse` pattern bridges Streamable HTTP MCP servers
(Anthropic hosted MCP, AMP, etc.) — discoverability fix so adopters
scanning the example see the wider applicability.

### `examples/connectors/McpConnectorTemplate/README.md`

Updated "Fork this template only when none of those fit" list:
- Direct HTTP MCP retained as a forkable case for now, with a forward
  note that a bundled `HttpMcpConnector` is on the near-term roadmap
  (timeless framing — readers on the version that ships HttpMcpConnector
  will see it bundled; readers pre-that-version see the fork path)
- Added explicit guidance for HTTP MCP servers: stdio-bridge path is
  the simplest today; check for bundled `HttpMcpConnector` before
  forking

### Phase 4 dogfood reframing (banked as project memory)

Bundling `HttpMcpConnector` in v0.16.0 collapses the Phase 4 cold-adopter
dogfood from implementation-validation (fork template + implement
HTTP-MCP from scratch) to configuration-validation (declare an instance
in `connectors.json` pointing at the endpoint). Still worth doing as a
matrix-validation lane — AmpSkillStore + AmpDataStore + bundled
HttpMcpConnector configured against AMP + skills exercising the full
toolbox, end-to-end — but cheaper. Banked as
`project_phase4_dogfood_reframe` for future phase planning.

Perry's structural framing: v0.16 charter = "structural discipline" —
`HttpMcpConnector` + the `runtime_capabilities` contract-test fixture
(from thread `adf47c0b`) both prevent the discipline-only-contracts
class. Defer language features to v0.17. Tight charter, clean narrative.

### Files changed

- `docs/adopter-playbook.md` — §Case 2 rewritten with the two-path HTTP
  MCP framing.
- `examples/onboarding-scaffold/connectors.json` — new comment on HTTP
  MCP transport applicability.
- `examples/connectors/McpConnectorTemplate/README.md` — updated fork-
  this-template guidance; HTTP MCP retains the forkable case with the
  forward note about bundled HttpMcpConnector.
- `package.json` — version 0.15.5 → 0.15.6.
- `tests/dogfood-t7.test.ts` — version assertion.
- `CHANGELOG.md` — this entry.

### Next

v0.16.0 — `HttpMcpConnector` (bundled, substrate-neutral) +
`runtime_capabilities` contract-test fixture. Source material for the
connector: Phase 2 cold-adopter dogfood's wire-layer code, generalized.

## 0.15.5 — 2026-06-01 — Phase 4 typed-contract gaps + two Phase 3 carry-overs

Three Phase-4 findings + one substrate-side bug uncovered along the way,
plus two Phase-3-era findings Perry surfaced after the v0.15.4 ship.
None are runtime correctness bugs in the Phase 4 set — the warm adopter
completed Phase 4 with full conformance and all probes green. The two
carry-overs ARE bugs (one runtime, one DX). Bundling them avoids a
release cycle.

The Phase 4 attribution skews substrate-ward — typed contract held, the
documented `bootstrap({dataStore})` path worked, conformance passed
unmodified. Phase 4 mostly stress-tested where the contract is silent
rather than where it's wrong; v0.15.5 fills the silences. The Phase 3
carry-overs are the discipline-only-contract pattern recurring (5th
instance of that class — see `enableUnsafeShell` below).

### `DataWrite.expires_at: number | null` — portable durable-forever opt-in

Pre-v0.15.5, `DataWrite.expires_at: number` forced every write to specify
a timestamp. Substrates with default TTL (AMP memory vaults, Redis with
default expiry, hosted memory APIs) had no portable contract verb to
express "durable forever" — each adopter had to invent a substrate-
specific durability path. The warm adopter papered over it via AMP's
`decay_model: "none"` + `pinned: true` flags inside their AmpDataStore,
but that's AMP-specific knowledge that doesn't transfer.

Type is now `number | null`:
- Unix timestamp → finite expiry (substrate-specific honor / sweep)
- `null` → "durable forever" — substrates with default sweep map this to
  their pin / no-decay flag; substrates that are already durable-by-default
  (the bundled `SqliteDataStore`) treat it as a no-op.
- Omitted → defer to the substrate's default lifecycle policy.

Back-compat preserved: existing skill bodies that set numeric timestamps
or omit the field continue to work unchanged. The `null` opt-in is new.

### `data-store-roundtrip` softens to `N ≥ 1` (substrate-portable across FTS variance)

The v0.15.3 + v0.15.4 demo's description asserted "read back 1 items"
based on an FTS query against a per-run unique marker embedded in
content. Worked for `SqliteDataStore`'s strict FTS; broke for AMP's
token-OR FTS where the marker's tokens (`probe`, year, month, etc.)
matched prior runs' records too. The contract is silent on FTS matching
strictness — both substrate behaviors are conformant — so the demo's
exact-count claim baked in a hidden capability assumption.

Fix: the demo body keeps the v0.15.3 shape (marker in content + FTS
query) but the **assertion softens** to `N ≥ 1 items returned`. Works
across any FTS-supporting substrate without imposing a hidden strictness
requirement. The portable strict-count pattern (`domain_tags=[...]`
filter) is documented in the playbook for adopters who need deterministic
exact-count reads — but not required by the bundled smoke test.

The demo body re-stamped (`v1:fb106073`); scaffold/skills copy synced.
Description rewritten to make the FTS-variance reality explicit and
point to the playbook's strict-count pattern.

Per Perry's `cf5ad0d7` thread: "the substrate-portability claim is
better served by demos that work uniformly than by demos that demand a
specific FTS semantic that varies across implementations." Bundled demos
are install-validation; the canonical pattern guides live in docs.

### `SqliteDataStore.query()` honors `domain_tags: string[]` (was silently dropped)

While fixing the demo, surfaced a real substrate-side bug. The bundled
`SqliteDataStore.query()` only handled `domain_tags` when the filter
value was a single string; passing an array silently dropped the filter
and returned unfiltered results. The contract docs
(`DataStoreTemplate/README.md`) document arrays as "any-of (OR) match" —
discipline-only-contract that bit the demo and would have bitten any
adopter passing arrays.

Fix: `domain_tags` accepts both shapes now:
- `domain_tags: "tag"` — single-tag exact match (existing behavior)
- `domain_tags: ["a", "b", ...]` — any-of (OR) match across the listed tags
- `domain_tags: []` — empty array = no filter applied (avoids the trap
  where a generated empty list silently zeroes results)

Implemented via dynamically-bound `IN ($tag_0, $tag_1, ...)` placeholders
so SQLite-prepared-statement caching stays effective per-arity. 9 new
test cases cover the matrix (string, array, empty-array, single-element-
array, non-matching, FTS+tag combined narrowing).

### Adopter-playbook gains FTS-strictness + durable-forever notes

Two new bullets in the §"Notable things..." section, both timeless:

- "FTS matching strictness varies by substrate" — articulates that the
  contract names the modes but doesn't pin down semantics within each.
  Portable read patterns use `domain_tags` filtering for deterministic
  count assertions; FTS is the mode wrapper with substrate-loose
  semantics.
- "Durable-forever opt-in via `expires_at: null`" — documents the new
  portable verb + the substrate impl responsibility (pin / no-decay map
  on TTL-default substrates; no-op on durable-default substrates).

### Files changed

- `src/connectors/types.ts` — `DataWrite.expires_at: number | null`.
- `src/connectors/data-store.ts` — `expires_at: null` no-op for SqliteDataStore; `domain_tags: string[]` honored via dynamic-IN placeholders.
- `src/mcp-server.ts` — `enableUnsafeShell` threaded into execute_skill ExecuteContext.
- `src/lint.ts` — new `vars-space-separated` tier-2 rule.
- `examples/skillscripts/data-store-roundtrip.skill.md` — description rewritten to soften the count assertion (`N ≥ 1`) and point at the playbook's tag-filter pattern for adopters needing strict counts; body keeps the v0.15.3 marker-in-content FTS-query shape. Re-stamped.
- `scaffold/skills/data-store-roundtrip.skill.md` — synced.
- `tests/v0.15.5-domain-tags-array.test.ts` (NEW) — 9 cases covering substrate fix + new `null` path.
- `tests/v0.15.5-enable-unsafe-shell-ctx.test.ts` (NEW) — 3-case regression for the ctx-threading bug.
- `tests/v0.15.5-vars-space-separated-lint.test.ts` (NEW) — 10 cases covering positive + negative shapes for the lint rule.
- `docs/adopter-playbook.md` — FTS-strictness + durable-forever bullets.
- `package.json` — version 0.15.4 → 0.15.5.
- `tests/dogfood-t7.test.ts` — version assertion.
- `CHANGELOG.md` — this entry.

### Phase 3 carry-over (1): `enableUnsafeShell` threaded into `execute_skill` ctx

Perry's thread `adf47c0b` — runtime bug surfaced by the warm adopter
during Phase 3 weather-skill authoring. `mcp-server.ts` built the
execute_skill `ExecuteContext` with `{registry, mechanical, recursionDepth}`
but never read `enableUnsafeShell` from `McpServerDeps`. Net effect: an
adopter who configured the runtime with `enableUnsafeShell: true` had:

- lint passes ✓
- compile passes ✓
- `runtime_capabilities` reported `unsafeShellEnabled: true` ✓
- but `execute_skill` execution path refused `shell(..., unsafe=true)` ✗

The contract surface declared discipline; the dispatch path didn't honor
it. **5th instance of the discipline-only-contracts class** — sibling to
v0.13.7 `skill_status`, v0.14.0 `strict_filters`, v0.14.x mutation gate,
v0.15.0 `skill_write` declared-but-unwired. One-line ctx fix in
`mcp-server.ts:executeSkill` (now spreads `enableUnsafeShell` when set in
deps), plus a three-case regression test
(`tests/v0.15.5-enable-unsafe-shell-ctx.test.ts`) covering:

- `enableUnsafeShell: true` → `shell(unsafe=true)` via execute_skill succeeds
- `enableUnsafeShell: false` → refuses with `UnsafeShellDisabledError`
- `enableUnsafeShell` unset → refuses (default-false posture preserved)

Per Perry's thread, a v0.16.x structural follow-on is worth considering:
a contract-test fixture that forces every config flag in
`runtime_capabilities` to have a matching execution-path probe test.
Would catch this whole class pre-merge. Filed but not landed here —
v0.15.5 closes the specific surface; the fixture pattern is its own scope.

### Phase 3 carry-over (2): `vars-space-separated` lint

Perry's thread `1b9d83a7` — warm adopter space-separated their
`# Vars:` declarations (`# Vars: A=1 B=2`), parser silently dropped `B`
(parser only splits on commas), downstream `$(B)` references fired
`undeclared-var` pointing at the symptom not the cause. One debugging
cycle wasted to discover the rule.

New tier-2 lint `vars-space-separated`: detects when a var's default
value contains whitespace followed by an `IDENT=` shape (in non-quoted
regions), emits a warning naming the suspect missing comma. Heuristic
respects quote-boundaries — `# Vars: NAME="Bob Jones"` doesn't false-fire
because the whitespace is inside the quoted region.

Ten test cases in `tests/v0.15.5-vars-space-separated-lint.test.ts` cover
the positive cases (`A=1 B=2`, three-space-separated, quoted-whitespace
mixed with comma-separated) and the negative cases (canonical comma form,
quoted internal whitespace, value with space but no follow-on `=`, URL
with `://`, etc.).

### Cold-adopter dogfood arc maturity progression

Phase 1 found bugs in the install path (broken examples, missing exports,
demo non-runnability). Phase 2 found seams in the typed-contract fork
path (conformance namespacing, ESM setup). Phase 3 found friction in
update / repeat-run paths (idempotency, warning suppression). Phase 4
found **silences in the contract itself** (expires_at type didn't have a
durability verb; FTS strictness was undefined). Different class of
finding, different remediation cost. The framework is approaching "what's
missing from the spec" rather than "what's wrong with the spec" —
maturity signal worth banking.

## 0.15.4 — 2026-06-01 — Phase 3 warm-adopter update DX polish

Two findings + a docs cleanup bundled. None are runtime correctness bugs;
both fixes surfaced when the warm adopter (Phase 2 graduate) updated from
v0.15.0 → v0.15.3 to begin Phase 3 (custom DataStore against AMP).

### `skill-store-roundtrip.skill.md` is now idempotent

The `SkillStoreMcpConnector` bridge has carried an overwrite-required guard
since v0.15.0 — `$ skill_write` against an existing skill name throws
`"skill '<name>' already exists. Pass overwrite=true to replace."` unless
the op opts in. The bundled `skill-store-roundtrip` demo never carried
the kwarg, so it worked on first run against an empty store and failed
on every subsequent run. Phase 1 cold agent ran it once; Phase 3 warm
agent rerunning it after upgrade hit the failure mode.

Fix: the demo's `$ skill_write` now carries `overwrite=true`. The body
re-stamped (`v1:f0f5da75`); scaffold/skills copy synced. Three sequential
runs against the bundled FilesystemSkillStore return the same transcript
every time.

This was a "probe-twice" gap on my side at v0.15.0 ship — the demo passed
my one-run probe and the cold-agent one-run probe; neither caught the
non-idempotency. Banked the discipline as feedback memory alongside the
fix.

### SQLite ExperimentalWarning suppression moves to load-site

v0.15.1 filtered the warning at `src/cli.ts` — the CLI entry. Programmatic
adopters running their own bootstrap (every Phase 2+ adopter) never hit
that filter, so the warning re-surfaced on every `tsx amp-bootstrap.ts`.
Phase 3 warm agent re-confirmed it during their update probe.

Fix: new `src/sqlite-warning-suppress.ts` shared helper — idempotent (first
call installs, subsequent calls no-op) and narrow (only the specific
`node:sqlite` ExperimentalWarning is intercepted; all other warnings pass
through to the default handler unchanged). Called from both
`src/connectors/data-store.ts:loadDatabaseSync()` and
`src/connectors/sqlite-skill-store.ts:loadDatabaseSync()` at the actual
`requireNode("node:sqlite")` site, so the suppression fires regardless
of whether the consumer is the CLI or a programmatic bootstrap.

The v0.15.1 CLI-only suppression block is removed — load-site coverage
is strictly broader.

For consumers who want the warning visible (e.g., debugging which node
version's sqlite is loading), `restoreSqliteWarning()` is exported from
the same module — but no default path needs it.

### Adopter-playbook timeless rewrite + Phase 3 prep

While in the patch, bundled a docs sweep flagged during Phase 3 prep:
the playbook had retrospective version-history pollution
("was advisory in v0.14.0; v0.14.1 makes it enforceable", "Pre-v0.14.1...",
"(v0.14.1)" parenthetical markers). Adopter docs describe present state;
CHANGELOG owns history. Two existing bullets rewritten to be timeless,
two new bullets added for DataStore-substrate context (in-skill write
asymmetry between skill_write and data_write trust models; mutation gate
fires upstream of the bridge), and two cross-references added to the
§"Wire your substrates" section for adopters discovering security knobs
(`allowed_tools` allowlist + `enable_unsafe_shell` discipline).

Banked the playbook-is-timeless discipline as a feedback memory so the
pollution pattern doesn't reappear next time someone edits adopter docs.

### Files changed

- `examples/skillscripts/skill-store-roundtrip.skill.md` — `overwrite=true` + re-stamped.
- `scaffold/skills/skill-store-roundtrip.skill.md` — synced with examples/ version.
- `src/sqlite-warning-suppress.ts` (NEW) — shared idempotent helper.
- `src/connectors/data-store.ts` — calls suppressor before `requireNode("node:sqlite")`.
- `src/connectors/sqlite-skill-store.ts` — same.
- `src/cli.ts` — removed the v0.15.1 CLI-only suppression block (now redundant).
- `docs/adopter-playbook.md` — version-pollution rewrites + 2 additions + 2 cross-references.
- `package.json` — version 0.15.3 → 0.15.4.
- `tests/dogfood-t7.test.ts` — version assertion.
- `CHANGELOG.md` — this entry.

### Cold-adopter dogfood arc state

- Phase 1 findings (4): all closed in v0.15.1 + v0.15.2.
- Phase 2 findings (4): all closed in v0.15.3.
- Phase 3 update findings (2): closed in v0.15.4.

Phase 3 (custom DataStore against AMP) starts cleanly against v0.15.4.

## 0.15.3 — 2026-06-01 — Phase 2 cold-adopter DX polish

Four findings surfaced by the Phase 2 cold-adopter dogfood (custom
`AmpSkillStore` fork against the AMP skills vault). None are runtime
correctness bugs — the adopter completed Phase 2 with 20/20 conformance
and all three Phase 1 demos green against their AMP-backed substrate.
These are the DX seams an adopter improvised around to get there.

### `./dashboard` added to package exports

Pre-v0.15.3 the adopter-playbook + `examples/custom-bootstrap.example.ts`
both directed adopters to mount `DashboardServer` on top of the bootstrap
result, but `import "skillscript-runtime/dashboard/server.js"` failed with
`ERR_PACKAGE_PATH_NOT_EXPORTED` — the subpath wasn't in the exports map.
The Phase 2 adopter improvised around it via a deep-path hack
(`./node_modules/skillscript-runtime/dist/dashboard/server.js`); v0.15.3
makes the documented path actually resolve. `package.json` exports gains:

```
"./dashboard": {
  "types": "./dist/dashboard/server.d.ts",
  "import": "./dist/dashboard/server.js"
}
```

Existing deep-path imports continue to work but are no longer required.
dogfood-t7 case #3 updated from "10 public surface entries" → 11.

### `adopter-playbook.md` flags `type: "module"` setup requirement

The package is ESM-only. `npm init -y` (which the Phase 1 canonical
workflow uses) produces a CJS `package.json` by default, which fails the
first custom-bootstrap run with top-level-await / ESM-import errors.
Phase 2 adopter hit this immediately. v0.15.3 adds a one-paragraph flag
to the playbook's setup section directing adopters to run
`npm pkg set type=module` before authoring bootstrap code.

### SkillStoreTemplate + DataStoreTemplate READMEs document conformance
namespacing for shared persistent substrates

The conformance suite's `build()` callback is invoked per fixture, and
the first stateful assertion expects `query()` on an empty store to
return `[]`. For shared persistent substrates (AMP, Postgres, MongoDB —
anything where state survives across `build()` calls), a naive `build()`
that wraps the live store fails immediately because prior fixtures'
state leaks in. The Phase 2 adopter caught this from reading the
assertions directly (not the README), namespaced into a marker-domain-tag
subspace per fixture + wiped before/after, and reached 20/20.

v0.15.3 adds a "Running conformance against a shared persistent
substrate" section to both template READMEs explaining the discipline
explicitly: tag-marker isolation, per-test database/schema, per-test
prefix. The conformance suite can't (and shouldn't) know what isolation
your substrate supports — that's the impl's responsibility.

### `data-store-roundtrip.skill.md` uses per-run marker for deterministic count

Pre-v0.15.3 the demo's transcript implied a fixed "read back 1 items"
count, but accumulated SqliteDataStore state across runs returned >= 1
items as soon as the FTS query matched prior records. The Phase 2 adopter
caught it (their probe showed "read back 2 items" — still a valid
round-trip but misleading transcript).

Fix: bind a per-run marker at runtime via `$set MARKER = "probe-${NOW}"`,
embed it in the written record's content, and FTS-query for the same
marker. The read count is now exactly 1 regardless of prior runs. Three
sequential probes after the fix all return "read back 1 items" — the
demo is now deterministic.

### Files changed

- `package.json` — `./dashboard` exports entry + version 0.15.2 → 0.15.3.
- `docs/adopter-playbook.md` — `type: "module"` setup flag.
- `examples/connectors/SkillStoreTemplate/README.md` — conformance namespacing section.
- `examples/connectors/DataStoreTemplate/README.md` — parallel conformance namespacing section.
- `examples/skillscripts/data-store-roundtrip.skill.md` — per-run marker + re-stamped.
- `scaffold/skills/data-store-roundtrip.skill.md` — synced with examples/ version.
- `tests/dogfood-t7.test.ts` — version assertion + exports map count (10 → 11).
- `CHANGELOG.md` — this entry.

### Cold-adopter dogfood arc state

- Phase 1 findings (4): all closed in v0.15.1 + v0.15.2.
- Phase 2 findings (4): all closed in v0.15.3.

The dogfood has now validated both the canonical install path (Phase 1)
and the custom typed-contract substrate fork path (Phase 2) via a real
adopter walking each end-to-end. Phase 3 (if any) decides between custom
DataStore, custom AgentConnector, or closing the arc.

## 0.15.2 — 2026-06-01 — `execute_skill` kwarg alignment

Closes the fourth and final finding from the v0.15.0 cold-adopter Phase 1
dogfood: `execute_skill` was the only `skill_*` MCP tool taking
`skill_name`; the other four (`skill_read`, `skill_metadata`, `skill_status`,
`skill_write`) all take `name`. The outlier was historical — `execute_skill`
needed `skill_name` to disambiguate from `source` in the inline-execute
mode — but to a cold adopter hand-wiring JSON-RPC, the inconsistency was
a papercut on every call.

Per Perry signoff (thread `75abc8c0`): `name` is canonical going forward;
`skill_name` is a silent back-compat alias. No tier-3 advisory, no
deprecation warn. Three arguments for `name`-canonical:

1. Less drift — 4 of 5 `skill_*` tools already use `name`. Aligning one
   outlier is cheaper than migrating four.
2. The `source` disambiguation argument doesn't generalize — other tools
   don't have a sibling kwarg that could collide.
3. Tool name carries context — `skill_read({name})` is unambiguous because
   the *tool name* says skill; the kwarg need not repeat it.

### Surface changes

- `execute_skill` MCP tool accepts `name` as canonical; `skill_name` is
  accepted as a silent alias. If both are supplied with different values,
  the call is rejected as ambiguous. Matching values pass through.
- `inputSchema` declares both kwargs, with the `skill_name` description
  explicitly flagging it as a back-compat alias.
- `execute_skill(...)` function-call grammar (in-skill, `src/parser.ts`)
  accepts either `name=` or `skill_name=`. Parser-time ambiguity check
  mirrors the MCP-wire path.
- `dispatchExecuteSkillIntercept` (in-skill `$ execute_skill` dispatch,
  `src/composition.ts`) accepts either kwarg.
- Composition-reference lint extractor (`src/lint.ts`) recognizes either
  kwarg form when collecting skill references for the
  `unknown-skill-reference` rule.
- `help-content.ts` canonical-shape headers updated to show `name=` as
  the preferred form; worked examples below stay on `skill_name=` since
  the alias works unchanged and per-example rewrites add no value.

### Scope

Tightly scoped to `skill_*` per Perry's framing. `data_*` and `file_*`
tools have their own naming conventions; if the Phase 2 cold-adopter
dogfood surfaces analogous warts in those families, file separately.
Don't compound scope.

### Tests

`tests/v0.15.2-execute-skill-name-kwarg.test.ts` — 14 new cases covering
MCP-wire dispatch (canonical, alias, identical-result equivalence,
ambiguity rejection, disambiguation preservation, inputSchema shape) +
function-call grammar (canonical works, alias works, conflict rejected
at parse time) + lint extractor (kwarg recognized for both shapes,
unknown-skill-reference fires correctly).

### Files changed

- `src/mcp-server.ts` — `executeSkill` handler + inputSchema.
- `src/parser.ts` — function-call kwarg alias.
- `src/composition.ts` — in-skill `$ execute_skill` dispatch.
- `src/lint.ts` — composition-reference regex extended.
- `src/help-content.ts` — canonical-shape headers updated.
- `tests/v0.15.2-execute-skill-name-kwarg.test.ts` (NEW).
- `tests/dogfood-t7.test.ts` — version assertion.
- `package.json` — version 0.15.1 → 0.15.2.
- `CHANGELOG.md` — this entry.

## 0.15.1 — 2026-06-01 — Phase 1 cold-adopter DX polish

Three small but high-DX fixes surfaced by the cold-adopter Phase 1 dogfood
against shipped v0.15.0. None are runtime correctness bugs — every probe
passed end-to-end. They're UX seams that read as "something's wrong with my
install" to a cold adopter discovering the package for the first time.

### `skillfile init` now seeds the three Phase 1 demos into `skills/`

Pre-v0.15.1, `init` copied only `hello-world.skill.md` and only into
`examples/`. Adopters wanting to dispatch via `execute_skill({name})` had
to manually `cp` from `node_modules/skillscript-runtime/examples/skillscripts/`
into `$SKILLSCRIPT_HOME/skills/`. Now `init` seeds all three Phase 1
demos directly into `skills/`:

- `hello-world.skill.md` — baseline runtime check, no substrate
- `skill-store-roundtrip.skill.md` — Lisp-shape `$ skill_write` demo
- `data-store-roundtrip.skill.md` — `$ data_write` + `$ data_read` round-trip

All three ship pre-stamped (`# Status: Approved v1:<token>`). After
`skillfile init`, `execute_skill({skill_name: "hello-world"})` works
immediately — no manual seeding required.

### `skillfile init` Next: hint points at the canonical MCP/dashboard path

Pre-v0.15.1, `init` printed:

```
Next:
  skillfile run examples/skillscripts/hello-world.skill.md
```

— a file-path execution that bypasses the SkillStore + the v0.9.0 hash-token
approval gate. Cold adopters following the hint ended up evaluating a
different code path than the canonical production flow. Now `init` prints:

```
Next:
  skillfile dashboard --host 0.0.0.0 --port 7878
  # Then dispatch a seeded demo via the MCP wire:
  #   curl -s -X POST http://localhost:7878/rpc \
  #     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute_skill","arguments":{"skill_name":"hello-world"}}}' \
  #     | jq -r '.result.content[0].text' | jq
```

Aligns the hint with the documented production workflow: dashboard launches
the MCP server; in-skill dispatch goes through `execute_skill({skill_name})`.

### `node:sqlite` ExperimentalWarning suppressed at the CLI entry

`(node:XXXX) ExperimentalWarning: SQLite is an experimental feature ...`
fired on every CLI invocation that touched sqlite (dashboard, serve,
execute against substrate-resident skills). To a cold adopter it read as
"something's wrong with my install." `SqliteDataStore` + `SqliteSkillStore`
are intentional substrate choices; the warning was noise, not signal.

Filtered at `process.emitWarning` at the CLI entry point — only the specific
SQLite `ExperimentalWarning` is suppressed; all other warnings pass through
to stderr unchanged. CLI-only — programmatic library consumers see the
warning unchanged so they can choose their own logging discipline.

### Tests

- `tests/cli.test.ts` — two new cases verifying `init`'s post-v0.15.1 shape:
  seeds three demos with valid Approved+token headers; Next: hint matches
  the canonical `dashboard` + `execute_skill` pattern (and the old
  `skillfile run examples/...` shape is regression-guarded against
  reappearance).

### Files changed

- `src/cli.ts` — `cmdInit` seeds three demos into `skills/`; rewrites
  `Next:` hint; adds `process.emitWarning` filter for the SQLite warning.
- `scaffold/skills/{hello-world, skill-store-roundtrip, data-store-roundtrip}.skill.md`
  (NEW) — pre-stamped scaffold payload mirroring `examples/skillscripts/`.
- `scaffold/examples/` (REMOVED) — folded into `scaffold/skills/` since
  init now seeds the runnable location, not the browsable one.
- `tests/cli.test.ts` — two new test cases (init seeds + Next: hint).
- `tests/dogfood-t7.test.ts` — version assertion bumped 0.15.0 → 0.15.1.
- `package.json` — version 0.15.0 → 0.15.1.
- `CHANGELOG.md` — this entry.

### Cold-adopter Phase 1 collapses

Post-v0.15.1, the Phase 1 cold-adopter briefing loses the manual `cp` step
entirely. The flow becomes: `npm install` → `skillfile init` →
`skillfile dashboard` → `execute_skill({name})`. Four commands, no manual
file shuffling, no spurious experimental warnings.

## 0.15.0 — 2026-06-01 — SkillStore-as-bridge: in-skill `$ skill_write` + Draft-default trust boundary

The "skills can write skills" Lisp-shape primitive now works from inside a
running skill — not just on the outside MCP wire. v0.15.0 wires the SkillStore
as an `McpConnector` so `$ skill_write` and `$ skill_read` are dispatchable
from in-skill code, closing the substrate-symmetry asymmetry where `$ data_write`
worked in-skill (via `DataStoreMcpConnector` bootstrap wiring) but SkillStore
mutators required outside-MCP dispatch.

Pairs with two structural fixes from the same arc: the mutation gate now
catches resource_action names structurally (no more explicit `data_write`
special-case), and three bundled Phase 1+ demo skills ship pre-stamped with
valid approval tokens — `cp` from `node_modules/skillscript-runtime/examples/skillscripts/`
into `$SKILLSCRIPT_HOME/skills/` and `execute_skill({name})` runs immediately.

### New: `SkillStoreMcpConnector` bridge — `$ skill_write` works in-skill

Parallel structure to `DataStoreMcpConnector`. Bootstrap auto-registers the
bridge under `skill_read` and `skill_write` so bare-form dispatch from inside
an executing skill resolves to the substrate:

```
# Skill: parent
# Status: Approved v1:...
# Autonomous: true
run:
    $ skill_write name="generated-child" source="..." -> W
    $ skill_read name="generated-child" -> R
    emit(text="wrote ${W.name}; read ${R.source|length} bytes")
default: run
```

Use case: agent factories, template materialization, dynamic skill libraries —
the "skill that writes a classic Anthropic skill to the SkillStore" pattern
becomes a usable in-skill primitive.

### Trust boundary: in-skill writes force `# Status: Draft`

In-skill `$ skill_write` overrides any `# Status: Approved` declaration in
the written body, stamping `# Status: Draft` instead. To make the written
skill runnable, an authorized agent (human via dashboard, or MCP-direct)
reviews and promotes via the outside-MCP `skill_status` tool.

Different threat model from `$ data_write`: a bad `data_write` lands one
bad row (bounded blast radius); a bad `skill_write` lands an executable
artifact that fires arbitrarily many times in arbitrary contexts (unbounded).
The Draft-default gate prevents an Autonomous parent that calls
`~ qwen prompt="generate a skill"` and writes the LLM output from creating
immediately-runnable skills with zero human review.

The Lisp-shape primitive (skill-writes-skill) is preserved. Only
immediate-loop execution (parent writes child, child runs same fire) is
gated. Outside-MCP `skill_write` (cold-author agents authoring directly)
keeps its existing "body declares status, auto-stamp via store" behavior.

### Bridge surface (v0.15.0): write + read only

- `$ skill_write name="..." source="..." [overwrite=true] -> R` — Draft-only override applied here.
- `$ skill_read name="..." [version="..."] -> R` — returns body, status, version.

Deferred to a later release with threat-model context attached:
- `skill_delete` — destructive; no use case articulated yet.
- `skill_update_status` — the gate-bypassing op (Draft → Approved). Allowing
  it in-skill would let an Autonomous parent both write Draft AND promote
  Approved in the same fire, defeating the Draft-default trust boundary.

### Mutation gate widened — structural fix, not enumeration

`MUTATING_TOOL_PATTERN` changed from prefix-anchored (`/^(?:write_|update_|...)/ `)
to underscore-boundary-anchored (`/(?:^|_)(?:write|update|...)(?:_|$)/`).

Resource_action shapes (`skill_write`, `skill_delete`, `memory_write`,
`skill_update_status`) now classify uniformly with action_resource shapes
(`write_file`, `update_status`). The pattern subsumes the v0.14.1 explicit
`data_write` special-case; `data_write` keeps its kind tag for back-compat
in error copy but no longer needs name-specific recognition.

Closes the discipline-only-contract gap structurally — the gate doesn't
care how a new mutating tool is named, as long as its name carries a
recognized verb token. False-positive guards: `data_writer` (no boundary
after verb), `created_at` (no boundary after verb), `data_read` (no verb
in token list) all correctly pass through.

### New: three pre-stamped bundled Phase 1+ demo skills

`examples/skillscripts/`:

- `hello-world.skill.md` — no substrate, baseline runtime check. `# Vars: WHO=world` demonstrates `--input` threading. Supersedes `hello.skill.md`.
- `skill-store-roundtrip.skill.md` — writes a child skill via `$ skill_write`, reads it back via `$ skill_read`, exercises the Lisp-shape primitive. Body explicitly comments the Draft-default gate.
- `data-store-roundtrip.skill.md` — `$ data_write` + `$ data_read` FTS round-trip.

All three ship with valid `# Status: Approved v1:<token>` stamps. Adopters
`cp` them into `$SKILLSCRIPT_HOME/skills/` and `execute_skill({name})` works
out of the box — no `skill_write` round-trip needed for Phase 1 dogfood.

### New: token-stamp integrity CI guard

`tests/dogfood-t7.test.ts` case #14 — for every `examples/skillscripts/*.skill.md`,
recompute `computeApprovalToken(body, "v1")` and assert it matches the stamp
in the file. Catches body-edit-without-restamp drift on every `pnpm test`.
Fix path: `node scripts/stamp-bundled-skills.mjs` (idempotent; only writes
when the body actually changed). Sibling structural-guard pattern to the
hardcoded version assertion (case #1) and the LOC ceiling test (case #7).

### Breaking: `hello.skill.md` → `hello-world.skill.md`

The legacy `examples/skillscripts/hello.skill.md` (Draft, no approval
stamp) is replaced by `hello-world.skill.md` (Approved, stamped). The
scaffold copy (`scaffold/examples/hello-world.skill.md`) is what
`skillfile init` copies into `$SKILLSCRIPT_HOME/examples/`. Adopters
referencing the old path need to update.

### Docs

- `examples/README.md` — restructured to highlight the three Phase 1+
  demos. The "Connector requirements" table flags the new no-deps
  baseline (`hello-world.skill.md`).
- `src/cli.ts` per-command `--help` examples updated to point at the
  new filename.

### Files changed

- New: `src/connectors/skill-store-mcp.ts` (~95 LOC; bridge + `forceDraftStatus`).
- New: `examples/skillscripts/{hello-world, skill-store-roundtrip, data-store-roundtrip}.skill.md`.
- New: `scaffold/examples/hello-world.skill.md`.
- New: `scripts/stamp-bundled-skills.mjs` (idempotent stamper, run on body edits).
- New: `tests/v0.15.0-skill-store-bridge.test.ts` (16 cases).
- Removed: `examples/skillscripts/hello.skill.md`, `.provenance.json`, `scaffold/examples/hello.skill.md`.
- Updated: `src/mutation-gate.ts` (pattern widened), `src/connectors/index.ts` (bridge re-export), `src/connectors/config.ts` (bridge in KNOWN_CONNECTOR_CLASSES), `src/bootstrap.ts` (bridge auto-wire), `src/cli.ts` (hello-world references), `tests/v0.14.1-mutation-gate.test.ts` (10 new cases for widened pattern), `tests/dogfood-t7.test.ts` (version + LOC ceiling + file count + token-stamp guard + bundled-skills existsSync).

### Why v0.15.0 not v0.14.2

New dispatch surface (SkillStore as in-skill bridge) — minor bump, not patch.
Per the pre-adoption rule (no external users yet, no published install base),
the bump is cheap; matching the version to the size of the claim avoids
underclaiming.

### Parser hardening — `\"` escape + `interpretDoubleQuotedEscapes` consistency

Cold-adopter probe of `skill-store-roundtrip` surfaced three discipline-only
gaps in the string-escape surface — closed in v0.15.0:

1. **`tokenizeKeywordArgs` + `extractParenBody` didn't honor `\"` inside quoted
   strings.** `$ skill_write source="...emit(text=\"hi\")..."` truncated at
   the first internal `\"`. Both quote-state machines now recognize `\"`,
   `\'`, `\\` as escapes inside their corresponding quote pair.
2. **`coerceKwargValue` (runtime $ op kwarg path) stripped quotes but didn't
   interpret escapes** — inconsistent with `processSetValue` (used for `$set`
   + function-call kwargs since v0.7.2). Now calls the shared
   `interpretDoubleQuotedEscapes` for double-quoted values, preserves
   single-quoted as literal, handles triple-quote `"""..."""` multi-line
   literals. `$ skill_write source="...\n..."` lands real newlines.
3. **`stampApprovalToken` regex matched any `# Status:` line in the body** —
   including ones inside string literals. When a parent skill body contained
   `source="...# Status: Approved..."` and lacked its own outer Status header,
   the stamper mutated the inner string content. Now only considers
   `# Status:` lines inside the HEADER BLOCK (lines from start until first
   blank line or first non-`#`-comment line).

`interpretDoubleQuotedEscapes` is now exported from `parser.ts` (previously
internal) so runtime + future call sites can share the implementation.

### Architecture invariants reinforced

- **Discipline-only contracts are bugs** — the prefix-only pattern + explicit
  `data_write` special-case combo was the recurring shape. Underscore-boundary
  pattern + drop-the-special-case is the structural fix. The parser-hardening
  pass is the same lens applied to string-escape interpretation: `processSetValue`
  did it for some kwarg contexts, `coerceKwargValue` didn't for `$` op
  kwargs — silent-inconsistency surface eliminated.
- **Capability granularity follows threat model, not implementation convenience** —
  banked from Perry's `f2a85892` thread reply. data_write's bounded blast
  radius vs skill_write's unbounded blast radius is the lens that drove the
  Draft-default boundary. Symmetric-for-symmetry's-sake would have been the bug.
- **Build/probe before claiming done** — banking the lesson that running
  `pnpm test` alone wasn't enough; the in-skill `$ skill_write` demo only
  surfaced as broken when actually executed via CLI. Test fixtures wrote
  short bodies that didn't trigger the tokenization edge cases.

## 0.14.1 — 2026-05-31 — Contract-vs-runtime parity: mutation gate + strict filters

Cold-adopter Phase 1 v4 dogfood against v0.14.0 closed clean on substrate-portability
+ package-only sufficiency, but surfaced four findings on **contract-vs-runtime parity** —
cases where the language reference / spec described a guarantee that only lint
enforced, leaving callers who bypassed lint (`execute_skill({source})`) silently
slipping through. v0.14.1 makes the runtime the load-bearing enforcement boundary;
lint stays advisory.

Per the "discipline-only contracts are bugs" invariant (banked this release as
sibling to the substrate-portability architecture invariant): when the spec
classifies an op or feature as requiring authorization/validation/sequencing,
runtime enforcement is mandatory — every layer that knows the contract should
enforce it.

### Breaking-ish: mutation gate now throws at runtime

**`$ data_write` / `file_write` / `$ <mutating-name-tool>` ops now throw
`UnconfirmedMutationError` at the runtime boundary** unless one of three
authorization signals is present:

1. `# Autonomous: true` skill-header (cron/agent-fired skills)
2. A preceding `??` / `ask(...)` in the same target (interactive confirmation)
3. `approved="reason"` per-op kwarg (per-op intent marker)

Pre-v0.14.1 these signals were lint-warned but runtime-permitted; lint-tier
warnings don't block execution, and `execute_skill({source})` bypassed lint
preflight entirely. v0.14.1 closes both bypass paths:

- **Layer A (load-bearing)** — `execOps` checks each op before dispatch.
- **Layer B (regression guard)** — `execOpInner` re-checks at the `$` /
  `file_write` dispatch sites. Same predicate, fail-closed default `authState`.

Migration: cron / agent-fired skills with mutation ops need `# Autonomous: true`.
Bundled example skills updated; corpus authors set the header once at the top.

Pattern-shape (mutation classes): `$ data_write` MCP dispatch, `$ <tool>` with
mutating-name prefix (`write_`, `update_`, `delete_`, `archive_`, `prune_`,
`deploy_`, etc.), `file_write(...)` runtime-intrinsic.

### Breaking-ish: substrate-side strict filters on `$ data_read`

**`DataStoreMcpConnector` now enforces every non-base filter key against the
wrapped `DataStore.manifest().supported_filters`**, throwing
`UnsupportedFilterError` for unknowns. Closes the silent-scope-leak class
where pre-v0.14.1 substrates dropped unsupported filters (e.g., a skill
passing `vault="team"` against a substrate without vault semantics got
unfiltered results back, with no signal that the scoping was ignored).

Per-call opt-out: `permissive_filters: true` on the query acknowledges
"unknown keys are advisory; substrate may ignore them" — for cases where
the author knows their substrate is permissive by design.

Substrate implementor responsibility: declare every filter your `query()`
actually honors in `manifest().supported_filters`. Omissions become
"this filter is rejected at the bridge."

### Docs

- **`runtime_capabilities.shellExecution.description`** rewritten to lead with
  canonical `shell(command="...")` syntax; legacy `@ <cmd>` / `@ unsafe <body>`
  noted as deprecated-symbol-op aliases that parse identically.
- **`scaffold/config.toml`** — stale `@@` reference replaced with canonical
  `shell(command=..., unsafe=true)` form.
- **README** MCP-surface section — `execute_skill` now distinguishes
  `{skill_name}` mode (subject to v0.9.0 hash-token approval gate) vs `{source}`
  mode (ad-hoc inline; never persisted; bypasses SkillStore + approval gate);
  explicitly calls out that v0.14.1 mutation gate applies in both modes.
- **`docs/adopter-playbook.md`** — substrate-neutral rewrite. New "What the
  runtime promises connector implementors" section flat-lists the 5 typed
  contract methods + explicit "what's NOT in the contracts" boundary (vaults,
  namespaces, expiration, auth — all implementor concerns). Case 1 vs Case 2
  table updated. Mutation-gate + strict-filters added to the "things the
  playbook should be honest about" list.

### Examples sweep — v0.14.1 contract compliance

- **`examples/onboarding-scaffold/bootstrap.ts`** — wires `data_write` bridge
  alongside `data_read` (matches bundled `src/bootstrap.ts` pattern; one
  bridge instance, two connector names).
- **`examples/onboarding-scaffold/file-data-store.ts`** — `manifest()` declares
  `supported_filters: []` with comment explaining the substring scorer
  doesn't filter on fields; teaches the v0.14.1 strict-default contract.
- **`examples/connectors/DataStoreTemplate/`** — `manifest()` + `query()` docs
  explain v0.14.1 strict-filters enforcement at the bridge and how
  `supported_filters` is now load-bearing.
- **`examples/custom-bootstrap.example.ts`** — commented wiring example mirrors
  the bundled both-names pattern.
- **`examples/skillscripts/`** — `feedback-sentiment-scan`, `service-health-watch`,
  `classify-support-ticket` rewritten to v0.14.1 contract (`# Autonomous: true`;
  canonical `$ data_write content=... tags=[...]`; envelope `${X.items}`
  iteration; tokens recomputed). `cut-release-tag` shell-quote hygiene
  warnings cleaned.
- **`examples/programmatic-trace-demo.mjs`** + **`docs/sqlite-skill-store.md`** —
  legacy `! <text>` shorthand replaced with canonical `emit(text="...")`.

### New error classes (`src/errors.ts`)

- `UnconfirmedMutationError extends OpError` — `opShape` ("data_write" /
  "mutating_tool" / "file_write") + `detail` (tool name or path) +
  `requiredSignals[]` + concrete one-line suggestion in remediation.
- `UnsupportedFilterError extends OpError` — `unsupportedKeys[]` +
  `supportedKeys[]` + `substrate` name; remediation names 3 paths
  (drop / opt out / switch substrate).

### Internal

- New `src/mutation-gate.ts` (~85 LOC): `classifyMutation`,
  `authorizationGranted`, `buildAuthorizationSuggestion`,
  `MUTATING_TOOL_PATTERN`. Single source of truth — both lint and runtime
  call into the same classifier.
- New `src/connectors/filter-enforcement.ts` (~40 LOC):
  `enforceSupportedFilters(filters, supportedKeys, substrateName)` helper +
  base-shape-key allowlist.
- `src/lint.ts` `UNCONFIRMED_MUTATION` rule refactored to call the shared
  classifier (net -25 LOC).
- `src/runtime.ts` `execOps` / `execOp` / `execOpInner` signatures plumb
  `MutationAuthState`; recursive `foreach` / `if` / `else` calls pass the
  same authState reference (sawConfirm propagates across nesting).
- `src/connectors/data-store-mcp.ts` lazily caches `supported_filters` from
  the wrapped substrate's manifest (one async call per bridge instance).
- Narrow-core LOC ceiling bumped 9550 → 9700 per Scott's "ceiling is a
  signal, not a budget" rule. File count (22) unchanged.

### Tests

- `tests/v0.14.1-mutation-gate.test.ts` — 8 cases: unauthorized throws + no
  dispatch; `approved=` works; `# Autonomous: true` works; preceding `ask()`
  authorizes (sawConfirm path); mutating-name shape throws + no dispatch;
  file_write paths.
- `tests/v0.14.1-strict-filters.test.ts` — 7 cases: unknown key throws +
  no substrate call; error names keys; `permissive_filters: true` bypasses;
  base keys never flagged; declared keys pass; empty manifest fails closed;
  manifest fetched once / cached.
- Test corpus migration: 4 test files (`file_write` / `$ data_write` fixtures)
  got `# Autonomous: true` to keep passing under the new runtime gate.

Suite: 1296 passing (+8 since v0.14.0).

## 0.14.0 — 2026-05-30 — Rename: `MemoryStore` → `DataStore` (breaking)

**Upgrade impact:** BREAKING, CONFIG — the `connectors.json` substrate key `memory_store` was renamed to `data_store`; rename the key in your config or the loader rejects the file. (Only breaking `connectors.json` change to date.) See [UPGRADING.md §4](UPGRADING.md).

Pre-adoption window means breaking changes are still cheap. `MemoryStore` was
misleading nomenclature — it imported cognitive / agent-mental-state semantics
from AMP (the Tradita-internal substrate where this code originated) into what
is actually a generic data-persistence contract. Adopters without an AMP-like
memory broker had to mentally translate every time. Cost compounds per adopter;
pay once now.

The mental model after rename:

| Contract | What it does | Adopter intuition |
|---|---|---|
| `SkillStore` | Named, versioned, lifecycle-tracked code artifacts | "My skill catalog / code repo / playbook library" |
| `DataStore` | Generic key/value persistence with query | "My data store / KV store / search index" |
| Richer semantics (vector retrieval, memory broker, etc.) | Wire via MCP, not via skillscript contract | "Bring my own substrate" |

Both contracts describe what they DO. The asymmetry we documented in v0.13.8
(SkillStore is mutable/versioned CRUD vs append-only search log) is now
obvious-from-the-name, not a design stance the doc has to call out.

### Breaking changes (every external identifier renamed; hard rename, no aliases)

**Contract + types:**
- `MemoryStore` → `DataStore`
- `MemoryStoreClass` → `DataStoreClass`
- `MemoryStoreCapabilities` → `DataStoreCapabilities`
- `MemoryStoreManifest` → `DataStoreManifest`
- `MemoryStoreFeature` → `DataStoreFeature`
- `MemoryWrite` → `DataWrite`
- `MemoryWriteRecord` → `DataWriteRecord`
- `PortableMemory` → `PortableData`
- `CuratedMemoryField` → `CuratedDataField`
- `CURATED_MEMORY_FIELDS` → `CURATED_DATA_FIELDS`

**Bundled impls + bridges + templates:**
- `SqliteMemoryStore` → `SqliteDataStore`
- `MemoryStoreMcpConnector` → `DataStoreMcpConnector`
- `MemoryStoreTemplate` (fork-me skeleton) → `DataStoreTemplate`

**Registry methods:**
- `registerMemoryStore` → `registerDataStore`
- `getMemoryStore` → `getDataStore`
- `getMemoryStoreClass` → `getDataStoreClass`
- `listMemoryStores` → `listDataStores`
- `listMemoryStoreClasses` → `listDataStoreClasses`
- `hasMemoryStore` → `hasDataStore`

**Config + env + filesystem:**
- `connectors.json` substrate key: `memory_store` → `data_store`
- Env var: `MEMORY_DB` → `DATA_DB`
- Bootstrap option: `memoryDbPath` → `dataDbPath`
- Default db filename: `<SKILLSCRIPT_HOME>/memory.db` → `<SKILLSCRIPT_HOME>/data.db`
- `runtime_capabilities` field: `memoryStores` → `dataStores`

**Ops (skill source) + MCP tools:**
- `$ memory ...` read op → `$ data_read ...`
- `$ memory_write ...` write op → `$ data_write ...`
- MCP tool: `memory_read` → `data_read`
- Internally-registered MCP connector instance names: `memory` → `data_read`,
  `memory_write` → `data_write`

**Source files:**
- `src/connectors/memory-store.ts` → `data-store.ts`
- `src/connectors/memory-store-mcp.ts` → `data-store-mcp.ts`
- `examples/connectors/MemoryStoreTemplate/` → `DataStoreTemplate/`
- `examples/onboarding-scaffold/file-memory-store.ts` → `file-data-store.ts`

### NOT renamed (intentional — naming is honest)

- `SkillStore` (and `SqliteSkillStore`, `FilesystemSkillStore`, etc.) — skills
  ARE skills. The misleading-naming pattern was specific to memory-store
  importing agent-cognition semantics into generic data persistence.
- `AgentConnector` (and the HTTP webhook bridge) — substrate-neutral delivery
  to a frontier agent; name honestly describes the function.
- `docs/sqlite-skill-store.md` filename — documents `SqliteSkillStore` which
  stays named. (Perry's initial rename mapping had this as a typo; corrected.)
- `language-reference.md` rename pass — separate doc lane, Perry's work.

### Adopter migration

This is a one-PR rename for any adopter who's forked a connector template. The
patterns are mechanical: every `Memory` identifier in your code becomes `Data`;
every `$ memory` op in your skills becomes `$ data_read`; every
`registerMemoryStore` call becomes `registerDataStore`; etc.

The Phase 2/3 cold-adopter `AmpMemoryStore` becomes `AmpDataStore` in the same
fashion. ~5 LOC of identifier renames per file plus the constructor/import
updates.

### Why now

[[project_pre_adoption_rule]]: pre-adoption window is cheap; aliases + soft
deprecation are more total cost than one painful PR. SkillStore + DataStore is
the mental model we'd want a v1.0 reader to see immediately. Pay once now.

## 0.13.8 — 2026-05-29 — Phase 3 fallout + memory_read MCP tool + storage-conventions docs

Phase 3 cold-adopter dogfood (AMP-backed MemoryStore + AmpSkillStore vault
migration) wrapped successfully. The cold agent delivered an implementer's-eye
summary surfacing several contract-design questions Perry locked in thread
`4b58c283`; v0.13.8 ships the narrow set (bug fix + docs + small additive),
v0.14.0 will absorb the contract evolution (Q2 vault op-syntax + Q3
strict_filters).

### Added

- **`memory_read(id, store?) -> PortableMemory | null` MCP tool** (Perry Q1C).
  Direct memory lookup by substrate-assigned id; mirrors `skill_read` pattern.
  Returns `null` on miss (matches MemoryStore's empty-set convention — distinct
  from SkillStore's throw-on-miss; cold agent flagged this asymmetry as
  load-bearing in their "credit where due" summary). **No `memory_write` MCP
  by design** — writes are skill-context-only (`$ memory_write` op inside a
  skill body) to preserve intent-tracking. Reaches via the registered
  MemoryStore; errors cleanly when no store is registered.
- **`MemoryStore.get(id): Promise<PortableMemory | null>`** — new contract
  method backing `memory_read`. SqliteMemoryStore impl is a simple
  `SELECT WHERE id = $id`. Adopters forking `MemoryStoreTemplate` add a
  matching impl; null semantics must hold.
- **`MemoryWrite` + `MemoryWriteRecord` re-exported** from
  `skillscript-runtime/connectors`. Phase 3 cold agent caught v0.13.7's F2
  fix was incomplete — `MemoryStoreTemplate.ts` imported these two types but
  they weren't re-exported. Template now compiles standalone after fork
  (same as the SkillStore/LocalModel/McpConnector/AgentConnector templates
  did post-v0.13.7).
- **`README.md` Memory row + tool count bumped 15 → 16** (memory_read in its
  own row; matches dogfood-t7's table-vs-runtime drift guard added below).
- **`docs/connector-contract-reference.md` § "Storage-layer conventions"**
  (~120 lines). Documents the SkillStore + MemoryStore conventions that live
  in bundled reference impls but aren't in the typed contracts:
  `content_hash = sha256(approval-stamped body)`, `version = first 12 hex`,
  `store()` auto-stamps approval token (runtime-semantic leak callout),
  summary/detail split is convention, `get(id)` returns null vs SkillStore
  `load()` throws, durability stance, filter-scope discipline. Cold-agent
  framing: *"the contracts are shape-portable, not semantics-portable —
  hidden coupling to the reference impl, documented only in its source."*
  Now documented.
- **`docs/adopter-playbook.md` § "Notable gaps"** — three new bullets covering
  (1) SkillStore vs MemoryStore lifecycle asymmetry as design stance, (2)
  durability-is-implementer's-responsibility, (3) filter-scope advisory-
  today + v0.14.0 strict_filters preview. Includes Phase 3's AMP TTL example
  as cautionary tale.

### Fixed

- **Doc drift in MCP-surface table** (Perry's `a8ac822f`). README listed 3
  trigger tools; actual is 4. v0.13.3 fixed the total count but missed
  per-row update for Triggers. `set_trigger_enabled` now in the Triggers
  row.
- **`docs/ERD.md` was silently shipping in the tarball** since v0.13.3 — the
  `.npmignore` was theater (npm ignores `.npmignore` when `files` array is
  set in `package.json`). Fixed via explicit `files` list (5 user-facing
  docs enumerated, not a `docs/*.md` glob). `.npmignore` deleted as
  redundant + misleading.
- **`tests/dogfood-t7.test.ts` test #17 — README-vs-runtime tool-list
  drift guard.** Closes the doc-drift class structurally: every tool the
  README claims exists must exist in the runtime, every runtime tool must
  be claimed somewhere in the MCP-surface table. Different class than
  v0.13.3's link-guard (which validates path resolution, not table
  content); same belt-and-braces pattern.

### Meta-lesson banked

**"Defaults matter more than knobs for security-relevant surfaces"**
(Perry, thread `4b58c283`). All three Phase 3 contract design questions
laddered to the same axis: Q1 (writes skill-context-only by default — no
memory_write MCP; preserves intent-tracking), Q2 (vault choice explicit
per-write; intent-driven not implicit), Q3 (strict_filters default-on for
filter enforcement). The "we'll let adopters opt in" pattern is seductive
and consistently wrong for scope/visibility/security shapes — aware
adopters opt out, naive adopters get protection. Banked as a feedback
memory for future contract decisions. Sibling to v0.13.7's `skill_status`
silent-corruption finding: "the contract declares a discipline, but
enforcement is opt-in or absent" is the recurring class.

### Note on v0.14.0

Two contract-evolution items locked but deferred:
- **Q2** — `$ memory_write vault="..."` op-syntax kwarg (writes-only, not
  on `$ memory` query). Real signal from Phase 3 cold agent who hit
  "the op can't express it" for per-call team override.
- **Q3** — `strict_filters: true` default + lint-time filter check +
  `UnsupportedFilterError` class. Cold agent's "single most valuable fix
  for non-SQLite adopters." Belt-and-braces (runtime + lint) per Perry.

Both are language-grammar / behavior-change scope; bundling together in
v0.14.0 keeps the contract evolution narrative clean.

## 0.13.7 — 2026-05-29 — skill_status silent-corruption hardening + fork-template re-exports

Phase 2 dogfood (a cold adopter wrote a real `AmpSkillStore` against the 8-method
contract via programmatic bootstrap, ran end-to-end including execute_skill,
persistence-across-restart, audit trail, approval stamping) **empirically
validated the typed-contract substrate-portability claim**. The audit/lock
discipline on the SkillStore contract paid off — the cold adopter built to
spec without needing source-repo access, and it worked. Banking that as an
architecture invariant — see dev-log §27.

Two real bugs surfaced.

### Fixed

- **`skill_status` silent skill corruption (F1).** The MCP handler's
  `inputSchema` declared `new_state` as required with an enum, but the
  dispatcher doesn't enforce inputSchema — the handler's `args["new_state"]
  as SkillStatus` cast was a runtime lie. A caller omitting/misnaming the
  arg flowed `undefined` through to `rewriteStatusHeader`, which silently
  wrote literal `# Status: undefined` into the skill body. Since `# Status:`
  is load-bearing for the approval gate, a corrupted skill becomes
  unauthorized to run — and the corruption was invisible to the caller (the
  RPC call returned success). The bundled `SqliteSkillStore` and
  `FilesystemSkillStore` were equally vulnerable to direct API calls
  bypassing the MCP layer.
  
  Defense in depth (per Perry's thread `0217b0e0` framing):
  - **MCP handler layer**: `skill_status` validates `new_state` against
    `VALID_SKILL_STATUSES` before dispatching to the store. Rejects with
    structured `OpError` if invalid.
  - **Store layer**: both `SqliteSkillStore.update_status` and
    `FilesystemSkillStore.update_status` validate input at entry. Direct
    API callers bypassing the MCP layer can't corrupt skills either.
  - **New exports**: `VALID_SKILL_STATUSES: readonly SkillStatus[]` + 
    `isSkillStatus(value): value is SkillStatus` type guard, both re-exported
    from `skillscript-runtime/connectors`.
  - **Tests**: MCP layer tests for both missing-arg and invalid-arg paths
    verify clean error + body-untouched; store-layer tests for both
    `undefined` and bad-string inputs verify defense-in-depth holds.

- **Connector fork templates couldn't compile from `node_modules` (F2).**
  All four template TS files (`SkillStoreTemplate`, `MemoryStoreTemplate`,
  `LocalModelTemplate`, `McpConnectorTemplate`) imported their per-kind
  `Capabilities` interfaces from `../../../src/connectors/types.js` — a path
  that ships in the source repo but NOT in the npm tarball (`src/` isn't in
  the `files` array). `HttpWebhookAgentConnector` had the same issue
  importing from `../../../src/connectors/agent.js`. Adopters following the
  fork-this-template workflow hit TS2305 immediately.
  
  - Re-exported `SkillStoreCapabilities`, `MemoryStoreCapabilities`,
    `LocalModelCapabilities`, `McpConnectorCapabilities`,
    `AgentConnectorCapabilities` (and the per-kind `*Manifest` interfaces)
    from `skillscript-runtime/connectors`.
  - Re-exported `DeliveryMeta`, `RequestResponseOpts`, `Response` from the
    same path — `HttpWebhookAgentConnector` needed them.
  - Fixed all four template imports to use `skillscript-runtime/connectors`.

### Architecture invariant banked

**SkillStore contract validated portable via cold-adopter AmpSkillStore impl,
v0.13.6 / 2026-05-29.** A cold adopter wrote the 8-method `SkillStore`
contract against AMP (hand-rolled streamable-HTTP MCP client, payload_type
"skill" memory mapping, full version-history per memory) entirely from the
shipped spec + template + docs. Persistence across daemon restart confirmed
the skill lives in AMP not in process. This is the load-bearing externalize
signal that internal probes can't produce — the typed-contract substrate-
portability claim in `docs/adopter-playbook.md` § "Substrate ship-status"
is now empirical, not aspirational.

### Meta-lesson

The `skill_status` bug is an instance of a broader class: **`inputSchema`
declares constraints, but the McpServer dispatcher doesn't enforce them
before invoking handlers.** Every tool with `required` or `enum` constraints
is similarly vulnerable. v0.13.7 closes the *instance* (Perry's call —
narrow defense in depth at two layers, shippable today). The *class* fix
(dispatcher validates args against tool.inputSchema for ALL tools) is its
own ship cycle. Same lesson as v0.13.5: a contract that declares constraints
should enforce them — but scope the fix to what's blocking adopters today.

## 0.13.6 — 2026-05-29 — Cold-adopter docs sweep + REGEXP warning UX

Fresh-agent Phase 1 dogfood (v0.13.5 install, isolated `SKILLSCRIPT_HOME=
~/.skillscript-adopter`) completed successfully — the daemon-isolation
primitive worked end-to-end. Perry's review surfaced 4 docs/UX gaps worth
addressing before Phase 2.

### Fixed

- **`docs/configuration.md` default-paths table** — the `sqlite` memory_store
  row said `<skillsDir>/memories.db`. Actual is `$SKILLSCRIPT_HOME/memory.db`
  (different directory AND filename). The CLI threads `MEMORY_DB =
  $HOME/memory.db` through bootstrap; the `<skillsDir>/memories.db` fallback
  in `bootstrap.ts:420` never fires from the CLI launch path. Fixed both
  rows to use explicit `$SKILLSCRIPT_HOME` paths matching the code.
- **`docs/configuration.md` SKILLSCRIPT_HOME gap** — the canonical config
  doc never mentioned the root-override env var despite it being "the
  architectural primitive" for multi-instance isolation. Added a new top-
  level section before "Quick start" listing every default path that
  derives from `SKILLSCRIPT_HOME` + the side-by-side adopter example. Cold
  adopters reading configuration.md for path config now see the primitive
  immediately, not buried in adopter-playbook's "Two-instance posture."
- **`src/connectors/sqlite-skill-store.ts` REGEXP warning** — was emitted
  on every construction; on macOS node:sqlite builds (no REGEXP), every
  launch printed the warning. Now log-once per process via module-level
  flag. The manifest still exposes `regexp_fallback_active` per-instance
  for adopters who want to introspect programmatically. UX win: clean
  startup logs on macOS without losing the signal.

### Added

- **`docs/adopter-playbook.md` SqliteMemoryStore reduced-features note** —
  bundled SqliteMemoryStore reports `false` for `supports_semantic` /
  `supports_pinning` / `supports_decay_model` / `supports_thread_status_filter`.
  This is intentional: the bundled impl is a deliberately minimal reference
  for FTS-style tag/text retrieval. Adopters needing semantic / pinning /
  decay-scoring fork `MemoryStoreTemplate/` and wire their backing system
  (memory broker, vector DB, AMP, etc.). Now called out alongside the
  4-of-6-trigger-sources-parse-but-don't-fire gap in § "Substrate
  ship-status > Notable gaps the playbook should be honest about."

### Meta-lesson

Phase 1 dogfood validated the v0.13.3 → v0.13.5 docs/install hardening AND
the SKILLSCRIPT_HOME isolation primitive end-to-end. But the docs that an
adopter READS (configuration.md) didn't mention the primitive that makes
multi-instance work — discovery of `SKILLSCRIPT_HOME` required reading
adopter-playbook or the env section of README. Cold-reader signal beats
maintainer assumptions: I'd internalized SKILLSCRIPT_HOME as obvious
because I'd been editing the code; the cold agent needed to grep `cli.ts`
to find it. **A primitive that's load-bearing for adopter posture deserves
top-billing in the adopter-facing config doc.**

Same pattern as the v0.13.3 finding ("README links docs that don't ship"):
both are cases of "the dev's mental model of what's adopter-facing diverged
from what's actually adopter-accessible." Banked in dev-log §26.

## 0.13.5 — 2026-05-29 — Build script split: link-guard out of the Docker build path

v0.13.4 (Dockerfile-COPY patch) failed in CI for the same root cause as
v0.13.3: `scripts/check-published-paths.mjs` running inside the Docker build
needs more of the source tree than the runtime image cares about. v0.13.4
added `COPY README.md` and `COPY docs`; v0.13.5's failure surfaced two MORE
missing paths the script flagged (`examples/` and `LICENSE` — both linked from
README but not COPYed into Docker). Whack-a-mole.

### The architectural fix

The link-guard is **build-for-publish validation**. Docker produces a runtime
image, not an npm tarball. Conceptually the script doesn't belong inside the
Docker build path.

`package.json` `scripts` split:

| Script | Chain | Used by |
|---|---|---|
| `build:dist` (new) | `tsc + copy-dashboard-assets` | Dockerfile build stage |
| `build` (existing) | `build:dist + check-published-paths.mjs` | Local dev, CI release pipeline, dogfood-t7 |

Dockerfile build stage now invokes `pnpm run build:dist` instead of
`pnpm run build`. Reverted the `COPY README.md` + `COPY docs` additions from
v0.13.4 — no longer needed since Docker doesn't run the link-check.

### Meta-lesson (combined v0.13.3 + .4 + .5 arc)

When adding a build-time guard, ask "which build contexts is this guard
meant for?" before wiring it. The link-guard's job is "would the npm
tarball, if published from this state, have valid README references?"
That's only meaningful in contexts that produce npm tarballs:

- Host dev environment (the dev about to tag a release) ✓
- CI release pipeline (the pipeline about to publish) ✓
- `dogfood-t7` pack test (validating the would-publish artifact) ✓
- Docker build stage (produces a runtime image, NOT a tarball) ✗

I wired the guard into `build` which runs in all four. Should have wired
it only into the publish-relevant chain. v0.13.5's split is what should
have shipped with v0.13.3.

Combined with v0.13.2's "audit silent-broken signals" lesson and v0.13.3's
"ship the guard, not just the fix" lesson, the pattern is: **a build-time
guard is itself a contract that needs to think about its consumers.**

## 0.13.4 — 2026-05-29 — Dockerfile build context patch for v0.13.3 link guard

v0.13.3 tests + build + version-tag-match all passed in the release pipeline,
but the multi-arch GHCR container build failed: `scripts/check-published-paths.mjs`
(new in v0.13.3) reads `README.md` and runs `npm pack --dry-run`, but the
Dockerfile build stage only `COPY`ed `package.json`, `pnpm-lock.yaml`,
`tsconfig*.json`, `src`, `scaffold`, `scripts` — no README, no docs/. Result:
ENOENT on `/work/README.md` inside the container build; container/release/npm
publish all skipped.

### Fixed

- `Dockerfile` build stage now `COPY`s `README.md ./README.md` and
  `COPY docs ./docs`. The runtime image is unchanged (still distroless
  nodejs22 with just dist/, scaffold/, node_modules/, package.json) — only
  the build stage needs the markdown sources for the link-guard script.

### Meta-lesson

Same shape as the v0.13.2 → v0.13.3 dependency: when adding a build-time
guard, audit every build context that invokes `pnpm run build` — host, CI
release.yml, dogfood-t7's pack test, AND the Dockerfile build stage. Three
out of four were exercised before tagging; the Dockerfile context wasn't
because local `pnpm run build` doesn't go through Docker. The fix is to
think "what does this script need to read?" and ensure every build context
provides those files.

## 0.13.3 — 2026-05-29 — Docs/install hardening + skill_read MCP tool

Fresh-agent Phase 1 dogfood (against v0.13.2 fresh install) surfaced 5 findings.
This release closes all 5 + adds a permanent regression guard for the broken-
README-link class.

### Added

- **`skill_read` MCP tool** — `skill_read({name, version?}) -> {name, version,
  status, source}`. Symmetric peer to `skill_write`. Cold-reader friction: the
  Phase 1 dogfood agent (correctly) reasoned to `skill_read` after seeing
  `skill_write`; previously there was no peer. Routed through `SkillStore.load`
  for shared audit-path with `skill_metadata` (per Perry's design-review thread
  `df5f6c3f` — "asymmetric surfaces lead to misclassification").
  - Net MCP surface: 14 → 15 tools.
- **`scripts/check-published-paths.mjs`** — build-time guard that runs
  `npm pack --dry-run --json` and verifies every relative markdown link in
  `README.md` resolves to a path in the published tarball. Wired into the
  `build` script — runs on every local build + CI release pipeline + dogfood-t7
  pack test. Closes the regression class that caused this release.
- **`docs/configuration.md` ExperimentalWarning note** — single line explaining
  the `node:sqlite` "experimental feature" startup log so cold adopters don't
  treat it as an error.

### Changed (breaking — pre-adoption cheap)

- **`skill_metadata` no longer returns `source`** — caller must use `skill_read`
  for the source body. Exclusive shape (not additive) per Perry's call: pre-
  adoption is the window to clean up the contract; two paths to the same data
  ossify into auth-divergence + docs-drift + canonical-path arguments forever
  after. Dashboard SPA migrated to call both tools in parallel.
- **`package.json` `files` array** — added `"docs/*.md"`, removed
  `"ARCHITECTURE.md"`. ARCHITECTURE.md is an internal-architecture doc for
  runtime contributors, not adopters; stays in the source repo.
- **`.npmignore`** (new) — excludes `docs/ERD.md` (internal ERD framing, not
  adopter-facing).
- **`README.md` Quickstart** — added a "Running side-by-side with another
  instance?" callout recommending local install + `npx skillfile` over
  `npm install -g` for multi-instance setups. The global `skillfile` binary
  collides on PATH when running adopter + dev daemons side-by-side.
- **`README.md` ARCHITECTURE.md link** — removed the `see ARCHITECTURE.md`
  parenthetical from the closed-set class registry section (line 337). The
  "deliberately out of scope" assertion stands on its own; runtime contributors
  still have ARCHITECTURE.md in the source repo for the rationale.
- **`README.md` MCP tool count** — corrected from 13 to 15 (was off-by-one
  even before this release; now correct + reflects `skill_read` addition).

### Fixed

The 5 Phase 1 dogfood findings:

1. **Broken docs links in npm tarball** — README linked to `docs/configuration.md`,
   `docs/adopter-playbook.md`, `docs/connector-contract-reference.md`,
   `docs/language-reference.md`, `docs/sqlite-skill-store.md`. None shipped.
   Fixed via `files` array + permanent guard script.
2. **`skill_read` MCP tool didn't exist** — agent's instinct hit a missing peer
   to `skill_write`. Fixed via new tool + Perry's exclusive-shape decision.
3. **README quickstart contradicted local-install constraint** — TL;DR + Quickstart
   said `-g` install without noting PATH collision risk for multi-instance setups.
   Fixed via Quickstart callout.
4. **node:sqlite ExperimentalWarning surprise** — adopters seeing the warning at
   startup didn't know it was Node-side and harmless. Fixed via docs note.
5. **Scaffold note about custom-via-connectors.json** — already documented in
   `docs/configuration.md` § "Custom form"; agent's instinct correct; no fix
   needed. Confirmation banked.

### Meta-lesson

Same shape as v0.13.2: a `files` array regression undetected for 5 ship cycles
because no test asserted "what the README claims is in the package is actually
in the package." Dogfood caught it within hours of v0.13.2 publish. The
`check-published-paths.mjs` guard closes the class structurally — not just this
instance — so a future README link addition can't silently rot.

Companion meta-lesson banked in [[skillscript-dev-log §25]]: when shipping a
"docs hardening" release, also ship the structural guard that prevents the
recurrence. Test-only assertions catch regressions; build-time guards prevent
them from leaving the dev's machine.

### Internal

- `tests/dogfood-t7.test.ts` test #14 extended with positive assertions for the
  5 user-facing docs + negative assertions for `ARCHITECTURE.md` and
  `docs/ERD.md` (belt-and-braces alongside the build-time guard).
- `tests/mcp-server.test.ts` — `skill_metadata` test asserts source absence
  (`not.toHaveProperty("source")`); two new tests for `skill_read` (round-trip
  + missing-skill error propagation).
- `src/dashboard/spa/app.js` — `renderSkillDetail` now calls `skill_metadata`
  and `skill_read` in parallel via `Promise.all`. Guarded `skill_read.catch`
  so the detail view degrades cleanly if the source isn't loadable.

## 0.13.2 — 2026-05-29 — Publish recovery: retired the YouTrack proving test

The release pipeline has been silently broken since the May 28 housecleaning
sweep. Five tag pushes (v0.11.0 → v0.13.1) never reached npm, GHCR, or
GitHub Releases — the `Test` step failed before any of those ran. Dogfood
attempt (`npm install skillscript-runtime@0.13.1`) surfaced this: npm
registry only had v0.10.0.

### Two failure modes, single fix

- **`ci.yml`** (every main push since May 28) failed on the env-gate assert
  in `tests/v0.4.1-youtrack-proving.test.ts` — the test always-fails when
  `YOUTRACK_TEST_TOKEN` is unset, and ci.yml never had that secret.
- **`release.yml`** (every tag push since v0.11.0) passed the env gate
  (token IS set as a release-only secret) but then failed on `ENOENT` for
  `examples/youtrack-morning-sweep.skill.md` — the file got moved to
  `examples/skillscripts/` in the housecleaning, and this one test was the
  straggler I missed when fixing other path references.

### Cut

`tests/v0.4.1-youtrack-proving.test.ts` was a development-time MCP proving
artifact, not part of the runtime contract. It depended on a live YouTrack
instance + a CI secret + a personal cloud subdomain. The other ~10 tests
that reference `youtrack` as a string fixture (allowlist, unwired-connector,
function-call rejection, object-iteration) don't need a real backend and
stay. The `examples/skillscripts/youtrack-morning-sweep.skill.md` skill
stays too — it's a user-facing example of a remote MCP connector wired
declaratively.

### Removed

- `tests/v0.4.1-youtrack-proving.test.ts` (entire file)
- `YOUTRACK_TEST_TOKEN` env block + comment in `.github/workflows/release.yml`
  Test step

### Operational hygiene

- The `YOUTRACK_TEST_TOKEN` GitHub repo secret should be deleted from repo
  settings (UI action — not scriptable from CI). Token itself stays valid
  in Scott's environment for ad-hoc local MCP probes if needed.

### Meta-lesson banked

The "ignorable YouTrack env-gate failure" note I'd carried across the v0.10
→ v0.13.1 arc was load-bearing on a false premise. The test was passing on
main pre-housecleaning when the token was set; the reorg broke it for a
*new* reason (path), and I conflated the two failure modes. Pattern:
when an unrelated change lands near a known-broken signal, re-classify
the signal — don't assume the failure mode is unchanged.

## 0.13.1 — 2026-05-29 — LocalModel shape alignment + stale-content cleanup

Per Scott review — LocalModel was the asymmetric contract. Other contracts
have fork templates; LocalModel had `*(coming)*` since v0.12 ("signal-driven").
Signal received. Plus the bundled `OllamaLocalModel` was silently defaulting
the model tag to `gemma2:9b` (may not be pulled on the adopter's Ollama);
that's the same silent-fallback footgun smell #5 fixed elsewhere.

### Added

`examples/connectors/LocalModelTemplate/` — fork-me skeleton for adopters
writing OpenAI-compat / Anthropic-compat / vLLM / TGI / SGLang / hosted-LLM /
any-other LocalModel substrate impls:

- `LocalModelTemplate.ts` — 2 stubbed methods (`run`, `manifest`) +
  `staticCapabilities`. Constructor throws so forks force customization.
- `README.md` — forking workflow, contract semantics (2-method LocalModel vs
  McpConnector's 1 + SkillStore's 8), `OllamaLocalModel` reference notes
  (timeout pattern, fetch_error surfacing, dedupe stderr), explicit note on
  why there's no `registerLocalModelClass()` equivalent (LocalModel is
  intrinsically singleton; adopters wire programmatically).

### Changed

- **`OllamaLocalModel.defaultModelTag` now required** when wiring via
  `substrate.local_model.config.defaultModelTag`. Was silently defaulted to
  `"gemma2:9b"` in `bootstrap.ts:buildLocalModelFromChoice` — that model may
  not be pulled on the adopter's Ollama instance, leading to opaque "model
  not found" errors at first dispatch. Now: clear bootstrap error pointing
  at the config knob (matches v0.10 Concern-1 cold-author UX pattern).
- **`examples/connectors/README.md` index** — LocalModel "(coming)" cell
  replaced with link to `LocalModelTemplate`. **All five connector contracts
  now have fork stories.**
- **OllamaLocalModel JSDoc refreshed** — removed stale "registers `default` /
  `gemma2` / `qwen`" references (that multi-instance wire was dropped in
  v0.10's defaultRegistry cleanup; nothing wires it that way anymore).
- **`scaffold/config.toml` LocalModel sections dropped** — stale references
  to multi-instance wire pre-v0.10. Replaced with a pointer at
  `connectors.json` substrate section + `docs/configuration.md`.

### Notes

- No new dependencies. No contract changes. No substrate-config parser
  changes.
- Adopters with `substrate.local_model: "ollama"` (bare short form, no
  config) will hit the new error pointing at `defaultModelTag`. Pre-adoption
  rule: cheap fix for any adopter (add the field).

## 0.13.0 — 2026-05-29 — code-smell sweep (5 surfaces, contract + runtime + connector tightening)

Quality-bar pass through five distinct smells (per Scott's review). All fixes
probed live; no behavioral surprises. Pre-adoption rule applies — TypeScript
contract changes are breaking for any adopter type annotations, but no
external adopters yet.

### Smell #3 — Contract drift (HIGH)

`ManifestInfo.manifest: Record<string, unknown>` and
`StaticCapabilities.features: Record<string, boolean>` were free-form. Adopters
reverse-engineered per impl; typos in `# Requires:` lint checks went
undetected.

- Discriminated `StaticCapabilities` union per kind (`SkillStoreCapabilities`,
  `MemoryStoreCapabilities`, `LocalModelCapabilities`, `McpConnectorCapabilities`,
  `AgentConnectorCapabilities`)
- Per-kind feature unions (closed-set, typo-safe at authoring time):
  `SkillStoreFeature` (5 flags), `MemoryStoreFeature` (7), `LocalModelFeature`
  (4 — added `supports_embedding`), `McpConnectorFeature` (3),
  `AgentConnectorFeature` (6)
- Parameterized `ManifestInfo<K>` with per-kind manifest interfaces
  (`SkillStoreManifest`, `MemoryStoreManifest`, `LocalModelManifest`,
  `McpConnectorManifest`) — curated known fields + `[key: string]: unknown`
  adopter-extension catch-all
- All 9 bundled connector impls + 3 fork templates updated to use per-kind
  return-type annotations on `staticCapabilities()` / `manifest()`

**5 pre-existing bugs caught + fixed** as the type system tightened:
- `supports_writes` (plural) vs `supports_write` (singular) divergence between
  features and manifest in 3 files (canonical now: `supports_writes` plural;
  manifest's duplicate dropped)
- `supports_embedding` flag was used but not in any union (added to
  `LocalModelFeature`)
- `MemoryStoreMcpConnector.features.supports_write` was substrate leakage at
  bridge layer (dropped; bridge inherits via `staticTools().includes("memory_write")`)
- `conformance.ts` had a dead `mode === "fts"` arm checking
  `supports_fts` flag that no connector ever declared
- `conformance.ts` indexed `caps.features` without discriminating the union;
  added `if (caps.connector_type !== "skill_store") return` guards

### Smell #4 — Inconsistent error surface (MEDIUM-HIGH)

`makeOpError(kind, msg)` was a 4-line shim returning bare `Error` with tacked-on
`opKind`. `buildExecutionError` special-cased `OpError instanceof` so
`makeOpError` outputs always lost the `remediation` surface. Plus bare
`throw new Error(...)` in `$append` validation. Plus inlined
`err instanceof Error ? err.message : String(err)` at 5 sites.

- **Dropped `makeOpError`**; 12 call sites now `throw new OpError(message, kind, remediation, target)` with real cold-author remediation strings
- **2 bare `throw new Error` in `$append`** validation → `OpError` (target initialization remediation)
- **`messageOf(err: unknown): string` helper** in `errors.ts`; 5 inlined
  `err instanceof Error ? err.message : String(err)` patterns consolidated
- **`local-model.ts` silent network catch fixed**: was
  `.catch(() => [] as string[])` that swallowed all failures + cached empty
  result forever; now surfaces `manifest.fetch_error: <message>` field on
  `LocalModelManifest`, doesn't cache on failure (retries next call), writes
  one deduped stderr warning per unique error. `fetchInstalledModels()` itself
  no longer swallows HTTP non-2xx either.

Cold author hitting `file_read` against a missing path now sees:
```json
{ "class": "OpError",
  "remediation": "Verify the path exists and is readable, or add `(fallback: \"default\")` to the op for graceful failure." }
```
(was `class: "Error"` with no remediation pre-v0.13.)

### Smell #5 — AgentConnector asymmetric default (MEDIUM-HIGH)

`getAgentConnector` silently returned `NoOpAgentConnector` when nothing was
wired (other `get*` methods throw). `getAgentConnectorClass` had `NoOp as unknown as
AgentConnectorClass` cast that masked any interface drift.

- **`getAgentConnector(name?)` now throws** on missing — symmetric with
  `getSkillStore` / `getMcpConnector` / etc.
- **`getAgentConnectorOrDefault(name?)`** — explicit opt-in for NoOp
  fallback (used by runtime dispatch paired with `hasAgentConnector()` check
  to flag `delivery_skipped`)
- **`getAgentConnectorClassOrDefault(name?)`** — direct typing; no `as unknown
  as` cast. If `NoOpAgentConnector` ever drifts from `AgentConnectorClass`,
  the compiler reports it.

Runtime behavior on the wire is unchanged (NoOp dispatch still records
`delivery_skipped: true` with remediation); the registry surface is now
explicit about which path the caller chose.

### Smell #7 — SqliteSkillStore: silent REGEXP fallback + fragile transactions (MEDIUM)

`node:sqlite` doesn't ship with REGEXP. Pre-v0.13 query path tried `name REGEXP`
in SQL, caught the failure, rebuilt the query without REGEXP, and did a JS-side
regex over a full table scan. Operator had no idea the index was bypassed.
Plus three near-identical BEGIN/COMMIT/ROLLBACK blocks.

- **REGEXP support probed once at construction**. When unsupported: write
  stderr warning, set internal flag, fall back to JS-side filter proactively
  (no try/catch on every query), surface `manifest.regexp_fallback_active:
  true` for `runtime_capabilities` discovery
- **`withTransaction<T>(fn: () => T): T` helper** consolidates the three
  transaction blocks (`store()`, `delete()`, `update_status()`). The "ROLLBACK
  after a successful COMMIT throws" edge case lives in the helper, documented
  once
- **`delete()`'s post-commit `SkillNotFoundError` throw moved outside** the
  transaction (it's reporting on commit completion, not a rollback condition)
- **`skillRow` JSDoc documents** the cascade-delete ambiguity (can't
  distinguish "never existed" from "deleted between calls" — fundamental
  limitation under hard-cascade)

### Smell #8 — SqliteMemoryStore: FTS gotchas (MEDIUM)

`domain_tags` filter was a post-FTS JS substring scan on the JSON tags column
(linear, wrong-ranked). `sanitizeFtsQuery` wrapped every token in quotes
including operators — `"a OR b"` became literal phrase search for the word "OR",
silently breaking FTS5 boolean syntax.

- **Normalized `memory_tags(memory_id, tag)` relation** + `(tag)` index. Tag
  filter pushed into SQL via `EXISTS` join. One-time backfill on bootstrap
  from existing JSON when relation is empty + memories has tags-bearing rows
  (adopter migrations from earlier versions are automatic)
- **Semantic change**: tag filter is now **exact match** (was substring); tag
  `"production"` no longer matches `"production-staging"`. Surfaced in
  manifest as `tag_filter_semantic: "exact match via indexed memory_tags
  relation"`
- **`raw:` prefix escape hatch** for FTS5 boolean syntax: `raw:foo OR bar`
  passes through verbatim; caller takes responsibility for FTS5 syntax
  correctness. Default sanitizer behavior accurately documented:
  phrase-tokens, boolean ops disabled. Surfaced in manifest as
  `fts_query_semantic: "phrase-tokens (boolean ops disabled); use raw: prefix
  for FTS5 syntax"`

### Test surface

1271/1272 tests passing (YouTrack env-gate only, pre-existing). New tests
across the 5 smell-fix arcs all green. LOC narrow-core 9300 → 9550 (~150 LOC
of contract / connector tightening; `types.ts` per-kind unions + manifest
interfaces dominate).

### Notes

- No new dependencies. No connector contract additions beyond the type
  refinement. No substrate-config changes.
- Every fix was probed live before commit — file_read OpError surface; Ollama
  fetch_error field; SqliteSkillStore REGEXP fallback warning + manifest
  field; memory_tags exact match + raw: escape; AgentConnector symmetric
  throw + OrDefault opt-in.

## 0.12.0 — 2026-05-28 — McpConnectorTemplate fork skeleton + McpConnector contract audit

Closes the v0.10–v0.12 connector-house-in-order arc. Same pattern as v0.10
(SkillStore) and v0.11 (MemoryStore): contract audit (clean — no plumbing
changes) + fork skeleton in `examples/connectors/`. McpConnector already
had four bundled impls; this fills the adopter-fork discoverability slot.

### Added

`examples/connectors/McpConnectorTemplate/` — fork-me skeleton for adopters
writing transports the four bundled impls don't cover (direct HTTP MCP,
WebSocket MCP, in-process, custom protocol):

- `McpConnectorTemplate.ts` — two stubbed methods (`call`, `manifest`) +
  `staticCapabilities`. Optional `staticTools()` + `fromConfig()` commented
  out with usage guidance. Constructor throws so forks force customization.
- `README.md` — when to fork (vs. using `RemoteMcpConnector` for stdio
  bridging), forking workflow including `registerConnectorClass()` pattern
  for `connectors.json` JSON-instantiability, `call()` semantics, staticTools
  lint integration, McpConnector vs. SkillStore/MemoryStore differences.

### Updated

`examples/connectors/README.md` index — McpConnector "(coming)" replaced
with McpConnectorTemplate link. **All five connector contracts now have
fork templates or worked examples.** LocalModel is the only remaining
"(coming)" slot — adopter signal-driven from here.

### Audit findings (McpConnector-as-connector)

Same shape as the v0.10 + v0.11 audits. Walk:

| Layer | Pluggable? | Evidence |
|---|---|---|
| `McpConnector` interface | ✓ substrate-agnostic | types.ts:319-326 — 2 methods, no transport leakage |
| Registry | ✓ | `Registry.registerMcpConnector(name, instance, allowedTools?)` |
| Runtime consumers | ✓ interface-typed | runtime.ts:919-963, lint.ts:2641-2663, dispatch-validate.ts:55-77, skill-manager.ts:261, mcp-server.ts:753 |
| Adopter class extensibility | ✓ | `registerConnectorClass()` (v0.7.3); already in place |
| Class-aware lint | ✓ intentional | `getMcpConnectorCtor()` / `getMcpConnectorClass()` for `staticTools()` dispatch validation — not leakage |
| `connectors.json` JSON-instantiability | ✓ | `fromConfig` factory pattern documented in template |

No plumbing changes needed. McpConnector's substrate-agnostic claim was
already true; v0.12 just makes the adopter-fork path discoverable.

### The connector-house-in-order arc — what landed

| Version | Contract | What shipped |
|---|---|---|
| v0.9.6 | AgentConnector | Audit (Q1-Q12) + contract lock |
| v0.9.7 | AgentConnector | `HttpWebhookAgentConnector` worked example in `examples/connectors/` |
| v0.10 | SkillStore | Audit + `SqliteSkillStore` bundled default in `src/connectors/` + `connectors.json` substrate section + `SkillStoreTemplate` fork skeleton |
| v0.11 | MemoryStore | Audit + `MemoryStoreTemplate` fork skeleton (SqliteMemoryStore was already bundled since v0.8) |
| v0.12 | McpConnector | Audit + `McpConnectorTemplate` fork skeleton (4 bundled impls already covered the common patterns) |

Five connector contracts; four have adopter-fork stories complete
(SkillStore + MemoryStore + AgentConnector + McpConnector). LocalModel
remains "(coming)" — signal-driven.

### Notes

- No new dependencies. No CLI changes. No substrate-config changes.
- McpConnector has no `substrate` slot in `connectors.json` by design —
  the contract is intrinsically *instanced* (`youtrack`, `github`, `jira`,
  ...), not singleton. Per-instance config via top-level `connectors.json`
  keys is the right shape.
- Auto-wired bridges (`llm`, `memory`, `memory_write`) continue to fire when
  their substrates are configured — unchanged behavior.

### Up next

- Adopter-signal-driven LocalModel template, if a deployment wants something
  other than Ollama
- Tradita-internal work still floating (NanoClaw extraction)
- Dogfood adopter ramp

## 0.11.0 — 2026-05-28 — MemoryStoreTemplate fork skeleton + MemoryStore contract audit

**Per Perry's audit thread `6b442259`.** Symmetric to v0.10's SkillStore work:
contract audit (clean — no plumbing changes) + fork-template skeleton in
`examples/connectors/`. SqliteMemoryStore stays in `src/` as the bundled
default (already there since v0.8; no restructure needed).

### Added

`examples/connectors/MemoryStoreTemplate/` — fork-me skeleton for adopters
writing their own MemoryStore impl (Pinecone-, Weaviate-, AMP-,
Postgres-backed, etc.):

- `MemoryStoreTemplate.ts` — three stubbed methods (`query`, `write`,
  `manifest`) + `staticCapabilities()`. Constructor throws so forks force
  customization. TypeScript-clean via `async fn(): Promise<X> { throw }`.
- `README.md` — forking workflow, contract-surface explanation (3-method
  contract vs SkillStore's 8), curated-subset PortableMemory field model,
  query mode dispatch axis, filter conventions, MemoryStore vs SkillStore
  differences, conformance-suite integration.

### Audit findings (MemoryStore-as-connector)

Same shape as v0.10's FilesystemSkillStore-as-connector audit (`fa8091cc`).
Walk findings:

| Layer | Pluggable? | Evidence |
|---|---|---|
| `MemoryStore` interface | ✓ substrate-agnostic | types.ts — 3 methods, no `sqlite`/`fts5`/path leakage; curated-subset field model in `PortableMemory` |
| Registry | ✓ | `Registry.registerMemoryStore(name, instance)` — registry.ts:66 |
| Runtime consumers | ✓ interface-typed | mcp-server.ts:748, skill-manager.ts:259, runtime.ts:1048 |
| Bootstrap | ✓ opts-configurable | `opts.memoryStore?: MemoryStore` (v0.10); falls back to `new SqliteMemoryStore` only when no override |
| MCP bridge | ✓ interface-typed | `MemoryStoreMcpConnector` constructor takes `MemoryStore` interface |
| CLI / `defaultRegistry()` | hardcoded to SqliteMemoryStore | by design — reference-deployment convenience; adopter-custom paths skip |

Verdict: contract layer is genuinely connector-pluggable. Same architecture
promise that v0.10 established for SkillStore now confirmed for MemoryStore.
No plumbing work needed.

### Updated

`examples/connectors/README.md` — index table: MemoryStore "(coming)" cell
→ link to MemoryStoreTemplate. Three connector contracts now have a fork
template (SkillStore, MemoryStore) or worked example (AgentConnector); two
still pending (LocalModel, McpConnector).

### Notes

- No `docs/sqlite-memory-store.md` shipped. SqliteMemoryStore's surface
  (single table + FTS5 virtual + triggers) is documented in source comments;
  the MemoryStoreTemplate README covers adopter-relevant context. Will write
  if adopter signal demands more depth.
- No new dependencies. No substrate-config parser changes (v0.10 already
  shipped `substrate.memory_store` short/object/custom forms). No CLI
  changes.

### Up next

- **v0.12** — McpConnector audit (per the connector-house-in-order arc)
- Potential follow-ups: LocalModel template + McpConnector template per
  adopter signal

## 0.10.0 — 2026-05-28 — SqliteSkillStore bundled default + connectors.json substrate section

**Per Perry's audit thread `2a674169` + Scott's re-scope direction 2026-05-28
("MCP and dashboard MUST honor the configuration that skillscript is built at").**
First within-contract substrate-portability ship for SkillStore. SqliteSkillStore
ships as a bundled default in `src/connectors/` (parallel to `SqliteMemoryStore`
precedent), wired via `connectors.json` substrate section so MCP server +
web dashboard honor whichever leg the deployment configures.

### Added

**`src/connectors/sqlite-skill-store.ts`** — `SqliteSkillStore` bundled default
(promoted from examples/ after Scott's re-scope; pattern parallel to
`SqliteMemoryStore`):

- Two-table schema: `skills` (current-state fast path) + `skill_versions`
  (append-only history with full body bytes per version)
- WAL journal mode at bootstrap (concurrent readers don't block writers)
- Transactional status transitions: `update_status()` wraps UPDATE skills +
  INSERT skill_versions in BEGIN/COMMIT (`supports_atomic_status_transitions: true`,
  the SQL advantage over FilesystemSkillStore)
- Tag filtering via `json_extract(metadata_json, '$.tags')` (O(n) table scan
  documented in `manifest()`)
- `delete()` hard-cascade: removes both `skills` row + `skill_versions` rows.
  Footgun-guard documented on the README + JSDoc
- `load(name, version)` returns historical bytes (substrate-portability gain
  over FilesystemSkillStore which only retains current bytes)
- 49 tests including the framework-agnostic `SkillStoreConformance.buildTests()`
  suite — same suite that validates FilesystemSkillStore, so adopter forks get
  drift-detection for free

**`docs/sqlite-skill-store.md`** — three-leg model docs (FS / Sqlite /
adopter-custom), programmatic-embedding framing, schema overview, footgun-guard,
forking checklist for adopters writing their own SkillStore impl.

**`substrate` section in `connectors.json`** — singleton substrate config for
SkillStore / MemoryStore / LocalModel. Three forms per slot:

```json
{
  "substrate": {
    "skill_store": "sqlite",
    "memory_store": "sqlite",
    "local_model": null
  }
}
```

- Short form (`"sqlite"`, `"filesystem"`, `"ollama"`, `null`) wires bundled
  defaults with sensible defaults
- Object form (`{type, config}`) overrides config (e.g., custom dbPath)
- Custom form (`{type: "custom", module, export, config}`) declares an
  adopter-written impl. **v0.10 limitation**: sync `bootstrap()` can't
  dynamic-import; custom-via-connectors.json surfaces a clear error and falls
  back to default. Adopters wanting custom impls write a programmatic
  bootstrap (existing pattern, no change). Future: async bootstrap supporting
  custom impls.

Precedence: programmatic opts (`opts.skillStore`) > substrate config > built-in
default.

### Changed — base config

Per Scott's "base config" framing (2026-05-28):

| Substrate | v0.9.x default | v0.10 default |
|---|---|---|
| SkillStore | FilesystemSkillStore | FilesystemSkillStore (unchanged) |
| MemoryStore | SqliteMemoryStore (conditional) | SqliteMemoryStore (conditional) (unchanged) |
| LocalModel | **3 Ollama models pre-wired** | **null** (adopter wires explicitly) |
| McpConnector | null + `llm`/`memory` bridge auto-wire when substrate exists | same |
| AgentConnector | null | null (unchanged) |

The Ollama default cleanup: previously `defaultRegistry()` registered three
OllamaLocalModel instances against `localhost:11434` unconditionally. They'd
fail at `run()` if Ollama wasn't actually running on the machine. v0.10
removes the unconditional registration — adopters who want Ollama wire it via
`substrate.local_model: "ollama"` (or `opts.localModel` programmatically).
Removes the "registered-but-broken" footgun.

### Audit findings (FilesystemSkillStore-as-connector)

Audited per the v0.10 scope addition: is SkillStore genuinely
connector-pluggable? Result: YES at the runtime layer.

- `Registry.registerSkillStore(name, instance)` exists (registry.ts:62) and is
  the canonical adopter-facing wire-up
- All runtime consumers (mcp-server, scheduler, lint, composition,
  skill-catalog) take the `SkillStore` interface, not a concrete impl
- `FilesystemSkillStore` lives in `src/connectors/` as the bundled default,
  no hardcoded references in runtime code paths
- The only hardcoded sites are the CLI (`src/cli.ts` — 5 sites) and
  `bootstrap.ts:defaultRegistry()`. Both are *reference-deployment helpers*;
  adopter-custom paths skip them entirely

No plumbing work needed. The architecture promise ("pluggable") is real.

### Scope decisions

- **CLI widening walked back** (`b574e4f2`). Initial proposal: env-var-driven
  `SKILLSCRIPT_SKILL_STORE=sqlite` config in the CLI. Walkback per Perry's
  use-case analysis: CLI is fundamentally a filesystem-first authoring tool
  (vim → lint → compile loop). Sqlite-first and adopter-custom users author
  via dashboard or `skill_write` MCP, never CLI. The widening served a phantom
  use case. Future tension at `skillfile dashboard` / `skillfile serve` flagged
  but not acted on — wait for dogfood signal
- **Cascade delete locked** over preserve-versions. Pre-adoption rule wins;
  soft-delete is the upgrade path if adopter signal demands audit-grade
  retention later
- **Two SQLite databases by default** for adopters who want zero-external-dep
  bundled storage: one for skills (this connector), one for memories
  (`SqliteMemoryStore`, already bundled — v0.11 will restructure as example)

### Lesson banked

When framing a surface-change decision as "narrow vs wider", do the use-case
analysis FIRST. Ask "who uses this surface and for what?" before sizing the
trade-off. Without that step, you size trade-offs for use cases that don't
exist (the CLI widening was solving for "Sqlite user wants to run `skillfile
compile`" — a user that doesn't exist; they author via dashboard).

### Up next

- **v0.11** — MemoryStore audit + SqliteMemoryStore restructure as example connector
- **v0.12** — McpConnector audit
- Dogfood after v0.12

## 0.9.9 — 2026-05-28 — categorization rule fix (v0.9.8.1 thematic patch)

**Per Perry's `ec74e5fd` test-pass.** v0.9.8 shipped a derivation rule with a
gap: skills with text/file/none output AND no autonomous triggers were
landing in `headless` instead of `skills`. Cold agents calling `skill_list()`
at session start couldn't see this common skill class — `hello`,
`cut-release-tag`, agent-callable analyzers, etc.

### Fixed

Derivation rule grew an "agent-invokable inference" branch:

```
ANY output[i].kind === "agent"        → "augmenting"
else ANY output[i].kind === "template" → "template"
else IF no autonomous triggers        → "template" (agent-invokable inference)
else                                  → "headless"
```

The trigger-presence check disambiguates:
- text/file/none output + NO triggers = "I expect to be invoked" → `skills`
- text/file/none output + cron/session/event triggers = "I fire myself" → `headless`

Verification table:
- `cut-release-tag` (output=text, no triggers) → Template ✓ (was Headless)
- `hello` (output=[], no triggers) → Template ✓
- `analyzer` (output=[], no triggers) → Template ✓
- `queue-length-monitor` (output=[], cron trigger) → Headless ✓ (unchanged)
- `service-health-watch` (output=none, cron trigger) → Headless ✓ (unchanged)
- `morning-brief` (output=agent, cron trigger) → Augmenting ✓ (unchanged)
- `classify-support-ticket` (output=agent, no triggers) → Augmenting ✓ (unchanged)

### Process note pinned

Perry's `ec74e5fd` flagged that v0.9.8 pushed without her pre-push test pass
— deviation from the v0.9.6/v0.9.7 "share in shared → test pass → push"
pattern. The probe-pass-finds-bug here would have caught this pre-push.
The pattern is load-bearing even when discipline is high; v0.9.9 onward,
hold the push until Perry's signal.

### Lesson banked

When tightening a derivation rule to handle a new dimension (multi-output),
re-walk the original cases to verify they still resolve correctly. Same
shape as `1bc9d7a2` (multi-layer-check-inconsistency) at the derivation-rule
layer: lose a branch silently, faithful downstream impl misses it, only
catches at wire-surface probe.

## 0.9.8 — 2026-05-28 — skill_list evolution → SkillCatalog (agent-facing discovery)

**Per Perry's audit thread `f0b8b832` + addendum `73c79a28` + lock `011feaf0`.**
`skill_list` returns a pre-grouped `SkillCatalog` so cold agents reading at
session start see immediately "what pushes to me" vs "what I can invoke."

### Wire shape changes (BREAKING — pre-adoption rule)

`skill_list` response shape changed from `SkillMeta[]` (flat array) to
`SkillCatalog` (pre-grouped object):

```typescript
interface SkillCatalog {
  receives?: SkillEntry[];   // augmenting (# Output: agent:)
  skills?: SkillEntry[];     // template (# Output: template:) + agent-invokable
  headless?: SkillEntry[];   // no agent/template output; present when audience filter allows
}

interface SkillEntry {
  name: string;
  category: "augmenting" | "template" | "headless";
  description: string;
  status: SkillStatus;
  vars: Array<{ name: string; required: boolean; default: string | null }>;
  output: Array<{ kind: "agent" | "template" | "text" | "file" | "none"; target?: string }>;
  triggers: Array<
    | { kind: "cron"; expression: string }
    | { kind: "session"; phase: "start" | "end" }
    | { kind: "webhook"; path?: string }
    | { kind: "event"; event_type: string }
  >;
}
```

### Category derivation

From existing `# Output:` semantics — no new frontmatter syntax. Multi-output rule:

```
ANY output[i].kind === "agent"    → "augmenting" (surfaces in `receives`)
else ANY output[i].kind === "template" → "template" (surfaces in `skills`)
else                              → "headless"   (surfaces only when audience filter allows)
```

### Filter mechanism (AND-composed)

```typescript
interface SkillListFilter {
  audience?: "agent" | "all" | "headless";  // default "agent"
  status?: SkillStatus;                      // default "Approved"
  trigger_kind?: "cron" | "session" | "webhook" | "event";
  domain_tags?: string[];                    // AND-match
  name_prefix?: string;                      // adopter-side scoping
}
```

### Vars rendering (per addendum `73c79a28`)

| `# Vars:` frontmatter | Rendered entry |
|---|---|
| `NAME` (bare) | `{ name: "NAME", required: true, default: null }` |
| `NAME=value` | `{ name: "NAME", required: false, default: "value" }` |
| `NAME=` (equals, empty value) | `{ name: "NAME", required: false, default: "" }` |

### Footnote pinned in SkillEntry doc-comment

*"Invocation is independent of discovery grouping. `execute_skill(skill_name="X")`
works regardless of whether X surfaced in `receives` or `skills`. Discovery
grouping is signal, not gating."*

### Added

- `src/skill-catalog.ts` — `buildSkillCatalog()` + category derivation +
  vars/outputs/triggers rendering helpers (~160 LOC; auxiliary surface, not narrow-core)
- `src/connectors/types.ts` — `SkillCatalog`, `SkillEntry`, `SkillListFilter` interfaces
- `tests/v0.9.8-skill-catalog.test.ts` — locked-shape coverage (category derivation,
  vars rendering, triggers union, filter composition, audience grouping, Q2 footnote)

### Migration

- `mcp__skillscript__skill_list` callers consuming the flat-array shape break.
  Pre-adoption rule applies; no shipped adopters.
- Bundled dashboard updated to flatten the grouped response for its existing
  table view.

### LOC ceiling

Bumped narrow-core 8550 → 8650 for the new contract types in `connectors/types.ts`.
Fourth bump in v0.9.x; consolidate-first signal stands but new contract surface
isn't consolidatable.

## 0.9.7 — 2026-05-27 — HttpWebhookAgentConnector example impl

**Q5 deliverable from the v0.9.6 audit** (`df34313e`). Bundled example
AgentConnector for HTTP-webhook substrates — the canonical worked example
adopter agents read + fork when wiring their own substrate. Lives in
`examples/connectors/` (outside narrow-core LOC budget per audit decision).

### Added

- **`examples/connectors/HttpWebhookAgentConnector/`** — full directory:
  - `HttpWebhookAgentConnector.ts` — the connector class with strict input
    validation in `fromEnv()` (NaN-guard on timeout, agents-shape validation,
    required-url enforcement). Validation pattern is intentionally educational
    for adopter forks.
  - `README.md` — canonical reference for adopter agents. Documents Models
    A/B/C deployment shapes (URL-routed / body-routed / variable-substituted),
    wire format, auth (bearer + HMAC combinable), forking discipline.
  - `.env.example` — nested JSON config + bearer + HMAC stubs.
  - `receiver-example/express.js` + `flask.py` — reference receiver snippets
    with HMAC raw-body validation pattern (validate BEFORE parse).
  - `tests/HttpWebhookAgentConnector.test.ts` — 32 tests, mock HTTP server
    (Node built-in `http.createServer`, zero external deps).

### Design choices documented

- **Wire body includes `agent_id` at top-level** alongside the canonical
  `DeliveryPayload` shape — extension to the wire format the
  HttpWebhookAgentConnector defines (not the contract itself). Enables Model
  B router-receivers to dispatch without URL inspection. Optional for
  Model-A-only deployments.
- **Receipt synthesis is permissive** — tolerantly parses substrate-specific
  response shapes (NanoClaw `{status, id}`, Discord message JSON, Slack
  `{ts, channel}`, empty body) into canonical `DeliveryReceipt`. Adopters
  with strict shape replace `synthesizeReceipt()`.
- **Three deployment models** without code branching:
  - Model A: one URL per agent_id (URL-routed)
  - Model B: single URL, router receiver, agent_id in body
  - Model C: variable-driven channel selection in the skill
    (`notify(agent="agent-${CHANNEL}", ...)`)

### Out of scope (fork to add)

Retries, multi-region failover, OAuth/mTLS/SAML auth, streaming deliveries,
async-callback `request_response()` reply pattern (v0.10 design choice).

### Per Perry's `3f04b413` code review

Two adopter-footgun catches landed before push (fromEnv `timeout_ms` NaN guard,
agents JSON shape validation); five optional polish items (option naming
consistency `auth_header`→`authorization`, README softening on Model-A vs
Model-B forking, Bearer+HMAC combinability note, malformed receiver JSON test,
`client_validation` cause_kind enum) absorbed in the same patch.

## 0.9.6 — 2026-05-27 — AgentConnector audit + contract lock for v1.0

**First connector contract audit + lock for v1.0** per Perry's thread `b722bbf4`.
Closes Q1-Q12 across three pressure-test rounds (sender/substrate lens →
agent-as-receiver lens → full code-audit reconciliation). Opens the
"connector house in order" gate-3 sequence; remaining contracts (McpConnector,
SkillStore, MemoryStore, LocalModel) audit + lock in subsequent v0.9.x slots.

### Contract changes (`src/connectors/agent.ts`)

- **Added `DeliveryMeta` envelope** on both `DeliveryPayload` variants (Q8).
  Runtime auto-fills `dispatch_id` (UUID per emit), `sent_at` (emit-clock),
  `origin.skill_name` / `origin.trigger_kind` (required); optional
  `origin.entry_skill_name`, `origin.caller_agent_id`, `event_type`,
  `correlation_id` populate when context provides them.
- **Added `health_check()` required method** (Q6). Bootstrap-throws on `false`
  via `registerAgentConnector()` — wiring failures surface at boot, not at
  first skill-fire.
- **Added `request_response()` required method** (Q1) with locked `Response`
  shape `{ correlation_id, content, sent_at, agent_id }`. Impl deferred to
  v0.10 when `exchange()` op ships; adopters throw `NotImplementedError`
  until then.
- **Added `delivery_skipped?: boolean`** to `DeliveryReceipt` (Q7). Contract-
  level signal for "accepted but not pushed" (offline agent, rate-limit drop,
  etc.); runtime honors connector-set value, preserves NoOp fallback inference.
- **Dropped `manifest()`** (Q2). No production callers; folded into
  conformance test surface.
- **Dropped `TriggerProvenance`** interface (Q12) and its envelope fields
  (`source_skill`, `triggered_by`, `delivery_context`, `templates`, `format`).
  Each folded into `meta` per Q8-Q11 or dropped to trace-only surface.

### Syntax changes

- **`# Delivery-context:` → `# Event-type:` frontmatter rename** (Q9). Vocab
  consistency between skill-author and receiver-agent surfaces; the field
  flows to `meta.event_type` as the frontmatter fallback (`notify(event_type=...)`
  kwarg takes precedence per-emit).
- **`notify()` op gains `event_type=` and `correlation_id=` kwargs**. Per-emit
  override of frontmatter; `correlation_id` is the reply-correlation primitive
  for the v0.10 `exchange()` shape.

### Behavior changes

- `Registry.registerAgentConnector()` is now `async` — invokes `health_check()`.
- `triggerCtx.source` enum migrated from `{cron, session, event, agent-event, file-watch, sensor, manual}` to Q8's `{cron, session, webhook, agent, cli, dashboard, inline}`. The pre-v0.9.6 "extra" values were parse-only (no production firing path emitted them). `manual` → `inline` is the only meaningful migration.
- `# Templates:` frontmatter still parsed for `unknown-template-reference` lint
  but no longer flows through `DeliveryPayload` (Q10 — vestigial removal).

### Deliverables

- New `docs/connector-contract-reference.md` — canonical reference for adopters
  (audience: adopter agents). Includes the four footnotes Perry pinned during
  the audit (broadcast dispatch_id semantics, deeper-than-2-level chain elision,
  caller_agent_id general rule, sent_at vs delivered_at distinction).
- Updated `docs/adopter-playbook.md` AgentConnector method list.
- Updated `docs/language-reference.md` AgentConnector + DeliveryPayload sections.
- New `tests/v0.9.6-agent-connector-audit.test.ts` (15 tests covering Q1-Q12);
  includes Perry's plumbing-risk SHAPE test for `entry_skill_name` propagation
  (cites lesson `1bc9d7a2`).

### Pre-adoption migration

Pre-adoption rule applies (no external users); breaking changes are cheap.
Adopters who experimented against pre-v0.9.6 code:

- Drop `manifest()` from AgentConnector impls.
- Add `health_check()` + `request_response()` (throw NotImplementedError until v0.10).
- Replace `source_skill` / `triggered_by` / `delivery_context` / `templates` /
  `format` payload field reads with `meta.origin.*` / `meta.event_type` reads.
- Rename `# Delivery-context:` → `# Event-type:` in skill source.

### Methodology lesson (per Perry, worth banking)

*"Contract audits compound. Each pressure-test pass before lock has near-zero
cost; each pass after adoption has near-infinite cost. Spend pre-lock budget
liberally."* Three pressure-test rounds (Q1-Q7 → Q8 → Q9-Q12 audit-reconciliation)
each caught real gaps the previous round missed. The pre-adoption rule made
the discipline cheap; the audit-as-methodology made the pass-count load-bearing.

### LOC ceiling

Bumped narrow-core from 8300 → 8500. Third bump in the v0.9.x series — per §18
note, the "consolidate first" threshold. Most of the ~150 net LOC growth is
doc-comments on `agent.ts`; per the `adopter-agent-as-author` memory,
reference impls are the dominant signal source for adopter agents, so
docstring richness is load-bearing.

## 0.9.5 — 2026-05-27 — lint polish (v0.9.4.1 thematic patch)

**Two mechanical lint fixes from Perry's R-series next-ring (`77ed6c65`).**
Standalone patch ahead of the AgentConnector audit work — keeps
contract-design surface separate from cold-author polish per the
thematic-discipline pattern that worked through v0.9.x. No contract
surface touched; v1.0 cold-author signoff (mean UX 4.0/5 against
v0.9.4) still stands as the gate-1 baseline.

### Fixed — fallback-trailer lint-layering

Cold authors expected `(fallback: ...)` on a bare `$ TOOL` op to
suppress the tier-1 `unwired-primary-connector` error (the intuition:
"if I provide a fallback, the runtime is guarded"). It didn't — lint
runs at authoring-time and fallback resolves at dispatch-time, so the
error fired regardless of fallback presence. The layering wasn't
obvious from the diagnostic.

Fix: when every call site for a `(target, tool)` pair carries an
op-level `(fallback: ...)` trailer, demote the finding from `error`
to `info`. The advisory message explains the layering ("Lint runs at
authoring-time and the fallback resolves at dispatch-time; the
runtime branch is reached only if dispatch fails in production"). If
any call site lacks a fallback, the error stays. Per R8 cold-author
finding in `77ed6c65`.

### Fixed — forward-reference noise dedup

Pre-v0.9.5 lint emitted up to 4 diagnostics for 2 missing skills:
`unknown-skill-reference` keyed by `via:name` (so the same missing
skill referenced via both `&` and `$ execute_skill` produced 2
findings) AND the paired `deferred-skill-reference` advisory doubled
the count. Per Perry's "4 diagnostics for 2 missing skills" cold-author
finding — noisy without adding signal.

Fix:
- `unknown-skill-reference` now dedups by skill name (not `via:name`);
  the message lists all vias encountered.
- `deferred-skill-reference` advisory removed entirely — the warning's
  remediation field already explains the forward-ref path. One warning
  per missing skill carries the same signal.

Net: 2 missing skills × dual-ref produces 2 findings (down from 8).
Cold author noise floor reduced; pre-adoption rule applies (no
external migration needed).

## 0.9.4 — 2026-05-27

**Cold-author cleanup cluster — N1–N8.** Closes the next ring of findings
surfaced by Perry's R8 + qwen re-validation against v0.9.3
(memory `9086b3f8`). Mean UX delta from 3.86/5 → projected 4+/5,
clearing the v1.0 cold-author signoff threshold.

### Fixed — N1 `approved=` kwarg suppresses unconfirmed-mutation lint

Docs explicitly list `approved="reason"` as one of three valid
authorization paths for the `unconfirmed-mutation` lint, but the
parser only populated `op.approved` for function-call ops — `$` op
kwargs were captured in `op.body` as a string and the lint rule
checked `op.approved` (which was undefined). So `$ memory_write ...
approved="..."` failed the docs-promised suppression silently.

Fix: parser extracts `approved="..."` (and `approved='...'`) from `$`
op bodies via `extractApprovedKwarg()` and populates `op.approved`
explicitly. Per R8 minion #4 finding.

### Fixed — N2 `$append STRING_VAR <"line">` strips operator chars

The angle-bracket-arrow `<value>` is the canonical APPEND operator,
but the parser captured the brackets as part of `setValue` for the
string-target concat case. Authors writing
`$set REPORT = ""` then `$append REPORT <"line 1">` got
`<"line 1">` embedded literally in the report — silent wrong output.

Fix: parser strips outer `<...>` from `$append` value capture before
calling `processSetValue`. List-append back-compat preserved. Per R8
minion #3 finding.

### Added — N3 `transcript-footgun` tier-2 lint

`${R.transcript}` against a composition-result var reads as
"human-readable text" but is actually the child skill's emissions
array — interpolation produces JSON-ish array stringification.

Tier-2 warning when `${VAR.transcript}` appears in any substitution
position. Remediation: bind explicitly via `final_vars.NAMED_VAR`,
use `outputs.text` (joined string), or iterate `foreach LINE in
${R.transcript}:` to consume per-line. Per R8 minion #6 finding.

### Added — N5 `set-json-literal-advisory` tier-3 lint

`$set VAR = [{...}]` binds the literal string form, not a parsed
JSON structure. Skillscript's `$set` is literal-only — JS-class
object/array literals don't auto-parse. Cold authors hit this when
mocking structured data inline.

Tier-3 advisory. Suggests `$ json_parse '[{...}]' -> VAR` for
structured-array intent.

### Added — N8 `skill-name-collision` tier-3 lint

When `lint_skill` is called with a `skillStore` and the parsed
skill's name already exists in the store, surface a tier-3 advisory
so cold authors don't round-trip to discover the conflict at
`skill_write` time.

### Changed — N4 docs: shell() argv quoting + N6 FS isolation

`help({topic:"ops"})` shell() section now documents the structural-
spawn quote-stripping behavior (workaround: `unsafe=true` for
quoted-arg-aware bash, or write-then-read via file_write). Plus
explicit container FS isolation note matching file_read/file_write.

### Changed — N7 docs: `${ARRAY|length}` not `${ARRAY.length}`

`help({topic:"examples"})` per-substrate return-shape note now
explicitly says: use the `|length` filter for collection counts; JS
convention `.length` doesn't work (dotted-ref resolver does string-
keyed property descent). Closes the qwen Test B substitute-
hallucination (`.totalCount` → `.length`).

### Notes

- 11 new tests (`v0.9.4-cleanup.test.ts`).
- Suite at 1116/1127 passing, 10 skipped, 1 baseline YouTrack env-gated.
- Narrow-core LOC ceiling bumped 8200 → 8300 to accommodate the parser
  + lint additions. Per `feedback-loc-vs-clarity`: ceiling is a
  signal, not a budget.
- v1.0 cold-author signoff is the next milestone — R8 + qwen re-run
  against v0.9.4 validates the empirical bar.

## 0.9.3 — 2026-05-27

**Deferred design calls — P1.2 + P1.3.** Closes the last two items in
Perry's locked v0.9.x sequencing (`c9c667d2`). Two tier-2 lint
additions, no parser or runtime surface changes — design calls landing
as guardrails rather than language extensions.

### Added — `numeric-subscript` lint (P1.2)

Cold authors hit `${LATEST.items.0}` expecting indexed array access;
the substitution resolver's dotted descent does string-keyed property
access which works on JS arrays for direct single-step subscript but
fails silently on multi-segment refs. Per R8 minion #5 finding in
`dec3ca8a`.

- **Tier-2 warning `numeric-subscript`** fires when a `${VAR.N...}`
  ref has any numeric segment after the var name.
- **Remediation**: use `foreach IT in ${VAR}:` for iteration, or
  `${VAR|first}` for first-only, or bind via `$ json_parse` against
  parsed JSON for true indexed access.
- **Design call**: numeric subscripts NOT promoted to first-class
  syntax. Would conflict with dotted-field-access semantics when JSON
  keys are numeric strings; foreach is the canonical shape.

### Added — `deprecated-addressed-to` lint (P1.3)

`$ memory_write` docs mixed `recipients=["agent"]` (array, plural) and
`addressed_to="agent"` (string, singular) across the quickstart vs
connectors topic. The bundled `MemoryStoreMcpConnector` only ever read
`recipients=[...]` — `addressed_to=` parsed but silently dropped.
Per R8 minion #4 finding in `dec3ca8a`.

- **Tier-2 warning `deprecated-addressed-to`** fires on
  `$ memory_write ... addressed_to=...` with the canonical-fix
  recommendation.
- **Docs fix**: `help({topic:"connectors"})` example updated to
  `recipients=[oncall]` (bracket-array form) — the actual contract.
- **Design call**: `recipients=[...]` is canonical (array, plural,
  matches AMP broker model). Adopters with custom MemoryStoreMcpConnector
  impls that genuinely accept `addressed_to` can wire it — the lint
  is a nudge toward the bundled-default contract, not tier-1.

### Notes

- 7 new tests (`v0.9.3-design-calls.test.ts`).
- Suite at 1105/1116 passing, 10 skipped, 1 baseline YouTrack env-gated.
- Concludes the v0.9.x patch series per Perry's locked sequencing.
  Remaining work (R8/qwen re-validation as periodic harness; v1.0 cold-
  author signoff) is bandwidth-driven from here.

## 0.9.2 — 2026-05-27

**Compiler permissiveness + runtime observability.** Closes P0.5–P0.9
(silent-drop lint additions) + P1.1 (delivery_skipped) + P1.4
(fallback_fired) + P1.6 (worked examples) + P2.5 (file_write transcript)
from Perry's R8 + qwen findings in `dec3ca8a`. Three commits per the
locked sequencing in `c9c667d2`.

### Added — compiler permissiveness lint cluster (P0.5–P0.9)

Smaller LLM authors (qwen-class) confabulate where the prose is abstract;
the pre-v0.9.2 compiler silently dropped malformed syntax. Five lint
additions surface those silent-drops as vocal errors:

- **P0.5 `no-space dispatch`** (parser tier-1) — `$<word>` without a
  space (e.g. `$ticketing_search query="x"`) was silently dropped from
  the topo-sort. Parser now emits a clear `missing the space between
  $ and the tool/connector name` error with the canonical fix.
- **P0.6 `colon-kwarg-syntax`** (lint tier-1) — `key:value` colon-style
  kwargs (e.g. `limit:20`) parsed as part of an adjacent token; lint
  now catches and recommends `key=value`. Skips quoted strings, array
  literals, brace literals, and `(fallback:...)` trailers.
- **P0.7 emit binding refused** (parser tier-1) — `emit(text="hi") -> R`
  was silently accepted; the binding was ignored at runtime. Parser
  now refuses with the canonical fix.
- **P0.8 `$append VAR = ...` refused** (parser tier-1) — the regex
  silently accepted the `=` shape with the `=` becoming part of the
  literal value. Parser now detects and suggests `$set` (replace)
  vs `$append VAR <value>` (append).
- **P0.9 `missing-default-target`** (lint tier-1, promoted from tier-3
  info) — skills without an explicit `default:` line now error. New
  `ParsedSkill.entryTargetExplicit: boolean` distinguishes
  explicit-vs-fallback resolution.

### Added — runtime observability signals (P1.1 + P1.4 + P2.5)

Cold authors couldn't tell whether their skill actually delivered or
just silently no-op'd, and `(fallback:)` substitutions were
indistinguishable from real success in the caller's view.

- **P1.1 `delivery_skipped` flag** — `agentDeliveryReceipts[].delivery_skipped: true`
  set when `# Output: agent:` declared but no real AgentConnector is wired
  (only the NoOp fallback). Includes a `reason` string with the canonical
  fix (`registerAgentConnector('primary', ...)`).
- **P1.4 `fallbacks[]` on ExecuteResult** — new `FallbackRecord[]`
  field. Populated when an op's `(fallback: ...)` trailer caught a
  dispatch failure. Inspect `length > 0` to detect partial-success
  runs. Two firing sites covered today: `file_read` and `$` op.
  Empty array `[]` when no fallbacks fired (clean run).
- **P2.5 `[file_write] wrote N bytes to <path>` transcript line** —
  emitted on successful file_write so cold authors can confirm side
  effects landed without reading the file back.

### Changed — worked examples expanded per substrate (P1.6)

`help({topic:"examples"})` adds two new worked examples — memory
durable-handoff (`$ memory_write`) and file-output (file_write +
`$append` accumulator) — plus a "per-substrate return-shape note"
documenting the canonical envelope shapes (ticketing → `{items, totalCount}`,
memory → `{items}`, LLM → string, etc.). Closes the qwen pattern-matching
issue where Test B inherited `.totalCount` from a ticketing example
onto a memory query result that didn't have it.

### Notes

- 21 new tests (`v0.9.2-permissiveness.test.ts` + `v0.9.2-runtime-signals.test.ts`).
- Suite at 1098/1109 passing, 10 skipped, 1 baseline YouTrack env-gated.
- Qwen re-validation queued — re-run the single-shot harness against
  v0.9.2 to confirm P0.5–P0.9 silent-drops now surface as vocal errors.
- v0.9.3 queued: P1.2 numeric subscript decision, P1.3 kwarg-name
  canonicalization. Bandwidth-driven.

## 0.9.1 — 2026-05-27

**Surface completion + structural dispatch validation.** Closes the v0.9.0
cold-author findings from Perry's R8 + qwen test batteries (thread
`dec3ca8a`, sequencing locked in `c9c667d2`). Three coherent commits.

### Added — `validateQualifiedDispatch` structural fix (P0.1 + P1.5)

Closes the multi-layer-promise pattern's third recurrence
(v0.7.2 → v0.7.3 → v0.9.0). Lint and runtime now call the SAME validator
for qualified `$ <connector>.<tool>` dispatch shapes — they can't drift
apart again.

- **New module `src/dispatch-validate.ts`** exports
  `validateQualifiedDispatch({toolName, qualifiedConnector, registry})`
  returning diagnostics. Lint rules consume them; runtime calls the same
  validator at the `$` op dispatcher as defense-in-depth.
- **New static surface on `McpConnectorClass`**: optional
  `staticTools(): string[] | null`. Bundled bridges declare their
  canonical surface — `LocalModelMcpConnector → ["prompt"]`,
  `MemoryStoreMcpConnector → ["query", "memory_write"]`. Connectors
  without a static surface (RemoteMcpConnector, adopter classes) return
  null and get tier-3 advisory treatment.
- **New tier-1 lint rule `unknown-tool-on-connector`** fires when a
  qualified op references a tool not declared on the connector's
  static surface. Catches `$ llm.tweet_post` etc. at compile time.
- **New tier-3 lint rule `unverified-qualified-tool`** fires when the
  connector class doesn't declare a static surface — advisory only;
  runtime will fail with a connector-specific error if the tool is
  missing.
- **`Registry.getMcpConnectorCtor(name)`** exposes the wired connector's
  class constructor so external validators can read `staticTools()`.
- **PR-template discipline addition** in `docs/adopter-playbook.md` —
  every new dispatch shape lands with lint + runtime + e2e tests as the
  forcing function. Prevents recurrence #4.

### Added — `skill_write` auto-stamp (P0.4)

Headless adopter unblock per thread `dec3ca8a` R8 minion #6. MCP-only
adopters (no dashboard) no longer need a `skill_status` Draft→Approved
round-trip to get a runnable Approved state.

- **`SkillStore.store()` auto-stamps** when the body declares
  `# Status: Approved` (with or without an existing token). Stamping is
  idempotent — pre-stamped bodies get a fresh recomputed token; Draft
  and Disabled bodies pass through verbatim.
- **`tests/setup.ts` simplified** — production code now handles the
  Approved-body case; the test hook only covers the legacy
  no-`# Status:`-header case for fixture convenience.

### Changed — docs sweep (P0.2 + P0.3 + P2.1 + P2.8)

- **`notify()` added to `help({topic:"ops"})`** (P0.2). The op was
  shipped in v0.8.0 but the closed-set list in the ops topic still said
  "emit, ask, inline, execute_skill, shell, file_read, file_write" —
  cold authors by-the-book couldn't find notify. Now documented with a
  full section + contrast against emit ("end-of-skill bulk via
  `# Output: agent:` lifecycle hook" vs "mid-skill synchronous alert").
- **Quickstart's "$ memory_write deferred" lie removed** (P0.3). Both
  the three-channels table and the dispatch surface paragraph now
  correctly state memory_write is live and routes through the bundled
  `memory_write` connector.
- **Dotted-form added to quickstart** (P2.1). One-paragraph addition
  explaining bare (`$ <name>`) vs dotted (`$ <connector>.<tool>`)
  routing, with a multi-connector slack disambiguation example.
- **`unwired-primary-connector` remediation triaged by audience** (P2.8).
  Author-side fix (qualify the op or pick a tool-matching name) is now
  separated from operator-side fix (wire a connector or add `primary` to
  connectors.json). Cold authors no longer have to triage which
  remediation applies to them.

### Notes

- 16 new tests (`v0.9.1-validate-dispatch.test.ts`,
  `v0.9.1-skill-write-autostamp.test.ts`). Suite at 1077/1088 passing,
  10 skipped, 1 baseline YouTrack env-gated.
- v0.9.2 queued: compiler permissiveness lint additions (P0.5–P0.9) +
  qwen re-validation harness as release-gate criteria. Per locked
  sequencing in thread `c9c667d2`.

## 0.9.0 — 2026-05-26

**Hash-token approval gate + trigger enable/disable.** Closes the v0.9.x
auth-model design settled in thread `29b6208e` (Scott + Perry + CC,
2026-05-26). Replaces the deferred `1866302d` lockdown's 6 moving parts
with one substrate-neutral mechanism. 5-10× lighter implementation.

### Added — ad-hoc inline-source execution (carve-out)

Per thread `10746795` (Slack 4:31-4:46 PM). The strict "Approved required to
execute" interpretation creates a corner for ad-hoc scripting: write a quick
skill → can't run it → store it → human reviews → stamps → finally executes,
with the script now persisting forever as detritus. Bad UX for one-off work.

- **`execute_skill({source: "..."})`** runs the supplied source body in
  memory and discards it. **Never crosses the SkillStore boundary** so the
  hash-token gate (which lives at that boundary) doesn't engage.
- **`execute_skill({skill_name: "..."})`** unchanged — stored execution,
  gate fires, Draft/tampered bodies refused.
- **Exactly one** of `skill_name` / `source` must be provided.
- **Child references stay gated.** An inline parent that does
  `$ execute_skill skill_name="child"` or `& data-ref` STILL routes those
  children through the SkillStore + gate. Only the top-level inline body
  is ungated.
- **Threat model rationale**: the gate protects against silent-swap of
  stored autonomous skills. Inline-source has no silent-swap attack — the
  caller wrote/saw the source they're handing in. Invocation IS the
  review. Same intuition as `bash -c "..."`.
- **New export**: `executeSkillFromSource` from `src/composition.ts`.

### Added — hash-token approval gate

- **Two states matter: Draft + Approved.** Draft skills can be authored,
  compiled, linted, viewed — but cannot execute anywhere. Approved skills
  with a valid stamped token execute via every dispatch path (manual MCP,
  in-skill compose, scheduler dispatch, compile-time data-skill inline).
- **`# Status: Approved v1:<token>`** — the dashboard's "Transition to
  Approved" flow now computes `f(body − Status line)` and stamps the
  token into the skill body. Runtime re-computes on every execution;
  mismatch blocks with a clear "re-approve via dashboard" error.
- **Version-prefix enumeration**: `v0:` reserved, `v1:` = CRC32 (bundled),
  `v2:` reserved for HMAC-SHA256, `v3:` reserved for Ed25519. Adopters
  substitute stronger functions via `registerApprovalFn(version, fn)`
  without language changes.
- **Content-change-resets is automatic** via the math — body edits
  invalidate the prior hash, so the next execution fails the gate.
- **Tamper-evident, not tamper-proof** out of the box. CRC32 is a
  discipline barrier; adopters with adversarial threat models substitute
  HMAC/Ed25519. Same protocol shape, stronger function.
- **NEW exports**: `src/approval.ts` →
  `computeApprovalToken`, `verifyApprovalToken`, `evaluateApprovalGate`,
  `stampApprovalToken`, `registerApprovalFn`, `parseApprovalToken`,
  `extractStatusFromBody`, `stripStatusLineForHashing`.
- **NEW error**: `ApprovalRejectedError` (`src/errors.ts`) — flows
  through `# OnError:` chains like other `ConnectorError` subclasses.

### Added — trigger enable/disable

- **`enabled: boolean` field on TriggerRegistration** (default `true`).
  Disabled triggers stay registered but the scheduler skips firing them
  — vacation / maintenance windows without losing the registration.
- **`scheduler.setTriggerEnabled(id, enabled)`** — toggle API. Fires the
  `onTriggersChanged` hook for imperative triggers (persists to
  `triggers.json`); declarative triggers toggle in-memory only (they
  rederive from skill bodies at bootstrap).
- **NEW MCP tool** `set_trigger_enabled({trigger_id, enabled})` — 14th
  bundled tool (was 13).
- **`triggers.json` schema bumped 1 → 2.** v1 files load with
  `enabled: true` (back-compat hydration); fresh writes use schema v2
  with the `enabled` field.

### Added — dashboard surface

- **Approval-state badge on skill detail view.** Approved skills show
  `verified` or `re-approval needed` based on runtime hash check. Stale
  Approved (body edited after approval) surfaces a banner + a
  "Re-approve (refresh token)" button alongside the standard transitions.
- **Trigger enable/disable buttons in the Triggers view.** Each row now
  shows `enabled` / `disabled` state with a one-click toggle alongside
  the unregister button.
- **`skill_metadata` MCP response includes `approval` field**:
  `{gate_ok: true}` when the body verifies cleanly, or
  `{gate_ok: false, reason: "..."}` with the human-readable refusal text.

### Migration

- **Existing skills with `# Status: Approved` (no token) refuse to
  execute** until re-approved via the dashboard. Pre-adoption rule:
  no installed base, no migration tooling needed beyond the one-time
  dashboard click.
- **`examples/*.skill.md` and `scaffold/examples/hello.skill.md`** stamped
  with valid `v1` tokens via `scripts/stamp-examples.mjs` (re-run after
  any body edit).
- **Test fixtures** are auto-stamped at `SkillStore.store()` boundary via
  `tests/setup.ts` — production code paths unaffected.

### Notes

- **R7 cold-author harness still queued.** v0.9.0 ships the auth gate;
  R7 lands separately post-stabilization.
- **`unconfirmed-mutation` lint** stays bundled in v0.9.0 — drop is a
  separate concern; the hash-token gate is the real enforcement, but the
  lint surfaces author-intent gaps at compile time, which is independent
  value.

## 0.8.0 — 2026-05-26

**Delivery model lockdown.** Closes the v0.8.x delivery-model design (Perry/CC
threads `42a0cc41` → `6995d006` → `ef5219a9` → `bb34de4e` → `a39345f9`,
May 26). Three substrate-portable output paths replace the v0.7.x
`# Output:` enum's implicit-substrate behavior:

1. **Substrate writes** — `$ memory_write` (NEW) + `file_write` (existing)
2. **Programmatic return** — result binding `-> VAR` (existing)
3. **Direct agent alerting** — `notify()` op (NEW) + `# Output: agent:` /
   `template:` lifecycle hooks (substrate-neutral, end-of-skill)

**Auth model deferred for rethinking.** The skill-author tracking + promotion
gate work settled in `43178c86` / `1866302d` is kicked down the road per
Scott's call ("needs to be better thought out and perhaps made simpler").
`$ memory_write` ships with the current `approved=` lint gate (same as
`file_write`); `# Status: Draft → Approved` stays self-promotable.

### Changed — OutputKind shape (breaking change; pre-adoption rule applies)

- **`prompt-context:` renamed to `agent:`.** The pre-v0.8.0 name leaned on
  substrate-specific "prompt-context" terminology that doesn't apply to
  Obsidian-vault-backed or mailbox-style agent substrates. `agent:` is
  substrate-neutral — "deliver to whoever's wired for X via their
  AgentConnector."
- `# Output: agent: <name>` → `AgentConnector.deliver({kind: "augment",
  content: <joined-emissions>})`
- `# Output: template: <name>` (unchanged) → `AgentConnector.deliver({kind:
  "template", prompt: <joined-emissions>})`
- Internal v0.7.x value `prompt-context` removed from the OutputKind union;
  internal `output_kind` discriminator in `AgentDeliveryReceiptRecord`
  similarly updated.
- Sweep across `examples/*.skill.md`, test fixtures, scaffold docs.

### Added — `notify()` runtime-intrinsic op

- **`notify(agent, message?, connectors?) -> ACK`** dispatches mid-skill
  synchronous alerts via wired AgentConnector(s). Specialization vs the
  `# Output: agent:` end-of-skill lifecycle hook (per Perry's
  refactor-resistance argument: ordering puzzles dissolve when the
  end-of-skill hook owns emission accumulation and `notify()` owns
  mid-skill fires).
- **Default behavior** when `message` is absent: dispatches the accumulated
  emissions-so-far. Authors can write `notify(agent="X")` between emits to
  fire a checkpoint without manually constructing the message.
- **Fan-out**: dispatches to ALL wired AgentConnectors whose `list_agents()`
  includes the target agent. `connectors=["webhook","tmux"]` restricts.
- **Failure semantics**: best-effort by default. Per-connector errors are
  captured in the ACK's `dispatched[]` array but don't propagate. `strict=true`
  opt-in deferred to dogfooding signal (per Q3 lockdown).
- **Return shape (signature lock)**: `{agent: string, dispatched:
  Array<{connector: string, ok: boolean, error?: string}>}`. Fire-and-forget
  callers ignore the binding; check-delivery callers inspect ACK.
- **Substrate-neutrality**: nothing bundled. Adopters wire AgentConnector
  impls (webhook, tmux, Slack, Discord, etc.). Substrate-specific delivery
  destinations live in adopter-wired AgentConnectors, NOT in the language.
- Closed-set RUNTIME_INTRINSIC_FN_NAMES expanded with `"notify"`.

### Added — tier-2 `# Output:` lint contract warns

- **`output-agent-target-no-emit`** — `# Output: agent: X` / `template: X`
  declared but skill has no `emit()` ops in body; delivery would fire with
  empty content. Warns to surface contract drift.
- **`output-agent-target-no-connector`** — `# Output: agent: X` / `template: X`
  declared but no AgentConnector wired; delivery would silently no-op via
  the NoOp default. Warns when lint context provides registry info.
- Per Q4 lockdown: tier-3 advisories for "header + notify(agent=X) both fire"
  deferred to dogfooding signal (Perry's call — wait for real footgun
  evidence before adding the lint).

### Added — `$ memory_write` op + `MemoryStore.write()` contract

- **`MemoryStore.write({content, tags?, recipients?, expires_at?, metadata?})
  -> {id, created_at}`** — new method on the typed MemoryStore contract.
  Bundled `SqliteMemoryStore` implements via the existing upsert schema with
  generated UUIDs. Companion: onboarding-scaffold `FileMemoryStore.write()`
  implements via JSON file append.
- **`$ memory_write content="..." [recipients=[...]] [tags=[...]]
  [expires_at=N] [metadata={...}] -> R`** — bare-form MCP dispatch through
  the `MemoryStoreMcpConnector` bridge. Bridge dispatches on toolName:
  `memory` routes to `query()`; `memory_write` routes to `write()`. Bootstrap
  auto-registers the same bridge instance under both names.
- Returns `{id, created_at}` envelope (per Q6 ack-shape lockdown).
- `recipients[]` is a substrate-advisory hint — memory systems with alerting
  (AMP) act on it; systems without (Obsidian-vault) ignore. Skillscript
  doesn't enforce or implement alerting at the language layer.
- **Memory handoff delivery channel** (the third "first-class" path
  documented in QUICKSTART since v0.7.0) is now real, no longer paper.

### Deferred to future v0.8.x or later

- **Skill-author tracking + promotion gate.** Per Scott (2026-05-26):
  "needs to be better thought out and perhaps made simpler." The
  `43178c86` / `1866302d` design is reopened for re-thinking. Possible
  simplification: promotion gate as operator-policy at the SkillStore layer
  rather than language-level identity tracking. Until then,
  `# Status: Draft → Approved` stays self-promotable as today.
- **Drop `unconfirmed-mutation` lint + reframe `# Autonomous: true` as
  documentation.** Pairs with the auth model rethink — under the current
  approach the lint is still load-bearing. Defer with auth.
- **R7 cold-author harness for NFR-6** — queued post-v0.8.0; tests
  ops/filters/lint-rules extension surfaces against the new file layout.
- **Portability stress-test scaffold** — v1.0 gate prep; vector-DB memory +
  hosted-API LLM + webhook AgentConnector substrate combination.

### Notes for cold authors

- `# Output: prompt-context: X` from v0.7.x skills is a parse error in
  v0.8.0. Rename to `# Output: agent: X` — pre-adoption rule applies (no
  external installed base; sweep your own test fixtures).
- `notify()` is for mid-skill alerts; `# Output: agent: X` is for end-of-skill
  bulk delivery. See `docs/adopter-playbook.md` for the lifecycle distinction.
- `$ memory_write content="..."` works against any MemoryStore impl that
  implements the typed `write()` contract. Bundled `SqliteMemoryStore` and
  the onboarding-scaffold `FileMemoryStore` both ship it.

## 0.7.3 — 2026-05-26

**Agent-as-author hardening.** Closes structural gaps surfaced by the v0.7.3
roadmap review (`076bdeac`, Perry/CC thread, May 26). The language *shape*
locked at v0.7.2; v0.7.3 hardens the adopter surface so agents (and the
humans wiring them up) have a substrate-neutral, merge-friendly, honestly-
documented surface to build against. `$ memory_write` is deferred to v0.8.x
bundled with the passthrough auth model — see the auth design thread
`43178c86` for the settled framing.

### Added — adopter-extensible connector class registry

- **`registerConnectorClass(name, entry)` public API.** Adopters with custom
  `McpConnector` classes call this from their bootstrap before
  `loadConnectorsConfig` runs. Closes the merge-conflict bait of editing
  the bundled `KNOWN_CONNECTOR_CLASSES` Map directly. Adopter overrides
  take precedence over bundled set on name collision (lets adopters swap
  bundled classes with hardened variants). Companion: `unregisterConnectorClass`,
  `getConnectorClass`. See `examples/custom-bootstrap.example.ts`.

### Added — canonical runtime config

- **`skillscript.config.json`.** Externalizes runtime knobs (skillsDir,
  traceDir, memoryDbPath, dashboard port + host, pollIntervalSeconds,
  enableUnsafeShell, mode, ollamaBaseUrl, triggersFilePath,
  connectorsConfigPath) into one declarative file. `${VAR}` substitution
  matches `connectors.json`. Loader is graceful on missing file. CLI's
  `dashboard` / `serve` commands accept `--config <path>`; CLI flags
  override file values; file values override defaults.
- **Driver:** two-instance posture. Running dev-skillscript + adopter-wiring
  instance on the same machine requires independent ports/paths. The
  config file makes this a copy-and-tweak operation rather than threading
  CLI flags.
- **`skillscript.config.json.example`** ships at repo root as the template.

### Added — onboarding scaffold (`examples/onboarding-scaffold/`)

- Complete adopter deployment with file-backed memory + OpenAI LLM +
  tmux-shell agent delivery. ~200 LOC across three adapter files plus
  bootstrap. Case-1 typed-contract wiring end-to-end — skills authored
  against this scaffold use canonical `$ llm` / `$ memory` and run
  unchanged against any other Case-1 substrate.
- `file-memory-store.ts` — `MemoryStore` impl over a JSON file with
  simple substring FTS
- `openai-local-model.ts` — `LocalModel` impl over OpenAI Chat
  Completions API
- `tmux-shell-agent-connector.ts` — `AgentConnector` impl via `tmux
  send-keys` (mirrors what nanoclaw-style harnesses do internally)
- `bootstrap.ts` — wiring example tying all three together with the
  v0.7.2 bridges
- `README.md` walking through quick-start, two-instance posture, and
  what to modify for production

### Added — adopter playbook (`docs/adopter-playbook.md`)

- Case-1 typed-contract vs Case-2 MCP-tools wiring tradeoff (the
  load-bearing decision)
- Joe-Programmer setup walkthrough
- Conventions for upstream-merge-friendly modifications (dedicated
  adopter files, `// ADOPTER:org —` sentinels, public registration APIs)
- Substrate ship-status table with honest v0.7.x gap callouts
- Skill discovery + cross-agent composition patterns under Case-1 memory

### Changed — OutputKind cleanup (substrate-neutrality)

- **Dropped `slack` and `card` from `OutputKind`.** Substrate-specific
  delivery names in what's supposed to be a substrate-neutral language.
  Same anti-pattern v0.7.0 removed for `LocalModel` and `MemoryStore`
  dispatch shapes. `OutputKind` now: `text` / `prompt-context: <agent>` /
  `template: <agent>` / `file: <path>` / `none`. Adopters wanting
  Slack / WhatsApp / Discord / etc. use either `$ slack.post ...` MCP
  dispatch inside the skill body OR `# Output: prompt-context: <agent>`
  letting the receiving agent decide. The bundled `EmissionConnector`
  v1.x backlog item is also dropped — MCP-dispatch handles the use case.
- **Substrate-neutrality sweep** of the language surface (parser
  enums, lint code names, ambient refs, frontmatter values, help
  content). Clean post-cleanup; no other substrate-specific leaks
  found in the language contract. Internal AST field `ampParams`
  flagged for renaming in a future pass (not user-facing, no
  contract impact).

### Changed — reference bootstrap framing

- `src/bootstrap.ts` reframed as **reference wiring, not canonical**.
  File header + `bootstrap()` docstring explicitly direct adopters with
  custom substrates to write their own bootstrap importing the public
  APIs. `bootstrap()` remains part of the v0.7.x+ stable public surface
  for default deployments. See `examples/custom-bootstrap.example.ts`
  + `examples/onboarding-scaffold/bootstrap.ts`.

### Changed — public exports

- **New top-level exports** from `skillscript-runtime`:
  `loadSkillscriptConfig`, `bootstrap`, `defaultRegistry`,
  `wireDeclarativeTriggers`, `registerConnectorClass`,
  `unregisterConnectorClass`, `getConnectorClass`,
  `listKnownConnectorClasses`, `loadConnectorsConfig`.
- **New `skillscript-runtime/connectors` exports**:
  `LocalModelMcpConnector`, `MemoryStoreMcpConnector` (so adopter
  bootstraps can wire bridges over their own typed-contract impls
  without reaching into bundled `bootstrap()`).

### Deferred to v0.8.x

- **`$ memory_write`** with the `MemoryStore.write({content, tags?,
  recipients?, expires_at?, metadata?})` contract extension. Ships
  bundled with the passthrough auth model so the credibility-crack of
  documented-but-unshipped delivery closes alongside the auth design.
- **Authorization model.** Mixed: passthrough for op-level mutations
  (substrate enforces; runtime threads credentials); runtime-enforced
  for skill-promotion (`# Status: Draft → Approved` requires non-author
  signer). `# Autonomous: true` becomes documentation; `unconfirmed-mutation`
  lint drops (substrate enforcement makes it theater). New-version-of-
  same-name returns to Draft on content change. See thread `43178c86`
  for the settled design.

### Deferred (post-v0.7.3 ship)

- **R7 cold-author harness.** Tests NFR-6 agent-modifiability empirically:
  cold agent adds a new filter, a new lint rule, and a new runtime-
  intrinsic op against the v0.7.3 file layout. If they succeed, NFR-6 is
  satisfied empirically; if they fail, the failure mode targets which
  extension point to refactor first. Evidence-driven, no major-version
  refactor slot.

### Notes for cold authors

- Run `help({topic: "frontmatter"})` for the updated 5-kind OutputKind set.
- Adopters integrating new substrates: see `docs/adopter-playbook.md`
  for the Case-1 vs Case-2 framing — this is the most important
  decision in your wiring.
- `${VAR}` interpolation, the canonical `$ llm` / `$ memory` surfaces,
  bare-form bridge dispatch, the v0.7.2 typed contracts — all unchanged
  in v0.7.3. Existing skills run as-is unless they used `# Output: slack:`
  or `# Output: card:` (rewrite to `prompt-context:` or use MCP dispatch).

## 0.7.2 — 2026-05-25

**R4-driven punchlist + bridge classes.** Closes the cold-author findings
from the R4 harness round (Perry's report `d284763f`, Scott's decisions
`d89905f3`, bridge-class scope-lock `831c2661`, Perry's GO `5f471b0a`).
The hypothesis test passed in R4 — minions reached for canonical
`emit()`, `file_write()`, `${VAR}` naturally; friction moved deeper into
substantive language semantics. v0.7.2 closes the substantive friction
and lands the substrate-portability story end-to-end.

### Added — language semantics

- **String escape interpretation in double-quoted strings.** `\n`, `\t`,
  `\\`, `\"` interpret to their actual chars inside `"..."`. Bash /
  Python / JS / Go / C all do this; skillscript joins the prior. R4
  minion 4 was reaching for `@ printf %b "${VAR}"` as a workaround;
  now `$set X = "line1\nline2"` produces real newlines. Single-quoted
  strings stay literal pass-through (reserved for v0.8+ literal
  semantics). **Breaking change** — pre-adoption rule applies (no
  external users to disrupt); any skill relying on literal `\n` bytes
  needs a one-time rewrite.

- **Triple-quote multi-line string literals.** `"""..."""` for prose-
  shaped content. Spans line breaks naturally; embedded single `"`
  doesn't terminate (three consecutive `"` chars don't accidentally
  appear in natural English). Escape interpretation applies same as
  single double-quote. Use cases: long-form `emit(text="""...""")`,
  `file_write(content="""...""")`, multi-line `$set X = """..."""`
  reports.

- **`${VAR}` substitution in `# Output:` target slot.** Compile-time
  inputs resolution (caller-passed `inputs` to `compile_skill`,
  `# Vars:` defaults, `# Requires:` cascade values). Runtime-bound
  refs (from `$` op outputs) explicitly deferred — needs two-phase
  frontmatter resolution architectural call. Closes R4 finding #6
  (minion 5 wrote `# Output: prompt-context: ${TARGET_AGENT}` expecting
  parameterized routing; now works).

### Added — lints

- **Tier-3 `object-iteration-advisory` lint.** R4's strongest signal
  (4 of 5 minions hit it). Fires on `foreach IT in ${VAR}` where VAR's
  binding origin is a `$` MCP tool output without `.field` accessor.
  Hints at common envelope-field names (`.items`, `.results`,
  `.issuesPage`, `.data`, `.records`). Placeholder for v0.8 tool-schema
  introspection that catches this precisely.

- **`unconfirmed-mutation` broadened to legacy `@` ops.** Closes R4
  minion 4 sub-finding: `@ printf %b ${REPORT}` silently word-split
  when `REPORT` contained whitespace. Lint now flags any suspect
  `${VAR}` substitution in `@` op bodies (same origin-detection logic
  as the existing `$` op coverage). Pattern also widened to recognize
  both `$(VAR)` and `${VAR}` forms.

### Added — bridge classes (substrate-portability lands)

- **`LocalModelMcpConnector`.** Bridge class that exposes a registered
  `LocalModel` instance as an `McpConnector`. Wraps `LocalModel.run`
  per the canonical contract:
  `$ <connector> prompt="..." [maxTokens=N] [model="..."] -> R` where
  R is the model's response string.

- **`MemoryStoreMcpConnector`.** Bridge class that exposes a registered
  `MemoryStore` instance as an `McpConnector`. Wraps `MemoryStore.query`:
  `$ <connector> mode="fts|semantic|rerank" query="..." limit=N
  [...extras] -> R` where R = `{items: PortableMemory[]}` envelope
  (consistent with the object-iteration-advisory's hint pattern).

- **Bootstrap auto-wire.** Bridges wire automatically at bootstrap as
  connector instances `llm` (default LocalModel) + `memory` (default
  MemoryStore, when SQLite db exists). Zero-config — `$ llm prompt="..."`
  and `$ memory mode=fts query="..." limit=10` work in default
  deployments without adopter wiring. Adopters override by re-registering
  the names or wiring entries in `connectors.json`.

### Architectural framing — canonical MCP-dispatch contract

v0.7.2 doesn't just ship bridge code — it **defines what `$ llm` and
`$ memory` MEAN in skillscript** by shipping with explicit kwarg surfaces.

**Two layers of substrate portability:**

1. **`LocalModel` + `MemoryStore` interface contracts** (typed contracts
   within the runtime). Adopters implement these to plug in their
   substrate without writing MCP servers. Bundled `OllamaLocalModel` +
   `SqliteMemoryStore` are reference impls.
2. **MCP dispatch via `$ <name>`** — bridge classes expose Layer 1 as
   MCP; adopters can also bypass bridges and wire any MCP server under
   any name (`$ pinecone_vector`, `$ amp.amp_query_memories`, etc.).

**Bundled memory surface is ONE canonical call** (per Perry's scope-lock
`5f471b0a`):
```
$ memory mode="fts|semantic|rerank" query="..." limit=N [...extras] -> R
```
Read-only, FTS-flavored. Substrate-portable across any `MemoryStore`-
interface impl. Explicitly **not** bundled (adopter wires via dotted-form
escape hatch `$ <connector>.<tool>`):
- `$ memory_write`, `$ memory_get` (no MemoryStore interface methods)
- Thread operations (`$ thread_get`, `$ thread_close`,
  `$ thread_check_mailbox`, etc.) — substrate-specific
- Introspection / traversal / promote / reinforce — substrate-specific
- Mutations beyond write — substrate-specific

For Tradita-style deployments, AMP wires as `$ amp.<tool>` with the
full ~15-tool surface available; `$ memory` covers the canonical query
path, `$ amp.<tool>` covers AMP-specific operations.

### Changed

- **`deprecated-symbol-op` lint** — remediation messages now confidently
  suggest `$ llm` / `$ memory` (the bridge auto-wire makes these
  load-bearing in default deployments). No more "(or your wired LLM
  connector name)" caveat.

- **`help()` content** — all six topics (quickstart, ops, frontmatter,
  examples, composition, connectors, lint-codes) refreshed to canonical
  v0.7.0+ surface. Container FS isolation note added. `object-iteration-
  advisory` indexed. Tradita-internal naming scrubbed from connectors
  topic.

- **Quickstart hero example** — broken `$append REPORT <line>...</line>`
  accumulator pattern replaced with `emit(text="...")` per-line +
  `# Output: prompt-context:` delivery channel. Matches Perry's
  corrected §1 doc atom.

- **AST**: `op.sourceForm?: "function-call"` field already added in v0.7.1
  to distinguish canonical from legacy at lint time. Continues to do
  load-bearing work for the deprecated-symbol-op lint.

### LOC ceiling

Narrow-core ceiling 7250 → 7550. Bridges add ~80 LOC each (auxiliary
surface). String-escape interpreter + triple-quote tokenizer state +
${VAR}-in-Output substitution + object-iteration advisory + @-op
unquoted-subst extension add ~200 LOC narrow-core total.

### Tests

53 new tests across 5 v0.7.2-specific test files:
- `v0.7.2-object-iteration-advisory.test.ts` — 6 tests
- `v0.7.2-string-escapes.test.ts` — 12 tests
- `v0.7.2-triple-quote-literals.test.ts` — 14 tests
- `v0.7.2-output-substitution.test.ts` — 9 tests
- `v0.7.2-unquoted-subst-at-op.test.ts` — 7 tests
- `v0.7.2-bridge-classes.test.ts` — 16 tests (unit + closed-set registry)

Plus updated fixtures across test files where bootstrap auto-wire
shifted expected behavior. Suite: 974 passing, 10 skipped, 1 env-gated
YouTrack.

### Deferred to v0.8 (per locked roadmap)

- **Tool-schema introspection** that adapts the object-iteration-advisory
  + deprecation lints based on actual connector availability
- **Richer memory contract** covering vector / embedding / hybrid
  substrates beyond FTS-flavored query
- **`MemoryStore.write()`** interface addition to enable a bundled
  `$ memory_write` bridge (currently adopter-wired)
- **Pagination / `while` loop** primitive (v0.9)
- **Phase 2 trigger sources** (event + agent-event) — v0.11
- **Output routers** (slack + card) — v0.12

## 0.7.1 — 2026-05-25

**R4-enabling polish.** Help-content refresh (was the R4 cold-author harness
blocker), tier-2 deprecation visibility lints, broadened `unconfirmed-mutation`
enforcement using the captured `approved="..."` kwarg from v0.7.0, scaffold
hygiene. Per Perry's v0.7.1 kickoff `7f31c7a4`. Bridge classes
(`LocalModelMcpConnector` + `MemoryStoreMcpConnector`) deferred to v0.7.2
as a dedicated AMP-substrate dogfooding release.

### Added

- **Tier-2 `deprecated-symbol-op` lint.** Fires on legacy symbol-form ops
  (`~`, `>`, `@`, `!`, `??`, `&`) with the canonical replacement in the
  remediation message (`emit(text="...")`, `shell(command="...")`, etc.).
  Tier-2 (warning, not error) during the v0.7.x grace period; tier-1
  promotion (refuse-to-compile) lands in v0.8/v0.9. Dedupes per-kind-per-
  target — one nudge per legacy op type per target. Uses a new
  `op.sourceForm` AST marker to distinguish canonical function-call ops
  (silent) from legacy symbol-form ops (warned), since both parse to the
  same AST kind in v0.7.0.

- **Tier-2 `deprecated-substitution-shape` lint.** Fires on legacy
  `$(VAR)` substitution form, advises rewrite to `${VAR}` canonical. Skips
  the `$$(VAR)` escape (used in `@ unsafe` for bash literal pass-through).
  Dedupes per-var-per-target. Tier-1 promotion in v0.8/v0.9.

- **`unconfirmed-mutation` broadening.** Closes the captured-but-not-
  enforced gap from v0.7.0. The lint now covers:
  - `$` MCP dispatch with mutating-shape tool name (unchanged)
  - `$ memory_write` MCP dispatch (new — matches the canonical memory-
    delivery channel name)
  - `file_write(...)` runtime-intrinsic op (new — v0.7.0 ship)

  Three authorization paths recognized:
  1. `# Autonomous: true` skill flag (existing, v0.4.2)
  2. Preceding `??` / `ask(prompt="...")` confirmation op in same target
  3. **New (v0.7.0+):** `approved="reason"` per-op kwarg — any non-empty
     string. Value not parsed semantically; presence is what matters.
     Replaces the v0.4.2-era `(approved: "...")` trailer for function-
     call ops.

- **`help()` content refresh (R4 blocker).** Quickstart (default `help()`
  call) rewritten to lead with the v0.7.0 framework — trigger → process →
  deliver model, three op classes, three delivery channels, canonical
  `${VAR}` substitution and function-call op shape throughout. Worked
  end-to-end example uses canonical syntax (morning-showstopper-sweep
  pattern with memory-handoff delivery). Legacy syntax footnoted with
  grace-period note. `LINT_CODES` topic updated with the two new
  deprecation rules + broadened `unconfirmed-mutation` semantics.

- **Scaffold hygiene** (`scaffold/connectors.json` +
  `connectors.json.example`). Updated to v0.4.0+ class-registry format,
  explicit v0.7.0 substrate-framing comments, planned `LocalModelMcpConnector`
  + `MemoryStoreMcpConnector` v0.7.2 entries as future-reference templates.
  All internal naming (Tradita, AmpMcpConnector, amp_query_memories)
  scrubbed — scaffold is adopter-neutral.

### Changed

- **AST:** new optional field `op.sourceForm?: "function-call"` set by the
  parser's function-call dispatch path. Distinguishes canonical from
  legacy at lint time without changing runtime/render dispatch (both
  paths still produce identical AST kinds).

### Roadmap update

- **v0.10 `foreach parallel` cut from roadmap.** Cron windowing covers
  the use case; parallel `$append` opens thread-safety + ordering
  complexity in a constrained language; adopters can implement parallel
  inside an MCP tool. Speculative gap, not load-bearing for the
  broker-replacement north star.

### LOC ceiling

Narrow-core ceiling nudged 7150 → 7250. ~105 LOC across lint.ts (two new
tier-2 rules + `unconfirmed-mutation` broadening) + ~5 LOC in parser.ts
(sourceForm marker setters). Help-content refresh is content swap, no
net LOC.

### Tests

14 new tests in `tests/v0.7.1-deprecation-lints.test.ts` covering the
two deprecation rules + `unconfirmed-mutation` broadening (file_write +
`$ memory_write` + `approved=` kwarg + `# Autonomous: true` + preceding
`ask()` gate). Suite: 910 passing, 10 skipped, 1 env-gated YouTrack.

## 0.7.0 — 2026-05-25

**Syntax revamp + pre-adoption clean break.** Two grammar additions
(canonical `${VAR}` substitution + function-call op shape), two new
runtime-intrinsic ops (file_read, file_write), one throwaway script
that mechanically rewrites every prior-version skill to the new
surface. Legacy forms (`$(VAR)`, `~`, `>`, `@`, `!`, `??`, `&`) continue
to compile + run during the grace period; tier-1 lint promotion lands
in v0.8/v0.9. Per Perry's kickoff `50a83a88` + final consolidated framework
`c48fca7e` + approval `783a10a4`.

### Added (canonical surface)

- **`${VAR}` substitution canonical form.** Replaces `$(VAR)` (legacy,
  still works during grace period). Field access `${VAR.field}` +
  filter chain `${VAR|filter:"arg"|filter2}` work identically. Closes
  the bash-command-substitution collision (`$(date)` runs `date` in
  bash; `${VAR}` is bash variable-interpolation — same intuition path,
  no semantic ambiguity). The `$$(VAR)` shell-escape gains a parallel
  `$${VAR}` form.

- **Function-call op grammar.** `verb(kwarg=value, ...) [-> BINDING]`.
  Closed runtime-intrinsic set: `emit`, `ask`, `inline`, `execute_skill`,
  `shell`, `file_read`, `file_write`. Paren-balanced parsing (nested
  parens in kwarg values handled), comma-separated kwargs, quote-aware.
  Unknown function-call names produce a parse error with remediation:
  "if this is an MCP tool, use `$ tool args -> R` shape instead."

- **`file_read(path=) -> CONTENT` runtime op.** Reads file contents
  via Node `fs.readFile`. Substitutes `${VAR}` in the path. Optional
  `(fallback: "...")` trailer for missing-file handling. New
  runtime-intrinsic op for skills that pull data from local files for
  prompt-context injection or processing.

- **`file_write(path=, content=, approved="...")` runtime op.** Writes
  contents via Node `fs.writeFile`. Auto-creates parent directories
  (`mkdir -p` semantics). Substitutes `${VAR}` in both path and content.
  The `approved=` kwarg is the v0.7.0 author-intent marker for mutation
  ops outside `# Autonomous: true` skills; lint enforcement broadens
  in v0.7.1.

- **`approved="reason"` inline kwarg shape.** Captured on every
  function-call AST node; uniform with the all-kwargs discipline.
  Required string value forces author intent (presence matters; value
  not parsed semantically). Replaces the `(approved: "...")` trailer
  syntax for function-call ops (legacy trailer still works on symbol-
  form ops).

### Changed (substrate framing)

- **`local_model` and `memory_query` removed as language keywords.**
  Pre-v0.7.0: `~` and `>` ops dispatched to amp's `amp_invoke_local_model`
  and `amp_query_memories` MCP tools via hardcoded paths — amp-specific
  privilege baked into the language. v0.7.0: they become regular
  `$ <connector>` MCP dispatch resolved against `connectors.json`.
  Tradita wires `llm` + `memory` as connector names pointing at amp;
  external adopters wire whatever substrate they use. Language stops
  assuming amp is the substrate.

### Architectural framework

Per the design conversation captured in thread `50a83a88 → c48fca7e`:

- **Skillscript is a compose-time prompt-construction language.** Its
  job is to build the prompt-context the agent receives, with optional
  pre-dispatch optimizations baked in. Not a general execution
  environment.
- **Two layers:** compose (skillscript) + execute (agent at higher
  level with native Read/Write/Bash/MCP tools).
- **Three delivery channels** — embedded prompt (`emit`), memory
  handoff (`$ memory_write`), file handoff (`file_write`). All
  first-class.
- **Three op classes** — mutation statements (`$set`/`$append`),
  runtime-intrinsic function-calls, external MCP dispatch.

### Migration + harness cleanup

One-shot Node script (`scripts/migrate-v07.mjs`, removed after use)
rewrote `examples/` from legacy to canonical (9 files, 138 rewrites:
92 substitution-shape + 25 emit + 8 tilde + 7 shell + 5 memory + 1
ask). Markdown-aware, idempotent. No permanent CLI surface.

**Pre-adoption harness cleanup.** The wild-and-crazy harness corpus
(R1/R2/R3 cold-author fixtures from v0.2.9 production) — `tests/skills/`,
`tests/fixtures/harness/`, `tests/harness-corpus.test.ts`,
`tests/skills-battery.test.ts` — removed in this release. Pre-adoption
means no external users depend on backwards-compat regression coverage;
R4 will rebuild fresh fixtures against canonical v0.7.0 syntax. Test
count drops ~187 (harness-corpus 66 + skills-battery 121) but the
remaining 896 tests cover the parser/runtime/lint paths comprehensively,
and v0.7.0-brace-substitution + v0.7.0-function-call ship 30 new tests
specific to the canonical surface. Git history preserves the discarded
fixtures if any are ever wanted as legacy snapshots.

### Deprecation grace period

Legacy syntax (`$(VAR)`, `~`, `>`, `@`, `!`, `??`, `&`) continues to
compile + execute in v0.7.x — both forms work identically during the
grace window. Tier-2 `deprecated-symbol-op` lint (visibility nudge)
ships in a v0.7.x point release; tier-1 promotion (refuse-to-compile)
lands in v0.8 or v0.9 once adopter ecosystem confirms migration.

### LOC ceiling

Narrow-core ceiling nudged 6800 → 7150 (current: 7078). ~280 LOC
across parser.ts (function-call grammar + REF_PATTERN const + paren-
balanced helpers) + runtime.ts (file_read/file_write + loose-bracket
condition regexes + `$${` escape) + compile.ts (alternation substitute
+ new op renderers) + lint.ts (4-capture extractVarRefs). Per the
v0.5.0 lesson `loc-vs-clarity`: ceiling is a signal, not a budget.

### Tests

30 new tests across 2 files (`v0.7.0-brace-substitution.test.ts`,
`v0.7.0-function-call.test.ts`). All 7 runtime-intrinsic function-call
ops covered + ${VAR} substitution in all positions (substitution body,
conditions, $set RHS, kwarg values) + file_read/file_write round-trip
+ mkdir-p + fallback + mixed legacy-and-new in same skill. Net suite
(after harness cleanup): 896 passing, 10 skipped, 1 env-gated
(YouTrack token).

## 0.5.0 — 2026-05-24

**R3 harness-driven cold-author UX wins.** Eight items closing the
load-bearing footguns the R3 cold-author harness surfaced (Perry kickoff
`15a50e29`). Bash-shaped string composition lands as a pair (items 2+3);
the `|fallback:"X"` filter closes ref-level coalesce; silent stubs on
unwired connectors become hard errors with a tier-1 lint; the
unquoted-substitution kwarg footgun gets a tier-2 lint with binding-
origin awareness; `$(NOW)` aligns with its documented ISO-8601 shape;
docs catch up on outputs.text + kwarg grammar.

### Added (load-bearing)

- **String-typed `$append` (item 2).** `$append VAR "more"` now type-
  dispatches on the target binding: list → push (existing behavior,
  regression-protected); string → concatenate (new). Lifts the
  `append-to-non-list` lint restriction for string-typed inits. Mirrors
  bash `+=`. Smallest behavior change to existing op that closes the
  R3 minion 4 string-composition gap.

- **`$set` bind-time interpolation (item 3).** `$set X = "...$(REF)..."`
  now resolves `$(REF)` at bind time (was: literal binding, refs
  unresolved at use-time). Mirrors bash double-quoted assignment. Per
  the design philosophy memory `8cccf5e5`: cold authors approach
  skillscript with bash intuition; items 2+3 together close the
  bash-shaped composition category without adding new operator surface.
  Behavior change called out per `dc824ee4` lesson option 1 — the
  literals-only spec was the cold-author footgun, not a deliberate
  call. R3 minion 4 + T6 dogfood independently confirmed in 3 days.

- **`|fallback:"X"` filter (item 4).** `$(VAR.field|fallback:"-")` —
  coalesce-on-missing-ref. When the upstream ref is unresolved, the
  filter substitutes the literal arg and the chain continues. Positional
  within the chain. Named `fallback` (not `default`) to align with
  op-level `(fallback: ...)` vocabulary — different syntactic site,
  same universal word for "what to do when a value-producer doesn't
  produce." Renaming decision: design thread `15a50e29` / `9f59ef63`.
  The pipe chain IS a primitive (filter-composition algebra); breaking
  the chain to align with op-level syntax would lose real expressiveness.

- **Silent-stub-on-unwired-connector → hard error + tier-1 lint
  (item 5).** Pre-v0.5.0: bare `$ TOOL` ops with no `primary` connector
  and no embedder toolDispatch emitted "Would call tool X (no
  dispatcher wired)" and bound `null` to the output var. Autonomous
  skills thought they succeeded. v0.5.0: runtime throws
  `ConnectorNotFoundError` (caught by op-level `(fallback:)` if
  declared); new tier-1 `unwired-primary-connector` lint surfaces the
  same at compile time when the registry is queryable. R3 minion 4
  motivation.

- **`unquoted-substitution-in-kwarg-value` tier-2 lint (item 1).** Fires
  when `$ tool key=$(VAR)` has unquoted `$(VAR)` AND VAR's binding
  origin suggests whitespace (`# Vars:` default with whitespace, `$set`
  literal with whitespace, `~`/`$`/`>` op output, or foreach iterator).
  Closes the R3 silent-arg-truncation footgun — pre-v0.5.0 the rendered
  string `key=value with spaces` re-tokenized at the MCP arg boundary
  and only the first chunk bound to `key`. Folklore (always quote
  dynamic kwarg values) becomes lint discipline. Walker tracks binding
  origin via `# Vars:` / `$set` / op-output / foreach-iter and only
  fires on suspect origins — no noise on safe literals.

### Added (polish)

- **`$(NOW)` ISO-8601 alignment (item 6).** `$(NOW)` now substitutes as
  ISO-8601 per the documented spec (was: raw epoch ms — docs/runtime
  drift identified by R3 minion 2). Numeric epoch ms/sec remain
  available as `$(EVENT.fired_at)` / `$(EVENT.fired_at_unix)`. New
  `|isodate` filter formats epoch ms/sec (auto-detected by magnitude)
  or ISO strings to ISO-8601 — `$(EVENT.fired_at_unix|isodate)`.

- **Docs: outputs.text shape clarification (item 7).** Investigated:
  the runtime intentionally distinguishes "programmatic surfaces"
  (`text`, `file:` — default to lastBoundVar, structured) from
  "human-readable surfaces" (`prompt-context:` / `template:` /
  `slack:` / `card:` — default to joined emissions). Cold-author
  surprise (R3 minion 3) was a docs gap, not a runtime bug. Help
  content now explains both shapes inline with the `# Output:` syntax.
  Emit-as-binding primitive (`! "text" -> VAR`) deferred to v0.5.1 as
  its own design item.

- **Docs improvements (item 8).** `# Output:` value-shape per kind
  documented inline. `$` op kwarg grammar table added (bare string,
  quoted string, integer, boolean, null, JSON array, JSON object,
  substitution, quoted substitution) with the v0.5.0 unquoted-kwarg
  lint warning surfaced inline. `|fallback:"X"` + `|isodate` filter
  entries added to the pipe-filters table. `$(NOW)` ISO-8601 note in
  the filters section.

### Changed

- **`|default:"X"` filter renamed to `|fallback:"X"`** (never shipped
  under the old name — vocabulary alignment landed pre-release, see
  item 4 above).

- **Runtime `$(NOW)` now substitutes as ISO-8601 string** (was: number
  with epoch ms). Skills consuming `$(NOW)` as a string get the
  documented shape; skills doing math on `$(NOW)` must migrate to
  `$(EVENT.fired_at)` (epoch ms) or `$(EVENT.fired_at_unix)` (sec).
  No shipped skills are known to math on `$(NOW)` — the surface read
  as a "current timestamp string" everywhere.

### Implementation notes

- **51 new tests across 5 v0.5.0 test files**: `v0.5.0-bash-pair`,
  `v0.5.0-fallback-filter`, `v0.5.0-unwired-connector`,
  `v0.5.0-unquoted-kwarg`, `v0.5.0-now-isodate`, `v0.5.0-outputs-shape`.
  Suite is 1052/1064 passing (2 failures are the YouTrack proving env
  gate and the pre-bump LOC ceiling — both expected).
- **LOC ceiling nudged 6600 → 6800** to accommodate the binding-origin
  walker + condition-context filter applier + chain parser.
- **Design discipline**: items 4 and 7 each ran a design-pushback loop
  (CC pushed back on Perry's primitive-unification framing for item 4;
  Perry conceded with "adjacent concepts that rhyme aren't the same
  primitive" sharpening; CC investigated item 7 first per Perry's gate
  framing, found it was a docs change, deferred emit-as-binding to
  v0.5.1). Both directions of the pushback pattern, healthy.

## 0.4.4 — 2026-05-24

**Dashboard SPA Connectors view shows the wired registry.** Closes the
"dashboard MCP view" gap (per `08a08316`): pre-v0.4.4 the SPA's
`#connectors` tab showed only post-hoc activity metrics from
`health_metrics`, so a user could wire YouTrack through `connectors.json`
and see an empty page until a skill actually exercised it.

### Fixed

- **`renderConnectors()` polls `runtime_capabilities`** and renders the
  full wired registry (MCP, Local model, Memory store, Skill store,
  Agent) above the existing activity-metrics table. Each entry shows
  class, contract version, and (for MCP) the effective `allowed_tools`
  allowlist from v0.4.1. Available MCP classes for `connectors.json`
  surface as a footer note (closed-set registry from v0.4.0).

- **`state.capabilities` field** populates on every poll (30s cadence).
  Refresh path is `runtime_capabilities` alongside the existing
  `skill_list` / `list_triggers` / `health_metrics` calls.

### Implementation notes

- **SPA-only change.** No runtime / parser / lint impact. The
  `runtime_capabilities` MCP tool already surfaced the full registry
  shape (v0.4.0 + v0.4.1); this release wires the SPA to consume it.
- **Tests:** 5 new in `tests/v0.4.4.test.ts` covering source-level
  wiring (polling, render, allowlist, classes) + dist/ build
  verification (so deployed dashboards get the fix).
- **LOC unchanged.** SPA changes don't count against narrow core; no
  ceiling impact.

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
