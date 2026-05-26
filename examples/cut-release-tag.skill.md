# Skill: cut-release-tag
# Status: Approved v1:eb29a798
# Description: Run when the user says "ship a release" or "cut a tag" on the current branch; collects commit-list since last tag, asks the user to confirm the version bump, applies the tag, and pushes it
# Vars: BUMP_KIND=patch
# Output: text

last_tag:
    shell(command="git describe --tags --abbrev=0") -> PREV_TAG
else:
    $set PREV_TAG = "(no prior tags)"
    emit(text="no previous tag found; treating this as the first release")

commits_since:
    needs: last_tag
    shell(command="git log --oneline ${PREV_TAG}..HEAD") -> COMMITS
else:
    $set COMMITS = "(unable to read commit log; proceeding without preview)"

propose:
    needs: commits_since
    $ llm prompt="Propose the next semver tag given prev tag '${PREV_TAG}', bump kind '${BUMP_KIND}', and commits below. Return ONLY the new tag string (e.g. v1.4.3). No commentary.\n\nCommits:\n${COMMITS}" model=qwen maxTokens=30 -> PROPOSED_TAG

confirm:
    needs: propose
    emit(text="Previous tag: ${PREV_TAG}")
    emit(text="Commits since:")
    emit(text="${COMMITS}")
    emit(text="Proposed new tag: ${PROPOSED_TAG|trim}")
    ask(prompt="Cut tag ${PROPOSED_TAG|trim}?") -> APPROVED

apply:
    needs: confirm
    shell(command="git tag ${PROPOSED_TAG|trim}") -> TAG_OUT
    shell(command="git push origin ${PROPOSED_TAG|trim}") -> PUSH_OUT
    emit(text="Tagged and pushed ${PROPOSED_TAG|trim}")
else:
    emit(text="Tag/push failed; rolling back local tag")
    shell(command="git tag -d ${PROPOSED_TAG|trim}") -> ROLLBACK

default: apply
