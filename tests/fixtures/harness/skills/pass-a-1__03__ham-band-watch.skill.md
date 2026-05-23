# Skill: ham-band-watch
# Description: cron 15-min — check propagation conditions for 20m and ping Scott if SFI > threshold (so he gets on the radio)
# Status: Approved
# Vars: SFI_THRESHOLD=150
# Triggers: cron: */15 * * * *
# Output: text

fetch:
    @ curl -s "https://www.hamqsl.com/solarxml.php" -> XML (fallback: "")

extract: fetch
    ~ prompt="From this hamqsl solar XML, extract ONLY the integer value of the <solarflux> tag. No prose, no units. XML: $(XML)" model=qwen maxTokens=20 -> SFI

evaluate: extract
    if $(SFI|trim) > $(SFI_THRESHOLD):
        ! Solar flux $(SFI|trim) > $(SFI_THRESHOLD) — 20m should be hot. Time to get on the air, Scott.
        $ amp_write_memory summary="20m propagation alert" detail="SFI=$(SFI|trim) at $(NOW)" vault=private knowledge_type=common confidence=0.7 domain_tags=["ham-radio","propagation"] expires_at=$(EVENT.fired_at_plus_1d_unix) recipients=["scott"]
    else:
        ! SFI $(SFI|trim) under threshold ($(SFI_THRESHOLD)). No alert.

default: evaluate