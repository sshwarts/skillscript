# Skill: mailbox-triage
# Description: Walk mailbox items, classify each, surface only the high-signal ones with a single-line verdict.
# Status: Approved
# Vars: MAX_ITEMS=20

fetch:
    > mode=fts query="addressed:perry pending" limit=$(MAX_ITEMS) -> MAIL (fallback: "[]")

triage: fetch
    foreach M in $(MAIL):
        ~ prompt="One word verdict on whether this needs Perry's attention today. Reply act, defer, or ignore. Item: $(M.summary)" model=qwen maxTokens=8 -> VERDICT
        if $(VERDICT|trim) == "act":
            ! ACT  $(M.id): $(M.summary)
        elif $(VERDICT|trim) == "defer":
            ! defer $(M.id): $(M.summary)
        else:
            ! (ignored) $(M.summary)

default: triage