# Skill: project-fingerprint-drift
# Description: Every 15 minutes, compute a content fingerprint over the active project's pinned memories. If it differs from the last stored fingerprint, emit a drift alert with a diff summary.
# Status: Approved
# Vars: PROJECT_SLUG=amp
# Triggers: cron: */15 * * * *
# Output: text

current:
    > mode=fts query="$(PROJECT_SLUG) pinned" limit=50 -> PINNED
    @ sha256sum -> FP_BYTES (fallback: "no-hash")
    $set CURRENT_FP_LABEL = "current-fp"

prior:
    > mode=fts query="fingerprint:$(PROJECT_SLUG)" limit=1 -> PRIOR_RECORD (fallback: "")

compare: current prior
    if $(FP_BYTES|trim) == $(PRIOR_RECORD.summary|trim):
        ! no drift since last scan
    else:
        ~ prompt="Briefly describe how this current pinned set differs in shape from prior. Current: $(PINNED|json). Prior summary: $(PRIOR_RECORD|json)" model=qwen maxTokens=200 -> DIFF
        ! DRIFT detected in $(PROJECT_SLUG): $(DIFF)
        $ amp_write_memory summary="fingerprint:$(PROJECT_SLUG)" detail="$(FP_BYTES|trim)" vault="private" knowledge_type="personal" confidence=0.9 domain_tags=["fingerprint","$(PROJECT_SLUG)"] -> WRITE_ACK

default: compare