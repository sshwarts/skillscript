# Skill: morning-brief
# Status: Draft
# Description: Compose a daily morning brief from calendar, mailbox, and overnight notes when the cron trigger fires at 7am. Delivers via the agent: lifecycle hook to the receiving agent, who decides whether to surface to Slack / Discord / etc. Requires a `calendar` connector configured in connectors.json (the dotted `$ calendar.*` form). `model=qwen` is a representative LocalModel alias — adopters register one under whatever name fits (the bundled bootstrap registers `default`). Every leg carries a per-leg `(fallback:)` so one failed source degrades loudly instead of sinking the whole gather; BRIEF itself is fallback-bound so the output template always renders.
# Vars: AGENT, BRIEF_HORIZON_HOURS=24
# Triggers: cron: 0 7 * * *
# Output: agent: ${AGENT}

${BRIEF}

calendar:
    $ calendar.list_events horizon_hours=${BRIEF_HORIZON_HOURS} -> EVENTS (fallback: "(calendar unavailable)")

mailbox:
    $ data_read mode=fts query="messages for ${AGENT}" limit=10 -> MAIL (fallback: "(mailbox unavailable)")

overnight:
    $ data_read mode=rerank query="overnight notes and writes" limit=15 -> NOTES (fallback: "(overnight notes unavailable)")

compose: needs: calendar, mailbox, overnight
    $ llm prompt="Compose a concise morning brief. Calendar: ${EVENTS|json}. Mailbox: ${MAIL|json}. Overnight notes: ${NOTES|json}. Three sections, six bullets max each. A source marked unavailable should be reported as such, not invented." model=qwen maxTokens=1200 -> BRIEF (fallback: "(morning brief unavailable — compose failed; check the llm connector)")

default: compose
