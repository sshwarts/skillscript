# Skill: pr-drift-watch
# Description: Cron-fired sentinel — alerts when nodejs/node open PR count drifts past threshold vs last reading
# Status: Approved
# Vars: REPO=nodejs/node, THRESHOLD=600
# Triggers: cron: 0 */6 * * *

# FEATURE REQUEST (state across runs):
#   Skillscript has no persistent variable scope between invocations.
#   Imagined syntax:
#     $persist LAST_COUNT      <- declares LAST_COUNT as runtime-persisted across runs
#   Workaround below: stash to /tmp and read it back.

fetch:
    @ curl -s "https://api.github.com/search/issues?q=repo:$(REPO|url)+is:pr+is:open" -> RAW (fallback: "{}")

extract: fetch
    $ execute_skill skill_name=extract-json-number BLOB=$(RAW) FIELD=total_count -> COUNT

readPrior:
    @ cat /tmp/pr-drift-last.txt -> PRIOR (fallback: "0")

evaluate: extract readPrior
    if $(COUNT|trim) > $(THRESHOLD):
        ! ALERT: $(REPO) open PRs at $(COUNT|trim) — exceeds threshold $(THRESHOLD).
    elif $(COUNT|trim) != $(PRIOR|trim):
        ! drift: $(REPO) PR count $(PRIOR|trim) -> $(COUNT|trim).
    else:
        ! steady: $(REPO) PR count $(COUNT|trim).

persist: evaluate
    @ unsafe echo "$(COUNT|trim)" > /tmp/pr-drift-last.txt -> _

default: persist