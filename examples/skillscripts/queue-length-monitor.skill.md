# Skill: queue-length-monitor
# Status: Draft
# Description: Count pending items in a queue and alert when the count exceeds threshold. Requires `cat` on the operator's shell allowlist (default-deny: a non-allowlisted binary is refused).
# Vars: QUEUE_PATH=/var/queue/pending.json, THRESHOLD=10
# Triggers: cron: */5 * * * *

# The canonical "count items via |length, compare via numeric > " pattern.
# Fetches a JSON array, pipes through the |length filter to get the element
# count, then numeric-compares against a configured threshold. No LocalModel
# needed for the count — the filter is deterministic + free.

fetch:
    shell(command="cat ${QUEUE_PATH}") -> ITEMS (fallback: "[]")

evaluate:
    needs: fetch
    if ${ITEMS|length} > ${THRESHOLD}:
        emit(text="Queue backlog: ${ITEMS|length} items pending (threshold ${THRESHOLD}). Action required.")
    else:
        emit(text="Queue healthy: ${ITEMS|length} items pending (under ${THRESHOLD}).")

default: evaluate
