# Skill: status-card-augmenter
# Description: Composes a status report + delivers as augment payload to a downstream agent
# Status: Approved
# Vars: PROJECT=skillfile
# Delivery-context: Status update for project $(PROJECT). Recommend next move.
# Templates: project-status-followup, kickoff-meeting-template
# Output: prompt-context: olsen
# Timeout: 120

git_log:
    @ git log --oneline -10 -> RECENT (fallback: "no git history")

memories:
    > mode=fts query="project:$(PROJECT)" limit=10 -> MEMS

compose: git_log memories
    ~ prompt="Compose a 4-line status report. Recent commits: $(RECENT). Notes: $(MEMS|json)" model=qwen maxTokens=400 -> REPORT

deliver: compose
    ! Project $(PROJECT) status — $(NOW)
    ! $(REPORT|trim)

default: deliver