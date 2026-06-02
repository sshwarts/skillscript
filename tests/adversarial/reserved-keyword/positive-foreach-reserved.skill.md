# Skill: bad
# Vars: ITEMS=[a, b]

t:
    foreach in in $(ITEMS):
        emit(text="$(in)")
default: t
