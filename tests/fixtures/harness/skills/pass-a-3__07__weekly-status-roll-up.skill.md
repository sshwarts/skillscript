# Skill: weekly-status-roll-up
# Description: Compose three sub-skills — project drift, open threads, mailbox triage — into a single Friday roll-up.
# Status: Approved
# Triggers: cron: 0 16 * * 5
# Output: text
# Timeout: 120

# NOTE: would prefer `# OnError: weekly-roll-up-fallback` but that skill must
# already exist in the store at compile time — chicken-and-egg when authoring
# a composition tree top-down.

status:
    $ execute_skill skill_name="project-fingerprint-drift" -> DRIFT_RESULT (fallback: "drift skill unavailable")

threads:
    > mode=fts query="thread open" limit=20 -> OPEN_THREADS

triage:
    $ execute_skill skill_name="mailbox-urgency-triage" -> URGENT_RESULT (fallback: "triage skill unavailable")

assemble: status threads triage
    ~ prompt="Compose a Friday status digest with three sections: (1) Drift: $(DRIFT_RESULT). (2) Open threads (count=$(OPEN_THREADS|length)): $(OPEN_THREADS|json). (3) Urgent triage: $(URGENT_RESULT). Keep each section to 3 lines max." model=qwen maxTokens=600 -> DIGEST
    ! ===== Friday Roll-Up =====
    ! $(DIGEST)

default: assemble