# Skill: log-anomaly-watch
# Description: Pull recent error log lines, count them, and only wake Scott on a spike
# Status: Approved
# Vars: LOG_PATH=/var/log/app.log, BASELINE=5
# Triggers: cron: */15 * * * *

# Demonstrates `@ unsafe` — pipes/redirects via full bash. Linter flags every appearance tier-2.
gather:
    @ unsafe tail -n 500 $(LOG_PATH) | grep -i ERROR | tail -n 100 -> RECENT_ERRORS (fallback: "")

# WANT: a |count or |lines filter. Today I'd have to:
#   1. shell-pipe `wc -l` (already used unsafe above), OR
#   2. push the string through a model (wasteful), OR
#   3. accept that `|length` on a string returns char count, not line count.
#
# Right now $(RECENT_ERRORS|length) is character count — semantically wrong.
# Leaning on a high threshold (200 chars) as a hack instead.
evaluate: gather
    if $(RECENT_ERRORS|length) > "200":
        ~ prompt="Summarize these error lines in one sentence. Be specific. Lines: $(RECENT_ERRORS)" model=qwen maxTokens=160 -> SUMMARY
        ! [log spike] $(SUMMARY|trim)
    else:
        ! [log quiet]

default: evaluate