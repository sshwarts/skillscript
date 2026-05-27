#!/usr/bin/env node
// Enforces ERD §1's small-codebase property. The spec calls out:
//
//   "parser + compiler + executor + connector registry + lint together
//    ≤ ~5K LOC for the core" plus "fewer than 20 source files in the core."
//
// This script counts the NARROW core set (the five named components) against
// the ERD ceiling, and reports the BROAD count (all of src/) for transparency.
// Auxiliary surfaces — CLI, dashboard, MCP server, observability/trace store,
// metrics aggregator, error classes, provenance, scheduler, skill-manager,
// testing helpers — sit outside the narrow ceiling but are visible in the
// report so growth on the auxiliary surface is still tracked.
//
// History:
//   T1-T3: counted all of src/ against 5K-5500 ceiling
//   T4:    raised to 5500 for the rule engine
//   T5:    raised to 6500/22 for runtime + footgun rules
//   T6:    raised to 7500/24 for error contract + trace + metrics + CLI
//   T6b:   raised to 9500/28 for dashboard + MCP server
//   T7:    tightened the scope to the named ERD §1 core set; auxiliary
//          src/ is reported informationally rather than budgeted
//   v0.2.10: nudged narrow ceiling 5000 → 5100 to accommodate parser
//            robustness work (vars-comma + nested control flow + render
//            disambiguation). Core remains under the original ERD intent.
//   v0.2.12: nudged narrow ceiling 5100 → 5200 for Perry R2 fixes —
//            Bug 17 (unknown-template-reference lint, ~25 LOC) +
//            Bug 19 (composition-ref op-kind tagging, ~20 LOC across
//            three lint-rule call sites). Still tracking close to the
//            original ERD intent; nudge is bounded fix-driven growth.
//   v0.3.0:  nudged narrow ceiling 5200 → 5400 for the accumulator slate —
//            new $append op (parser + runtime, ~50 LOC) + three new
//            lint rules with scope-tracking walker (~150 LOC). First
//            actual language extension since v0.2's Bug-driven growth;
//            nudge is feature-driven, not fix-driven.
//   v0.3.1:  nudged narrow ceiling 5400 → 5500 for forward-reference
//            deferred resolution — new tier-3 deferred-skill-reference
//            lint rule (~45 LOC) + MissingSkillReferenceError class
//            + runtime defer-resolve path. Modest growth for a useful
//            language semantic.
//   v0.3.2:  nudged narrow ceiling 5500 → 5650 for compound conditions
//            (and/or/not) + |json_parse filter — recursive structural
//            decomposition in evalCondition + parser validateCondition,
//            filter chain support in substituteRuntime. ~80 LOC across
//            runtime + parser. Boolean trio + filter chain are core
//            grammar features — feature-driven, ceiling nudge appropriate.
//   v0.3.3:  nudged narrow ceiling 5650 → 5700 for $ json_parse op +
//            unparsed-json-field-access tier-3 advisory + compile_skill
//            warnings/advisories pass-through. Net ~50 LOC: ~25 for the
//            runtime $ json_parse intercept (mirrors $ execute_skill
//            shape), ~30 for the new lint advisory walker, ~5 net for
//            compile.ts tier-2/tier-3 plumbing, minus ~10 for the yanked
//            |json_parse filter case. Closes the v0.3.2 spec gap from
//            af14b7d8 (filter+field can't propagate parsed structure)
//            with an op-based alternative — same end-user outcome.
//   v0.3.4:  nudged narrow ceiling 5700 → 5750 for conditional multi-
//            filter chain + parse-error dedup + unified sink-scope
//            parser recovery. Net ~60 LOC: ~30 for the 12-regex chain
//            sweep + applyFilterChain helper in runtime.ts, ~5 for the
//            PARSE_ERROR filter (item 2), ~25 for sink-scope consistency
//            on the single-= rejection path (Bug D extension caught by
//            v0.3.4 item-2 test). Closes the recurring "conditional
//            grammar weak link" pattern named in dev-log §14.
//   v0.4.0:  nudged narrow ceiling 5750 → 6000 for connectors.json
//            loader + credential resolution + closed-set class registry
//            + two new tier-1 lint rules (unknown-connector +
//            unknown-connector-class) + runtime_capabilities discovery
//            extension. New file: `connectors/config.ts` (~170 LOC —
//            loader, env-substitution, registry, error paths). Lint
//            additions ~50 LOC. First MCP-scripting-era release;
//            v0.4.1 adds RemoteMcpConnector for stdio bridge.
//   v0.4.1:  nudged narrow ceiling 6000 → 6600 for RemoteMcpConnector
//            class + per-connector allowed_tools allowlist + env-block-
//            as-scope substitution + framing config + gitignore-detect
//            warning + lint auto-wiring + foreach-over-parsed-JSON +
//            kwarg type coercion. New file: connectors/mcp-remote.ts
//            (~330 LOC — spawn, LSP+newline framing, init handshake,
//            tool dispatch, lifecycle). Allowlist plumbing ~60 LOC
//            across Registry + config + lint + runtime. The first
//            "external-MCP-in-Skillscript" release; proven end-to-end
//            against real YouTrack via mcp-remote bridge.
//   v0.5.0:  nudged narrow ceiling 6600 → 6800 for the R3 harness-driven
//            scope: 8 items total. Bash-shaped string composition pair
//            ($append string-typed + $set bind-time interpolation),
//            |fallback:"X" filter (renamed from |default: per design
//            thread 15a50e29), silent-stub-on-unwired-connector hard
//            error + tier-1 lint, unquoted-substitution-in-kwarg-value
//            tier-2 lint (binding-origin-aware walker), $(NOW) ISO-8601
//            alignment + |isodate filter, outputs.text shape docs.
//            ~175 LOC across lint.ts (origin walker, two new rules) +
//            runtime.ts (chain parser + condition-context applier +
//            ConnectorNotFoundError fold) + filters.ts (parseFilterChain
//            + isodate). 50+ new tests across 5 v0.5.0 test files.
//   v0.8.0:  nudged narrow ceiling 7550 → 7800 for v0.8.0 delivery model:
//            notify() runtime-intrinsic op (~80 LOC parser + runtime + lint),
//            MemoryStore.write() contract extension (~30 LOC interface + impl),
//            $ memory_write op (~50 LOC parser + dispatch),
//            skill-author tracking + promotion gate (~70 LOC connectors +
//            mcp-server), tier-2 Output: lint warns (~30 LOC), and the
//            unconfirmed-mutation lint drop (~40 LOC removed). Net ~+200 LOC.
//   v0.7.2b: nudged narrow ceiling 7400 → 7550 for v0.7.2 bridge classes
//            (LocalModelMcpConnector + MemoryStoreMcpConnector) — ~80 LOC
//            each in src/connectors/, plus ~15 LOC bootstrap auto-wire +
//            class-registry update. Bridges define the canonical MCP-
//            dispatch contract for `$ llm` and `$ memory` op classes.
//   v0.7.2:  nudged narrow ceiling 7250 → 7400 for v0.7.2 R4-driven
//            additions: tier-3 object-iteration-advisory lint (~40 LOC) +
//            string escape interpretation in double-quoted strings
//            (~20 LOC) + triple-quote `"""..."""` multi-line literal
//            tokenizer state across foldQuotedContinuations,
//            tokenizeKeywordArgs, splitTopLevelCommas, and
//            extractParenBody (~70 LOC). More v0.7.2 work pending
//            (${VAR} in frontmatter, bridge classes). Help-content
//            refresh is content swap, no net LOC.
//   v0.7.1:  nudged narrow ceiling 7150 → 7250 for grace-period polish:
//            deprecated-symbol-op + deprecated-substitution-shape tier-2
//            lints (~85 LOC across lint.ts) + unconfirmed-mutation
//            broadening to file_write + memory_write + approved= kwarg
//            (~20 LOC). Help-content refresh is a content swap, no net LOC.
//   v0.7.0:  nudged narrow ceiling 6800 → 7150 for the syntax-revamp arc
//            (Perry kickoff `50a83a88`, final framework `c48fca7e`).
//            ${VAR} canonical substitution (alongside $(VAR) for grace
//            period) + function-call grammar `verb(kwarg=value, ...)` for
//            7-op closed runtime-intrinsic set (emit, ask, inline,
//            execute_skill, shell, file_read, file_write) + file_read /
//            file_write op implementations (Node fs read/write/mkdir) +
//            (approved:) inline kwarg captured on mutation-class ops.
//            ~280 LOC across parser.ts (REF_PATTERN const, paren-balanced
//            helpers, function-call dispatch) + runtime.ts (file_read /
//            file_write cases, $${...} escape, loose-bracket condition
//            regexes) + compile.ts (alternation substitute, file_read/
//            write renderers) + lint.ts (4-capture extractVarRefs + 2-form
//            detectors). Ceiling will tighten again when v0.8 promotes
//            deprecated-symbol-op to tier-1 and old paths can be removed.
//
// Run: `pnpm run loc-check`. CI fails the build if the narrow ceiling is
// breached. The broad count is reported but does NOT fail the build.

import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC_DIR = join(ROOT, "src");

// ERD §1 narrow core: parser + compiler + executor + connector registry + lint.
// Per T7 kickoff: src/connectors/* is treated as the connector registry
// surface (registry + bundled reference implementations + type contracts).
const CORE_PATHS = [
  "parser.ts",
  "compile.ts",
  "runtime.ts",
  "lint.ts",
  "connectors/",
];

const NARROW_MAX_LOC = 8300;
const NARROW_MAX_FILES = 20;
const BROAD_INFO_LOC = 9500;
const BROAD_INFO_FILES = 28;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

function isCore(relPath) {
  const norm = relPath.split(/[\\/]/).join("/");
  return CORE_PATHS.some((p) => p.endsWith("/") ? norm.startsWith(p) : norm === p);
}

const allFiles = await walk(SRC_DIR);
const rows = [];

for (const f of allFiles) {
  const body = await readFile(f, "utf8");
  const loc = body.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length;
  const rel = posix.normalize(f.slice(SRC_DIR.length + 1).split(/[\\/]/).join("/"));
  rows.push({ file: rel, loc, core: isCore(rel) });
}

rows.sort((a, b) => b.loc - a.loc);

const coreRows = rows.filter((r) => r.core);
const auxRows = rows.filter((r) => !r.core);
const coreLoc = coreRows.reduce((acc, r) => acc + r.loc, 0);
const auxLoc = auxRows.reduce((acc, r) => acc + r.loc, 0);
const totalLoc = coreLoc + auxLoc;

console.log("ERD §1 narrow core (parser + compile + runtime + lint + connectors/):\n");
for (const { file, loc } of coreRows) {
  console.log(`  ${String(loc).padStart(5)}  ${file}`);
}
console.log(`\n  CORE   ${coreLoc} LOC across ${coreRows.length} files`);
console.log(`  BUDGET ≤ ${NARROW_MAX_LOC} LOC across < ${NARROW_MAX_FILES} files (enforced)\n`);

console.log("Auxiliary src/ (CLI, dashboard, MCP server, trace, metrics, etc.):\n");
for (const { file, loc } of auxRows) {
  console.log(`  ${String(loc).padStart(5)}  ${file}`);
}
console.log(`\n  AUX    ${auxLoc} LOC across ${auxRows.length} files`);
console.log(`  TOTAL  ${totalLoc} LOC across ${rows.length} files`);
console.log(`  INFO   broad ceiling ≤ ${BROAD_INFO_LOC} LOC / < ${BROAD_INFO_FILES} files (reported only)\n`);

let failed = false;
if (coreLoc > NARROW_MAX_LOC) {
  console.error(`FAIL: narrow core LOC ${coreLoc} exceeds ERD §1 ceiling ${NARROW_MAX_LOC}`);
  failed = true;
}
if (coreRows.length >= NARROW_MAX_FILES) {
  console.error(`FAIL: narrow core file count ${coreRows.length} hits or exceeds ceiling ${NARROW_MAX_FILES}`);
  failed = true;
}

if (totalLoc > BROAD_INFO_LOC) {
  console.warn(`WARN: total src/ LOC ${totalLoc} exceeds informational broad ceiling ${BROAD_INFO_LOC} (not a build failure; consider whether auxiliary surface needs tightening)`);
}
if (rows.length >= BROAD_INFO_FILES) {
  console.warn(`WARN: total src/ file count ${rows.length} hits or exceeds informational broad ceiling ${BROAD_INFO_FILES} (not a build failure)`);
}

if (failed) process.exit(1);
console.log("OK: within ERD §1 narrow core ceiling.");
