# Skill: supervisor-notify
# Status: Draft
# Description: Example failure-supervisor handler. When SKILLSCRIPT_SUPERVISOR_SKILL points at a skill like this one, the scheduler's trace-sweeper routes every NON-CLEAN autonomous fire (errored / deadline-exceeded / uncertain-effects) to it, with the failure details as vars. Copy it, adapt the DELIVERY to your channel, and APPROVE it — it lands Draft, a human approves it (that IS the governed-skill story). This version delivers to ${SUPERVISOR_AGENT} via `# Output: agent:`; for email / Slack / a webhook, replace the `# Output:` line with a `run:` block that dispatches a `$ connector.tool` or `shell(command="curl ...")`. NOTE: if THIS handler itself fails, the runtime does NOT re-route it (loop guard) — it logs to stderr only. Keep it simple and its delivery reliable.
# Autonomous: true
# Tags: supervisor, observability, ops
# Vars: FAILED_SKILL=unknown, OUTCOME=unknown, TRACE_ID=none, TRIGGER=none, ERROR_SUMMARY=, UNCERTAIN_EFFECTS=, DEADLINE_EXCEEDED=false, FIRED_AT_MS=0, SUPERVISOR_AGENT=ops-oncall
# Output: agent: ${SUPERVISOR_AGENT}

⚠ An autonomous fire needs attention.

Skill:    ${FAILED_SKILL}
Outcome:  ${OUTCOME}
Trigger:  ${TRIGGER}
Trace:    ${TRACE_ID}   (full detail: fires({trace_id: "${TRACE_ID}"}))

Errors:            ${ERROR_SUMMARY}
Uncertain effects: ${UNCERTAIN_EFFECTS}

If "Uncertain effects" is non-empty, an external mutation was issued but its outcome is
UNKNOWN — it may have partially landed. Reconcile it by hand; the runtime never retried it.
