# Skill: morning-brief
# Status: Approved v1:a08d0f21
# Description: Compose a daily morning brief from calendar, mailbox, and overnight data writes when the cron trigger fires at 7am. Delivers via the agent: lifecycle hook to the receiving agent, who decides whether to surface to Slack / Discord / etc. The `model=qwen` value below is a representative alias — adopters register a LocalModel under whatever name fits their setup (the bundled bootstrap registers one as `default`).
# Vars: AGENT, BRIEF_HORIZON_HOURS=24
# Triggers: cron: 0 7 * * *
# OnError: morning-brief-degraded
# Output: agent: ${AGENT}

calendar:
    $ calendar.list_events horizon_hours=${BRIEF_HORIZON_HOURS} -> EVENTS

mailbox:
    $ data_read mode=fts query="addressed:${AGENT} created_after:${EVENT.fired_at_unix}" limit=10 -> MAIL

overnight:
    $ data_read mode=rerank query="overnight writes since:${EVENT.fired_at_plus_1d_unix}" limit=15 -> NOTES

compose: needs: calendar, mailbox, overnight
    $ llm prompt="Compose a concise morning brief. Calendar: ${EVENTS|json}. Mailbox: ${MAIL|json}. Overnight notes: ${NOTES|json}. Three sections, six bullets max each." model=qwen maxTokens=1200 -> BRIEF
    emit(text="${BRIEF}")

default: compose
