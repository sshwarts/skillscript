# Skill: olsen-overnight-distill
# Description: Cron-fired nightly — pulls today's prose memories, distills patterns, emits summary
# Status: Approved
# Triggers: cron: 0 3 * * *
# OnError: olsen-distill-fallback
# Timeout: 600

# FEATURE REQUEST: time-windowed retrieval predicate.
#   Want to say "memories created in the last 24h" inline. Today,
#   the > op has no since= predicate. Imagined:
#     > mode=fts query="prose" since="$(NOW)-86400" limit=200 -> RAW
#   Working around with a broad pull + LLM-filter.

pull:
    > mode=fts query="lesson hard_won" limit=200 -> RAW

cluster: pull
    ~ prompt="Group these memories into 3-7 themes. Return JSON array of {theme, memory_ids[]}. Items: $(RAW|json)" model=qwen maxTokens=1200 -> THEMES

narrate: cluster
    ~ prompt="Write a 6-line nightly distill from these clustered themes: $(THEMES)" model=default maxTokens=500 -> SUMMARY

emit: narrate
    ! === Olsen overnight distill ($(NOW)) ===
    ! Pulled $(RAW|length) candidates.
    ! $(SUMMARY|trim)

default: emit