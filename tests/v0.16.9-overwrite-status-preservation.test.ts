import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemSkillStore } from "../src/connectors/skill-store.js";

/**
 * v0.16.9 — Status preservation on overwrite (Perry's (A) intentional
 * trust-boundary). Status transition is the load-bearing security
 * operation — it requires explicit `update_status()` call (or
 * substrate-side authority via `metadata.status`), NOT a side-effect
 * of a body rewrite.
 *
 * Aligns with v0.16.8 `SkillMeta.author` immutability discipline: both
 * at the SkillStore trust-boundary, both prevent silent escalation
 * via body rewrite. Per Perry's `9d9aef14` / `fd18e3f7` ack.
 *
 * Scott resolved Perry's (A)-vs-(B) question with (A): intentional
 * trust-boundary. Aligns bundled `FilesystemSkillStore` with
 * `AmpSkillStore` behavior (which already preserved status across
 * overwrite per warm-adopter's `49e47835` finding).
 */

const DRAFT_BODY = `# Skill: probe
# Status: Draft

t:
    emit(text="hi")
default: t
`;

const APPROVED_BODY = `# Skill: probe
# Status: Approved

t:
    emit(text="hi")
default: t
`;

describe("v0.16.9 — overwrite-status preservation (FilesystemSkillStore)", () => {
  it("first-write with Approved body → stored as Approved (existing v0.9.1 auto-stamp behavior preserved)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0169-status-new-"));
    const store = new FilesystemSkillStore(dir);
    const info = await store.store("p1", APPROVED_BODY);
    expect(info.status).toBe("Approved");
    const meta = await store.metadata("p1");
    expect(meta.status).toBe("Approved");
  });

  it("first-write with Draft body → stored as Draft", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0169-status-new-draft-"));
    const store = new FilesystemSkillStore(dir);
    const info = await store.store("p2", DRAFT_BODY);
    expect(info.status).toBe("Draft");
  });

  it("overwrite existing Draft with Approved body → STAYS Draft (status preservation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0169-overwrite-draft-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("p3", DRAFT_BODY);
    // Re-write with Approved body declaration. Body's declaration should
    // NOT silently promote — that's the trust-boundary close.
    const info = await store.store("p3", APPROVED_BODY);
    expect(info.status).toBe("Draft");
    const meta = await store.metadata("p3");
    expect(meta.status).toBe("Draft");
  });

  it("overwrite existing Approved with Draft body → STAYS Approved (status preservation, both directions)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0169-overwrite-approved-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("p4", APPROVED_BODY);
    // Re-write with Draft body declaration. Body's declaration should NOT
    // silently demote either — symmetric preservation.
    const info = await store.store("p4", DRAFT_BODY);
    expect(info.status).toBe("Approved");
    const meta = await store.metadata("p4");
    expect(meta.status).toBe("Approved");
  });

  it("body is rewritten to match preserved status (body + persisted state agree post-overwrite)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0169-overwrite-body-rewrite-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("p5", DRAFT_BODY);
    await store.store("p5", APPROVED_BODY);
    // Body's declaration on disk should now say Draft (rewritten to match
    // preserved status). No mismatch between body and VersionInfo.
    const loaded = await store.load("p5");
    expect(loaded.source).toContain("# Status: Draft");
    expect(loaded.source).not.toMatch(/^# Status: Approved/m);
  });

  it("explicit metadata.status overrides preservation (authority-bypass path for update_status / dashboard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0169-explicit-override-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("p6", DRAFT_BODY);
    // Caller has authority — explicit metadata.status overrides preservation.
    // This is the path used by update_status and dashboard approval flows.
    const info = await store.store("p6", DRAFT_BODY, { status: "Approved" });
    expect(info.status).toBe("Approved");
    const meta = await store.metadata("p6");
    expect(meta.status).toBe("Approved");
  });

  it("Approved body on overwrite — approval token is re-stamped when persisted Approved (existing auto-stamp path preserved)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0169-approved-stamp-preserved-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("p7", APPROVED_BODY);
    // Overwrite with same Approved body. Persisted stays Approved (preserved);
    // approval token re-stamped on the rewritten body so hash matches.
    const info = await store.store("p7", APPROVED_BODY);
    expect(info.status).toBe("Approved");
    const loaded = await store.load("p7");
    expect(loaded.source).toMatch(/^# Status: Approved v\d+:[a-f0-9]+/m);
  });

  it("Disabled status preserved across overwrite (symmetric — applies to all transition directions)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0169-disabled-preserved-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("p8", DRAFT_BODY);
    await store.update_status("p8", "Disabled");
    // Body says Draft; persisted status is Disabled. Overwrite with same
    // body — preserve Disabled.
    const info = await store.store("p8", DRAFT_BODY);
    expect(info.status).toBe("Disabled");
  });

  it("status preservation works even when metadata.author is also being preserved (both invariants compose)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v0169-author-status-compose-"));
    const store = new FilesystemSkillStore(dir);
    await store.store("p9", DRAFT_BODY, { author: "alice" });
    // Overwrite with Approved body, no author override. Both author (alice)
    // and status (Draft) preserved.
    const info = await store.store("p9", APPROVED_BODY);
    expect(info.changed_by).toBe("alice");
    expect(info.status).toBe("Draft");
  });
});
