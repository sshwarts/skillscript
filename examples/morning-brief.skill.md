# Skill: morning-brief
# Status: Approved
# Description: Compose a daily morning brief from calendar, mailbox, and overnight memory writes when the cron trigger fires at 7am.
# Vars: AGENT, BRIEF_HORIZON_HOURS=24
# Requires: user-var:morning-brief-channel -> CHANNEL (fallback: dev-null)
# Triggers: cron: 0 7 * * *
# OnError: morning-brief-degraded
# Output: slack: $(CHANNEL)
# Output: prompt-context: perry

calendar:
    $ calendar.list_events horizon_hours=$(BRIEF_HORIZON_HOURS) -> EVENTS

mailbox:
    > mode=fts query="addressed:$(AGENT) created_after:$(EVENT.fired_at_unix)" limit=10 -> MAIL

overnight:
    > mode=rerank query="overnight writes since:$(EVENT.fired_at_plus_1d_unix)" limit=15 -> NOTES

compose: needs: calendar, mailbox, overnight
    ~ prompt="Compose a concise morning brief. Calendar: $(EVENTS|json). Mailbox: $(MAIL|json). Overnight notes: $(NOTES|json). Three sections, six bullets max each." model=qwen maxTokens=1200 -> BRIEF
    ! $(BRIEF)

default: compose
