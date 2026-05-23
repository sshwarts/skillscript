# Skill: disk-watchdog
# Description: Cron-fired disk-usage check; emits a warning when root partition is past threshold.
# Status: Approved
# Vars: THRESHOLD=85
# Triggers: cron: */15 * * * *

measure:
    @ df --output=pcent / -> RAW (fallback: "100%")

extract: measure
    ~ prompt="Extract just the integer percentage (no % sign) from this df output. Reply with only the number: $(RAW)" model=qwen maxTokens=10 -> PCT

evaluate: extract
    if $(PCT|trim) >= $(THRESHOLD):
        ! Disk pressure: root at $(PCT|trim)% (threshold $(THRESHOLD)%). Time to prune.
    else:
        ! Disk ok: root at $(PCT|trim)%.

default: evaluate