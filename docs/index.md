---
title: Skillscript
description: "A language for agents to write themselves in."
mode: wide
---

Skillscript is a small language your AI agent writes its own tools in. The agent authors a skill once, you approve exactly what it is allowed to do, and the runtime executes it deterministically from then on, instead of re-reasoning the same task from scratch every run.

These docs are for building with Skillscript: installing the runtime, wiring it into your agent, and authoring skills together. If you are still deciding whether it is for you, the [project overview](https://skillscript.ai) is the shorter read.

## What a skill looks like

```
# Skill: hello
# Status: Approved
# Description: The canonical first-run example.
# Vars: WHO=world

Hello, ${WHO}!
Welcome to Skillscript.
```

That is a complete, runnable skill. The body text is the output: the runtime renders it against the skill's variables and publishes it, with no boilerplate. The same shape scales to multi-stage skills that call tools, dispatch to models, query data, branch on conditions, and orchestrate other skills.

## The idea in brief

- **Written by a machine, approved by a human.** An agent authors the skill; you approve what runs. In secured mode, approval is an operator signature the agent can never forge, so it cannot approve its own work. Unsecured mode, the default for getting started, keeps approval to a single click for trusted setups.
- **Constrained on purpose.** Skillscript is not Turing-complete. It cannot `eval`, `subprocess`, or import arbitrary code, and it can only reach the tools, shell binaries, and paths the operator allowlists. That constraint is the safety story, and it is what makes a skill safe to approve and run unattended.
- **Coordination, not computation.** A skill composes calls into tools, models, and data stores. The heavy computation lives in those tools; the skill is the auditable orchestration around them.

For the full reasoning behind the design, see the [Language Reference](/docs/language-reference).

## Quickstart

Skillscript is operated by a human and authored with an agent. You install and run the runtime, wire it into your agent as an MCP server, then build skills together.

### 1. Install and run

```bash
npm install -g skillscript-runtime && skillfile init && skillfile dashboard
```

`init` scaffolds `~/.skillscript/` (config, connectors, demo skills); `dashboard` runs the server at `http://localhost:7878`. Configuration is optional; the defaults work. See [Configuration](/docs/configuration) for ports, the shell allowlist, secured mode, and the container image.

### 2. Wire it into your agent

On Claude Code and similar hosts, just ask: *"Add the skillscript MCP server at `http://localhost:7878/rpc`."* The host writes the config. For manual or stdio wiring, see [Configuration](/docs/configuration).

### 3. Write your first skill together

Ask your agent to build something: *"Author a skill that greets someone by name."* It authors the skill via `skill_write`. You review and approve it (the dashboard's approve button, or `skillfile approve <name>`), and it runs. From there the agent runs it with `execute_skill`, or you can from the CLI with `skillfile execute <name>`.

The runtime starts in unsecured mode, where approval is one click. For a deployment that only runs key-signed skills, see [Approval and secured mode](/docs/adopter-playbook#approval--secured-mode).

## Documentation

**Learn the language**
- [Language Reference](/docs/language-reference) — the canonical spec for syntax and semantics.
- [Examples](https://github.com/sshwarts/skillscript/tree/main/examples) — annotated example skills, each demonstrating one pattern.

**Configure and secure**
- [Configuration](/docs/configuration) — `connectors.json`, substrate selection, MCP connector wiring, and the full environment-variable surface.
- [Connector Contract Reference](/docs/connector-contract-reference) — interfaces for wiring your own tools, data stores, and agent delivery.

**Adopt and embed**
- [Adopter Playbook](/docs/adopter-playbook) — patterns for embedding the runtime in your own deployment.
- [Adopter Agent Guide](/docs/adopter-agent-guide) — wiring your agent's instructions so it actually uses Skillscript.
- [SqliteSkillStore](/docs/sqlite-skill-store) — the DB-backed skill store: schema, semantics, and forking checklist.

## Status

Pre-1.0, no external adopters yet. Core language stable, connector contracts locked, distribution polish in progress. Bug reports and feature requests are welcome via [Issues](https://github.com/sshwarts/skillscript/issues).

---
*Made by agents, for agents.*
