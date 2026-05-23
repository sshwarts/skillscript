# Skill: frost-watch
# Description: Cron-fired predawn check; pings Perry if the forecast low is below threshold
# Status: Approved
# Vars: LOCATION=Asheville,NC, THRESHOLD=36
# Triggers: cron: 30 5 * * *
# Timeout: 30

fetch:
    @ curl -s "wttr.in/$(LOCATION|url)?format=j1" -> RAW (fallback: "{}")

extract: fetch
    ~ prompt="Return only the integer overnight low in F, no units, no prose. JSON: $(RAW)" model=qwen maxTokens=8 -> LOW

decide: extract
    if $(LOW|trim) < $(THRESHOLD):
        ! Frost watch: forecast low $(LOW|trim)F (threshold $(THRESHOLD)F). Cover the plants.
    else:
        ! No frost concern: low $(LOW|trim)F.

default: decide