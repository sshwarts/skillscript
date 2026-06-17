# Skill: doc-qa-with-citations
# Status: Draft
# Description: When the user asks a question that requires retrieval over the doc set, answer with inline citations to record IDs
# Vars: QUESTION, K=6
# Output: text

${RESPONSE}

answer:
    $ data_read mode=rerank query="${QUESTION}" limit=${K} -> HITS (fallback: [])
    $ llm prompt="Answer the question using ONLY the supplied passages. Cite each claim inline as [id:<record-id>]. Question: ${QUESTION}. Passages: ${HITS|json}" maxTokens=900 -> RESPONSE

default: answer
