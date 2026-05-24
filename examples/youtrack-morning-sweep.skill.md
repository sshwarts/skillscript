# Skill: youtrack-morning-sweep
# Status: Approved
# Description: v0.4.1 proving case — pull recent YouTrack issues via a configured RemoteMcpConnector + dotted field access on parsed JSON + foreach over the issues array. Requires a `youtrack` connector configured in connectors.json (RemoteMcpConnector class, mcp-remote bridge, newline framing) with allowed_tools including search_issues + get_current_user.

fetch_me:
    $ youtrack.get_current_user -> ME

fetch_issues: fetch_me
    $ youtrack.search_issues query="for: me" limit=5 -> RAW

report: fetch_issues
    ! Morning sweep for $(ME.login):
    ! Open issues assigned: $(RAW.issuesPage|length)
    foreach I in $(RAW.issuesPage):
        ! - $(I.id): $(I.summary)

default: report
