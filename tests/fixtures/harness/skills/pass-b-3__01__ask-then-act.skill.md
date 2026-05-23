# Skill: ask-then-act
# Description: Interactive — confirms a destructive action before firing it. Demonstrates `??` and mutation-confirmation lint flow.
# Status: Approved
# Vars: TARGET_PATH=/tmp/scratch

probe:
    @ ls -la $(TARGET_PATH) -> LISTING (fallback: "missing")

confirm: probe
    ! About to delete contents of $(TARGET_PATH):
    ! $(LISTING)
    ?? Proceed with deletion? (yes / no) -> ANSWER

act: confirm
    if $(ANSWER|trim) == "yes":
        # Mutation tool call that should be PRECEDED by `??` — confirmed by `confirm` target.
        $ delete_path path=$(TARGET_PATH) -> RESULT
        ! Deleted. Result: $(RESULT)
    else:
        ! Aborted by user.

default: act