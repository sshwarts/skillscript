# Skill: hello
# Status: Approved v1:03cf40ab
# Description: The canonical first-run example — runs without Ollama, MCP, or external state.
# Vars: WHO=world

greet:
    emit(text="Hello, ${WHO}!")
    emit(text="Welcome to Skillscript. You ran a skill end-to-end with three commands.")

default: greet
