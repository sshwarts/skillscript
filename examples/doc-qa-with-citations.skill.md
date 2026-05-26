# Skill: doc-qa-with-citations
# Status: Approved v1:2187bf35
# Description: When the user asks a question that requires retrieval over the doc set, answer with inline citations to memory IDs
# Vars: QUESTION, K=6
# Output: text

answer:
    $ memory mode=rerank query="${QUESTION}" limit=${K} -> HITS (fallback: [])
    $ llm prompt="Answer the question using ONLY the supplied passages. Cite each claim inline as [id:<memory-id>]. Question: ${QUESTION}. Passages: ${HITS|json}" maxTokens=900 -> RESPONSE
    emit(text="${RESPONSE}")

default: answer
