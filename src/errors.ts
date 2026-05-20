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
