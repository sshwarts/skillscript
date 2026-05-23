# Skill: olsen-color-from-message
# Description: Augmenting — read the latest inbound user message, extract structural color (entities/intent/register/valence/confidence), deliver alongside as prompt-context to Perry
# Status: Approved
# Vars: MESSAGE
# Delivery-context: Limbic second-observer read. Cortex Perry should compare this to his own contextual interpretation; emit a marker only on disagreement.
# Templates: olsen-marker-emit
# Output: prompt-context: perry

cold_read:
    ~ prompt="You are Olsen — a structurally non-anchored second observer. You see ONLY this message, no history. Extract: entities (people/projects), tags (domains), intent (1-3 words), register (calm/curious/frustrated/playful/urgent), valence (-1..+1), confidence (0..1). Output JSON only. Message: $(MESSAGE)" model=qwen maxTokens=400 -> COLOR

emit: cold_read
    ! ## Olsen color (cold read)
    ! $(COLOR|trim)

default: emit