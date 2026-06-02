// v0.14.1 — Shared mutation classification + authorization helpers used by
// both lint (`unconfirmed-mutation` rule) and runtime enforcement (`execOps`
// Layer A + `execOpInner` Layer B). Single source of truth — when lint and
// runtime classify the same op the same way and check the same predicate,
// the "discipline-only contracts are bugs" class can't recur on this surface.
//
// Layered enforcement (defense-in-depth, mirrors the §27 `skill_status`
// template):
// - Layer A (load-bearing): `execOps` checks each op BEFORE dispatch; throws
//   `UnconfirmedMutationError` when `classifyMutation()` returns non-null
//   AND `authorizationGranted()` returns false.
// - Layer B (regression guard): `execOpInner` re-checks at the `$` and
//   `file_write` dispatch sites. Same predicate, same authState — defense
//   against a future caller that bypasses execOps. The fail-closed default
//   authState (`{ skillAutonomous: false }`) ensures any
//   bypass throws instead of silently passing.

import type { SkillOp } from "./parser.js";

/**
 * Mutating-tool name shapes that trigger mutation classification when used
 * with a bare `$ tool` dispatch. v0.15.0 broadens the pattern from prefix-
 * anchored (`/^(?:write_|update_|...)/ `) to underscore-boundary-anchored,
 * so resource_action names (skill_write, skill_delete, memory_write,
 * skill_update_status) classify uniformly with action_resource names
 * (write_file, update_status). Verbs are matched as underscore-delimited
 * tokens — `data_writer` is NOT a mutation (no boundary after "write"),
 * but `data_write`, `write_file`, and `pre_write_audit` all are.
 *
 * Closes the discipline-only-contract gap where the prefix pattern silently
 * passed `skill_write` while explicit special-casing caught `data_write`.
 *
 * Substrate-specific mutating tools whose names don't fit any verb token
 * still aren't auto-classified; authors can declare intent via
 * `approved="reason"` per-op kwarg or `# Autonomous: true` skill header.
 */
export const MUTATING_TOOL_PATTERN = /(?:^|_)(?:write|update|delete|remove|set|create|insert|put|patch|destroy|archive|prune|deploy|expire|consolidate|purge|reset|rotate|move|rename|drop|truncate|upsert|overwrite|clear|wipe|finalize)(?:_|$)/;

export type MutationKind = "data_write" | "mutating_tool" | "file_write";

export interface MutationClassification {
  kind: MutationKind;
  /** Tool name for `$` ops; path for `file_write`. User-facing in error copy. */
  detail: string;
}

/**
 * Returns the mutation classification for an op, or `null` if the op isn't
 * a mutation. Called by both the lint warning rule and the runtime
 * enforcement gate.
 */
export function classifyMutation(op: SkillOp): MutationClassification | null {
  if (op.kind === "$") {
    const toolName = op.body.split(/\s+/)[0] ?? "";
    // v0.15.0 — the broadened `MUTATING_TOOL_PATTERN` now subsumes the
    // earlier explicit `data_write` special-case (verbs match at any
    // underscore boundary). `data_write` keeps its own `kind` for
    // back-compat in `buildAuthorizationSuggestion` error copy; everything
    // else (skill_write, write_file, memory_delete, ...) flows through
    // the pattern path as `kind: "mutating_tool"`.
    const isDataWrite = toolName === "data_write" || /(?:^|_)data_write(?:_|$)/.test(toolName);
    if (isDataWrite) return { kind: "data_write", detail: toolName };
    if (MUTATING_TOOL_PATTERN.test(toolName)) return { kind: "mutating_tool", detail: toolName };
    return null;
  }
  if (op.kind === "file_write") {
    return { kind: "file_write", detail: op.fileParams?.path ?? "" };
  }
  return null;
}

/**
 * Per-target authorization state. `skillAutonomous` is set once from the
 * skill's `# Autonomous: true` header.
 *
 * v0.16.0: the `sawConfirm` path (legacy `??` / `ask()` gating) was retired
 * alongside the `ask` op removal. Authorization is now signaled only by
 * per-op `approved=` kwarg + skill-level `# Autonomous: true`.
 */
export interface MutationAuthState {
  skillAutonomous: boolean;
}

/**
 * The two authorization paths the spec defines. Predicate parity with the
 * lint `unconfirmed-mutation` rule — runtime uses this to enforce what
 * lint warns about.
 *
 * - `op.approved` truthy: per-op kwarg signaling author intent for this
 *   specific op. Any non-empty string accepts (presence is what matters;
 *   value not parsed semantically).
 * - `skillAutonomous`: `# Autonomous: true` skill header — declares the
 *   whole skill as unattended-by-design; no per-op confirmation required.
 */
export function authorizationGranted(op: SkillOp, authState: MutationAuthState): boolean {
  if (typeof op.approved === "string" && op.approved.length > 0) return true;
  if (authState.skillAutonomous) return true;
  return false;
}

/**
 * Build the concrete one-line remediation suggestion for an
 * `UnconfirmedMutationError`. Names all three authorization paths so
 * the adopter sees the full menu without bouncing to the docs.
 */
export function buildAuthorizationSuggestion(classification: MutationClassification): string {
  const opPhrase =
    classification.kind === "data_write" ? "$ data_write"
    : classification.kind === "mutating_tool" ? `$ ${classification.detail}`
    : `file_write(path="${classification.detail}")`;
  return (
    `Authorize this \`${opPhrase}\` op via one of two paths: ` +
    `(1) add \`approved="reason"\` kwarg on the op itself; ` +
    `(2) declare \`# Autonomous: true\` at the skill header for cron/agent-fired skills.`
  );
}
