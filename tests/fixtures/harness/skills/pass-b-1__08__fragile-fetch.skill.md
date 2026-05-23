# Skill: fragile-fetch
# Description: Demonstrates OnError dispatch — when the fetch fails and no else: rescues, brief-on-error fires.
# Status: Approved
# Vars: ENDPOINT=https://example.test/maybe-down
# OnError: brief-on-error
# Triggers: cron: 0 */6 * * *

fetch:
    @ curl -sf --max-time 5 $(ENDPOINT) -> BODY

parse: fetch
    ~ prompt="Summarize this JSON in one line: $(BODY)" model=qwen maxTokens=80 -> SUMMARY

speak: parse
    ! Endpoint summary: $(SUMMARY|trim)

default: speak