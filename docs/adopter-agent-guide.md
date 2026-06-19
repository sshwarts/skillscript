---
title: Adopter Agent Guide
description: "Wire your agent's instruction file so it discovers and prefers its skills instead of re-reasoning every session."
mode: wide
---

How to set up your agent's instruction file (`CLAUDE.md`, `AGENTS.md`, system prompt — whatever your harness uses) so the agent actually *takes advantage* of Skillscript instead of ignoring it.

Skillscript gives your agent a way to **capture a routine once as a durable, compiled, auditable skill** and run it many times — instead of re-reasoning the same workflow from scratch on every session, burning tokens and drifting a little each time. But an agent only uses skills if its instructions tell it to look. This guide is the minimum wiring to make that happen.

---

## 1. The runtime tells your agent how to use it

**You probably don't need to paste anything.** The MCP server ships the usage contract as its `instructions` field — most MCP hosts surface that to the model at session start, so a connecting agent already knows to `skill_list()` first, preflight before composing, author-when-repeated, and never assume a backend. Quick check: after wiring the MCP, ask your agent "what do you know about skillscript?" — if it describes the workflow, you're done, and your `CLAUDE.md` / `AGENTS.md` needs nothing about Skillscript.

**If your host doesn't surface server `instructions`** (some don't), paste the block below into your agent file. It mirrors what the server delivers — the authoritative copy is the runtime's `instructions` field, so keep this in sync rather than diverging from it.

```markdown
## Skillscript — your durable skills

You have a Skillscript runtime wired over MCP. A *skillscript* is a compiled,
auditable, reusable procedure — a routine captured once and run many times,
rather than re-derived every session.

### At session start
List what you already have before doing routine work:

- `skill_list()` — returns your skills grouped by category:
  - **skills** — skills you can invoke directly (template-output skills + skills with no `# Output:` declaration)
  - **receives** — skills that push augmenting context to you (`# Output: agent: <name>`)
  - **headless** — autonomous skills (cron/event-fired); yours to maintain, not to invoke

Know your own skills so you reach for them instead of rebuilding a workflow.

### When a task smells routine
If an existing skill fits, use it — don't re-reason the steps:

- `skill_preflight({ name })` — see what a skill takes, returns, requires, and
  *touches* (its effectful footprint) plus whether it's cleared to run, before
  you invoke or compose it. (`skill_list` entries already carry this contract, so
  often you won't need a separate call.)
- `execute_skill({ name })` — run a stored skill end-to-end.
- `compile_skill({ name })` — preview the rendered plan first, no side effects.

### When you're repeating yourself, author a skill
What you can script is the wired connectors, models, and allowed shell binaries that
`runtime_capabilities()` reports — that list is your **menu of what's capturable**. When
you catch yourself re-running the same multi-step routine over any of them, turn it into a skill:

1. `help()` — learn the language (and `help({ topic })` for ops, frontmatter,
   connectors, lint-codes).
2. Draft the skill body against what's wired.
3. `lint_skill({ source })` then `compile_skill({ source })` — catch mistakes
   before anything is stored.
4. `skill_write({ name, source })` — it lands **Draft**; a human reviews and
   approves before it can run (you can't self-approve).

If something you'd need isn't wired yet, ask the operator to add it (a connector, or a
binary on `SKILLSCRIPT_SHELL_ALLOWLIST`), then capture the routine.
```

That block is enough to change behavior. Everything below explains *why* and fills in the edges.

---

## 2. Best practices

### Discover before you build
The single highest-value instruction is "run `skill_list()` at session start." Agents that don't enumerate their skills silently re-derive workflows that already exist as skills — the exact waste Skillscript removes. Make discovery a reflex, not an afterthought.

### Prefer a skill over re-reasoning
A compiled skill runs the same way every time because the procedure *is* the source of record, not a prompt to be re-interpreted. When a routine exists as a skill, executing it is cheaper, more reliable, and auditable. Reserve fresh reasoning for the work that genuinely needs it.

### Write descriptions as *trigger conditions*, not summaries
When the agent picks among skills, it reads each `# Description:`. "Handles errors" is useless for selection. "If a downstream API returns non-200, run this" fires the skill at the right moment. Describe **when to invoke**, not what the skill does. This is what makes `skill_list()` actionable once you have more than a handful of skills.

### Two kinds of skill, two postures
- **Skills you invoke** — you call them when relevant (`execute_skill`).
- **Skills you own but never invoke** — autonomous skills fired by a `cron` or `event` trigger. Your job is to keep them correct, not to run them by hand. (They show up under `headless` in `skill_list`.)

Make sure your agent instructions distinguish these, so the agent doesn't try to manually fire a cron skill (or ignore a skill it should be invoking).

### Trust the approval gate
Every skill has a `Draft → Approved → Disabled` lifecycle, and only `Approved` skills run. **In secured mode** (`SKILLSCRIPT_SECURED_MODE=true` — the recommended posture for any agent-authored or multi-author deployment) approval is an operator's Ed25519 signature: a skill an agent `skill_write`s lands **Draft**, a naked `# Status: Approved` is forced to Draft, and only a human holding the operator key can sign it into a runnable state. That's the real safety boundary — an agent can *write* a skill, but a human decides whether it ever *runs*. In unsecured mode the status flag alone gates execution (a bare `# Status: Approved` runs, unkeyed) — convenient for a single trusted author, but it means a skill *you* write as Approved is immediately runnable. Either way, tell your agent to treat a freshly-written skill as not-yet-runnable until a human has approved it.

### Author against discovered capability, not assumptions
Before writing a skill that needs a data store, a model, or an external tool, check `runtime_capabilities()`. A skill that assumes a connector that isn't wired fails at dispatch with a clear error — but it's better to author against what's actually present. Use `# Requires: <connector>.<feature>` in a skill to fail-fast at compile time when a needed capability is missing.

### Keep deterministic work in tools, not skill bodies
Skills are orchestration. A fixed API call, a fixed parse, a fixed shell pipeline belongs in an MCP tool the skill *invokes* (`$ <connector> ...`), not hardcoded into the skill. This keeps skills portable across substrates and resistant to drift.

---

## 3. MCP tool reference

The tools your agent has when a Skillscript runtime is wired:

| Tool | Use |
|---|---|
| `skill_list({ filter? })` | Discover skills, grouped by category. Filter by status / trigger_kind / name_prefix / author. Each entry carries the full contract (vars / returns / requires / effectful footprint) + approval state. |
| `skill_preflight({ name })` | Pre-execution contract check for one skill: what it takes / returns / requires / touches (effectful footprint) + approval-gate state + version. Call before invoking or composing. |
| `skill_read({ name })` | Read a skill's source body. |
| `compile_skill({ name \| source, inputs? })` | Render the compiled plan + surface errors. Read-only — safe to preview. |
| `lint_skill({ name \| source })` | Static diagnostics (tier-1 errors / tier-2 warnings / tier-3 advisories). |
| `execute_skill({ name \| source, inputs? })` | Run a skill. `name` runs a stored, approved skill; `source` runs ad-hoc inline (bypasses the store — for one-offs). |
| `skill_write({ name, source, overwrite? })` | Store a skill. Lands Draft unless approved. |
| `skill_status({ name, new_state })` | Transition Draft / Approved / Disabled. |
| `help({ topic? })` | Language reference — quickstart, plus `ops`, `frontmatter`, `connectors`, `lint-codes`, `examples`, `composition`. |
| `runtime_capabilities()` | What's actually wired — connectors, models, shell mode. |
| `register_trigger` / `list_triggers` / `unregister_trigger` | Inspect/manage autonomous dispatch (cron / event). |

---

## 4. A minimal worked example

The smallest useful loop, from the agent's point of view:

```
1. skill_list()                    → "I have a `weekly-report` skill."
2. compile_skill({name:"weekly-report"})  → preview the plan, confirm it's right.
3. execute_skill({name:"weekly-report"})  → run it, use the result.
```

And authoring a new one:

```
1. help({topic:"ops"})             → learn the op surface.
2. lint_skill({source})            → fix tier-1 errors.
3. compile_skill({source})         → confirm it renders.
4. skill_write({name, source})     → stored as Draft.
5. (human approves)                → now it can run.
```

---

## 5. What *not* to put in your agent file

- **Don't reference a specific backend.** No "query the X store" / "call the Y model" by product name. Skills name connectors by role; the operator maps roles to backends in config. Your agent reads roles via `runtime_capabilities()`.
- **Don't tell the agent a freshly-authored skill is runnable.** In secured mode (the recommended posture) it lands Draft until a human approves; have the agent treat anything it just wrote as not-yet-runnable regardless.
- **Don't have the agent manually fire autonomous skills.** Cron/event skills fire themselves; the agent maintains them.
- **Don't hardcode tool/endpoint details into skill bodies.** That's tool territory; skills orchestrate, tools execute.

The throughline: your agent's instructions should make it **discover its skills, prefer them over re-reasoning, author new ones through the lint→compile→approve loop, and stay honest about what substrate is actually wired.**
