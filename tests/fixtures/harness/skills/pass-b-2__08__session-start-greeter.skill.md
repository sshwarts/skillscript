# Skill: session-start-greeter
# Description: Fires once at session start — checks mailbox + emits a short situational brief
# Status: Approved
# Triggers: session: start

mailbox:
    > mode=fts query="addressed:perry" limit=10 -> ITEMS

pinned:
    > mode=fts query="pinned" limit=5 -> PINS

brief: mailbox pinned
    ~ prompt="Compose a 3-line orientation. Mailbox count: $(ITEMS|length). Pinned reminders: $(PINS|length). Now: $(NOW)." model=qwen maxTokens=200 -> BRIEF

emit: brief
    ! Session up.
    ! $(BRIEF|trim)

default: emit