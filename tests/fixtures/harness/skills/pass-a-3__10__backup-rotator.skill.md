# Skill: backup-rotator
# Description: Cron-fired backup snapshot of the workspace. Writes a timestamped tarball, prunes older than RETAIN_DAYS. Uses ambient $(EVENT.fired_at_unix) for naming.
# Status: Approved
# Vars: WORKSPACE=/workspace/agent, BACKUP_DIR=/workspace/agent/backups, RETAIN_DAYS=30
# Triggers: cron: 0 3 * * *
# Output: none

snapshot:
    @ unsafe tar czf $(BACKUP_DIR)/snap-$(EVENT.fired_at_unix).tgz $(WORKSPACE) -> TAR_OUT (fallback: "snapshot failed")

prune:
    @ unsafe find $(BACKUP_DIR) -name 'snap-*.tgz' -mtime +$(RETAIN_DAYS) -delete -> PRUNED

verify: snapshot prune
    @ ls -la $(BACKUP_DIR) -> LISTING (fallback: "")
    if $(TAR_OUT) != "snapshot failed":
        ! snapshot ok
    else:
        ! snapshot FAILED — manual intervention needed

horizon: verify
    ! next snapshot horizon (raw seconds): $(EVENT.fired_at_plus_1d_unix)

default: horizon