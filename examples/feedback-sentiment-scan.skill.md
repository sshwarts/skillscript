# Skill: feedback-sentiment-scan
# Status: Approved v1:111610fc
# Description: Each night, scan the previous 24h of customer feedback records, classify sentiment via local model, surface entries where sentiment is "frustrated" or "blocking" so the team sees them at start-of-day; skip entries already seen on prior nights
# Triggers: cron: 0 3 * * *
# Vars: SCAN_LIMIT=50
# Output: agent: support-lead

fetch_new:
    $ memory mode=fts query="customer feedback" limit=${SCAN_LIMIT} created_after=${EVENT.fired_at_unix} -> FEEDBACK

fetch_seen:
    $ memory mode=fts query="sentiment-scan seen marker" limit=200 domain_tags=["sentiment-scan-seen"] -> SEEN_MARKERS

classify_and_emit:
    needs: fetch_new, fetch_seen
    emit(text="Sentiment scan results for ${NOW}:")
    foreach F in ${FEEDBACK}:
        if ${F.id|trim} in ${SEEN_MARKERS}:
            emit(text="- skipped (already classified): ${F.id|trim}")
        elif ${F.id|trim} not in ${SEEN_MARKERS}:
            $ llm prompt="Classify the sentiment of this customer feedback. Respond with ONE word: 'frustrated', 'blocking', 'satisfied', 'neutral'. No explanation.\n\nFeedback: ${F.summary}\nDetail: ${F.detail}" model=gemma2 maxTokens=10 -> VERDICT
            if ${VERDICT|trim} == "frustrated":
                emit(text="- FRUSTRATED [${F.id|trim}] ${F.summary}")
            elif ${VERDICT|trim} == "blocking":
                emit(text="- BLOCKING [${F.id|trim}] ${F.summary}")
            $ memorystore.write summary="sentiment-scan seen ${F.id|trim}" detail="verdict=${VERDICT|trim} on ${EVENT.fired_at_unix}" knowledge_type=common vault=private domain_tags=["sentiment-scan-seen"] expires_at=${EVENT.fired_at_plus_7d_unix}

default: classify_and_emit
