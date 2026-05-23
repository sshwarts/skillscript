# Skill: foreach-stress
# Description: Edge-case probe — nested foreach with membership checks and aliased vars.
# Status: Approved
# Vars: TAG=lesson

primary:
    > mode=fts query="domain:$(TAG)" limit=50 -> RECENT (fallback: "[]")

secondary:
    > mode=fts query="domain:related" limit=50 -> RELATED (fallback: "[]")

# Cross-join: emit each RECENT item that has a matching RELATED.author
join:
    needs: primary
    needs: secondary
    $set SEEN_AUTHORS=
    foreach R in $(RECENT):
        foreach A in $(RELATED):
            # FEATURE-REQUEST: no way to reference outer-loop iterator inside a nested foreach without aliasing.
            # Wanted: `if $(R.author) == $(A.author):` should work and does — but membership over a *list* of fields
            # like `if $(A.author) in $(RECENT[].author):` isn't supported.
            if $(R.author) == $(A.author):
                if $(R.author) not in $(SEEN_AUTHORS):
                    ! Match: author=$(R.author) recent=$(R.id) related=$(A.id)
                    # FEATURE-REQUEST: no list-append. Want `$set SEEN_AUTHORS=$(SEEN_AUTHORS)+[$(R.author)]`
                    $set SEEN_AUTHORS=$(R.author)

default: join