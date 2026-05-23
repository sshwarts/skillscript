# Skill: handoff-to-builder
# Description: Augmenting delivery — bundles a feature spec + delivery context for a builder agent.
# Status: Approved
# Vars: FEATURE_PROMPT, REPO_SLUG=nanoclaw/core
# Delivery-context: Builder: please scaffold this feature on a new branch. Match existing test patterns. Open a draft PR when the harness passes.
# Templates: builder-pr-template, builder-checklist
# Output: prompt-context: builder

gather:
    @ git -C /workspace/repos/$(REPO_SLUG|shell) log -1 --format=%H -> HEAD_SHA (fallback: "unknown")

draft: gather
    ~ prompt="Restate the following feature request as a crisp build brief: goals, acceptance criteria, out-of-scope notes. Source request: $(FEATURE_PROMPT)" model=qwen maxTokens=600 -> BRIEF

deliver: draft
    ! Feature handoff for $(REPO_SLUG) @ $(HEAD_SHA|trim)
    ! ---
    ! $(BRIEF)

default: deliver