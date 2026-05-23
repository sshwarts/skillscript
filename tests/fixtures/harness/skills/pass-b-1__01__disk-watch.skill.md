# Skill: disk-watch
# Description: Cron-fired disk usage monitor. Alerts when / partition exceeds threshold.
# Status: Approved
# Vars: THRESHOLD=85
# Triggers: cron: */15 * * * *

measure:
    @ df --output=pcent / -> RAW (fallback: "0%")

parse: measure
    ~ prompt="Extract the integer disk usage percentage from this df output. Reply with ONLY the integer, no % sign, no prose. Output: $(RAW)" model=qwen maxTokens=8 -> PCT

decide: parse
    if $(PCT|trim) >= $(THRESHOLD):
        ! ALERT: root partition at $(PCT|trim)% (threshold $(THRESHOLD)%). Run cleanup.
    else:
        ! Disk OK: $(PCT|trim)% used.

default: decide