# Skill: morning-brief
# Description: Composes a daily brief by orchestrating three child skills, then emits a unified narrative.
# Status: Approved
# Vars: USER_NAME=Scott
# Triggers: cron: 0 7 * * *

weather:
    $ execute_skill skill_name=disk-watchdog -> DISK_REPORT (fallback: "disk: unknown")

mail:
    $ execute_skill skill_name=mailbox-triage AGENT_ID=perry MAX_ITEMS=10 -> MAIL_REPORT (fallback: "mail: unknown")

calendar:
    # FEATURE-REQUEST: no built-in date/time helper. Want `$(NOW|date:"YYYY-MM-DD")` or a `$ now timezone=...` op.
    @ date +%Y-%m-%d -> TODAY (fallback: "today")

synthesize:
    needs: weather
    needs: mail
    needs: calendar
    ~ prompt="Compose a 3-bullet morning brief for $(USER_NAME) dated $(TODAY|trim). Sources:\nDISK: $(DISK_REPORT)\nMAIL: $(MAIL_REPORT)\nKeep it punchy." model=default maxTokens=300 -> BRIEF

deliver: synthesize
    ! Good morning, $(USER_NAME). Today is $(TODAY|trim).
    ! $(BRIEF|trim)

default: deliver