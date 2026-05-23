# Skill: candidate-promotion-review
# Description: Template — render an interactive promote-or-discard walk-through over recent AMP candidates. Agent executes the prompt via its own tools.
# Status: Approved
# Vars: AGE_HOURS=24
# Output: template: perry

fetch:
    > mode=fts query="is_candidate:true" limit=15 -> CANDS

walkthrough: fetch
    if $(CANDS|length) == "0":
        ! No candidates pending review.
    else:
        ! You have $(CANDS|length) candidates awaiting promotion review. For each:
        foreach C in $(CANDS):
            ! ---
            ! id: $(C.id)
            ! summary: $(C.summary)
            ! confidence: $(C.confidence)
            ! detail: $(C.detail)
            ?? "Promote, discard, or skip?" -> CHOICE
            if $(CHOICE|trim) == "promote":
                $ amp_promote_memory memory_id=$(C.id) -> ACK
                ! Promoted: $(ACK)
            elif $(CHOICE|trim) == "discard":
                $ amp_delete_memory memory_id=$(C.id) -> ACK
                ! Discarded.
            else:
                ! Skipped.

default: walkthrough