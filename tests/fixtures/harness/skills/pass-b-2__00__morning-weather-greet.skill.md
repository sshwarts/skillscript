# Skill: morning-weather-greet
# Description: Greet the user with a personalized weather summary at 7am local
# Status: Approved
# Vars: WHO=Scott, LOCATION=Asheville
# Triggers: cron: 0 7 * * *

fetch:
    @ curl -s "wttr.in/$(LOCATION|url)?format=j1" -> RAW (fallback: "{}")

summarize: fetch
    ~ prompt="One sentence summary of today's weather for a human, from JSON: $(RAW)" model=qwen maxTokens=120 -> SUMMARY

greet: summarize
    ! Good morning, $(WHO).
    ! $(SUMMARY|trim)

default: greet