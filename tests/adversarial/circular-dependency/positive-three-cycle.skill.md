# Skill: bad
a: b
    emit(text="a")
b: c
    emit(text="b")
c: a
    emit(text="c")
default: a
