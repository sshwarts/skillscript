# Skill: session-start-handoff
# Description: Fires at session start. Hands Perry a brief on what changed since last session, plus pointers to template skills he can pick up.
# Status: Approved
# Triggers: session: start
# Output: prompt-context: perry
# Delivery-context: Session boot brief. Read first; act only on items flagged ACTION.
# Templates: bug-triage-template, ghostwrite-reply
# Timeout: 30

since:
    > mode=fts query="last-session" limit=1 -> LAST (fallback: "")

unread:
    $ amp_check_mailbox limit=20 -> INBOX (fallback: "[]")

assemble: since unread
    ~ prompt="Produce a 5-line session boot brief for Perry. Line 1: what time-window we cover (since $(LAST.created_at|trim) until now=$(NOW)). Lines 2-4: most important unread items in $(INBOX|json). Line 5: tag any item that requires immediate action with the prefix 'ACTION:'." model=qwen maxTokens=400 -> BRIEF
    ! $(BRIEF)

default: assemble