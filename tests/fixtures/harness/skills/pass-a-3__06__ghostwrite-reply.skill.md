# Skill: ghostwrite-reply
# Description: Draft a reply to an inbound message in Perry's voice. Pulls the voice style block at compile time via &.
# Status: Approved
# Vars: INBOUND_BODY, INTENT=acknowledge

voice:
    & perry-voice-style-block -> STYLE

draft: voice
    ~ prompt="Write a one-paragraph reply. Intent: $(INTENT). Match this voice exactly: $(STYLE). Inbound: $(INBOUND_BODY)" model=qwen maxTokens=300 -> REPLY
    ! $(REPLY)

default: draft