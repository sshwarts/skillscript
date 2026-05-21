# Skill: bad
# Vars: SOURCE=/etc/config
t:
    @ unsafe cp $(SOURCE) /tmp/backup-$(date +%s)-$(undeclared_var)
default: t
