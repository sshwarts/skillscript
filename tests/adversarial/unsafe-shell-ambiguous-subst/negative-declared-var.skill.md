# Skill: ok
# Vars: TIMESTAMP=1234567890
t:
    shell(command="cp file.txt /tmp/backup-$(TIMESTAMP)", unsafe=true)
default: t
