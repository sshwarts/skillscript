# Skill: ok
# Vars: X=hi
t:
    if $(X):
        emit(text="truthy")
default: t
