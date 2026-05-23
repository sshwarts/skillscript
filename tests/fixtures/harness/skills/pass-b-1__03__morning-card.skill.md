# Skill: morning-card
# Description: Daily personal card. Embeds a fragment from a data-skill, prepends weather + date.
# Status: Approved
# Vars: NAME=Scott, CITY=Asheville
# Triggers: cron: 0 7 * * *

context:
    @ date "+%A, %B %-d" -> TODAY
    @ curl -s "wttr.in/$(CITY|url)?format=%C+%t" -> SKY (fallback: "weather unavailable")

mantra: context
    & weekly-mantra-fragment TONE=hopeful -> FRAGMENT

assemble: mantra
    ! Good morning, $(NAME).
    ! $(TODAY|trim) in $(CITY). $(SKY|trim).
    ! ---
    ! $(FRAGMENT)

default: assemble