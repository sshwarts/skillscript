# Skill: log-fanout-classifier
# Description: Parallel fan-out across log shards, per-shard LLM classification, gather + verdict.
#              Includes try/catch wrappers (feature request).
# Status: Approved
# Vars: SHARD_DIR=/var/log/agent

list_shards:
    @ ls $(SHARD_DIR) -> SHARDS

# FEATURE REQUEST: `parallel:` block. Each branch dispatches concurrently, results
# collected into a synthetic dict with branch-name keys. As of v0.2.9 the only
# concurrency primitive is `foreach`, which is serial.
classify: list_shards
    parallel:
        branch app:
            @ tail -n200 $(SHARD_DIR)/app.log -> APP_LOG
            ~ prompt="severity score (0-10) for this tail: $(APP_LOG)" model=qwen -> APP_SCORE
        branch worker:
            @ tail -n200 $(SHARD_DIR)/worker.log -> WORKER_LOG
            ~ prompt="severity score (0-10) for this tail: $(WORKER_LOG)" model=qwen -> WORKER_SCORE
        branch gateway:
            @ tail -n200 $(SHARD_DIR)/gateway.log -> GW_LOG
            ~ prompt="severity score (0-10) for this tail: $(GW_LOG)" model=qwen -> GW_SCORE
    # FEATURE REQUEST: implicit join — variables from each branch are available
    # in the enclosing scope after the parallel block. Today, target outputs
    # don't cross block boundaries cleanly.

# FEATURE REQUEST: try/catch with typed error filters. Today the only handler is
# (fallback: "...") per op + `# OnError:` skill at the skill level. No way to
# scope a rescue to a sub-block or pattern-match on error class.
verdict: classify
    try:
        ~ prompt="Given scores app=$(APP_SCORE) worker=$(WORKER_SCORE) gateway=$(GW_SCORE), emit a single line incident summary." model=qwen -> SUMMARY
        ! $(SUMMARY)
    catch TimeoutError as E:
        ! LLM timed out on roll-up: $(E.message)
    catch any as E:
        ! Roll-up failed unexpectedly: $(E.kind) — $(E.message)

default: verdict