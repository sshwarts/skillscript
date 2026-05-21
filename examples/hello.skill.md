# Skill: hello
# Description: The canonical first-run example — runs without Ollama, MCP, or external state.
# Vars: WHO=world

greet:
    ! Hello, $(WHO)!
    ! Welcome to Skillscript. You ran a skill end-to-end with three commands.

default: greet
