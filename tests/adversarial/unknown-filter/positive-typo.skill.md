# Skill: bad
# Vars: X=hi
t:
    emit(text="$(X|bogus)")
default: t
