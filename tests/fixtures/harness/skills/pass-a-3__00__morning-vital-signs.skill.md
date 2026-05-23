# Skill: morning-vital-signs
# Description: Fired at 7am to summarize overnight state into a single block of prose-context delivered to Perry.
# Status: Approved
# Vars: LOCATION=Asheville
# Triggers: cron: 0 7 * * *
# Output: prompt-context: perry
# Delivery-context: Morning vital signs digest. Surface anything anomalous in your first reply; otherwise just acknowledge.
# Timeout: 45

weather:
    @ curl -s "https://wttr.in/$(LOCATION|url)?format=%l:+%C+%t" -> WX (fallback: "weather unavailable")

mailbox:
    $ amp_check_mailbox limit=30 -> INBOX (fallback: "[]")

brief:
    > mode=fts query="morning-brief" limit=1 -> RECENT_BRIEF (fallback: "")

assemble: weather mailbox brief
    ~ prompt="Write 4 short bullet lines for Perry. Bullet 1: weather summary from this string: $(WX). Bullet 2: count of inbox items in this JSON: $(INBOX|json). Bullet 3: latest morning brief summary from: $(RECENT_BRIEF|json). Bullet 4: one anomaly-flag bullet only if anything looks off, else 'No anomalies'. No preamble." model=qwen maxTokens=300 -> DIGEST
    ! $(DIGEST)

default: assemble