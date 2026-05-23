# Skill: greet-stranger
# Description: Tiny one-shot — generate a warm greeting tailored to who's at the door.
# Status: Approved
# Vars: NAME=friend, MOOD=cheerful

compose:
    ~ prompt="Write one sentence greeting a person named $(NAME). Tone: $(MOOD). Keep it under 12 words." model=default maxTokens=60 -> LINE

deliver: compose
    ! $(LINE|trim)

default: deliver