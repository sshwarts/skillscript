# Skill: handoff-with-context
# Description: Hands a research task to a partner agent with full context-augmenting headers + follow-on templates.
# Status: Approved
# Vars: TOPIC, PARTNER=researcher
# Output: prompt-context: researcher
# Delivery-context: We need a 3-source synthesis on $(TOPIC). Mainstream + adversarial + one contrarian.
# Templates: deep-citation-chase, contradiction-finder
# Timeout: 120
# OnError: handoff-fallback

gather_known:
    > mode=fts query="$(TOPIC)" limit=20 -> KNOWN (fallback: "[]")

frame: gather_known
    ~ prompt="In one paragraph, describe what we already know about $(TOPIC) based on these atoms: $(KNOWN). Identify the gap that needs external research." model=default maxTokens=400 -> FRAME

# FEATURE-REQUEST: no way to set per-target output channel. The whole skill routes via top-level `# Output:` only.
# Wanted: `target_name -> output: prompt-context: $(PARTNER)` so a single skill can fan out to different agents.

handoff: frame
    ! TOPIC: $(TOPIC)
    ! WHAT WE KNOW:
    ! $(FRAME|trim)
    ! ---
    ! Please return a structured synthesis with the three viewpoints.

default: handoff