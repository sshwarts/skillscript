#!/usr/bin/env node
// `skillfile` CLI — the operator-facing entrypoint.
//
// T1 surface: `init`, `run`, `compile`, `lint`, `list`. The richer set
// (`diagram`, `audit`, `sign`/`verify`, `status`, `register-trigger`,
// `list-triggers`) lands in T6/T7.

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_VERSION as VERSION } from "./version.js";
import { compile } from "./compile.js";
import { execute } from "./runtime.js";
import { lint, formatLintResult } from "./lint.js";
import { audit, formatAuditResult } from "./audit.js";
import type { ProvenanceBlock } from "./provenance.js";
import { renderSidecarProvenance } from "./provenance.js";
import { Registry } from "./connectors/registry.js";
import { FilesystemSkillStore } from "./connectors/skill-store.js";
import { OllamaLocalModel } from "./connectors/local-model.js";
import { SqliteDataStore } from "./connectors/data-store.js";
import { parse, type SkillOp } from "./parser.js";
import { FilesystemTraceStore } from "./trace.js";
import { healthMetrics } from "./metrics.js";
import { DashboardServer } from "./dashboard/server.js";
import { bootstrap, defaultRegistry, wireDeclarativeTriggers } from "./bootstrap.js";
import { loadSkillscriptConfig } from "./runtime-config.js";
import { createHash } from "node:crypto";

const HOME_DIR = process.env["SKILLSCRIPT_HOME"] ?? join(homedir(), ".skillscript");
const SKILLS_DIR = join(HOME_DIR, "skills");
const DATA_DB = join(HOME_DIR, "data.db");
const EXAMPLES_DIR = join(HOME_DIR, "examples");
const PLUGINS_DIR = join(HOME_DIR, "plugins");
const TRACE_DIR = join(HOME_DIR, "traces");

// v0.15.4 — the node:sqlite ExperimentalWarning suppression that v0.15.1
// installed here moved to the actual sqlite-load sites
// (src/connectors/data-store.ts + src/connectors/sqlite-skill-store.ts)
// so it covers both CLI consumers AND programmatic adopters running their
// own bootstrap. See src/sqlite-warning-suppress.ts.

interface CommandHelp {
  description: string;
  usage: string;
  args?: ReadonlyArray<{ name: string; description: string }>;
  options?: ReadonlyArray<{ flag: string; description: string }>;
  examples?: ReadonlyArray<string>;
}

const COMMAND_HELP: Readonly<Record<string, CommandHelp>> = {
  init: {
    description: "Scaffold ~/.skillscript/ tree + bundled example",
    usage: "skillfile init",
    examples: ["skillfile init"],
  },
  execute: {
    description: "Compile + execute a skill end-to-end (mirrors MCP `execute_skill`)",
    usage: "skillfile execute <path|name> [options]",
    args: [{ name: "<path|name>", description: "Path to .skill.md file OR name registered in SkillStore" }],
    options: [
      { flag: "--input KEY=value", description: "Provide a value for a declared input (repeatable)" },
      { flag: "--format prompt|prose", description: "Render format (default: prompt)" },
      { flag: "--mechanical", description: "Preview mode — `$`/`~`/`>` ops don't dispatch" },
      { flag: "--trace on|off|sample", description: "Record execution trace via FilesystemTraceStore" },
    ],
    examples: [
      "skillfile execute examples/skillscripts/hello-world.skill.md",
      "skillfile execute hello --input WHO=Scott",
      "skillfile execute hello --mechanical --trace on",
    ],
  },
  // `skillfile run` was the original name (pre-v0.2.11). v0.2.11 added
  // `skillfile execute` and shipped `run` as a deprecated alias with a
  // stderr nudge. v0.2.12 drops the alias. Memory `2e999f9e` (Perry,
  // 2026-05-23) drove the rename for MCP-CLI symmetry.
  compile: {
    description: "Render the compiled artifact (no execution)",
    usage: "skillfile compile <path|name> [options]",
    args: [{ name: "<path|name>", description: "Path to .skill.md file OR name registered in SkillStore" }],
    options: [
      { flag: "--input KEY=value", description: "Provide a value for a declared input (repeatable)" },
      { flag: "--format prompt|prose", description: "Render format (default: prompt)" },
      { flag: "--inline-provenance", description: "Embed provenance block in artifact (default: sidecar)" },
      { flag: "--sidecar <path>", description: "Write provenance to this path (default: <output>.provenance.json)" },
    ],
    examples: [
      "skillfile compile examples/skillscripts/hello-world.skill.md",
      "skillfile compile hello --format prose",
      "skillfile compile hello --inline-provenance",
    ],
  },
  audit: {
    description: "Detect recompile-staleness via .provenance.json sidecar",
    usage: "skillfile audit <provenance-path> [--json]",
    args: [{ name: "<provenance-path>", description: "Path to a .provenance.json sidecar file" }],
    options: [{ flag: "--json", description: "Emit structured JSON instead of pretty-printed text" }],
    examples: [
      "skillfile audit examples/skillscripts/hello-world.skill.provenance.json",
      "skillfile audit support-response.provenance.json --json",
    ],
  },
  lint: {
    description: "Run static validation, print findings",
    usage: "skillfile lint <path|name> [--json|--human]",
    args: [{ name: "<path|name>", description: "Path to .skill.md file OR name registered in SkillStore" }],
    options: [
      { flag: "--json", description: "Emit structured JSON instead of pretty-printed text" },
      { flag: "--human", description: "Pretty-print findings (default when --json absent)" },
    ],
    examples: [
      "skillfile lint examples/skillscripts/hello-world.skill.md",
      "skillfile lint hello --json",
    ],
  },
  list: {
    description: "List available skills in the configured SkillStore",
    usage: "skillfile list [--status STATUS]",
    options: [{ flag: "--status STATUS", description: "Filter by status: Draft, Approved, or Disabled" }],
    examples: ["skillfile list", "skillfile list --status Approved"],
  },
  fires: {
    description: "List recent trace records for a skill",
    usage: "skillfile fires <skill> [--limit N] [--human]",
    args: [{ name: "<skill>", description: "Skill name to query trace records for" }],
    options: [
      { flag: "--limit N", description: "Cap results (default: 20)" },
      { flag: "--human", description: "Pretty-print summary instead of JSON" },
    ],
    examples: [
      "skillfile fires hello --limit 10",
      "skillfile fires hello --human",
    ],
  },
  diagram: {
    description: "Emit mermaid graph of the skill's control flow",
    usage: "skillfile diagram <path|name>",
    args: [{ name: "<path|name>", description: "Path to .skill.md file OR name registered in SkillStore" }],
    examples: [
      "skillfile diagram hello",
      "skillfile diagram hello > docs/hello-graph.md",
    ],
  },
  sign: {
    description: "Content-hash sign the skill source (SHA-256)",
    usage: "skillfile sign <path|name>",
    args: [{ name: "<path|name>", description: "Path to .skill.md file OR name registered in SkillStore" }],
    examples: ["skillfile sign hello"],
  },
  verify: {
    description: "Verify the skill matches a signature",
    usage: "skillfile verify <path|name> <hash>",
    args: [
      { name: "<path|name>", description: "Path to .skill.md file OR name registered in SkillStore" },
      { name: "<hash>", description: "Expected SHA-256 hash (from skillfile sign)" },
    ],
    examples: ["skillfile verify hello abc123..."],
  },
  replay: {
    description: "Re-run a recorded trace mechanically",
    usage: "skillfile replay <trace_id> [--connectors current]",
    args: [{ name: "<trace_id>", description: "Trace ID from skillfile fires output" }],
    options: [
      { flag: "--connectors current", description: "Re-run against today's wired connectors (default; debug)" },
    ],
    examples: ["skillfile replay tr-abc123", "skillfile replay tr-abc123 --connectors current"],
  },
  health: {
    description: "Aggregate runtime metrics across all traces",
    usage: "skillfile health [options]",
    options: [
      { flag: "--skill X", description: "Restrict to one skill" },
      { flag: "--connector Y", description: "Restrict to one connector" },
      { flag: "--since-ms N", description: "Window start (default: 24h ago)" },
      { flag: "--human", description: "Pretty-print instead of JSON" },
    ],
    examples: [
      "skillfile health",
      "skillfile health --skill hello --human",
      "skillfile health --connector data-store --since-ms 3600000",
    ],
  },
  serve: {
    description: "Start the headless runtime host: scheduler + MCP server, no browser SPA",
    usage: "skillfile serve [--port N] [--host ADDR] [--connectors PATH] [--config PATH]",
    options: [
      { flag: "--port N", description: "TCP port (default: 7878; overrides skillscript.config.json)" },
      { flag: "--host ADDR", description: "Bind address (default: 127.0.0.1; container deploys override to 0.0.0.0)" },
      { flag: "--connectors PATH", description: "Path to connectors.json (default: $SKILLSCRIPT_HOME/connectors.json)" },
      { flag: "--config PATH", description: "Path to skillscript.config.json (default: $SKILLSCRIPT_HOME/skillscript.config.json; loader is graceful on missing)" },
    ],
    examples: [
      "skillfile serve",
      "skillfile serve --host 0.0.0.0 --port 7878   # container deployment",
      "skillfile serve --config ./adopter.config.json   # two-instance posture",
    ],
  },
  dashboard: {
    description: "Start the full runtime host: scheduler + MCP server + browser dashboard SPA",
    usage: "skillfile dashboard [--port N] [--host ADDR] [--connectors PATH] [--config PATH]",
    options: [
      { flag: "--port N", description: "TCP port (default: 7878; overrides skillscript.config.json)" },
      { flag: "--host ADDR", description: "Bind address (default: 127.0.0.1; container deploys override to 0.0.0.0)" },
      { flag: "--connectors PATH", description: "Path to connectors.json (default: $SKILLSCRIPT_HOME/connectors.json; loader is graceful on missing file)" },
      { flag: "--config PATH", description: "Path to skillscript.config.json (default: $SKILLSCRIPT_HOME/skillscript.config.json; loader is graceful on missing)" },
    ],
    examples: [
      "skillfile dashboard",
      "skillfile dashboard --port 8080",
      "skillfile dashboard --host 0.0.0.0 --port 7878   # container only",
      "skillfile dashboard --config ./adopter.config.json   # two-instance posture",
    ],
  },
};

const COMMAND_ORDER: ReadonlyArray<string> = [
  "init", "execute", "compile", "audit", "lint", "list",
  "fires", "diagram", "sign", "verify", "replay", "health",
  "serve", "dashboard",
];

function usage(): string {
  const lines: string[] = [
    `skillfile v${VERSION} — Skillscript runtime + compiler CLI`,
    ``,
    `Usage:`,
    `  skillfile <command> [options]`,
    `  skillfile <command> --help`,
    `  skillfile --version`,
    ``,
    `Commands:`,
  ];
  const widest = Math.max(...COMMAND_ORDER.map((c) => c.length));
  for (const cmd of COMMAND_ORDER) {
    const help = COMMAND_HELP[cmd]!;
    lines.push(`  ${cmd.padEnd(widest + 2)}${help.description}`);
  }
  lines.push(
    ``,
    `Run \`skillfile <command> --help\` for command-specific options + examples.`,
    ``,
    `Environment:`,
    `  SKILLSCRIPT_HOME    Override config root (default ~/.skillscript)`,
    `  OLLAMA_BASE_URL     Override Ollama endpoint (default http://localhost:11434)`,
    ``,
  );
  return lines.join("\n");
}

function commandUsage(cmd: string): string {
  const help = COMMAND_HELP[cmd];
  if (help === undefined) return usage();
  const lines: string[] = [
    `skillfile ${cmd} — ${help.description}`,
    ``,
    `Usage:`,
    `  ${help.usage}`,
    ``,
  ];
  if (help.args !== undefined && help.args.length > 0) {
    lines.push(`Arguments:`);
    const widest = Math.max(...help.args.map((a) => a.name.length));
    for (const a of help.args) lines.push(`  ${a.name.padEnd(widest + 2)}${a.description}`);
    lines.push(``);
  }
  if (help.options !== undefined && help.options.length > 0) {
    lines.push(`Options:`);
    const widest = Math.max(...help.options.map((o) => o.flag.length));
    for (const o of help.options) lines.push(`  ${o.flag.padEnd(widest + 2)}${o.description}`);
    lines.push(``);
  }
  if (help.examples !== undefined && help.examples.length > 0) {
    lines.push(`Examples:`);
    for (const ex of help.examples) lines.push(`  ${ex}`);
    lines.push(``);
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === undefined || cmd === "-h" || cmd === "--help") {
    process.stdout.write(usage());
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // Per-command help: `skillfile <cmd> --help` (or -h) renders the
  // command-specific spec from COMMAND_HELP before the cmd handler runs.
  if (rest.includes("--help") || rest.includes("-h")) {
    if (COMMAND_HELP[cmd] !== undefined) {
      process.stdout.write(commandUsage(cmd));
      return 0;
    }
  }

  switch (cmd) {
    case "init":    return await cmdInit();
    case "execute": return await cmdRun(rest);
    case "compile": return await cmdCompile(rest);
    case "audit":   return await cmdAudit(rest);
    case "lint":    return await cmdLint(rest);
    case "list":    return await cmdList(rest);
    case "fires":   return await cmdFires(rest);
    case "diagram": return await cmdDiagram(rest);
    case "sign":    return await cmdSign(rest);
    case "verify":  return await cmdVerify(rest);
    case "replay":  return await cmdReplay(rest);
    case "health":  return await cmdHealth(rest);
    case "serve":               return await cmdRuntimeHost(rest, { mode: "serve" });
    case "dashboard":           return await cmdRuntimeHost(rest, { mode: "dashboard" });
    default:
      process.stderr.write(`skillfile: unknown command '${cmd}'\n\n${usage()}`);
      return 64;
  }
}

async function cmdInit(): Promise<number> {
  await mkdir(SKILLS_DIR, { recursive: true });
  await mkdir(EXAMPLES_DIR, { recursive: true });
  await mkdir(PLUGINS_DIR, { recursive: true });

  const scaffoldRoot = locateScaffoldRoot();
  await copyScaffoldFile(join(scaffoldRoot, "config.toml"), join(HOME_DIR, "config.toml"));
  // v0.15.1 — seed the three Phase 1 demos directly into `skills/` (where the
  // FilesystemSkillStore reads) so `execute_skill({skill_name: "hello-world"})`
  // works immediately after init — no manual `cp` from node_modules required.
  // All three ship pre-stamped (`# Status: Approved v1:<token>`). Adopters
  // who want them as browsable references can also find them under
  // `node_modules/skillscript-runtime/examples/skillscripts/`.
  for (const demo of ["hello-world", "skill-store-roundtrip", "data-store-roundtrip"]) {
    await copyScaffoldFile(
      join(scaffoldRoot, "skills", `${demo}.skill.md`),
      join(SKILLS_DIR, `${demo}.skill.md`),
    );
  }
  await copyScaffoldFile(join(scaffoldRoot, "connectors.json"), join(HOME_DIR, "connectors.json"));

  process.stdout.write(`Initialized ${HOME_DIR}
  skills/         ${SKILLS_DIR}
                  └─ hello-world, skill-store-roundtrip, data-store-roundtrip (Approved, ready to execute)
  examples/       ${EXAMPLES_DIR}
  plugins/        ${PLUGINS_DIR}
  config.toml     ${join(HOME_DIR, "config.toml")}
  connectors.json ${join(HOME_DIR, "connectors.json")}

Next:
  skillfile dashboard --host 0.0.0.0 --port 7878
  # Then dispatch a seeded demo via the MCP wire:
  #   curl -s -X POST http://localhost:7878/rpc \\
  #     -H "content-type: application/json" \\
  #     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute_skill","arguments":{"skill_name":"hello-world"}}}' \\
  #     | jq -r '.result.content[0].text' | jq
`);
  return 0;
}

async function cmdRun(args: string[]): Promise<number> {
  const opts = parseRunCompileArgs(args);
  if (opts.error) {
    process.stderr.write(`skillfile run: ${opts.error}\n`);
    return 64;
  }
  const source = await loadSkillSource(opts.skillRef!);
  if (source === null) {
    process.stderr.write(`skillfile run: skill '${opts.skillRef}' not found\n`);
    return 1;
  }
  const registry = buildRegistry();

  try {
    const compiled = await compile(source, {
      inputs: opts.inputs,
      format: opts.format,
      skillStore: registry.getSkillStore(),
    });
    const traceMode = opts.traceMode;
    const traceStore = traceMode !== undefined && traceMode !== "off"
      ? new FilesystemTraceStore(TRACE_DIR)
      : undefined;
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry,
      ...(opts.mechanical ? { mechanical: true } : {}),
      ...(traceMode !== undefined ? { trace: { mode: traceMode } } : {}),
      ...(traceStore !== undefined ? { traceStore } : {}),
    });
    for (const line of result.emissions) {
      process.stdout.write(`${line}\n`);
    }
    if (result.errors.length > 0) {
      process.stderr.write(`\n${result.errors.length} error(s):\n`);
      for (const e of result.errors) {
        process.stderr.write(`  [${e.target}/${e.opKind}] (${e.class}) ${e.message}\n`);
        if (e.remediation !== undefined) {
          process.stderr.write(`    → ${e.remediation}\n`);
        }
      }
      return 1;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`skillfile run: ${(err as Error).message}\n`);
    return 1;
  }
}

async function cmdCompile(args: string[]): Promise<number> {
  const opts = parseRunCompileArgs(args);
  if (opts.error) {
    process.stderr.write(`skillfile compile: ${opts.error}\n`);
    return 64;
  }
  const source = await loadSkillSource(opts.skillRef!);
  if (source === null) {
    process.stderr.write(`skillfile compile: skill '${opts.skillRef}' not found\n`);
    return 1;
  }
  try {
    const compiled = await compile(source, {
      inputs: opts.inputs,
      format: opts.format,
      skillStore: new FilesystemSkillStore(SKILLS_DIR),
      inlineProvenance: opts.inlineProvenance,
    });
    process.stdout.write(`${compiled.output}\n`);
    // Sidecar provenance — written unless `--inline-provenance` chose embed.
    if (!opts.inlineProvenance && opts.sidecarPath !== undefined) {
      await writeFile(opts.sidecarPath, renderSidecarProvenance(compiled.provenance), "utf8");
      process.stderr.write(`Provenance written to ${opts.sidecarPath}\n`);
    }
    if (compiled.warnings.length > 0) {
      process.stderr.write(`\nWarnings:\n`);
      for (const w of compiled.warnings) process.stderr.write(`  ${w}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`skillfile compile: ${(err as Error).message}\n`);
    return 1;
  }
}

async function cmdAudit(args: string[]): Promise<number> {
  const provenancePath = args[0];
  if (provenancePath === undefined) {
    process.stderr.write("skillfile audit: missing provenance path\n");
    return 64;
  }
  const jsonOutput = args.includes("--json");
  let body: string;
  try {
    body = await readFile(resolve(process.cwd(), provenancePath), "utf8");
  } catch {
    process.stderr.write(`skillfile audit: cannot read '${provenancePath}'\n`);
    return 1;
  }
  let block: ProvenanceBlock;
  try {
    block = JSON.parse(body) as ProvenanceBlock;
  } catch {
    process.stderr.write(`skillfile audit: '${provenancePath}' is not valid JSON\n`);
    return 1;
  }
  const store = new FilesystemSkillStore(SKILLS_DIR);
  try {
    const result = await audit(block, store);
    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatAuditResult(result)}\n`);
    }
    // Exit code: 0 if clean, 1 if any findings (consistent with lint).
    return result.findings.length === 0 ? 0 : 1;
  } catch (err) {
    process.stderr.write(`skillfile audit: ${(err as Error).message}\n`);
    return 1;
  }
}

async function cmdLint(args: string[]): Promise<number> {
  const ref = args[0];
  if (ref === undefined) {
    process.stderr.write("skillfile lint: missing skill path or name\n");
    return 64;
  }
  const source = await loadSkillSource(ref);
  if (source === null) {
    process.stderr.write(`skillfile lint: skill '${ref}' not found\n`);
    return 1;
  }
  const jsonOutput = args.includes("--json");
  const humanOutput = args.includes("--human");
  // Pass the bundled-default class set so capability `# Requires:`
  // validation works against the standard connector surface. Pass the
  // SkillStore so cross-skill rules (unknown-skill-reference,
  // disabled-skill-reference) can resolve.
  const result = await lint(source, {
    classes: [FilesystemSkillStore, SqliteDataStore, OllamaLocalModel],
    skillStore: new FilesystemSkillStore(SKILLS_DIR),
    callSite: "cli",
  });
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (humanOutput || !jsonOutput) {
    process.stdout.write(`${formatLintResult(result)}\n`);
  }
  return result.errorCount > 0 ? 1 : 0;
}

async function cmdList(args: string[]): Promise<number> {
  const statusFilter = extractFlag(args, "--status");
  const store = new FilesystemSkillStore(SKILLS_DIR);
  const metas = await store.query(
    statusFilter !== undefined ? { status: statusFilter as "Draft" | "Approved" | "Disabled" } : undefined,
  );
  if (metas.length === 0) {
    process.stdout.write(`No skills found in ${SKILLS_DIR}.\nRun \`skillfile init\` to scaffold the tree.\n`);
    return 0;
  }
  for (const m of metas) {
    const desc = m.description !== undefined ? ` — ${m.description}` : "";
    process.stdout.write(`  ${m.name} [${m.status}]${desc}\n`);
  }
  return 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

interface RunCompileOpts {
  skillRef?: string;
  inputs: Record<string, string>;
  format: "prompt" | "prose";
  mechanical: boolean;
  inlineProvenance: boolean;
  sidecarPath?: string;
  /** When set, `skillfile run` records a trace via FilesystemTraceStore at TRACE_DIR. */
  traceMode?: "off" | "on" | "sample";
  error?: string;
}

function parseRunCompileArgs(args: string[]): RunCompileOpts {
  const opts: RunCompileOpts = { inputs: {}, format: "prompt", mechanical: false, inlineProvenance: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--input") {
      const kv = args[++i];
      if (kv === undefined) return { ...opts, error: "--input requires KEY=value" };
      const eq = kv.indexOf("=");
      if (eq <= 0) return { ...opts, error: `--input expected KEY=value, got '${kv}'` };
      opts.inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--format") {
      const v = args[++i];
      if (v !== "prompt" && v !== "prose") {
        return { ...opts, error: `--format must be 'prompt' or 'prose' (got '${v}')` };
      }
      opts.format = v;
    } else if (a === "--mechanical") {
      opts.mechanical = true;
    } else if (a === "--inline-provenance") {
      opts.inlineProvenance = true;
    } else if (a === "--sidecar") {
      const v = args[++i];
      if (v === undefined) return { ...opts, error: "--sidecar requires a path" };
      opts.sidecarPath = v;
    } else if (a === "--trace") {
      const v = args[++i];
      if (v !== "off" && v !== "on" && v !== "sample") {
        return { ...opts, error: `--trace must be off/on/sample (got '${v}')` };
      }
      opts.traceMode = v;
    } else if (a.startsWith("--")) {
      return { ...opts, error: `unknown flag '${a}'` };
    } else if (opts.skillRef === undefined) {
      opts.skillRef = a;
    } else {
      return { ...opts, error: `unexpected positional argument '${a}'` };
    }
  }
  if (opts.skillRef === undefined) return { ...opts, error: "missing skill path or name" };
  // Default sidecar path when not inlining and not explicitly named.
  // Source `.skill.md` files emit `.skill.provenance.json` (drop the `.md`,
  // append `.provenance.json` per the source/compiled split convention).
  if (!opts.inlineProvenance && opts.sidecarPath === undefined) {
    const ref = opts.skillRef;
    if (ref.endsWith(".skill.md")) {
      opts.sidecarPath = ref.replace(/\.skill\.md$/, ".skill.provenance.json");
    } else if (ref.endsWith(".skill")) {
      opts.sidecarPath = ref.replace(/\.skill$/, ".skill.provenance.json");
    } else {
      opts.sidecarPath = `${ref}.provenance.json`;
    }
  }
  return opts;
}

function extractFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

/**
 * Resolve a skill reference to source text. Rules:
 *   1. If it's an absolute or relative path that resolves to an existing file, read it.
 *   2. Otherwise, treat it as a name and look up `<SKILLS_DIR>/<name>.skill.md`.
 *      (`.skill.md` is the source convention; bare `.skill` is reserved for
 *      compiled artifacts.)
 *   3. If neither hits, return null.
 *
 * `examples/<name>.skill.md` paths are resolved against either the working
 * directory or the configured EXAMPLES_DIR — whichever exists.
 */
async function loadSkillSource(ref: string): Promise<string | null> {
  const candidates: string[] = [];
  if (isAbsolute(ref)) candidates.push(ref);
  else {
    candidates.push(resolve(process.cwd(), ref));
    if (ref.startsWith("examples/")) {
      candidates.push(join(HOME_DIR, ref));
    }
    if (!ref.includes("/") && !ref.endsWith(".skill") && !ref.endsWith(".skill.md")) {
      candidates.push(join(SKILLS_DIR, `${ref}.skill.md`));
    }
  }
  for (const c of candidates) {
    try {
      return await readFile(c, "utf8");
    } catch {
      /* try next */
    }
  }
  return null;
}

function buildRegistry(): Registry {
  return defaultRegistry({ skillsDir: SKILLS_DIR, dataDbPath: DATA_DB }).registry;
}

/** Locate the bundled scaffold directory — works both in dev (running from src/) and prod (running from dist/). */
function locateScaffoldRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "scaffold"),
    resolve(here, "..", "..", "scaffold"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Could not locate bundled scaffold/ directory (looked in: ${candidates.join(", ")})`);
}

async function copyScaffoldFile(src: string, dest: string): Promise<void> {
  try {
    await stat(dest);
    // Don't overwrite existing config — `init` is safe to re-run.
    return;
  } catch {
    /* dest doesn't exist — proceed */
  }
  await mkdir(dirname(dest), { recursive: true });
  const body = await readFile(src, "utf8");
  await writeFile(dest, body, "utf8");
}

async function cmdRuntimeHost(args: string[], opts: { mode: "serve" | "dashboard" }): Promise<number> {
  // v0.7.3 — load skillscript.config.json if present. CLI flags override
  // config-file values; config-file values override defaults.
  const configPath = extractFlag(args, "--config") ?? join(HOME_DIR, "skillscript.config.json");
  const { config: fileConfig, errors: configErrors } = loadSkillscriptConfig({ path: configPath });
  for (const err of configErrors) process.stderr.write(`[cli] ${err}\n`);
  const portStr = extractFlag(args, "--port");
  const port = portStr !== undefined ? parseInt(portStr, 10) : fileConfig.dashboard?.port ?? 7878;
  // --host is the bind address inside the running process. 127.0.0.1 is
  // the safe default for local invocation; container deployments pass
  // --host 0.0.0.0 so the host-side port-forward can reach the listener
  // (host port mapping still enforces 127.0.0.1 externally).
  const host = extractFlag(args, "--host") ?? fileConfig.dashboard?.host ?? "127.0.0.1";
  const triggersFilePath = fileConfig.triggersFilePath ?? join(HOME_DIR, "triggers.json");
  // v0.4.3 — auto-discover connectors.json from HOME_DIR. Closes the
  // last-mile gap of the v0.4.x arc: pre-v0.4.3 the loader + lint +
  // runtime + allowlist all worked, but the canonical CLI entry point
  // didn't read connectors.json. --connectors <path> overrides the
  // default for non-standard layouts. Loader is graceful on missing.
  const connectorsConfigPath = extractFlag(args, "--connectors") ?? fileConfig.connectorsConfigPath ?? join(HOME_DIR, "connectors.json");
  const wired = bootstrap({
    skillsDir: fileConfig.skillsDir ?? SKILLS_DIR,
    traceDir: fileConfig.traceDir ?? TRACE_DIR,
    dataDbPath: fileConfig.dataDbPath ?? DATA_DB,
    triggersFilePath,
    connectorsConfigPath,
    mode: opts.mode,
    ...(fileConfig.pollIntervalSeconds !== undefined ? { pollIntervalSeconds: fileConfig.pollIntervalSeconds } : {}),
    ...(fileConfig.enableUnsafeShell !== undefined ? { enableUnsafeShell: fileConfig.enableUnsafeShell } : {}),
    // Scheduler-fired skills record traces by default; `fires` / `health` /
    // `health_metrics` (MCP) all read from the trace store.
    trace: { mode: "on" },
  });
  // Register declarative `# Triggers:` headers BEFORE arming the tick loop
  // so the first tick can fire any minute-aligned cron entries.
  await wireDeclarativeTriggers(wired);
  wired.scheduler.start();
  // v0.2.7: dashboard mounts the SPA; serve runs headless on /rpc only.
  const server = new DashboardServer({
    mcpServer: wired.mcpServer,
    port,
    bindAddress: host,
    mountSpa: opts.mode === "dashboard",
    ...(fileConfig.dashboard?.mcpCallerIdentityHeader !== undefined
      ? { mcpCallerIdentityHeader: fileConfig.dashboard.mcpCallerIdentityHeader }
      : {}),
  });
  await server.start();
  const label = opts.mode === "dashboard" ? "dashboard" : "serve (headless)";
  process.stdout.write(`skillfile ${label} running on http://${host}:${port}\nctrl-C to stop\n`);
  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async (): Promise<void> => {
        await wired.scheduler.stop();
        await server.stop();
        resolve();
      })();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  return 0;
}

async function cmdFires(args: string[]): Promise<number> {
  const skill = args.find((a) => !a.startsWith("--"));
  if (skill === undefined) {
    process.stderr.write("Usage: skillfile fires <skill> [--limit N] [--human]\n");
    return 64;
  }
  const limitStr = extractFlag(args, "--limit");
  const limit = limitStr !== undefined ? parseInt(limitStr, 10) : 20;
  const human = args.includes("--human");
  const store = new FilesystemTraceStore(TRACE_DIR);
  const records = await store.query({ skill_name: skill, limit });
  if (human) {
    if (records.length === 0) {
      process.stdout.write(`No trace records for '${skill}' under ${TRACE_DIR}.\n`);
      return 0;
    }
    for (const r of records) {
      const ts = new Date(r.fired_at_ms).toISOString();
      const status = r.errors.length === 0 ? "ok" : `err:${r.errors[0]!.class}`;
      process.stdout.write(`${ts}  ${r.trace_id}  ${status}  ${r.duration_ms}ms  ${r.ops.length} ops\n`);
    }
  } else {
    process.stdout.write(JSON.stringify(records, null, 2) + "\n");
  }
  return 0;
}

async function cmdDiagram(args: string[]): Promise<number> {
  const ref = args[0];
  if (ref === undefined) {
    process.stderr.write("Usage: skillfile diagram <path|name>\n");
    return 64;
  }
  const source = await loadSkillSource(ref);
  if (source === null) {
    process.stderr.write(`skillfile: could not locate skill '${ref}'\n`);
    return 66;
  }
  const parsed = parse(source);
  process.stdout.write(renderMermaid(parsed.name ?? "skill", parsed) + "\n");
  return 0;
}

function renderMermaid(skillName: string, parsed: ReturnType<typeof parse>): string {
  const lines: string[] = ["```mermaid", "flowchart TD", `  start(["${skillName}"])`];
  for (const [name, target] of parsed.targets) {
    const ops = target.ops.map((o) => o.kind).join(",");
    lines.push(`  ${name}["${name}\\n[${ops}]"]`);
    for (const dep of target.deps) {
      lines.push(`  ${dep} --> ${name}`);
    }
  }
  if (parsed.entryTarget !== null) {
    lines.push(`  start --> ${parsed.entryTarget}`);
  }
  lines.push("```");
  return lines.join("\n");
}

async function cmdSign(args: string[]): Promise<number> {
  const ref = args[0];
  if (ref === undefined) {
    process.stderr.write("Usage: skillfile sign <path|name>\n");
    return 64;
  }
  const source = await loadSkillSource(ref);
  if (source === null) {
    process.stderr.write(`skillfile: could not locate skill '${ref}'\n`);
    return 66;
  }
  const hash = createHash("sha256").update(source, "utf8").digest("hex");
  const signature = {
    skill: ref,
    content_hash: hash,
    algorithm: "sha256",
    signed_at_ms: Date.now(),
    version: "v1",
  };
  process.stdout.write(JSON.stringify(signature, null, 2) + "\n");
  return 0;
}

async function cmdVerify(args: string[]): Promise<number> {
  const ref = args[0];
  const expected = args[1];
  if (ref === undefined || expected === undefined) {
    process.stderr.write("Usage: skillfile verify <path|name> <expected-hash>\n");
    return 64;
  }
  const source = await loadSkillSource(ref);
  if (source === null) {
    process.stderr.write(`skillfile: could not locate skill '${ref}'\n`);
    return 66;
  }
  const actual = createHash("sha256").update(source, "utf8").digest("hex");
  const result = { verified: actual === expected, expected, actual };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.verified ? 0 : 1;
}

async function cmdReplay(args: string[]): Promise<number> {
  const traceId = args.find((a) => !a.startsWith("--"));
  if (traceId === undefined) {
    process.stderr.write("Usage: skillfile replay <trace_id> [--connectors current]\n");
    return 64;
  }
  // v1 ships `current` mode only — replay against today's wired connectors.
  // `recorded` mode (deterministic replay against captured responses) requires
  // TraceOpRecord to capture op results too; deferred to v1.x as a schema bump.
  const mode = extractFlag(args, "--connectors") ?? "current";
  if (mode !== "current") {
    process.stderr.write(`replay: --connectors mode '${mode}' not supported in v1. 'current' only. 'recorded' lands in v1.x.\n`);
    return 64;
  }
  const store = new FilesystemTraceStore(TRACE_DIR);
  const record = await store.get(traceId);
  if (record === null) {
    process.stderr.write(`replay: trace '${traceId}' not found under ${TRACE_DIR}\n`);
    return 66;
  }
  // Re-load the skill by name from SkillStore; compile + execute fresh.
  const skillStore = new FilesystemSkillStore(SKILLS_DIR);
  let loaded;
  try {
    loaded = await skillStore.load(record.skill_name);
  } catch (err) {
    process.stderr.write(`replay: skill '${record.skill_name}' no longer in SkillStore (${(err as Error).message})\n`);
    return 66;
  }
  const compiled = await compile(loaded.source);
  const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
    registry: new Registry(),
    mechanical: true,
  });
  process.stdout.write(JSON.stringify({ replayed_trace_id: traceId, replay_skill_version: loaded.metadata.version, original_skill_version: record.skill_version, result }, null, 2) + "\n");
  return result.errors.length === 0 ? 0 : 1;
}

async function cmdHealth(args: string[]): Promise<number> {
  const human = args.includes("--human");
  const skill = extractFlag(args, "--skill");
  const connector = extractFlag(args, "--connector");
  const sinceStr = extractFlag(args, "--since-ms");
  const store = new FilesystemTraceStore(TRACE_DIR);
  const filter: { skills?: string[]; connectors?: string[]; since_ms?: number } = {};
  if (skill !== undefined) filter.skills = [skill];
  if (connector !== undefined) filter.connectors = [connector];
  if (sinceStr !== undefined) filter.since_ms = parseInt(sinceStr, 10);
  const metrics = await healthMetrics(store, filter);
  if (human) {
    process.stdout.write(`Health metrics (${new Date(metrics.windowStart_ms).toISOString()} → ${new Date(metrics.windowEnd_ms).toISOString()}, ${metrics.totalFires} fires)\n\n`);
    for (const [name, m] of Object.entries(metrics.perSkill)) {
      process.stdout.write(`Skill: ${name}\n`);
      process.stdout.write(`  fires=${m.fireCount} success=${m.successCount} errors=${m.errorCount} successRate=${(m.successRate * 100).toFixed(1)}%\n`);
    }
    for (const [name, m] of Object.entries(metrics.perConnector)) {
      process.stdout.write(`Connector: ${name}\n`);
      process.stdout.write(`  calls=${m.callCount} errors=${m.errorCount} errorRate=${(m.errorRate * 100).toFixed(1)}% p50=${m.latencyMs.p50}ms p95=${m.latencyMs.p95}ms p99=${m.latencyMs.p99}ms\n`);
    }
  } else {
    process.stdout.write(JSON.stringify(metrics, null, 2) + "\n");
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`skillfile: unexpected error: ${err.message}\n`);
  process.exit(2);
});
