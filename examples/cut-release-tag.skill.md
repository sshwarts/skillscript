# Skill: cut-release-tag
# Status: Approved
# Description: Run when the user says "ship a release" or "cut a tag" on the current branch; collects commit-list since last tag, asks the user to confirm the version bump, applies the tag, and pushes it
# Vars: BUMP_KIND=patch
# Output: text

last_tag:
    @ git describe --tags --abbrev=0 -> PREV_TAG
else:
    $set PREV_TAG = "(no prior tags)"
    ! no previous tag found; treating this as the first release

commits_since:
    needs: last_tag
    @ git log --oneline $(PREV_TAG)..HEAD -> COMMITS
else:
    $set COMMITS = "(unable to read commit log; proceeding without preview)"

propose:
    needs: commits_since
    ~ prompt="Propose the next semver tag given prev tag '$(PREV_TAG)', bump kind '$(BUMP_KIND)', and commits below. Return ONLY the new tag string (e.g. v1.4.3). No commentary.\n\nCommits:\n$(COMMITS)" model=qwen maxTokens=30 -> PROPOSED_TAG

confirm:
    needs: propose
    ! Previous tag: $(PREV_TAG)
    ! Commits since:
    ! $(COMMITS)
    ! Proposed new tag: $(PROPOSED_TAG|trim)
    ?? "Cut tag $(PROPOSED_TAG|trim)?" -> APPROVED

apply:
    needs: confirm
    @ git tag $(PROPOSED_TAG|trim) -> TAG_OUT
    @ git push origin $(PROPOSED_TAG|trim) -> PUSH_OUT
    ! Tagged and pushed $(PROPOSED_TAG|trim)
else:
    ! Tag/push failed; rolling back local tag
    @ git tag -d $(PROPOSED_TAG|trim) -> ROLLBACK

default: apply
