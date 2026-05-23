# Skill: tarot-pull
# Description: Draw a tarot card via random shell + LLM interpretation, then emit.
# Status: Approved
# Vars: QUESTION=What should I focus on this week?

draw:
    @ shuf -n1 -i 1-78 -> CARD_NUM

interpret: draw
    ~ prompt="You are a tarot reader. The querent drew card #$(CARD_NUM) of the Rider-Waite deck. Identify the card by number, then give a 3-sentence reading on this question: $(QUESTION)" model=qwen maxTokens=300 -> READING

speak: interpret
    ! Card drawn: #$(CARD_NUM|trim)
    ! ---
    ! $(READING)

default: speak