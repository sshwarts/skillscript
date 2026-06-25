# Upgrading Skillscript (pre-1.0)

Pre-1.0, the runtime moves fast. **Most bumps require nothing** — they're additive
and backward-compatible. The exception that matters most today is the secured-mode
transition (§3). Each [CHANGELOG](CHANGELOG.md) entry carries an **Upgrade impact:**
line so you can see a bump's requirements at a glance before you take it.

## 1. Check your version

```
skillfile --version        # or -v   (there is no `version` subcommand)
```

## 2. Check for recompile-staleness after an upgrade

A runtime/compiler bump can leave a previously-compiled skill stale relative to its
provenance. Audit against the `.provenance.json` sidecar:

```
skillfile audit <skill>.provenance.json [--json]
# e.g. skillfile audit examples/skillscripts/hello-world.skill.provenance.json
```

`audit` takes the **`.provenance.json` sidecar path** (not a skill name or a
`.skill.md` file) and reports recompile-staleness. It does **not** report approval
state — that's §3.

## 3. Secured mode (0.20.0+) — re-approval required

**Secured mode is opt-in and OFF by default.** If you never set
`SKILLSCRIPT_SECURED_MODE=true`, none of this applies and an upgrade won't stop your
skills from running.

**What changed (0.20.0).** When secured mode is on, skill approval is an *enforced*
security boundary, not an advisory flag. Approved skills are Ed25519-signed, and the
runtime verifies the signature on **every** execution path (by-name, cron, `/event`,
composition).

**What breaks when you enable it.** Skills approved under a pre-secured build (or any
unsigned `# Status: Approved`) carry no valid signature, so in secured mode they will
**not execute until re-approved**. This is by design — the guarantee is that nothing
unapproved can run.

**How to find what needs re-approval — in bulk, not skill-by-skill.** Three surfaces:

- **`skillfile reapprove`** (dry run) — sweeps the whole store and reports every
  Approved skill lacking a valid signature (the migration set). This is the
  one-command answer to "what do I need to fix."
- **The dashboard Approvals queue** — shows the same set as a worklist that empties as
  you approve.
- **A startup warning** — when the runtime boots in secured mode it prints a stderr
  line naming the unsigned skills, so a headless operator sees it without opening
  anything.

**How to fix.**

```
skillfile reapprove            # dry-run: what needs re-signing
skillfile reapprove --apply    # re-sign the whole migration set with the operator key
```

Or per-skill / for review: `skillfile approve <name>` at a terminal, or the dashboard
Approvals queue. After re-signing, the skill runs.

**Why re-approve instead of auto-migrate.** Auto-signing on upgrade would defeat the
boundary — the point is that a human vouches for what runs.

## 4. connectors.json

Schema changes ran v0.4.0 → v0.19.9, with **one breaking change**: **v0.14.0**
(2026-05-30) renamed the substrate key `memory_store` → `data_store`. The schema has
been **stable since v0.19.9** (2026-06-09) and untouched through 0.20.x / 0.21.x;
everything besides 0.14.0 was additive (new optional sections + connector classes).

There is no `schema_version` field, so a too-old file fails loader validation rather
than getting a friendly version-mismatch message. If validation fails right after an
upgrade, your file predates a change — check the 0.14.0 `memory_store` → `data_store`
rename first.

Current shape:

```json
{
  "substrate": { "skill_store": "...", "data_store": "...", "local_model": "...", "agent_connector": "..." },
  "<connector-name>": { "class": "...", "config": { }, "allowed_tools": [] }
}
```

## 5. Other pre-0.20 transitions that need action

- **0.18.8** — `shell(...)` ops became **default-deny**. They refuse until you
  allowlist the binaries via `SKILLSCRIPT_SHELL_ALLOWLIST` (run `skillfile shell-audit`
  to list what your corpus uses).
- **0.19.0** — the trigger model collapsed to `cron` + `event`. Skills declaring removed
  sources (`session` / `webhook` / `file-watch` / `sensor`) fail to parse — rewrite
  those `# Triggers:` as `cron`, or drive them by `POST /event`.

## 6. Migrating a programmatic bootstrap to `bootstrapFromEnv()` (0.24.0, optional)

0.24.0 adds `bootstrapFromEnv()` — the programmatic equivalent of `skillfile dashboard`/`serve` (loads `.env` + `connectors.json` + the `SKILLSCRIPT_*` cascade, returns `{ wired, server }`). Adopting it is optional; existing hand-assembled `bootstrap()` code keeps working. **If you do migrate**, move any options you hardcoded on `bootstrap()` / `new DashboardServer({...})` to their `SKILLSCRIPT_*` env equivalents — `bootstrapFromEnv()` resolves them from env, so a dropped value reverts to default. The one that bites:

- **`mcpCallerIdentityHeader` → `SKILLSCRIPT_MCP_CALLER_IDENTITY_HEADER`** fails **silently** — drop it and skill-author attribution reverts to the store's default writer identity, no error. (`enableUnsafeShell` → `SKILLSCRIPT_ENABLE_UNSAFE_SHELL` fails loud — unsafe ops just refuse.)

After migrating, verify: send your identity header on a `/rpc` `skill_write` and confirm the captured `author`. (`bootstrap()`-level opts can also go via `bootstrapFromEnv`'s `overrides`; `DashboardServer`-level ones are env-only.)

## 7. Going forward

Every CHANGELOG entry carries an **Upgrade impact:** line — `BREAKING` / `RE-APPROVE` /
`CONFIG` / `none (additive)`. Scan it before you bump. Making a specific jump and not
sure what it entails? Open an issue with your from→to and we'll confirm the exact diff.
