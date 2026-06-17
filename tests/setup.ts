/**
 * Vitest setup — global hooks shared across all test files.
 *
 * Compatibility hook for fixtures that omit `# Status:` entirely: such bodies
 * are treated as implicitly Approved for test convenience (a bare-words skill
 * body without lifecycle ceremony lands runnable). v1.0 Gate #7 — unsecured
 * approval is UNKEYED, so this inserts a bare `# Status: Approved` header (no
 * token; the gate accepts it in unsecured mode, which is the test default).
 *
 * Tests exercising the gate's refusal path (Draft / Disabled / secured-mode
 * unsigned) write those statuses + arm secured mode explicitly — they never
 * reach this code path.
 */
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { extractStatusFromBody } from "../src/approval.js";

const originalStore = FilesystemSkillStore.prototype.store;
FilesystemSkillStore.prototype.store = async function patchedStore(
  this: FilesystemSkillStore,
  name: string,
  source: string,
  metadata?: Parameters<typeof originalStore>[2],
) {
  let body = source;
  const extracted = extractStatusFromBody(body);
  if (extracted === null) {
    // No Status header → insert a bare Approved header (unkeyed; runnable).
    body = /^#\s*Skill\s*:/m.test(body)
      ? body.replace(/^(#\s*Skill\s*:.*)$/m, `$1\n# Status: Approved`)
      : `# Status: Approved\n${body}`;
  }
  return originalStore.call(this, name, body, metadata);
};
