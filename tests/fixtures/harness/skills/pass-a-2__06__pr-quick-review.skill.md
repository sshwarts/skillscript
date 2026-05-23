# Skill: pr-quick-review
# Description: Fetch a PR diff and produce a Perry-voiced first-pass review
# Status: Approved
# Vars: REPO, PR_NUMBER

fetch:
    @ gh pr diff $(PR_NUMBER) --repo $(REPO) -> DIFF (fallback: "")

review: fetch
    & perry-voice-prelude -> VOICE
    ~ prompt="$(VOICE) Review the following PR diff. Surface concrete issues only, no praise. Diff: $(DIFF)" model=qwen maxTokens=900 -> REVIEW

emit: review
    ! PR $(REPO)#$(PR_NUMBER):
    ! $(REVIEW|trim)

default: emit