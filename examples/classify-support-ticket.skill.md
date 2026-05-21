# Skill: classify-support-ticket
# Status: Approved
# Description: Read an incoming support ticket and route it: severity-1 tickets get paged to ops-channel, billing tickets get tagged for finance review, everything else gets a draft reply queued for human review
# Vars: TICKET_TEXT, TICKET_ID
# Output: slack: ops-pages

classify:
    ~ prompt="Categorize this support ticket. Reply with EXACTLY one of: 'sev-1', 'billing', 'general'. No other text.\n\nTicket: $(TICKET_TEXT)" model=qwen maxTokens=10 -> CATEGORY

severity_check:
    needs: classify
    ~ prompt="Does this support ticket describe a service outage, data loss, security incident, or other production-severity-1 issue? Reply ONLY 'yes' or 'no'.\n\nTicket: $(TICKET_TEXT)" model=qwen maxTokens=10 -> IS_SEV1

route:
    needs: severity_check
    if $(CATEGORY|trim) == "sev-1":
        ! PAGE: sev-1 ticket $(TICKET_ID) - $(TICKET_TEXT)
        $ memorystore.write summary="sev-1 ticket $(TICKET_ID)" detail="$(TICKET_TEXT)" knowledge_type=hard_won vault=private domain_tags=["support","sev-1","page"]
    elif $(IS_SEV1|trim) == "yes":
        ! PAGE: classifier said $(CATEGORY|trim) but severity-check flagged this as sev-1: $(TICKET_ID)
        $ memorystore.write summary="sev-1 escalation $(TICKET_ID)" detail="category=$(CATEGORY|trim) but severity-check=yes" knowledge_type=hard_won vault=private domain_tags=["support","sev-1","disagreement"]
    elif $(CATEGORY|trim) == "billing":
        $set TAG_FOR = "finance"
        ! Tagged for $(TAG_FOR) review: $(TICKET_ID)
        $ memorystore.write summary="billing ticket $(TICKET_ID)" detail="$(TICKET_TEXT)" knowledge_type=common vault=private domain_tags=["support","billing"]
    else:
        ~ prompt="Draft a polite acknowledgment reply for this support ticket. Two short sentences. No greeting, no sign-off.\n\n$(TICKET_TEXT)" model=qwen maxTokens=150 -> DRAFT
        $ memorystore.write summary="support draft $(TICKET_ID)" detail="$(DRAFT|trim)" knowledge_type=common vault=private domain_tags=["support","draft"]

default: route
