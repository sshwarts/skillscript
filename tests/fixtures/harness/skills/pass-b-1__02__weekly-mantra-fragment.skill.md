# Skill: weekly-mantra-fragment
# Description: Data skill: produces a poetic mantra fragment for the parent skill to embed.
# Type: data
# Status: Approved
# Vars: TONE=stoic

mint:
    ~ prompt="Write a single-line $(TONE) mantra. No quotes, no preamble. Just the line." model=gemma2 maxTokens=40 -> LINE

emit: mint
    ! $(LINE|trim)

default: emit