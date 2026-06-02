# Skill: bad
# Vars: SOURCE=/etc/config
t:
    shell(command="cp $(SOURCE) /tmp/backup-$(date +%s)-$(undeclared_var)", unsafe=true)
default: t
