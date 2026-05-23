# Skill: brief-on-error
# Description: Error handler — invoked when a parent skill's op fails without a target-level else.
# Status: Approved

log:
    @ logger -t skillscript "skill error: $(ERROR_CONTEXT)" -> _

emit: log
    ! Skill failed. Context: $(ERROR_CONTEXT)
    ! Captured to syslog. Will retry on next trigger.

default: emit