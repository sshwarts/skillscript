/**
 * Vitest setup — global hooks shared across all test files.
 *
 * v0.9.0 — auto-stamp approval tokens on FilesystemSkillStore.store() in
 * tests. The production v0.9.0 design requires `# Status: Approved` to
 * carry a valid `vN:<token>` stamped by the dashboard's human-approval
 * flow. Test fixtures (~46 files) write bare `# Status: Approved` directly
 * via `skillStore.store()`; rather than sweeping every site to compute a
 * token, we transparently stamp Approved-without-token bodies at the
 * substrate boundary. Tests that exercise the gate's refusal path
 * (Draft / tampered / Disabled) write those statuses explicitly — they
 * never reach this code path.
 *
 * Production paths are unaffected: `update_status(name, "Approved")` does
 * the real stamping; bare-Approved bodies persisted via production code
 * stay bare and are refused at runtime as the design intends.
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
  // Fixtures may omit `# Status:` entirely or write `# Status: Approved`
  // without a token. Either case auto-stamps to a valid v1 token so the
  // gate accepts the fixture at runtime — tests that exercise gate
  // refusal write Draft/Disabled/tampered bodies explicitly.
  if (extracted === null || (extracted.status === "Approved" && extracted.approvalToken === null)) {
    body = stampApprovalToken(body);
  }
  return originalStore.call(this, name, body, metadata);
};
