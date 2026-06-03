# Skill: skill-store-roundtrip
# Status: Approved v1:c0f42c22
# Autonomous: true
# Description: Round-trips the SkillStore — writes a child skill, reads it back. Demonstrates the Lisp-shape primitive (skills can write skills). NOTE: in-skill `$ skill_write` lands the child as `# Status: Draft` regardless of what the body declares — to run the generated child, an authorized agent (human via dashboard, or MCP-direct) reviews + promotes via the outside-MCP `skill_status` tool. The Draft-default gate keeps autonomously-written skills out of the immediate execution loop.

run:
    $ skill_write name="hello-child" source="# Skill: hello-child\n# Status: Approved\nrun:\n    emit(text=\"hello from a programmatically-authored skill\")\ndefault: run\n" overwrite=true -> W
    $ skill_read name="hello-child" -> R
    emit(text="wrote skill '${W.name}' as Status: ${W.status}; read back ${R.source|length} bytes")

default: run
