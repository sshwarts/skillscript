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
  ) {
    const message = `${connectorType} '${connectorName}' not registered with the runtime.`;
    const remediation =
      `Configure the connector via the registry (\`registry.register${connectorType.replace(/_./g, (m) => m[1]!.toUpperCase())}\` API), ` +
      `or check the spelling against the registered connector names. ` +
      `Bare \`${opKind} ...\` routes through the 'primary'/'default' connector; ` +
      `\`${opKind} <name>.<tool>\` routes through the named instance.`;
    super(message, opKind, remediation, target);
    this.name = "ConnectorNotFoundError";
  }
}

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

/** A `??` ask-user op fired in autonomous mode (no `askUser` callback wired). */
export class InteractiveOpInAutonomousModeError extends OpError {
  constructor(
    public readonly prompt: string,
    target?: string,
  ) {
    const message = `\`??\` ask-user encountered in autonomous execution: ${prompt}`;
    const remediation =
      `Restructure the skill to take the value as an input (\`# Vars:\`) or via \`# Requires:\` cascade, ` +
      `or invoke from an interactive context that wires the \`askUser\` callback on ExecuteContext.`;
    super(message, "??", remediation, target);
    this.name = "InteractiveOpInAutonomousModeError";
  }
}

/** An `@ unsafe` op fired with `runtime.enable_unsafe_shell = false` (default). */
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
    public readonly viaOp: "&" | "$ execute_skill" | "# Templates",
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
