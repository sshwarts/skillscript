# Skill: fingerprint-drift-recovery
# Description: Fallback for project-fingerprint-drift. Logs the error context to AMP so the next run has a breadcrumb, and emits a quiet 'check me' note.
# Status: Approved

log_error:
    $ amp_write_memory summary="drift-skill-failed" detail="$(ERROR_CONTEXT)" vault="private" knowledge_type="hard_won" confidence=0.6 domain_tags=["skill-failure","drift"] -> ACK (fallback: "write failed too")

emit: log_error
    ! drift skill errored at target $(ERROR_CONTEXT). recovery breadcrumb written.

default: emit