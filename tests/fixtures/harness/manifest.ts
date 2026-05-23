/**
 * Wild-and-crazy harness manifest (2026-05-23). Cold-author ground-truth
 * corpus produced by 6 fresh sub-agents (3 Pass A spec-fed, 3 Pass B
 * help-only) authoring creative Skillscript portfolios against v0.2.9.
 * Promoted to permanent regression fixtures per Perry's call (memory
 * `c04c1ac3`). See `README.md` (sibling) for the full background.
 *
 * Each entry classifies the expected outcome when the skill is run
 * through `compile()` against a SkillStore that has the entire corpus
 * loaded (so `&` data-skill references resolve). The test in
 * `tests/harness-corpus.test.ts` iterates this manifest.
 *
 * **Maintenance note.** If a future patch fixes Bug 11 (forward-
 * reference deferred resolution for `# OnError:` / `&` refs), the
 * `needs-fallback-skill` entries become `pass` and the stub-skill
 * scaffolding can drop away. If a future patch fixes Bug 14 (unknown-
 * block-introducer diagnostic), the `intentional-failure` entries'
 * error patterns may shift from "indentation" to "unknown-keyword" —
 * the patterns below match loosely to absorb that.
 */

export type HarnessClassification =
  | { kind: "pass" }
  | { kind: "needs-inputs"; inputs: Record<string, string> }
  | { kind: "needs-fallback-skill"; fallbackName: string; inputs?: Record<string, string> }
  | { kind: "intentional-failure"; errorPattern: RegExp; reason: string };

export interface HarnessEntry {
  file: string;
  classification: HarnessClassification;
}

// Plausible synthetic input values for "needs-inputs" skills. Match the
// shape the minion's skill body would naturally expect — short strings,
// realistic enough to satisfy `# Vars:` declarations without surprise.
const TEST_INPUTS: Record<string, string> = {
  MESSAGE: "Test message for olsen color classification.",
  SLUG: "test-doc-slug",
  REPO: "sshwarts/skillscript",
  PR_NUMBER: "42",
  TOPIC: "test-topic",
  REPORT_URL: "https://example.com/bug/123",
  REPORT_BODY: "Test bug report body.",
  INBOUND_BODY: "Test inbound message body for ghostwrite-reply.",
  FEATURE_PROMPT: "Test feature request prompt.",
};

function inputs(...keys: ReadonlyArray<keyof typeof TEST_INPUTS>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = TEST_INPUTS[k];
  return out;
}

export const HARNESS_MANIFEST: ReadonlyArray<HarnessEntry> = [
  // ─── needs-inputs (7) ──────────────────────────────────────────────────
  { file: "pass-a-1__07__olsen-color-from-message.skill.md", classification: { kind: "needs-inputs", inputs: inputs("MESSAGE") } },
  { file: "pass-a-1__10__doc-section-stitcher.skill.md", classification: { kind: "needs-inputs", inputs: inputs("SLUG") } },
  { file: "pass-a-2__06__pr-quick-review.skill.md", classification: { kind: "needs-inputs", inputs: inputs("REPO", "PR_NUMBER") } },
  { file: "pass-a-2__09__cluster-distill.skill.md", classification: { kind: "needs-inputs", inputs: inputs("TOPIC") } },
  { file: "pass-a-3__04__bug-triage-template.skill.md", classification: { kind: "needs-inputs", inputs: inputs("REPORT_URL", "REPORT_BODY") } },
  { file: "pass-a-3__06__ghostwrite-reply.skill.md", classification: { kind: "needs-inputs", inputs: inputs("INBOUND_BODY") } },
  { file: "pass-b-1__05__handoff-to-builder.skill.md", classification: { kind: "needs-inputs", inputs: inputs("FEATURE_PROMPT") } },

  // ─── needs-fallback-skill (3) — exercises Bug 11 (forward-reference) ──
  // These cold-authored skills declared `# OnError: <name>` for a fallback
  // they didn't define. Test stubs the fallback into the SkillStore.
  { file: "pass-a-2__07__ticket-router.skill.md", classification: { kind: "needs-fallback-skill", fallbackName: "ticket-router-fallback", inputs: { TICKET_BODY: "test ticket body", TICKET_ID: "T-42" } } },
  { file: "pass-b-2__02__olsen-overnight-distill.skill.md", classification: { kind: "needs-fallback-skill", fallbackName: "olsen-distill-fallback" } },
  { file: "pass-b-3__08__handoff-with-context.skill.md", classification: { kind: "needs-fallback-skill", fallbackName: "handoff-fallback", inputs: inputs("TOPIC") } },

  // ─── intentional-failure (2) — feature-request manifestos ─────────────
  // Both use hypothetical block-introducing keywords the parser doesn't
  // recognize. Match loosely so a future Bug 14 diagnostic (unknown-
  // keyword surfacing) doesn't break this test.
  { file: "pass-b-1__10__log-fanout-classifier.skill.md", classification: { kind: "intentional-failure", errorPattern: /indent(ation)?|unknown[-_ ]keyword/i, reason: "FR manifesto: `parallel:` / branch-scope / try/catch" } },
  { file: "pass-b-1__11__streaming-incident-narrator.skill.md", classification: { kind: "intentional-failure", errorPattern: /indent(ation)?|unknown[-_ ]keyword/i, reason: "FR manifesto: `@@` / destructuring / `|json_parse`" } },

  // ─── pass (54) ─────────────────────────────────────────────────────────
  { file: "pass-a-1__00__tide-glance.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-1__01__pre-deploy-gate.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-1__02__thread-stewardship.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-1__03__ham-band-watch.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-1__04__schedule-window-router.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-1__05__morning-brief.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-1__06__cluster-distill-driver.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-1__08__candidate-promotion-review.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-1__09__dedup-foreach-walk.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-2__00__morning-brief.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-2__01__mailbox-triage.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-2__02__frost-watch.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-2__03__log-anomaly-watch.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-2__04__morning-routine.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-2__05__perry-voice-prelude.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-2__08__archive-old-threads.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-3__00__morning-vital-signs.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-3__01__mailbox-urgency-triage.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-3__02__project-fingerprint-drift.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-3__03__session-start-handoff.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-3__05__perry-voice-style-block.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-3__07__weekly-status-roll-up.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-3__08__fingerprint-drift-recovery.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-3__09__olsen-digest-distill.skill.md", classification: { kind: "pass" } },
  { file: "pass-a-3__10__backup-rotator.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-1__00__tarot-pull.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-1__01__disk-watch.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-1__02__weekly-mantra-fragment.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-1__03__morning-card.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-1__04__pr-triage-orchestrator.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-1__06__mailbox-triage.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-1__07__brief-on-error.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-1__08__fragile-fetch.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-1__09__package-bump-wizard.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-2__00__morning-weather-greet.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-2__01__pr-drift-watch.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-2__03__drift-detection-orchestrator.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-2__04__signature-block.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-2__05__brief-with-signature.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-2__06__ticket-triage-router.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-2__07__status-card-augmenter.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-2__08__session-start-greeter.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-2__09__dangerous-cleanup.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-2__10__feature-request-showcase.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-3__00__greet-stranger.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-3__01__ask-then-act.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-3__02__disk-watchdog.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-3__03__retry-with-backoff.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-3__04__morning-brief.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-3__05__nightly-summary.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-3__06__olsen-digest-aside.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-3__07__pr-review-augment.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-3__09__foreach-stress.skill.md", classification: { kind: "pass" } },
  { file: "pass-b-3__10__mailbox-triage.skill.md", classification: { kind: "pass" } },
];
