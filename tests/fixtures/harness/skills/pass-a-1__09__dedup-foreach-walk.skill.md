# Skill: dedup-foreach-walk
# Description: Edge-case probe — walk retrieved memories, dedupe against a previously-seen-id set, only act on novel items. Pushes filters + set membership.
# Status: Approved
# Vars: TOPIC=skillscript
# Output: text

seen_log:
    > mode=fts query="dedup-foreach-walk-seen" limit=1 -> LOG (fallback: "[]")

# FEATURE REQUEST: there's no clean way to extract a JSON array of ids out of a memory's detail field.
# I want $(LOG|pluck:id|json) — the `pluck` filter is explicitly listed as pending in the v2/v3 table
# (Reference §Pipe filters). Today I have to round-trip through ~ to coerce.

normalize_seen: seen_log
    ~ prompt="Return ONLY a JSON array of memory ids previously seen. If input is empty, return []. Input: $(LOG.detail)" model=qwen maxTokens=400 -> SEEN

candidates:
    > mode=fts query="$(TOPIC)" limit=20 -> ITEMS

walk: candidates normalize_seen
    foreach M in $(ITEMS):
        if $(M.id) not in $(SEEN):
            ! NEW: $(M.id) — $(M.summary)
            # FEATURE REQUEST: I want to accumulate IDs across loop iterations and write the new
            # seen-set back after the loop. Two problems:
            #   1. No `append` filter or list-mutation op.
            #   2. Scoping rules state $set inside foreach is loop-local — bindings don't persist.
            # The pattern I want: a per-skill accumulator that survives foreach iterations.
            # $set SEEN = $(SEEN|append:$(M.id))   ← imagined syntax, neither piece exists
        else:
            ! seen: $(M.id|trim)

default: walk