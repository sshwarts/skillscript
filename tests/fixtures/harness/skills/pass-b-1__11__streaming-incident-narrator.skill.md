# Skill: streaming-incident-narrator
# Description: Subscribe to a log stream, run incremental LLM narration as chunks arrive,
#              destructure structured returns, write back via a mutating tool with guarded confirmation.
# Status: Approved
# Vars: STREAM_URL=tail+sse://logs.internal/incidents

# FEATURE REQUEST: streaming op kind. Today `@`, `~`, `$`, `>` are all single-shot
# request/response — they bind a final value. There's no way to consume a stream
# while it's still emitting. Proposed shape:
#
#   @@ curl --no-buffer -N $(STREAM_URL) -> CHUNK every:
#       ~ prompt="Narrate this log chunk: $(CHUNK)" model=qwen -> NOTE
#       ! $(NOTE)
#
# The `every:` clause would run its body once per chunk. Loop terminates when the
# stream closes. Sibling: `~~` for streaming LLM completions (token-by-token).

# FEATURE REQUEST: structured destructuring on op returns. Today `$(M.id)` only
# works inside `foreach M in ...:`. Outside iteration, you can't decompose a
# returned JSON blob. Proposed shape:
#
#   $ get_status repo=$(REPO) -> { sha: HEAD_SHA, branch: BRANCH, dirty: IS_DIRTY }
#
# would bind three vars at once instead of forcing a downstream `~` to parse JSON.

# FEATURE REQUEST: typed numeric ops on bound values. Today `if $(N) > "10":` works
# via Number()-coercion but you can't do arithmetic. Proposed:
#
#   $set TOTAL = $(A) + $(B)
#   $set RATE = $(COUNT) / $(DURATION_SECONDS)
#
# This is a glaring gap — most monitoring skills end up shelling out to `bc`.

ingest:
    @@ curl -N $(STREAM_URL) -> EVENT every:
        ~ prompt="Classify severity (info/warn/crit) and write a 1-line summary. Reply as JSON {severity, summary}. Event: $(EVENT)" model=qwen -> RAW
        # destructuring (feature request):
        $set { severity: SEV, summary: S } = $(RAW|json_parse)
        if $(SEV) == "crit":
            # FEATURE REQUEST: `--confirm` flag on mutating $ ops, separate from
            # the implicit `??` lint warning. Forces a runtime gate without
            # restructuring the skill into a sub-target.
            $ create_incident severity=$(SEV) text=$(S) --confirm -> TICKET_ID
            ! Filed incident $(TICKET_ID): $(S)
        elif $(SEV) == "warn":
            ! [warn] $(S)
        # else: drop info chunks silently

default: ingest