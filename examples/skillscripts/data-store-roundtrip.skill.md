# Skill: data-store-roundtrip
# Status: Approved v1:b6e1bfb1
# Autonomous: true
# Description: Round-trips the DataStore — writes a record tagged with a per-run marker, reads it back via full-text search against the same marker. The marker makes the read deterministic (count == 1) regardless of prior runs accumulated in the store. If this skill executes and emits "read back 1 items", your DataStore substrate is wired correctly.

run:
    $set MARKER = "probe-${NOW}"
    $ data_write content="${MARKER} adopter dogfood probe record" tags=["phase1","probe"] -> W
    $ data_read mode="fts" query="${MARKER}" limit=5 -> R
    emit(text="wrote record '${W.id}'; read back ${R.items|length} items")

default: run
