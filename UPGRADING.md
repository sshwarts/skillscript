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

## 7. Bare numeric list declarations became numbers (0.39.4)

0.39.4 fixed `$set VAR = ${ref}` corrupting an array of objects into string fragments
(GitHub issue #3). The fix parses a structured value as JSON before falling back to the
bare literal-list split — which changes one adjacent case.

**What changed.** A **bare** numeric list in a declaration now holds numbers:

```
# Vars: N=[1, 2, 3]

${N}   before 0.39.4  →  ["1","2","3"]
${N}   from   0.39.4  →  [1,2,3]
```

**What did NOT change.** Conditions stringify both operands before comparing, so
`if ${I} == "1":` still matches inside a `foreach` over that list, and a single
element still renders as `1`. Only interpolating the **whole list** differs. Lists
whose elements are already quoted (`["a", "b"]`) and bare non-numeric lists
(`[a, b, c]`) are unaffected — the latter is not valid JSON, so it still takes the
original split path.

**Do you need to act?** Only if a skill interpolates a bare numeric list verbatim into
something that matches on the quoted form — a payload sent to an external system, an
`==` against a whole rendered list, a written record another skill parses back. To keep
the old value exactly, quote the elements at the declaration:

```
# Vars: N=["1", "2", "3"]
```

To find candidates, grep your corpus for a bare-numeric `# Vars:` list and check whether
the bare `${NAME}` (not `${NAME.field}` or a loop variable) is interpolated anywhere:

```
grep -rnE '^# Vars:.*=\[ *-?[0-9]' <your-skills-dir>
```

## 8. Unresolved references in `if` conditions now raise (0.40.0)

Before 0.40.0, a condition operand that could not be resolved evaluated as **false**.
So `if ${R.count} == "5":` on a response with no `count` field took the else path —
and reported nothing. "The field is missing" and "the field says no" were the same
answer. From 0.40.0 the unresolvable case raises `UnresolvedConditionRefError` and
aborts the target.

**Note the direction, because it is not only about silence.** Absence made some
conditions *fire*:

```
if not ${R.result.asleep}:      # absent → not false → TRUE  → branch RAN
if ${R.count} != "0":           # absent → "" != "0" → TRUE  → branch RAN
if ${R.count} == "0":           # absent → "" == "0" → false → branch skipped
```

The first two performed work on a value nothing could read. That is why this raises
rather than warns.

### Will this affect me?

Only if a condition operand can actually be absent at runtime. **A skill whose fields
always resolve sees no change at all.** There is no compile-time signal for this —
lint cannot read a connector's response contract — so use the new warning to list
candidates:

```
skillfile lint <skill>          # look for: unguarded-dotted-ref-in-condition
```

### At most sites, do nothing

If the field is always present in a well-formed response, **the raise is what you
want** and the warning is expected. Absence there means something upstream broke —
a renamed field, a changed API shape, a typo — and you want to hear about it.

Only where absence is a **normal, expected state** should you say so explicitly:

```
truthy       if ${R.result.asleep|fallback:"true"}:
comparison   if ${R.count|fallback:"none"} != "none":
```

**Do not add `|fallback:` just to clear the warning.** It suppresses the raise, which
puts back exactly the silence this release removes. Adding it everywhere converts a
loud, locatable failure into the twelve-day variety.

### One related fix in the same release

`|fallback:` previously worked in comparisons but was **silently ignored in bare-truthy
position** — `if ${X.maybe|fallback:"true"}:` behaved as if the filter were not there.
It now fires in all three contexts. If you wrote a truthy guard before 0.40.0 believing
it worked, it did not; it does now.

### If the condition is inside a `foreach`, the blast radius is the whole loop

**Read this before upgrading a skill that loops over externally-sourced records.**
It is the case the rest of this section does not cover, and it was raised by an
adopter running exactly that shape.

`foreach` has **no per-iteration error boundary.** A raise inside the loop body
propagates straight out and aborts the whole target. So on a sweep over many
independent records:

```
foreach R in ${RECORDS}:
    if ${R.stage} == "active":      # one record missing `stage`…
        ...
    else:
        ...
                                    # …and every record AFTER it in iteration
                                    # order gets zero processing this run.
```

Before 0.40.0 that condition silently skipped the bad record and the rest of the
batch continued. Now the batch stops at the first bad record. **Both behaviours
are wrong for this shape** — the old one was silent, the new one is batch-wide —
and the language currently has no way to express "raise loudly, but isolate this
record."

**So this is the one place where adding `|fallback:` is about isolation rather
than suppression**, and it is a legitimate use:

```
foreach R in ${RECORDS}:
    if ${R.stage|fallback:"unknown"} == "active":
        ...
    else:
        # a record with no `stage` lands here instead of killing the batch
```

If your loop already has an `else:` catch-all per record, that is what the guard
preserves. Audit `foreach` bodies first and single-value skills second — the
per-record case is where an upgrade can cost you a whole run rather than one
branch.

### There is no in-language catch

A raising condition aborts the target. `else:` cannot catch it — the condition itself
raised, so no branch is chosen — `(fallback: …)` is an op trailer rather than a
condition guard, and `# OnError:` was removed in 0.39.0. Handle it by fixing the
upstream cause or by declaring the absence expected, not by catching.

## 9. `|fallback:` in a condition became empty-aware (0.40.1)

0.40.1 made filter chains behave identically in a condition and in a substitution.
Two of the three changes are pure fixes; one is a behaviour change worth checking.

**The behaviour change.** In a **condition**, `|fallback:` now fires on an empty
string and an empty array, not only on an unresolved reference:

```
if ${X.empty|fallback:"D"} == "D":

    before 0.40.1   false   (fallback fired only on undefined)
    from   0.40.1   true    (matches what a substitution has always done)
```

If a skill deliberately relies on an empty value flowing past a `fallback` in a
condition, drop the `|fallback:` from that operand or compare on the raw value.

**The fixes, which need no action.** `|fallback:` placed *after* another filter
now supplies its value instead of yielding a silent empty string — so
`${X.missing|trim|fallback:"D"}` rescues, as the language guide has always said
it should and as substitutions have always done. And `in`'s left-hand side now
honours `fallback` like every other operand.

**A chain with no `fallback` still raises.** 0.40.0's guarantee is unchanged; the
propagation only applies when a later `fallback` exists to catch it.

## 10. Going forward

Every CHANGELOG entry carries an **Upgrade impact:** line — `BREAKING` / `RE-APPROVE` /
`CONFIG` / `none (additive)`. Scan it before you bump. Making a specific jump and not
sure what it entails? Open an issue with your from→to and we'll confirm the exact diff.
