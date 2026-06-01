# Skill: hello-world
# Status: Approved v1:5ce6d5bf
# Description: The canonical first-run example. No substrate dependencies — pure emit. If this fails to execute, your install or runtime is broken; investigate before troubleshooting deeper layers. Demonstrates `# Vars:` declared inputs with `--input` override.
# Vars: WHO=world

greet:
    emit(text="Hello, ${WHO}!")
    emit(text="Your install is healthy. Try skill-store-roundtrip + data-store-roundtrip next to verify substrate wiring.")

default: greet
