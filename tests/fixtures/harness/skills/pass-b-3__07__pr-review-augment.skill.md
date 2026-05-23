# Skill: pr-review-augment
# Description: Pulls recent commit diff, scores risk, augments delivery to reviewer agent with template hooks.
# Status: Approved
# Vars: REPO_PATH=/workspace/repo, SINCE=24h
# Output: prompt-context: reviewer
# Delivery-context: Take a 60-second risk read on this diff. Flag anything with side effects.
# Templates: deep-diff-walkthrough, regression-checklist

snapshot:
    @ git -C $(REPO_PATH) log --since=$(SINCE) --patch -> DIFF (fallback: "")

score: snapshot
    if $(DIFF|length) == "0":
        ! No commits in the last $(SINCE). Nothing to review.
    else:
        ~ prompt="Score risk on this diff (low / medium / high) and give one-sentence rationale: $(DIFF)" model=default maxTokens=200 -> VERDICT
        ! Risk: $(VERDICT|trim)
        ! ---
        ! Diff slice (truncated by length):
        ! $(DIFF)

default: score