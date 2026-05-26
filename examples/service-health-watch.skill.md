# Skill: service-health-watch
# Status: Approved v1:7c93b4b4
# Description: Every 5 minutes check named service endpoints — if latency or status degrades, write a signal memory and alert
# Vars: SERVICES=[auth-api, ledger-api, search-api], LATENCY_BUDGET_MS=400
# Triggers: cron: */5 * * * *
# Output: none

probe:
    foreach SVC in ${SERVICES}:
        shell(command="curl -s -o /dev/null -w \"%{http_code} %{time_total}\" https://status.internal/${SVC|url}") -> RAW
        $ llm prompt="From the line '${RAW|trim}' (http_code time_seconds), and budget ${LATENCY_BUDGET_MS} ms, answer ok or degraded only." -> STATUS
        if ${STATUS|trim} == "degraded":
            $ memorystore.write summary="service degradation: ${SVC}" detail="probe at ${NOW}: ${RAW|trim}" domain_tags=[ops, service-health, degraded:${SVC}] vault=private knowledge_type=common expires_at=${EVENT.fired_at_plus_1d_unix} -> ACK
            emit(text="${SVC} degraded — wrote signal")
        else:
            emit(text="${SVC} ok")

default: probe
