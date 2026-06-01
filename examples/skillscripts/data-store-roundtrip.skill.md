# Skill: data-store-roundtrip
# Status: Approved v1:fb106073
# Autonomous: true
# Description: Round-trips the DataStore — writes a record tagged with a per-run marker in the content, reads it back via FTS query against the same marker. The exact item count depends on substrate FTS matching strictness (strict FTS substrates return 1; substrates with looser token-match semantics may return prior runs' records that share token shapes). If this skill executes and the emit line shows N ≥ 1 items returned, your DataStore substrate is wired correctly. For adopters needing deterministic counts (e.g. authoring round-trip tests), the `domain_tags` filter is the portable strict-match read path — see the adopter-playbook §"Notable things..." for the pattern.

run:
    $set MARKER = "probe-${NOW}"
    $ data_write content="${MARKER} adopter dogfood probe record" tags=["phase1","probe"] -> W
    $ data_read mode="fts" query="${MARKER}" limit=5 -> R
    emit(text="wrote record '${W.id}'; read back ${R.items|length} item(s)")

default: run
