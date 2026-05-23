# Skill: schedule-window-router
# Description: cron-fired hourly — decide whether we're inside a deep-work window and choose downstream skill to fire
# Status: Approved
# Vars: WORKDAY_START=9, WORKDAY_END=17
# Triggers: cron: 0 * * * *

clock:
    @ date +%H -> HOUR

decide: clock
    if $(HOUR|trim) >= $(WORKDAY_START):
        if $(HOUR|trim) < $(WORKDAY_END):
            ! Inside deep-work window ($(HOUR|trim):00); firing mailbox-digest
            $ execute_skill skill_name=mailbox-digest -> RESULT
            ! $(RESULT)
        else:
            ! After hours — skipping mailbox surface, just logging.
            $ amp_write_memory summary="Hourly tick — off-hours" detail="No action taken at $(HOUR|trim):00" vault=private knowledge_type=common confidence=0.3 domain_tags=["hourly-tick"] expires_at=$(EVENT.fired_at_plus_1d_unix)
    else:
        ! Before hours — silent.

# FEATURE REQUEST: nested `if` is a parse error today. Inner `if` indented to 8 spaces inside the
# outer `if` body (which sits at 4) trips `indentation: Mid-block indent change`. The parser tracks
# one indent depth per block and rejects nested blocks. Two possible fixes:
#   1. Permit nested control-flow with consistent +N indent per nesting level (the obvious fix).
#   2. Admit `and`/`or` boolean connectives so I never need to nest:
#         if $(HOUR|trim) >= $(WORKDAY_START) and $(HOUR|trim) < $(WORKDAY_END):
#      Reference §4 lists comparators but no boolean connectives. Today nested-if and compound
#      conditions are BOTH unavailable — that's a meaningful expressiveness ceiling.

default: decide