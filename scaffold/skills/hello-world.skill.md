# Skill: hello-world
# Status: Approved v1:b662ccd6
# Description: The canonical first-run example. No substrate dependencies, no compute block — pure declarative output. If this fails to execute, your install or runtime is broken; investigate before troubleshooting deeper layers. Demonstrates the template-only shape: body text IS the skill; `# Vars:` declared inputs feed the template with `--input` override.
# Vars: WHO=world

Hello, ${WHO}!
Your install is healthy. Try skill-store-roundtrip + data-store-roundtrip next to verify substrate wiring.
