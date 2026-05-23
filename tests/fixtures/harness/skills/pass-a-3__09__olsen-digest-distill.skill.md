# Skill: olsen-digest-distill
# Description: Distill Olsen's nightly digest into the top-3 items by composite (urgency * staleness). Wishful syntax left as comments where the language doesn't go.
# Status: Approved
# Triggers: cron: 0 8 * * *
# Output: text

fetch:
    > mode=fts query="olsen-digest" limit=20 -> ITEMS

# WISH: skill-level helper bindings. Want to declare a derived value once
# rather than re-prompting per-item. Today there's nothing between $set
# (literal RHS only) and a full ~ op. Feature request: $set with ref-RHS,
# or a let-binding for pure-string transforms.

# rank:
#     for M in $(ITEMS):
#         $set M.score = $(M.urgency) * $(M.staleness)   # arithmetic, doesn't exist
#     $sort ITEMS by .score desc                          # no sort op
#     $slice ITEMS 0 3 -> TOP_THREE                       # no slice op

# The above is what I wanted. Below is the LLM-shaped workaround that
# actually exists today.
rank: fetch
    ~ prompt="Rank these items by composite score = urgency * staleness. Return the top 3 as a JSON array of memory IDs, no prose. Items: $(ITEMS|json)" model=qwen maxTokens=300 -> TOP_IDS

walk: rank
    foreach M in $(ITEMS):
        if $(M.id) in $(TOP_IDS):
            ! TOP: $(M.summary)
        # WISH: `continue` inside foreach so I could early-out cleanly when
        # the item isn't in TOP_IDS. Not currently expressible — every
        # iteration runs to completion by design.

default: walk