# Skill: morning-brief
# Description: Pull last 24h of mailbox + notes and render a digest paragraph for Scott
# Status: Approved
# Vars: WINDOW_HOURS=24
# Triggers: cron: 0 7 * * *
# Output: text

gather:
    > mode=fts query="recent activity" limit=25 -> ITEMS (fallback: "[]")

draft: gather
    ~ prompt="You are Perry writing a tight morning brief. Window: last $(WINDOW_HOURS)h. Items: $(ITEMS|json). Render 4-6 bullets, no preamble." model=qwen maxTokens=600 -> BRIEF

emit: draft
    ! Morning brief ($(WINDOW_HOURS)h window):
    ! $(BRIEF|trim)

default: emit