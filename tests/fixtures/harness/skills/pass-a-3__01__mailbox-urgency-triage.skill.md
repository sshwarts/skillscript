# Skill: mailbox-urgency-triage
# Description: Walk mailbox items, ask the model which IDs are urgent as a JSON array, then per-item pin the urgent ones and emit a triage summary.
# Status: Approved
# Triggers: cron: 0 */2 * * *
# Output: text

fetch:
    $ amp_check_mailbox limit=50 -> ITEMS (fallback: "[]")

classify: fetch
    ~ prompt="Given this mailbox JSON, return a JSON array of memory IDs that are URGENT (action required in next 4 hours). Only the JSON array. Mailbox: $(ITEMS|json)" model=qwen maxTokens=400 -> URGENT_IDS

walk: classify
    foreach M in $(ITEMS):
        if $(M.id) in $(URGENT_IDS):
            ! URGENT: $(M.id) — $(M.summary)
            $ amp_update_memory memory_id=$(M.id) pinned=true -> ACK
        else:
            ! routine: $(M.id) — $(M.summary)

default: walk