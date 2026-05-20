# Adversarial library

Per-rule fixtures that exercise the lint engine against known-violating
and known-clean skill sources. The `tests/adversarial.test.ts` runner
walks each `<rule-id>/` directory and asserts that:

- `positive-*.skill` fixtures **DO** fire the rule
- `negative-*.skill` fixtures **DO NOT** fire the rule

Layout:

```
tests/adversarial/
  <rule-id>/
    positive-1.skill   # violates the rule (lint should flag)
    positive-2.skill
    negative-1.skill   # boundary case that LOOKS like a violation but isn't
    negative-2.skill
```

v1.0-dev seeds 3-5 fixtures per tier-1 rule, 2-3 per tier-2/3. Authoring
new fixtures: pick a real-world authoring mistake the rule catches; add
both `positive-*` (clear violation) and `negative-*` (boundary that
shouldn't trip). Names are descriptive (`positive-naked-var.skill`,
`negative-foreach-iter-allowed.skill`).

The library grows post-launch via agent-generated adversarial; v1.0-dev
ships with hand-authored seeds.
