# Skill: classify-support-ticket
# Status: Approved v1:670a94cf
# Autonomous: true
# Description: Read an incoming support ticket and route it: severity-1 tickets get paged to ops-channel, billing tickets get tagged for finance review, everything else gets a draft reply queued for human review
# Vars: TICKET_TEXT, TICKET_ID
# Output: agent: ops-oncall

classify:
    $ llm prompt="Categorize this support ticket. Reply with EXACTLY one of: 'sev-1', 'billing', 'general'. No other text.\n\nTicket: ${TICKET_TEXT}" maxTokens=10 -> CATEGORY

severity_check:
    needs: classify
    $ llm prompt="Does this support ticket describe a service outage, data loss, security incident, or other production-severity-1 issue? Reply ONLY 'yes' or 'no'.\n\nTicket: ${TICKET_TEXT}" maxTokens=10 -> IS_SEV1

route:
    needs: severity_check
    if ${CATEGORY|trim} == "sev-1":
        emit(text="PAGE: sev-1 ticket ${TICKET_ID} - ${TICKET_TEXT}")
        $ data_write content="sev-1 ticket ${TICKET_ID}: ${TICKET_TEXT}" tags=["support","sev-1","page"]
    elif ${IS_SEV1|trim} == "yes":
        emit(text="PAGE: classifier said ${CATEGORY|trim} but severity-check flagged this as sev-1: ${TICKET_ID}")
        $ data_write content="sev-1 escalation ${TICKET_ID}: category=${CATEGORY|trim} but severity-check=yes" tags=["support","sev-1","disagreement"]
    elif ${CATEGORY|trim} == "billing":
        $set TAG_FOR = "finance"
        emit(text="Tagged for ${TAG_FOR} review: ${TICKET_ID}")
        $ data_write content="billing ticket ${TICKET_ID}: ${TICKET_TEXT}" tags=["support","billing"]
    else:
        $ llm prompt="Draft a polite acknowledgment reply for this support ticket. Two short sentences. No greeting, no sign-off.\n\n${TICKET_TEXT}" maxTokens=150 -> DRAFT
        $ data_write content="support draft ${TICKET_ID}: ${DRAFT|trim}" tags=["support","draft"]

default: route
