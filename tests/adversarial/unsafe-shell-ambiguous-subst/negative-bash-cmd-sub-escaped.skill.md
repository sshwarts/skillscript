# Skill: ok
t:
    shell(command="cp file.txt /tmp/backup-$$(date +%s)", unsafe=true)
default: t
