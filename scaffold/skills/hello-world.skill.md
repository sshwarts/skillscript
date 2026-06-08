# Skill: hello-world
# Status: Approved v1:d5d87e0b
# Description: The canonical first-run example. No substrate dependencies — pure declarative output. If this fails to execute, your install or runtime is broken; investigate before troubleshooting deeper layers. Demonstrates the body-text-as-output template shape + `# Vars:` declared inputs with `--input` override.
# Vars: WHO=world

Hello, ${WHO}!
Your install is healthy. Try skill-store-roundtrip + data-store-roundtrip next to verify substrate wiring.

greet:
    $set _ = "noop"

default: greet
