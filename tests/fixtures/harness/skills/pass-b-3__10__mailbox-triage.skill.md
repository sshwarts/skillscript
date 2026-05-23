# Skill: mailbox-triage
# Description: Pull addressed memories from the mailbox, classify urgency per item, summarize the urgent ones.
# Status: Approved
# Vars: AGENT_ID=perry, MAX_ITEMS=15

fetch:
    > mode=fts query="addressed:$(AGENT_ID)" limit=$(MAX_ITEMS) -> ITEMS (fallback: "[]")

triage: fetch
    $set URGENT_LINES=
    foreach M in $(ITEMS):
        ~ prompt="Reply with just 'urgent' or 'normal'. Item summary: $(M.summary)" model=qwen maxTokens=8 -> VERDICT
        if $(VERDICT|trim) == "urgent":
            # FEATURE-REQUEST: there is no string-append filter or `$set VAR=$(VAR)\n...` accumulator pattern documented.
            # Wanted: $set URGENT_LINES=$(URGENT_LINES)\n- $(M.id): $(M.summary)
            ! URGENT — $(M.id): $(M.summary)

report: triage
    ! Triage complete. See urgent items above.

default: report