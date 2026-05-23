# Skill: feature-request-showcase
# Description: Deliberate kitchen-sink — every "I wish this existed" syntax in one file
# Status: Draft
# Vars: TARGET=skillfile, THRESHOLD=5

# FEATURE REQUEST 1: try/catch on op blocks
#   try:
#       @ curl -s https://flaky.example.com -> RAW
#   catch as ERR:
#       ! fetch failed: $(ERR.message)

# FEATURE REQUEST 2: timeout overlay per-op
#   @ slow-binary arg --timeout=30s -> OUT
#   Imagined as op-level decorator:
#     @timeout(30) curl -s https://example.com -> OUT

# FEATURE REQUEST 3: assertions
#   assert $(COUNT|length) > 0 message="empty result rejected"

# FEATURE REQUEST 4: structured returns from skill targets
#   return { count: $(COUNT), digest: $(DIGEST) }
#   Today targets are emission-only; the caller can only see bound vars
#   passed through `! ...`.

# FEATURE REQUEST 5: regex filter
#   $(RAW|match:/\d+/) -> NUMS

# FEATURE REQUEST 6: arithmetic in conditionals
#   if ($(COUNT) - $(PRIOR)) > $(THRESHOLD):
#   Today only direct < > <= >= against literals or refs works.

# FEATURE REQUEST 7: foreach with index
#   foreach M, IDX in $(MEMORIES):
#       ! [$(IDX)] $(M.summary)

# FEATURE REQUEST 8: conditional retrieval mode
#   > mode=$(MODE) query="..." limit=10 -> OUT
#   Today `mode=` only accepts literals.

work:
    > mode=fts query="$(TARGET)" limit=10 -> RESULTS

emit: work
    ! Showcase ran. $(RESULTS|length) results for $(TARGET).
    ! See comments above for the syntax I wished I had.

default: emit