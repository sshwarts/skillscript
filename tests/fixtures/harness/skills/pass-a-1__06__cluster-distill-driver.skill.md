# Skill: cluster-distill-driver
# Description: nightly cron — find clusters of related memories on a topic, compose distillation by calling extract-json-number sub-skill per cluster
# Status: Approved
# Vars: TOPIC=embedded
# Triggers: cron: 0 3 * * *
# Output: none

clusters:
    > mode=fts query="$(TOPIC)" limit=15 -> ITEMS

distill: clusters
    if $(ITEMS|length) < "3":
        ! Not enough material to distill for topic '$(TOPIC)' ($(ITEMS|length) items)
    else:
        ~ prompt="Given these $(ITEMS|length) memories on '$(TOPIC)', identify the dominant pattern and emit a single hard-won lesson in <100 words. Items JSON: $(ITEMS|json)" model=qwen maxTokens=600 -> LESSON
        $ amp_write_memory summary="Distilled: $(TOPIC) pattern" detail="$(LESSON)" vault=private knowledge_type=hard_won domain_tags=["$(TOPIC)", "distilled"] confidence=0.7 memory_subtype=lesson -> WRITE_ACK
        ! Distillation written: $(WRITE_ACK.id)

# FEATURE REQUEST: the `&` op (inline data-skill) should support procedural skills too,
# OR a cleaner shorthand than `$ execute_skill skill_name=foo arg=...`. Compare:
#     & extract-json-number path="overnight_low_f" blob=$(RAW) -> LOW
# vs
#     $ execute_skill skill_name=extract-json-number path="overnight_low_f" blob=$(RAW) -> LOW
# `&` is reserved for data-skills today; extending it to procedural unifies composition syntax.

default: distill