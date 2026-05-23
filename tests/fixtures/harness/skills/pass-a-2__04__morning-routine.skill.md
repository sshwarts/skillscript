# Skill: morning-routine
# Description: Composite — chains morning-brief + mailbox-triage + frost-watch under one cron tick
# Status: Approved
# Triggers: cron: 0 7 * * *
# Output: text

brief:
    $ execute_skill skill_name=morning-brief -> BRIEF_RESULT

mail: brief
    $ execute_skill skill_name=mailbox-triage MAX_ITEMS=15 -> MAIL_RESULT

weather: brief
    $ execute_skill skill_name=frost-watch -> WX_RESULT

assemble: mail weather
    ! === Morning ===
    ! $(BRIEF_RESULT)
    ! --- Mail ---
    ! $(MAIL_RESULT)
    ! --- Weather ---
    ! $(WX_RESULT)

default: assemble