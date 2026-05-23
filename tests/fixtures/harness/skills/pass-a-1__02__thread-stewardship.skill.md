# Skill: thread-stewardship
# Description: cron daily — sweep open AMP threads, ask local model which look stalled, post nudges
# Status: Approved
# Vars: STALL_DAYS=4
# Triggers: cron: 0 9 * * 1-5
# Output: text

open_threads:
    > mode=fts query="thread_status:open" limit=25 -> THREADS

# FEATURE REQUEST: I want a `> ... where_age_gt_days=N` extra-kwarg or an `age` filter on retrieval.
# Today there's no way to filter retrieval by created_before / age before iterating.

scan: open_threads
    foreach T in $(THREADS):
        # FEATURE REQUEST: arithmetic on ambient timestamps. I want:
        #   if $(NOW) - $(T.created_at) > $(STALL_DAYS) * 86400:
        # Skillfile doesn't admit arithmetic. Cron offsets like $(EVENT.fired_at_plus_1d_unix) exist
        # but there's no `fired_at_minus_N`, and no general expression layer. Pushing the comparison
        # into the LLM works but it's silly — the LLM is doing integer arithmetic.
        ~ prompt="Thread '$(T.summary)' last touched at unix $(T.created_at). Now is $(NOW). Is this older than $(STALL_DAYS) days AND still awaiting action? Reply 'stale' or 'fresh' only." model=qwen maxTokens=10 -> VERDICT
        if $(VERDICT|trim) == "stale":
            ! Nudging thread $(T.id): $(T.summary)
            $ amp_write_memory summary="Stewardship nudge — $(T.summary)" detail="Auto-flagged as stale (>$(STALL_DAYS)d)" vault=private domain_tags=["thread-stewardship"] knowledge_type=common confidence=0.6 thread_parent_id=$(T.id) payload_type=thread thread_status=pending_response

default: scan