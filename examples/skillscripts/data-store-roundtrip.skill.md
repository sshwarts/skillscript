# Skill: data-store-roundtrip
# Status: Approved v1:83897803
# Autonomous: true
# Description: Round-trips the DataStore — writes a record, reads it back via full-text search. If this skill executes and emits a successful round-trip, your DataStore substrate is wired correctly.

run:
    $ data_write content="adopter dogfood probe record" tags=["phase1","probe"] -> W
    $ data_read mode="fts" query="adopter dogfood probe" limit=5 -> R
    emit(text="wrote record '${W.id}'; read back ${R.items|length} items")

default: run
