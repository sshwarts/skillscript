# Skill: archive-old-threads
# Description: One-shot: ask Scott to confirm, then sweep resolved threads older than N days
# Status: Approved
# Vars: AGE_DAYS=14

preview:
    > mode=fts query="resolved threads" limit=50 -> THREADS (fallback: "[]")
    ! Found $(THREADS|length) resolved thread chains older than $(AGE_DAYS) days.

gate: preview
    ?? Archive these threads? Reply yes or no. -> ANSWER

act: gate
    if $(ANSWER|trim) == "yes":
        $ amp_archive_resolved_threads older_than_seconds=1209600 -> RESULT
        ! Archived. $(RESULT)
    else:
        ! Aborted.

default: act