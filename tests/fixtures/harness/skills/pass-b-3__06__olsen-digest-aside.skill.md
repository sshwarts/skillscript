# Skill: olsen-digest-aside
# Description: Data-skill — emits a one-paragraph human-style aside about Olsen's day. Inlined by other skills.
# Status: Approved
# Type: data
# Vars: RUNS=0, SURFACED=0, DEFERRED=0, VERDICT=neutral

paragraph:
    ! Olsen ran $(RUNS) decomposition passes, surfaced $(SURFACED) atoms,
    ! deferred $(DEFERRED). Net: $(VERDICT).

default: paragraph