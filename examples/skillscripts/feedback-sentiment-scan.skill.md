# Skill: feedback-sentiment-scan
# Status: Draft
# Description: Each night, scan the previous 24h of customer feedback records, classify sentiment via the local model, and surface entries that read 'frustrated' or 'blocking' so the team sees them at start-of-day.
# Triggers: cron: 0 3 * * *
# Vars: SCAN_LIMIT=50
# Output: agent: support-lead

scan:
    $ data_read mode=fts query="customer feedback" limit=${SCAN_LIMIT} -> FEEDBACK
    emit(text="Sentiment scan results for ${NOW}:")
    foreach F in ${FEEDBACK.items}:
        $ llm prompt="Classify the sentiment of this customer feedback. Respond with ONE word: 'frustrated', 'blocking', 'satisfied', 'neutral'. No explanation.\n\nFeedback: ${F.summary}\nDetail: ${F.detail}" maxTokens=10 -> VERDICT
        if ${VERDICT|contains:"frustrated"}:
            emit(text="- FRUSTRATED [${F.id|trim}] ${F.summary}")
        elif ${VERDICT|contains:"blocking"}:
            emit(text="- BLOCKING [${F.id|trim}] ${F.summary}")

default: scan
