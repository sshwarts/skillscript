# Skill: nightly-summary
# Description: Composes a nightly status memo by inlining the olsen-digest-aside data-skill plus its own LLM pass.
# Status: Approved
# Vars: DATE=today
# Triggers: cron: 0 23 * * *

stats:
    @ wc -l /var/log/olsen.log -> LINES (fallback: "0")

inline_aside:
    needs: stats
    & olsen-digest-aside RUNS=12 SURFACED=88 DEFERRED=3 VERDICT="green" -> ASIDE

compose:
    needs: inline_aside
    ~ prompt="Write a 4-sentence nightly memo for $(DATE). Include this aside verbatim:\n$(ASIDE)\nThen add one forward-looking note based on log volume: $(LINES|trim)." model=default maxTokens=400 -> MEMO

deliver: compose
    ! $(MEMO|trim)

default: deliver