# Skill: pr-triage-orchestrator
# Description: Runs three child skills in sequence — fetch PRs, classify each, summarize to a digest.
# Status: Approved
# Vars: REPO=nanoclaw/core

fetch:
    $ execute_skill skill_name=pr-fetch repo=$(REPO) -> PRS_RAW

classify: fetch
    $ execute_skill skill_name=pr-classify prs=$(PRS_RAW) -> CLASSIFIED

digest: classify
    $ execute_skill skill_name=pr-digest-render classified=$(CLASSIFIED) -> REPORT

emit: digest
    ! Daily PR triage for $(REPO):
    ! $(REPORT)

default: emit