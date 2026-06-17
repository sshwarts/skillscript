# Skill: service-health-watch
# Status: Draft
# Autonomous: true
# Description: Every 5 minutes check named service endpoints — if latency or status degrades, write a signal record and alert. Requires `curl` on the operator's shell allowlist (default-deny: a non-allowlisted binary is refused).
# Vars: SERVICES=[auth-api, ledger-api, search-api], LATENCY_BUDGET_MS=400
# Triggers: cron: */5 * * * *
# Output: none

probe:
    foreach SVC in ${SERVICES}:
        shell(command="curl -s -o /dev/null -w \"%{http_code} %{time_total}\" https://status.internal/${SVC|url}") -> RAW
        $ llm prompt="From the line '${RAW|trim}' (http_code time_seconds), and budget ${LATENCY_BUDGET_MS} ms, answer ok or degraded only." -> STATUS
        if ${STATUS|trim} == "degraded":
            $ data_write content="service degradation: ${SVC} at ${NOW}: ${RAW|trim}" tags=["ops","service-health","degraded:${SVC}"] expires_at=${EVENT.fired_at_plus_1d_unix} -> ACK
            emit(text="${SVC} degraded — wrote signal ${ACK.id}")
        else:
            emit(text="${SVC} ok")

default: probe
