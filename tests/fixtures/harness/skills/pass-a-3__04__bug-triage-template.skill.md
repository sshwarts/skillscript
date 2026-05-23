# Skill: bug-triage-template
# Description: Compiles to a procedure prompt an agent (e.g. Olsen) executes itself when handed a bug report. Template-kind skill; runtime does not dispatch.
# Status: Approved
# Vars: REPORT_URL, REPORT_BODY
# Output: template: olsen
# Delivery-context: You're triaging a bug. Follow each step in order. Stop and ask if any step's prerequisite is unclear.

intro:
    ! You are triaging a bug report.
    ! URL: $(REPORT_URL)
    ! Body: $(REPORT_BODY)

steps: intro
    ! Step 1: Reproduce locally. If you cannot reproduce, note environment delta and stop.
    ! Step 2: Bisect to the introducing commit if reproducible.
    ! Step 3: Write a failing test that captures the regression.
    ! Step 4: Open a PR with the fix and link the regression test.
    ! Step 5: Reply on this thread with the PR link and a one-paragraph postmortem.

default: steps