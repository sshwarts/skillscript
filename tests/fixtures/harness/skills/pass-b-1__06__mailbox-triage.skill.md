# Skill: mailbox-triage
# Description: Pull mailbox memories, skip ones already seen, route each by classifier verdict.
# Status: Approved
# Vars: SEEN_IDS=

fetch:
    > mode=fts query="addressed:perry" limit=20 -> MAILBOX

walk: fetch
    foreach M in $(MAILBOX):
        if $(M.id) in $(SEEN_IDS):
            ! skip $(M.id) (already triaged)
        else:
            ~ prompt="Classify this mailbox item as one of: 'urgent', 'fyi', 'noise'. Item summary: $(M.summary)" model=gemma2 maxTokens=8 -> VERDICT
            if $(VERDICT|trim) == "urgent":
                ! [URGENT] $(M.summary) ($(M.id))
            elif $(VERDICT|trim) == "fyi":
                ! [fyi] $(M.summary)
            else:
                ! [noise dropped] $(M.id)

default: walk