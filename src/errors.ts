// Structured error hierarchy. Connectors throw these; the executor catches
// them and routes through the language's `else:` / `# OnError:` machinery.
// Filter helpers (`$(ERR|class)`) expose the error class to skill authors.
//
// Runtime-layer errors (e.g. `ReferentialIntegrityError`, Phase 2.1) are
// NOT subclasses of `ConnectorError` — they live at a different layer and
// don't pass through the executor's recovery machinery.

import type { ConnectorType } from "./connectors/types.js";

export interface LintDiagnostic {
  rule: string;
  message: string;
  block?: string;
  /** Tier-1 violations carry "error"; tier-2 "warning"; tier-3 "info". Defaults to "error" when omitted (legacy shape). */
  severity?: "error" | "warning" | "info";
  /** Canned remediation guidance per rule. */
  remediation?: string;
  /** Rule-specific structured extras. */
  extras?: Record<string, unknown>;
}

/**
 * Base for any error thrown by a connector implementation. Carries the
 * connector kind + implementation name so dispatch consumers can attribute
 * failures precisely.
 */
export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly connector_type: ConnectorType,
    public readonly implementation: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export class SkillNotFoundError extends ConnectorError {
  constructor(
    public readonly skill_name: string,
    implementation: string,
  ) {
    super(`Skill not found: '${skill_name}'`, "skill_store", implementation);
    this.name = "SkillNotFoundError";
  }
}

/**
 * v0.9.0 — refused at the universal execution gate (scheduler dispatch,
 * MCP execute_skill, in-skill `$ execute_skill`). Skill is Draft, Disabled,
 * or carries an invalid/missing hash-token. Flows through `# OnError:` like
 * any other connector-class error.
 */
export class ApprovalRejectedError extends ConnectorError {
  constructor(
    public readonly skill_name: string,
    public readonly reason: string,
    implementation: string,
  ) {
    super(`Approval rejected for skill '${skill_name}': ${reason}`, "skill_store", implementation);
    this.name = "ApprovalRejectedError";
  }
}

export class VersionNotFoundError extends ConnectorError {
  constructor(
    public readonly skill_name: string,
    public readonly version: string,
    implementation: string,
  ) {
    super(`Version '${version}' of skill '${skill_name}' not found`, "skill_store", implementation);
    this.name = "VersionNotFoundError";
  }
}

export class LintFailureError extends ConnectorError {
  constructor(
    public readonly diagnostics: LintDiagnostic[],
    implementation: string,
  ) {
    const summary = diagnostics.map((d) => `[${d.rule}] ${d.message}`).join("; ");
    super(`Tier-1 lint failure: ${summary}`, "skill_store", implementation);
    this.name = "LintFailureError";
  }
}

export class StorageConflictError extends ConnectorError {
  constructor(
    public readonly skill_name: string,
    public readonly reason: string,
    implementation: string,
  ) {
    super(`Storage conflict on '${skill_name}': ${reason}`, "skill_store", implementation);
    this.name = "StorageConflictError";
  }
}

export class QueryError extends ConnectorError {
  constructor(
    message: string,
    connector_type: ConnectorType,
    implementation: string,
    public readonly mode?: string,
  ) {
    super(message, connector_type, implementation);
    this.name = "QueryError";
  }
}

export class DispatchError extends ConnectorError {
  constructor(
    message: string,
    implementation: string,
    public readonly tool?: string,
  ) {
    super(message, "mcp_connector", implementation);
    this.name = "DispatchError";
  }
}

export class ModelError extends ConnectorError {
  constructor(
    message: string,
    implementation: string,
    public readonly model?: string,
  ) {
    super(message, "local_model", implementation);
    this.name = "ModelError";
  }
}

export class TimeoutError extends ConnectorError {
  constructor(
    connector_type: ConnectorType,
    implementation: string,
    public readonly timeout_ms: number,
  ) {
    super(`Operation timed out after ${timeout_ms}ms`, connector_type, implementation);
    this.name = "TimeoutError";
  }
}

// ─── Op-level error hierarchy (executor layer) ──────────────────────────────
//
// Distinct from `ConnectorError` (substrate layer). OpError + subclasses are
// thrown at runtime by the executor / dispatcher, caught by the `else:` /
// `# OnError:` machinery, and surfaced in `result.errors[]` with structured
// metadata + canned remediation strings per ERD §8 + lesson `a3ba4149`
// (agent-authored output).

/**
 * Pull a human-readable message out of an unknown thrown value. Handles the
 * `err instanceof Error ? err.message : String(err)` pattern in one place
 * so call sites don't reinvent it.
 */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Base class for any error thrown during op dispatch. Carries the op kind,
 * the target where the op lived, an optional inner cause (preserved when
 * an underlying connector / spawn / etc. error propagates upward), and an
 * actionable remediation string per `a3ba4149`.
 */
export class OpError extends Error {
  constructor(
    message: string,
    public readonly opKind: string,
    public readonly remediation: string,
    public readonly target?: string,
    public readonly innerCause?: string,
  ) {
    super(message);
    this.name = "OpError";
  }
}

/** A `$` / `~` / `>` op references a connector name not registered with the runtime. */
export class ConnectorNotFoundError extends OpError {
  constructor(
    public readonly connectorName: string,
    public readonly connectorType: ConnectorType,
    opKind: string,
    target?: string,
    /**
     * v0.10 — when bare-form (`$ llm`, `$ data_read`, `$ data_write`) errors
     * because the auto-wired substrate bridge isn't registered, pass the tool
     * name so the error message points cold authors at the right
     * `connectors.json` substrate setting instead of the generic "register
     * via API" copy. Omit for non-bridge errors.
     */
    bareBridgeTool?: string,
  ) {
    const bridgeInfo = bareBridgeTool !== undefined ? RESOLVE_BRIDGE_INFO[bareBridgeTool] : undefined;
    let message: string;
    let remediation: string;
    if (bridgeInfo !== undefined) {
      message = `No \`${bareBridgeTool}\` connector wired.`;
      remediation =
        `Set \`substrate.${bridgeInfo.slot}: '${bridgeInfo.defaultType}'\` in \`~/.skillscript/connectors.json\` to enable ${bridgeInfo.bridgeName}, ` +
        `or register a custom ${bridgeInfo.contract} programmatically. See docs/configuration.md for the full substrate config reference.`;
    } else {
      message = `${connectorType} '${connectorName}' not registered with the runtime.`;
      remediation =
        `Configure the connector via the registry (\`registry.register${connectorType.replace(/_./g, (m) => m[1]!.toUpperCase())}\` API), ` +
        `or check the spelling against the registered connector names. ` +
        `Bare \`${opKind} ...\` is reserved for typed-contract / runtime-intrinsic ops (\`execute_skill\`, \`json_parse\`, or a tool name that matches a wired connector). ` +
        `Use named form \`${opKind} <connector>.<tool>\` for substrate-specific MCP dispatch.`;
    }
    super(message, opKind, remediation, target);
    this.name = "ConnectorNotFoundError";
  }
}

/**
 * v0.10 — substrate-bridge-tool → (slot, defaultType, bridgeName, contract).
 * Used by ConnectorNotFoundError to surface substrate-aware remediation copy
 * when a bare bridge name (`$ llm`, `$ data_read`, `$ data_write`) errors
 * against a null substrate slot. Auto-wired in `bootstrap.ts` when the
 * relevant substrate exists, so reaching this error path means the substrate
 * slot is null + cold author needs the config pointer.
 */
const RESOLVE_BRIDGE_INFO: Record<string, { slot: string; defaultType: string; bridgeName: string; contract: string }> = {
  llm: { slot: "local_model", defaultType: "ollama", bridgeName: "the default Ollama bridge", contract: "LocalModel" },
  data_read: { slot: "data_store", defaultType: "sqlite", bridgeName: "the default SQLite DataStore bridge", contract: "DataStore" },
  data_write: { slot: "data_store", defaultType: "sqlite", bridgeName: "the default SQLite DataStore bridge", contract: "DataStore" },
};

/** An op exceeded its resolved timeout (per-op > skill > built-in). */
export class OpTimeoutError extends OpError {
  constructor(
    public readonly timeoutMs: number,
    opKind: string,
    target?: string,
  ) {
    const message = `Op '${opKind}' timed out after ${timeoutMs}ms.`;
    const remediation =
      `Increase the timeout: per-op via \`${opKind === "~" ? "timeoutSeconds=N kwarg" : "(no per-op kwarg; use skill header)"}\`, ` +
      `skill-level via \`# Timeout: N\` header (seconds), or runtime fallback via \`ctx.absoluteTimeoutMs\`. ` +
      `If the op should be fast, investigate why it's slow — model service down, network partition, etc.`;
    super(message, opKind, remediation, target);
    this.name = "OpTimeoutError";
  }
}


/**
 * A path component failed `safePathJoin` validation — empty, all-dots
 * (`.` / `..` / etc.), or contains a separator or null byte. Surfaces
 * path-traversal attempts at filesystem boundaries (TraceStore writes,
 * substrate-touching surfaces with untrusted name components).
 */
export class InvalidPathError extends Error {
  constructor(
    public readonly badComponent: string,
    public readonly reason: string,
  ) {
    const safe = badComponent.length > 40 ? `${badComponent.slice(0, 40)}...` : badComponent;
    super(
      `Invalid path component '${safe}': ${reason}. ` +
      "Path components must be non-empty, must not be '.'/'..'/all-dots, " +
      "and must not contain '/', '\\\\', or null bytes."
    );
    this.name = "InvalidPathError";
  }
}

/** A shell op (`shell(command="...", unsafe=true)`) fired with `runtime.enable_unsafe_shell = false` (default). */
export class UnsafeShellDisabledError extends OpError {
  constructor(
    public readonly command: string,
    target?: string,
  ) {
    const truncated = command.length > 80 ? `${command.slice(0, 80)}...` : command;
    const message = `\`@ unsafe\` op refused: \`runtime.enable_unsafe_shell\` is false. Command: '${truncated}'`;
    const remediation =
      `Set \`ctx.enableUnsafeShell = true\` to permit (after reviewing the shell content), ` +
      `or refactor to use the default \`@\` form with structured-spawn sandbox (one binary, no metacharacters). ` +
      `\`@ unsafe\` is lint-flagged tier-2 every time it appears — confirm the shell content was reviewed.`;
    super(message, "@", remediation, target);
    this.name = "UnsafeShellDisabledError";
  }
}

/**
 * v0.18.8 — a `shell(...)` op fired against a binary not in the operator's
 * `SKILLSCRIPT_SHELL_ALLOWLIST`. Default-deny: an unset allowlist refuses
 * every shell call (BREAKING from v0.18.7).
 *
 * Per Perry's "the error message IS the remediation doc" requirement: the
 * message names the offending binary + the env var + the audit helper.
 * Operators reading this error in logs know exactly what to do.
 */
export class ShellBinaryNotAllowedError extends OpError {
  constructor(
    public readonly binary: string,
    public readonly allowlist: string[] | undefined,
    target?: string,
  ) {
    const allowlistDisplay = allowlist === undefined
      ? "(unset — default-deny)"
      : allowlist.length === 0
        ? "(empty list — operator declared no shell binaries permitted)"
        : allowlist.join(", ");
    const message = `\`shell\` op refused: binary '${binary}' is not in the operator's shell allowlist. Current allowlist: ${allowlistDisplay}.`;
    const remediation =
      `Add '${binary}' to the runtime's shell allowlist via one of three wiring paths: ` +
      `(1) \`SKILLSCRIPT_SHELL_ALLOWLIST\` env var (comma-separated; works on CLI + bootstrap()); ` +
      `(2) \`shellAllowlist\` field in \`skillscript.config.json\`; ` +
      `(3) \`bootstrap({ shellAllowlist: [...] })\` programmatic opt for embedders. ` +
      `Then restart the runtime. ` +
      `To discover what binaries your existing skill corpus uses, run \`skillfile shell-audit\` — it scans every skill and prints the union of binaries ready to paste into the allowlist. ` +
      `Binary-scope is an operator boundary the skill author cannot escape via the \`unsafe\` keyword or any other in-skill mechanism. ` +
      `See \`docs/adopter-playbook.md\` § "Shell binary allowlist" for the migration walkthrough (including the programmatic-bootstrap path's \`.env\` auto-load gotcha).`;
    super(message, "shell", remediation, target);
    this.name = "ShellBinaryNotAllowedError";
  }
}

/**
 * A composition reference (`&` data-skill inline, `$ execute_skill`, or
 * `# Templates:` delivery) couldn't be resolved at execute time because
 * the SkillStore has no skill by that name. v0.3.1: forward-reference
 * lint demotion means the runtime is now the resolution gate, not
 * compile-time lint. Inherits `OpError` so it flows through `# OnError:`
 * fallback chains naturally.
 *
 * Distinct from the SkillStore-contract `SkillNotFoundError` (line 39) —
 * that's thrown by `store.load()` / `store.metadata()` and signals the
 * connector-layer miss. This class is the OpError-shaped wrapper the
 * runtime synthesizes for the composition site so cold-author skills
 * can use `# OnError:` as the recovery path.
 */
export class MissingSkillReferenceError extends OpError {
  constructor(
    public readonly missingSkillName: string,
    opKind: string,
    public readonly viaOp: "inline" | "$ execute_skill" | "# Templates",
    target?: string,
  ) {
    const message =
      `Skill '${target ?? "?"}' references skill '${missingSkillName}' via \`${viaOp}\` at execute time, ` +
      `but the SkillStore has no skill by that name. Was the reference intentional ` +
      `(forward-ref) and the skill never stored, or is this a typo?`;
    const remediation =
      `Store the missing skill via \`skill_write\`, fix the spelling at the call site, ` +
      `or wire a \`# OnError: <fallback-skill>\` on the calling skill so the failure ` +
      `routes to a recovery path. v0.3.1 demoted the lint to tier-2 — runtime is ` +
      `the resolution gate.`;
    super(message, opKind, remediation, target);
    this.name = "MissingSkillReferenceError";
  }
}

/** A `$(VAR)` reference couldn't be resolved at runtime. */
export class UnresolvedVariableError extends OpError {
  constructor(
    public readonly varRef: string,
    opKind: string,
    target?: string,
  ) {
    const message = `Unresolved variable reference at runtime: $(${varRef})`;
    const remediation =
      `Declare the variable via \`# Vars:\`, \`# Requires:\`, or bind it from a prior op (\`-> ${varRef}\`). ` +
      `Tier-1 ambient refs (NOW/USER/SESSION_CONTEXT/TRIGGER_TYPE/TRIGGER_PAYLOAD/ERROR_CONTEXT) ` +
      `are auto-injected — check spelling. Dotted refs (\`$(X.field)\`) require the root \`X\` to be bound first.`;
    super(message, opKind, remediation, target);
    this.name = "UnresolvedVariableError";
  }
}

/**
 * A numeric comparison (`<` / `>` / `<=` / `>=`) in an `if` / `elif` condition
 * had a non-numeric operand. v0.2.5 explicit-mismatch class — silent
 * lexicographic fallback would be the wrong default for the orchestration
 * carve-out (numeric thresholds + counts). Per Perry's f75477a4.
 */
export class TypeMismatchError extends OpError {
  constructor(
    public readonly refDesc: string,
    public readonly operator: string,
    public readonly lhs: string,
    public readonly rhs: string,
    target?: string,
  ) {
    const truncLhs = lhs.length > 40 ? `${lhs.slice(0, 40)}...` : lhs;
    const truncRhs = rhs.length > 40 ? `${rhs.slice(0, 40)}...` : rhs;
    const message =
      `Numeric comparison '${operator}' requires numeric operands; got '${truncLhs}' ${operator} '${truncRhs}' (ref: ${refDesc}).`;
    const remediation =
      `Both operands of \`<\` / \`>\` / \`<=\` / \`>=\` must coerce to numbers. ` +
      `If a value comes from a \`~\` op or \`@\` shell output, pre-process with the model to extract a numeric value, ` +
      `or strip noise via \`|trim\` before comparison. For collection sizes use \`|length\`. ` +
      `Arithmetic operators are out of scope — that's tool computation, not skill orchestration.`;
    super(message, "if", remediation, target);
    this.name = "TypeMismatchError";
  }
}

/**
 * v0.14.1 — A mutation-class op fired without author authorization. Closes
 * the gap where lint's `unconfirmed-mutation` rule was the only enforcement
 * surface — `execute_skill({source})` bypassed lint entirely, and lint-tier
 * warnings don't block. Runtime is now the load-bearing gate; lint stays
 * advisory.
 *
 * Mutation classes per shared classifier (`src/mutation-gate.ts`): `$ tool`
 * with mutating-name shape (`write_...`, `update_...`, etc.); `$ data_write`
 * MCP dispatch; `file_write(...)` runtime intrinsic. Authorization signals:
 * `# Autonomous: true` skill header, preceding `??` / `ask()` in the same
 * target, or `approved="reason"` per-op kwarg.
 *
 * Reference: discipline-only contracts are bugs (architecture invariant
 * banked v0.14.1) — when the language reference classifies an op as
 * requiring authorization, runtime enforcement is mandatory.
 */
export class UnconfirmedMutationError extends OpError {
  constructor(
    public readonly opShape: "data_write" | "mutating_tool" | "file_write",
    public readonly detail: string,
    public readonly requiredSignals: string[],
    suggestion: string,
    opKind: string,
    target?: string,
  ) {
    const opDescription =
      opShape === "data_write" ? `\`$ ${detail}\``
      : opShape === "mutating_tool" ? `\`$ ${detail}\` (mutating-name shape)`
      : `\`file_write(path="${detail}")\``;
    const message =
      `${opDescription} in target '${target ?? "?"}' is a mutation op without author authorization.`;
    super(message, opKind, suggestion, target);
    this.name = "UnconfirmedMutationError";
  }
}

/**
 * v0.14.1 — A `data_read` query carried filter keys the substrate doesn't
 * declare in its `supported_filters` manifest. Closes the silent-scope-leak
 * gap from the Phase 1 v4 cold-adopter dogfood: pre-v0.14.1, substrates
 * silently dropped unknown filters, so authors who wrote `query=... vault=...`
 * against a substrate that didn't honor `vault` got results that ignored the
 * scoping. v0.14.1 default is strict — unknown keys throw at the bridge
 * boundary; adopters opt out per-call with `permissive_filters: true`.
 *
 * Reference: discipline-only contracts are bugs (architecture invariant) —
 * the manifest declares supported_filters; the bridge enforces. Defaults-
 * over-knobs: protect by default, opt out explicitly.
 */
export class UnsupportedFilterError extends OpError {
  constructor(
    public readonly unsupportedKeys: string[],
    public readonly supportedKeys: string[],
    public readonly substrate: string,
    target?: string,
  ) {
    const message =
      `\`data_read\` query against ${substrate} carried unsupported filter key(s): ` +
      `${unsupportedKeys.map((k) => `'${k}'`).join(", ")}. ` +
      `Substrate declares supported_filters: [${supportedKeys.map((k) => `'${k}'`).join(", ") || "(none)"}].`;
    const remediation =
      `Either (a) drop the unsupported filter key(s) — the substrate would silently ignore them anyway; ` +
      `(b) pass \`permissive_filters: true\` on the query to acknowledge that unknowns are advisory; ` +
      `(c) switch to a substrate whose manifest declares the filter you need. ` +
      `Strict-default closes the silent-scope-leak class where an unsupported filter ` +
      `passes through and the caller assumes filtering happened.`;
    super(message, "$", remediation, target);
    this.name = "UnsupportedFilterError";
  }
}

/**
 * Structured JSON shape for entries in `result.errors[]`. Surfaces in
 * dispatch trace records, CLI diagnostics, and dashboard error views.
 */
export interface OpErrorMetadata {
  class: string;
  opKind: string;
  target: string;
  message: string;
  remediation?: string;
  innerCause?: string;
  connector?: string;
  skill?: string;
  trace_id?: string;
}

/**
 * v0.19.0 — POST `/event` hit with an event_name not registered with the
 * scheduler. The route maps this to HTTP 404. Standalone (not an
 * OpError) because it fires from the HTTP boundary, not inside skill
 * execution.
 */
export class EventNotFoundError extends Error {
  constructor(public readonly eventName: string) {
    super(`event_name '${eventName}' is not registered with this runtime`);
    this.name = "EventNotFoundError";
  }
}

/**
 * v0.19.0 — POST `/event` hit a registered event_name but the params
 * don't match the declared set. The route maps this to HTTP 400.
 * Per Perry's spec (memory `ceaf4579`): strict v1 — all declared params
 * must be present; no unknown params allowed. Defaults + type validation
 * deferred to v2.
 */
export class EventParamMismatchError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly declared: string[],
    public readonly supplied: string[],
    public readonly missing: string[],
    public readonly extra: string[],
  ) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing required params: ${missing.map((p) => `'${p}'`).join(", ")}`);
    if (extra.length > 0) parts.push(`unknown params: ${extra.map((p) => `'${p}'`).join(", ")}`);
    super(`POST /event '${eventName}' — ${parts.join("; ")}. Declared params: [${declared.map((p) => `'${p}'`).join(", ") || "(none)"}].`);
    this.name = "EventParamMismatchError";
  }
}
