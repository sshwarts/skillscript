# Skill: retry-with-backoff
# Description: Edge-case probe — wants per-op retry with exponential backoff. No native support; documented as feature request.
# Status: Approved
# Vars: ENDPOINT=https://api.example.com/health, MAX_TRIES=3

# FEATURE-REQUEST: no built-in retry/backoff. The `(fallback: "...")` form catches one failure but doesn't retry.
# Wanted:
#   @ curl -fsS $(ENDPOINT) -> HEALTH (retry: 3, backoff: exponential, base_ms: 500)
# Today's best workaround: unroll attempts manually, which is ugly.

attempt_1:
    @ curl -fsS $(ENDPOINT) -> R1 (fallback: "")

attempt_2:
    needs: attempt_1
    if $(R1|trim) == "":
        @ curl -fsS $(ENDPOINT) -> R2 (fallback: "")
    else:
        $set R2=$(R1)

attempt_3:
    needs: attempt_2
    if $(R2|trim) == "":
        @ curl -fsS $(ENDPOINT) -> R3 (fallback: "")
    else:
        $set R3=$(R2)

report:
    needs: attempt_3
    if $(R3|trim) == "":
        ! Endpoint failed after $(MAX_TRIES) attempts.
    else:
        ! Endpoint healthy. Response: $(R3|trim)

default: report