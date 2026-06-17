# Skill: morning-brief
# Status: Draft
# Description: Compose a daily morning brief from calendar, mailbox, and overnight notes when the cron trigger fires at 7am. Delivers via the agent: lifecycle hook to the receiving agent, who decides whether to surface to Slack / Discord / etc. Requires a `calendar` connector configured in connectors.json (the dotted `$ calendar.*` form). `model=qwen` is a representative LocalModel alias — adopters register one under whatever name fits (the bundled bootstrap registers `default`).
# Vars: AGENT, BRIEF_HORIZON_HOURS=24
# Triggers: cron: 0 7 * * *
# OnError: morning-brief-degraded
# Output: agent: ${AGENT}

${BRIEF}

calendar:
    $ calendar.list_events horizon_hours=${BRIEF_HORIZON_HOURS} -> EVENTS

mailbox:
    $ data_read mode=fts query="messages for ${AGENT}" limit=10 -> MAIL

overnight:
    $ data_read mode=rerank query="overnight notes and writes" limit=15 -> NOTES

compose: needs: calendar, mailbox, overnight
    $ llm prompt="Compose a concise morning brief. Calendar: ${EVENTS|json}. Mailbox: ${MAIL|json}. Overnight notes: ${NOTES|json}. Three sections, six bullets max each." model=qwen maxTokens=1200 -> BRIEF

default: compose
