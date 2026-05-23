# Skill: morning-brief
# Description: cron 7am weekdays — compose Scott's morning brief by composing four sub-skills (calendar, mailbox, propagation, news). Demonstrates skill-of-skills.
# Status: Approved
# Triggers: cron: 0 7 * * 1-5
# Delivery-context: Scott's morning brief. Lead with anything time-sensitive; everything else is a glance.
# Output: prompt-context: perry

calendar:
    $ execute_skill skill_name=calendar-today -> CAL (fallback: "(no calendar data)")

mail:
    $ execute_skill skill_name=mailbox-digest -> MAIL (fallback: "(mailbox empty)")

prop:
    $ execute_skill skill_name=ham-band-watch -> PROP (fallback: "(no propagation read)")

news:
    $ execute_skill skill_name=hn-top-five -> NEWS (fallback: "(news unavailable)")

# FEATURE REQUEST: a way to fan-out sub-skill calls in parallel rather than sequential.
# These four are independent in the DAG but the runtime topo-sorts and dispatches sequentially.
# A `# Concurrency: parallel-targets` hint, or an explicit `parallel:` group marker, would let
# the orchestrator fork. Today each execute_skill blocks the next.

compose: calendar mail prop news
    ~ prompt="Compose Scott's morning brief in three paragraphs. Tone: dry, terse, smart-ass-adjacent. Lead with time-sensitive items. Calendar: $(CAL). Mailbox: $(MAIL). Propagation: $(PROP). HN: $(NEWS)." model=qwen maxTokens=800 -> BRIEF

write_record: compose
    $ amp_write_memory summary="Morning brief $(EVENT.fired_at_unix)" detail="$(BRIEF)" vault=private knowledge_type=common confidence=0.6 domain_tags=["morning-brief"] expires_at=$(EVENT.fired_at_plus_7d_unix) -> ACK

emit: write_record
    ! $(BRIEF)

default: emit