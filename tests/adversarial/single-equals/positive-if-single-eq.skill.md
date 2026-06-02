# Skill: bad-cond
t:
    if $(VERDICT) = "urgent":
        emit(text="urgent")
default: t
