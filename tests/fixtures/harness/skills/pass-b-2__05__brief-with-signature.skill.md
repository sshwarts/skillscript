# Skill: brief-with-signature
# Description: Compose a short brief and inline the signature data-skill at compile time
# Status: Approved
# Vars: TOPIC=skillfile runtime status

draft:
    ~ prompt="One-paragraph status brief on: $(TOPIC). Plain prose, no preamble." model=qwen maxTokens=300 -> BODY

compose: draft
    ! Brief: $(TOPIC)
    !
    ! $(BODY|trim)
    !
    & signature-block -> _

default: compose