# Skill: doc-qa-with-citations
# Status: Approved
# Description: When the user asks a question that requires retrieval over the doc set, answer with inline citations to memory IDs
# Vars: QUESTION, K=6
# Output: text

answer:
    > mode=rerank query="$(QUESTION)" limit=$(K) -> HITS (fallback: [])
    ~ prompt="Answer the question using ONLY the supplied passages. Cite each claim inline as [id:<memory-id>]. Question: $(QUESTION). Passages: $(HITS|json)" maxTokens=900 -> RESPONSE
    ! $(RESPONSE)

default: answer
