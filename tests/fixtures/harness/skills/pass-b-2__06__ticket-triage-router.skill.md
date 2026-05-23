# Skill: ticket-triage-router
# Description: Multi-stage triage — classify, look up prior incidents, route to oncall with template
# Status: Approved
# Vars: TICKET_BODY=placeholder
# Delivery-context: Inbound ticket — classification + similar-incident matches attached. Suggest owner.
# Templates: ticket-assignment-procedure, ticket-postmortem-template
# Output: prompt-context: oncall

classify:
    ~ prompt="Classify ticket as one of: critical, normal, low. Reply only the label. Ticket: $(TICKET_BODY)" model=qwen -> VERDICT

similar: classify
    > mode=fts query="$(TICKET_BODY)" limit=5 -> PRIORS

# FEATURE REQUEST: nested control flow.
#   I want `foreach` inside an `if`. Today the parser rejects it as
#   "Mid-block indent change". Flattening below as a workaround.
route: similar
    if $(VERDICT|trim) == "critical":
        ! CRITICAL: $(TICKET_BODY)
        ! Found $(PRIORS|length) similar prior incidents (full list below).
    elif $(VERDICT|trim) == "normal":
        ! Normal ticket queued. $(PRIORS|length) related incidents on file.
    else:
        ! Low-priority ticket logged.

# Unconditional list dump — would prefer nested under the critical branch.
priors: route
    foreach P in $(PRIORS):
        ! - $(P.summary)

default: priors