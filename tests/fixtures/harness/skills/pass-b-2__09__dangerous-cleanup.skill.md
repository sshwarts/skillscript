# Skill: dangerous-cleanup
# Description: Sweep stale /tmp artifacts older than 7d with confirmation
# Status: Approved
# Vars: AGE_DAYS=7

confirm:
    ?? About to delete /tmp files older than $(AGE_DAYS) days. Proceed? -> OK

scan: confirm
    @ unsafe find /tmp -type f -mtime +$(AGE_DAYS) | head -50 -> CANDIDATES

# FEATURE REQUEST: conditional on ?? result.
#   Want: if $(OK) == "yes": delete. else: abort. Today, ?? doesn't
#   have a documented yes/no shape; I'm treating it as free text.
prune: scan
    if $(OK|trim) == "yes":
        @ unsafe find /tmp -type f -mtime +$(AGE_DAYS) -delete -> _
        ! Pruned candidates listed above.
    else:
        ! Aborted; no files touched.

default: prune