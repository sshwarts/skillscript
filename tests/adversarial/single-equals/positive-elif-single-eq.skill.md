# Skill: bad-cond
t:
    if $(VERDICT) == "urgent":
        emit(text="urgent")
    elif $(VERDICT) = "quiet":
        emit(text="quiet")
default: t
