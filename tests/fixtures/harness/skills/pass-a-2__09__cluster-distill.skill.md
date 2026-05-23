# Skill: cluster-distill
# Description: Pull clusters of related memories, score each, and distill the top-3 into atoms.
# Status: Draft
# Vars: TOPIC, K=3
# Triggers: cron: 0 3 * * *

retrieve:
    > mode=rerank query="$(TOPIC)" limit=50 -> CANDIDATES (fallback: "[]")

# WANT: parallel fan-out over a collection with bounded concurrency.
# Today foreach is sequential. I want something like:
#
#   parallel foreach M in $(CANDIDATES) concurrency=4:
#       ~ prompt="score this: $(M.summary)" -> SCORE
#       $set $(M.id).score = $(SCORE|trim)
#
# Also: no way to mutate an element of an iterated collection.
# The `$set $(M.id).score = ...` pattern is invented. No struct-field assignment,
# no map type, no accumulator semantics.
score: retrieve
    foreach M in $(CANDIDATES):
        ~ prompt="Score 0-10 how central this is to '$(TOPIC)'. Reply with only the number. Item: $(M.summary)" model=qwen maxTokens=4 -> SCORE
        ! $(M.id) $(SCORE|trim)

# WANT: `top N by ...` collection operator. Right now I emit scores
# and a downstream tool has to sort. The skill cannot compose its own ranking.
#
#   $set TOP = top 3 from $(CANDIDATES) by $(M.score)
#
# WANT: retry with backoff on `~` ops. (fallback: "...") gives a default,
# not a retry.
#
#   ~ prompt="..." retry=3 backoff=exp -> X
#
# WANT: typed result destructuring on `$` ops. We get one bound var that the
# next op has to parse out of JSON. Something like:
#
#   $ amp_query_memories query="..." -> {memories: ITEMS, hint: HINT}
distill: score
    ~ prompt="Given these scored items, write the K=$(K) sentence summary capturing the cluster's through-line." model=qwen maxTokens=400 -> SUMMARY

emit: distill
    ! Cluster on $(TOPIC):
    ! $(SUMMARY|trim)

default: emit