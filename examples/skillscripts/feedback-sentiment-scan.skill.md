# Skill: feedback-sentiment-scan
# Status: Approved v1:4484f7e0
# Autonomous: true
# Description: Each night, scan the previous 24h of customer feedback records, classify sentiment via local model, surface entries where sentiment is "frustrated" or "blocking" so the team sees them at start-of-day; skip entries already seen on prior nights
# Triggers: cron: 0 3 * * *
# Vars: SCAN_LIMIT=50
# Output: agent: support-lead

fetch_new:
    $ data_read mode=fts query="customer feedback" limit=${SCAN_LIMIT} -> FEEDBACK

fetch_seen:
    $ data_read mode=fts query="sentiment-scan seen marker" limit=200 domain_tags=["sentiment-scan-seen"] -> SEEN_MARKERS

classify_and_emit:
    needs: fetch_new, fetch_seen
    emit(text="Sentiment scan results for ${NOW}:")
    foreach F in ${FEEDBACK.items}:
        if ${F.id|trim} in ${SEEN_MARKERS.items}:
            emit(text="- skipped (already classified): ${F.id|trim}")
        elif ${F.id|trim} not in ${SEEN_MARKERS.items}:
            $ llm prompt="Classify the sentiment of this customer feedback. Respond with ONE word: 'frustrated', 'blocking', 'satisfied', 'neutral'. No explanation.\n\nFeedback: ${F.summary}\nDetail: ${F.detail}" maxTokens=10 -> VERDICT
            if ${VERDICT|trim} == "frustrated":
                emit(text="- FRUSTRATED [${F.id|trim}] ${F.summary}")
            elif ${VERDICT|trim} == "blocking":
                emit(text="- BLOCKING [${F.id|trim}] ${F.summary}")
            $ data_write content="sentiment-scan seen ${F.id|trim} verdict=${VERDICT|trim} on ${EVENT.fired_at_unix}" tags=["sentiment-scan-seen"] expires_at=${EVENT.fired_at_plus_7d_unix} -> ACK

default: classify_and_emit
