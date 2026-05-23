# Skill: package-bump-wizard
# Description: Interactive npm dependency bump — asks before each upgrade, then ships a summary.
# Status: Approved
# Vars: MANIFEST=/workspace/agent/package.json

audit:
    @ npm outdated --json --prefix /workspace/agent -> OUTDATED (fallback: "{}")

distill: audit
    ~ prompt="Given this npm outdated JSON, list the top 3 packages most worth upgrading (high severity or large version gap). Output one per line: 'pkg | current -> latest | reason'. JSON: $(OUTDATED)" model=qwen maxTokens=300 -> SHORTLIST

confirm: distill
    ! Top upgrade candidates:
    ! $(SHORTLIST)
    ?? Approve upgrading the top candidate? Reply 'yes' or 'no'. -> APPROVAL

act: confirm
    if $(APPROVAL|trim) == "yes":
        ! User approved. (Bump would dispatch here.)
    else:
        ! Skipping bump. No changes made.

default: act