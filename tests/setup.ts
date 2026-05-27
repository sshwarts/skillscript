/**
 * Vitest setup — global hooks shared across all test files.
 *
 * v0.9.1 — minimal compatibility hook. Production code (v0.9.1
 * `SkillStore.store()` auto-stamp, P0.4) now handles `# Status: Approved`
 * bodies natively, so this hook only covers the legacy case where
 * fixtures omit `# Status:` entirely. Such fixtures are treated as
 * implicitly Approved for test convenience — a bare-words skill body
 * without lifecycle ceremony lands runnable.
 *
 * Tests exercising the gate's refusal path (Draft / tampered / Disabled)
 * write those statuses explicitly — they never reach this code path.
 */
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";
import { stampApprovalToken, extractStatusFromBody } from "../src/approval.js";

const originalStore = FilesystemSkillStore.prototype.store;
FilesystemSkillStore.prototype.store = async function patchedStore(
  this: FilesystemSkillStore,
  name: string,
  source: string,
  metadata?: Parameters<typeof originalStore>[2],
) {
  let body = source;
  const extracted = extractStatusFromBody(body);
  // Production code stamps Approved bodies natively. Only handle the
  // no-Status-header case here: insert a stamped Approved line so the
  // fixture runs without manual ceremony.
  if (extracted === null) {
    body = stampApprovalToken(body);
  }
  return originalStore.call(this, name, body, metadata);
};
