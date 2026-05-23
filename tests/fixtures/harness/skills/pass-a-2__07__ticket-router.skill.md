# Skill: ticket-router
# Description: Classify an incoming ticket, deliver augment context to oncall, expose follow-on templates
# Status: Approved
# Vars: TICKET_BODY, TICKET_ID
# Output: prompt-context: oncall
# Delivery-context: Triage assist — Perry's first read attached. Verdict not load-bearing; rerun if you disagree.
# Templates: ticket-assignment-procedure, ticket-escalate-procedure
# OnError: ticket-router-fallback

classify:
    ~ prompt="Classify urgency as critical, normal, or low. Reply with only the label. Ticket: $(TICKET_BODY)" model=qwen maxTokens=8 -> VERDICT

route: classify
    if $(VERDICT|trim) == "critical":
        ! [$(TICKET_ID)] CRITICAL — Perry's read. Body follows.
        ! $(TICKET_BODY)
    elif $(VERDICT|trim) == "normal":
        ! [$(TICKET_ID)] normal-priority. Standard SLA applies.
    else:
        ! [$(TICKET_ID)] low-priority. No action expected.

default: route