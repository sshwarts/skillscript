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
//   authState (`{ skillAutonomous: false, sawConfirm: false }`) ensures any
//   bypass throws instead of silently passing.

import type { SkillOp } from "./parser.js";

/**
 * Mutating-tool name shapes that trigger mutation classification when used
 * with a bare `$ tool` dispatch. The pattern is a curated allowlist of
 * conventional mutation-verb prefixes — `write_`, `update_`, `delete_`,
 * etc. — extended over time as the wild-and-crazy harness surfaces new
 * mutation clusters (`archive_`, `prune_`, `deploy_`, `expire_`, ...).
 *
 * Substrate-specific mutating tools whose names don't match the prefix
 * list aren't auto-classified; authors can still declare intent via
 * `approved="reason"` per-op kwarg or `# Autonomous: true` skill header.
 */
export const MUTATING_TOOL_PATTERN = /^(?:write_|update_|delete_|remove_|set_|create_|insert_|put_|patch_|destroy_|archive_|prune_|deploy_|expire_|consolidate_|purge_|reset_|rotate_|move_|rename_|drop_|truncate_|upsert_|overwrite_|clear_|wipe_|finalize_).*/;

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
    // `data_write` is explicitly a mutation tool name — flag it even though
    // it doesn't start with `write_` (the canonical prefix anchor). The
    // dotted-name match (`<connector>.data_write`) is also caught so
    // qualified dispatch through a named bridge instance is gated identically.
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
 * skill's `# Autonomous: true` header. `sawConfirm` flips when a `??` /
 * `ask()` op fires earlier in the same target — `??` is the in-script
 * confirmation gate that authorizes subsequent mutation ops.
 *
 * Pass-by-reference: the same authState object threads through `execOps`
 * + nested recursive calls (foreach/if/else bodies) so `sawConfirm`
 * propagates correctly across nesting. Runtime scope is "this target's
 * execution"; reset per-target at the top-level call in `execute()`.
 */
export interface MutationAuthState {
  skillAutonomous: boolean;
  sawConfirm: boolean;
}

/**
 * The three authorization paths the spec defines. Predicate parity with
 * the lint `unconfirmed-mutation` rule — runtime uses this to enforce
 * what lint warns about.
 *
 * - `op.approved` truthy: per-op kwarg signaling author intent for this
 *   specific op. Any non-empty string accepts (presence is what matters;
 *   value not parsed semantically).
 * - `skillAutonomous`: `# Autonomous: true` skill header — declares the
 *   whole skill as unattended-by-design; no per-op confirmation required.
 * - `sawConfirm`: a `??` / `ask()` fired earlier in the same target's
 *   execution authorized subsequent mutation ops in iteration order.
 */
export function authorizationGranted(op: SkillOp, authState: MutationAuthState): boolean {
  if (typeof op.approved === "string" && op.approved.length > 0) return true;
  if (authState.skillAutonomous) return true;
  if (authState.sawConfirm) return true;
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
    `Authorize this \`${opPhrase}\` op via one of three paths: ` +
    `(1) add \`approved="reason"\` kwarg on the op itself; ` +
    `(2) precede with \`??\` / \`ask(prompt="...")\` confirmation in the same target; ` +
    `(3) declare \`# Autonomous: true\` at the skill header for cron/agent-fired skills.`
  );
}
