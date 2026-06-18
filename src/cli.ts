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
import { resolveRuntimeConfigFromEnv } from "./runtime-env-resolver.js";
import { lint, formatLintResult } from "./lint.js";
import { audit, formatAuditResult } from "./audit.js";
import type { ProvenanceBlock } from "./provenance.js";
import { renderSidecarProvenance } from "./provenance.js";
import { Registry } from "./connectors/registry.js";
import { FilesystemSkillStore } from "./connectors/skill-store.js";
import type { SkillStore } from "./connectors/types.js";
import { setApprovalPublicKey, setSecuredMode, isSecuredMode, stampApprovalEd25519, evaluateApprovalGate } from "./approval.js";
import { OllamaLocalModel } from "./connectors/local-model.js";
import { SqliteDataStore } from "./connectors/data-store.js";
import { parse, type SkillOp } from "./parser.js";
import { FilesystemTraceStore } from "./trace.js";
import { healthMetrics } from "./metrics.js";
import { DashboardServer } from "./dashboard/server.js";
import { bootstrap, defaultRegistry, wireDeclarativeTriggers, ensureApprovalKeys, defaultApprovalKeyFile, defaultApprovalPublicKeyFile } from "./bootstrap.js";
import { loadSkillscriptConfig } from "./runtime-config.js";
import { loadEnvFile } from "./dotenv-loader.js";
import { createHash } from "node:crypto";

const HOME_DIR = process.env["SKILLSCRIPT_HOME"] ?? join(homedir(), ".skillscript");
// v0.17.4 — auto-load `$SKILLSCRIPT_HOME/.env` at CLI startup, before any
// config or env-var reads downstream. Missing file → no-op. Shell-set
// vars take precedence over file values (standard dotenv contract).
// Lets adopters drop a `.env` next to `skillscript.config.json` for
// posture switches like `SKILLSCRIPT_FORCE_ALWAYS_DRAFT=true`.
loadEnvFile({ path: join(HOME_DIR, ".env"), log: (msg) => process.stderr.write(`[cli] ${msg}\n`) });

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
  "shell-audit": {
    description: "Pre-upgrade discovery for v0.18.8 shell allowlist; scans corpus + emits SKILLSCRIPT_SHELL_ALLOWLIST value",
    usage: "skillfile shell-audit [--json]",
    args: [],
    options: [{ flag: "--json", description: "Emit structured JSON with per-binary skill citations" }],
    examples: [
      "skillfile shell-audit",
      "skillfile shell-audit --json | jq",
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
  approve: {
    description: "Approve a stored skill (sign it for secured-mode execution)",
    usage: "skillfile approve <name>",
    args: [{ name: "<name>", description: "Name of a skill in the SkillStore to review + sign with the operator's approval key" }],
    examples: ["skillfile approve my-skill"],
  },
  reapprove: {
    description: "Migrate pre-secured-mode approvals — batch re-sign Approved skills lacking a valid signature",
    usage: "skillfile reapprove [<name>] [--apply]",
    args: [{ name: "<name>", description: "Optional — limit the sweep to a single skill (default: all stored skills)" }],
    options: [{ flag: "--apply", description: "Re-sign the migration set with the operator's approval key (default: dry-run report only)" }],
    examples: ["skillfile reapprove", "skillfile reapprove --apply", "skillfile reapprove my-skill --apply"],
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
  "fires", "diagram", "sign", "verify", "approve", "reapprove", "replay", "health",
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
    case "shell-audit": return await cmdShellAudit(rest);
    case "lint":    return await cmdLint(rest);
    case "list":    return await cmdList(rest);
    case "fires":   return await cmdFires(rest);
    case "diagram": return await cmdDiagram(rest);
    case "sign":    return await cmdSign(rest);
    case "verify":  return await cmdVerify(rest);
    case "approve": return await cmdApprove(rest);
    case "reapprove": return await cmdReapprove(rest);
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
  // v1.0 Gate #7 — demos ship as `# Status: Draft` (honest: unreviewed-by-this-
  // operator; a bundled token could never validate on someone else's install).
  // init locally APPROVES them below with this machine's authority. Adopters
  // who want them as browsable references can also find them under
  // `node_modules/skillscript-runtime/examples/skillscripts/`.
  const demoNames = ["hello-world", "skill-store-roundtrip", "data-store-roundtrip"];
  for (const demo of demoNames) {
    await copyScaffoldFile(
      join(scaffoldRoot, "skills", `${demo}.skill.md`),
      join(SKILLS_DIR, `${demo}.skill.md`),
    );
  }
  const demoApproval = await approveSeededDemos(demoNames);
  await copyScaffoldFile(join(scaffoldRoot, "connectors.json"), join(HOME_DIR, "connectors.json"));
  // v0.17.4 — seed `.env.example` so adopters discover the dotenv
  // surface without grepping the source. We write `.env.example` (not
  // `.env`) so re-running init doesn't overwrite operator-edited
  // values; the operator copies `.env.example` → `.env` themselves.
  await copyScaffoldFile(join(scaffoldRoot, ".env.example"), join(HOME_DIR, ".env.example"));

  process.stdout.write(`Initialized ${HOME_DIR}
  skills/         ${SKILLS_DIR}
                  └─ hello-world, skill-store-roundtrip, data-store-roundtrip (${demoApproval}, ready to execute)
  examples/       ${EXAMPLES_DIR}
  plugins/        ${PLUGINS_DIR}
  config.toml     ${join(HOME_DIR, "config.toml")}
  connectors.json ${join(HOME_DIR, "connectors.json")}
  .env.example    ${join(HOME_DIR, ".env.example")} (cp → .env to set runtime env vars)

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

/**
 * v1.0 Gate #7 — locally approve the seeded demos at init time. The demos ship
 * as Draft (no bundled token can validate on someone else's install); init is
 * the operator at THIS terminal, choosing to install our bundled examples, so
 * it blesses them with this machine's authority:
 *   • secured — provision a keypair if absent + v3-SIGN each demo with the
 *     operator's private key (the runtime never holds it; this is the approve
 *     flow, same as `skillfile approve`).
 *   • unsecured — store each as bare `# Status: Approved` (unkeyed approval).
 * Returns a short word for the init summary line. Best-effort: a failure leaves
 * the demo Draft (still browsable + approvable later via `skillfile approve`).
 */
async function approveSeededDemos(demoNames: string[]): Promise<string> {
  const envConfig = resolveRuntimeConfigFromEnv();
  const store = new FilesystemSkillStore(SKILLS_DIR);
  try {
    if (envConfig.securedMode === true) {
      const keyFile = envConfig.approvalKeyFile ?? defaultApprovalKeyFile();
      const pubFile = envConfig.approvalPublicKeyFile ?? defaultApprovalPublicKeyFile();
      setApprovalPublicKey(ensureApprovalKeys(keyFile, pubFile));
      setSecuredMode(true);
      const priv = await readFile(keyFile, "utf8");
      for (const demo of demoNames) {
        const loaded = await store.load(demo);
        await store.store(demo, stampApprovalEd25519(loaded.source, priv), { status: "Approved" });
      }
      return "Approved, v3-signed";
    }
    // Unsecured — flip the seeded Draft to a bare `# Status: Approved` via the
    // status-transition API (rewrites the body header; no token, v1 retired).
    for (const demo of demoNames) {
      await store.update_status(demo, "Approved");
    }
    return "Approved";
  } catch (err) {
    process.stderr.write(`[init] could not auto-approve seeded demos (${(err as Error).message}); they remain Draft — approve with \`skillfile approve <name>\`\n`);
    return "Draft";
  }
}

async function cmdRun(args: string[]): Promise<number> {
  const opts = parseRunCompileArgs(args);
  if (opts.error) {
    process.stderr.write(`skillfile run: ${opts.error}\n`);
    return 64;
  }
  const resolved = await loadSkillSourceResolved(opts.skillRef!);
  if (resolved === null) {
    process.stderr.write(`skillfile run: skill '${opts.skillRef}' not found\n`);
    return 1;
  }
  const source = resolved.source;
  const registry = buildRegistry();

  try {
    const compiled = await compile(source, {
      inputs: opts.inputs,
      format: opts.format,
      skillStore: registry.getSkillStore(),
      // v0.19.10 — thread the wired registry into compile so the lint
      // preflight gets `mcpConnectorNames` populated. Without this,
      // connector-aware lints (unknown-connector, connector-as-tool,
      // remote-result-needs-parse) skip their checks from the CLI path
      // and the foot-guns only surface as runtime errors.
      registry,
    });
    const traceMode = opts.traceMode;
    const traceStore = traceMode !== undefined && traceMode !== "off"
      ? new FilesystemTraceStore(TRACE_DIR)
      : undefined;
    // v0.19.11 — thread runtime env (SKILLSCRIPT_SHELL_ALLOWLIST,
    // SKILLSCRIPT_ENABLE_UNSAFE_SHELL) into the execute ctx. Pre-v0.19.11
    // CLI execute didn't read these envs, so `shell()` ops hit the
    // default-deny allowlist gate even when the env was set — the
    // confused-state Perry surfaced when probing `argv` (the env shows
    // up in `bootstrap()` adopters via resolveRuntimeConfigFromEnv, but
    // CLI execute had a separate code path that skipped it). Same
    // CLI-auto-vs-programmatic-explicit class as the v0.19.1 env-resolver
    // structural fix (memory 9d969eb1) — apply the unified resolver here too.
    const envConfig = resolveRuntimeConfigFromEnv();
    // v1.0 Gate #7 — the CLI execute path must honor secured mode or it's a side
    // door around the boundary: an unapproved skill running effects via the CLI
    // (the env resolved `securedMode` but nothing armed it, so isSecuredMode()
    // stayed false and the effect gate was dormant). Arm secured mode + the
    // verifier from env, then mint the effect capability ONLY for a body that
    // passes the approval gate — the same formula the scheduler + composition
    // use. Unsecured → true (gate dormant); secured + unapproved → false →
    // every effectful op refused at dispatch, "regardless of method".
    if (envConfig.securedMode === true) {
      setSecuredMode(true);
      const pubFile = envConfig.approvalPublicKeyFile ?? defaultApprovalPublicKeyFile();
      if (existsSync(pubFile)) setApprovalPublicKey(await readFile(pubFile, "utf8"));
    }
    // v1.0 Gate #7 — a STORED (by-name) skill that fails the gate in secured
    // mode is refused OUTRIGHT, matching the scheduler + MCP execute_skill
    // dispatch paths (a stored skill behaves identically however it's invoked).
    // A by-PATH ad-hoc skill is the explicit escape hatch — it still runs, but
    // with effects gated below (it just can't have carried a valid approval).
    if (resolved.fromStore && isSecuredMode()) {
      const gate = evaluateApprovalGate(source);
      if (!gate.ok) {
        process.stderr.write(`skillfile execute: '${opts.skillRef}' refused — ${gate.reason}\n`);
        return 1;
      }
    }
    const effectsAuthorized = !isSecuredMode() || evaluateApprovalGate(source).ok;
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry,
      effectsAuthorized,
      ...(opts.mechanical ? { mechanical: true } : {}),
      ...(traceMode !== undefined ? { trace: { mode: traceMode } } : {}),
      ...(traceStore !== undefined ? { traceStore } : {}),
      ...(envConfig.shellAllowlist !== undefined ? { shellAllowlist: envConfig.shellAllowlist } : {}),
      ...(envConfig.fsAllowlist !== undefined ? { fsAllowlist: envConfig.fsAllowlist } : {}),
      ...(envConfig.enableUnsafeShell !== undefined ? { enableUnsafeShell: envConfig.enableUnsafeShell } : {}),
    });
    // v0.19.4 — complementary-channels output. Template-bearing skills
    // own canonical output via `outputs.text` (rendered string); legacy
    // emit-only skills produce emissions which are the canonical output.
    // CLI surfaces whichever the skill authored — template > emissions —
    // matching the c7ddfc50 channel semantic. Emit-only skills continue
    // to print emissions exactly as before.
    if (compiled.parsed.outputTemplate !== null && typeof result.outputs.text === "string") {
      process.stdout.write(`${result.outputs.text}\n`);
    } else {
      for (const line of result.emissions) {
        process.stdout.write(`${line}\n`);
      }
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

/**
 * v0.18.8 — pre-upgrade migration helper for the shell binary allowlist.
 * Scans every `.skill.md` under `$SKILLSCRIPT_HOME/skills/`, parses each,
 * walks shell ops, and emits the union of first-token binaries as a
 * comma-separated value ready to paste into `SKILLSCRIPT_SHELL_ALLOWLIST`.
 *
 * Sequence (per Perry's pre-upgrade migration framing): operator runs
 * this BEFORE upgrading to v0.18.8 — they get the current corpus's
 * shell footprint, paste into `.env`, then upgrade. Skills don't break
 * silently; the operator made an explicit decision.
 *
 * Unsafe-mode ops surface as `bash` (the actual binary the runtime
 * invokes via `bash -c`). The body's pipeline contents are NOT
 * enumerated — per Perry's reframe (thread `7aab6f3f`), parse-based
 * enumeration on the unsafe path is unsound.
 *
 * --json flag emits structured output with per-binary skill citations
 * for adopter review tooling.
 */
async function cmdShellAudit(args: string[]): Promise<number> {
  const jsonOutput = args.includes("--json");
  const store = new FilesystemSkillStore(SKILLS_DIR);
  let metas: Array<{ name: string }>;
  try {
    metas = await store.query({});
  } catch (err) {
    process.stderr.write(`skillfile shell-audit: ${(err as Error).message}\n`);
    return 1;
  }
  // binary → set of skill names where it's used
  const usage = new Map<string, Set<string>>();
  for (const meta of metas) {
    let source: string;
    try {
      const loaded = await store.load(meta.name);
      source = loaded.source;
    } catch {
      continue;
    }
    const parsed = parse(source);
    for (const [, target] of parsed.targets) {
      const walk = (ops: typeof target.ops): void => {
        for (const op of ops) {
          if (op.kind === "shell") {
            const trimmed = op.body.trim();
            const binary = op.policy === "unsafe"
              ? "bash"
              : trimmed.length === 0 || trimmed.startsWith("${") || trimmed.startsWith("$(")
                ? null
                : /^([^\s]+)/.exec(trimmed)?.[1] ?? null;
            if (binary !== null) {
              if (!usage.has(binary)) usage.set(binary, new Set());
              usage.get(binary)!.add(meta.name);
            }
          }
          if (op.foreachBody !== undefined) walk(op.foreachBody);
          if (op.ifBranches !== undefined) for (const b of op.ifBranches) walk(b.body);
        }
      };
      walk(target.ops);
    }
  }
  const binaries = [...usage.keys()].sort();
  if (jsonOutput) {
    const report = {
      skills_scanned: metas.length,
      binaries: binaries.map((b) => ({
        binary: b,
        used_by: [...usage.get(b)!].sort(),
      })),
      allowlist_value: binaries.join(","),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`Scanned ${metas.length} skill(s) under ${SKILLS_DIR}.\n`);
    if (binaries.length === 0) {
      process.stdout.write("\nNo `shell(...)` ops detected. SKILLSCRIPT_SHELL_ALLOWLIST may be left empty (or unset for full default-deny).\n");
    } else {
      process.stdout.write(`\nBinaries used:\n`);
      for (const binary of binaries) {
        const callers = [...usage.get(binary)!].sort();
        process.stdout.write(`  ${binary}  (in: ${callers.join(", ")})\n`);
      }
      process.stdout.write(`\nReady-to-paste .env entry:\n\nSKILLSCRIPT_SHELL_ALLOWLIST=${binaries.join(",")}\n`);
      if (binaries.includes("bash")) {
        process.stdout.write(`\nNote: 'bash' is on the list because at least one skill uses \`shell(..., unsafe=true)\`. To permit unsafe shell, ALSO set SKILLSCRIPT_ENABLE_UNSAFE_SHELL=true; otherwise the unsafe ops will still refuse (independent axis).\n`);
      }
    }
  }
  return 0;
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

/**
 * v1.0 Gate #7 — `skillfile approve <name>`. The operator approval action: sign
 * the stored skill body with the operator's Ed25519 PRIVATE key and stamp
 * `# Status: Approved v3:<sig>`. Running this command IS the human review — it
 * prints the body, then signs. The signed body lands Approved (the store honors
 * a valid v3 signature in secured mode; the metadata.status="Approved" override
 * supplies the transition authority). The runtime never holds the private key —
 * only this approve action reads it.
 */
async function cmdApprove(args: string[]): Promise<number> {
  const name = args.find((a) => !a.startsWith("-"));
  if (name === undefined) {
    process.stderr.write("Usage: skillfile approve <skill-name>\n");
    return 64;
  }
  const keyFile = process.env["SKILLSCRIPT_APPROVAL_KEY_FILE"] ?? defaultApprovalKeyFile();
  const pubFile = process.env["SKILLSCRIPT_APPROVAL_PUBLIC_KEY_FILE"] ?? defaultApprovalPublicKeyFile();
  if (!existsSync(keyFile)) {
    process.stderr.write(
      `skillfile approve: no approval private key at ${keyFile}.\n` +
      `Start the runtime once in secured mode to provision a keypair, or set SKILLSCRIPT_APPROVAL_KEY_FILE.\n`,
    );
    return 66;
  }
  const store = new FilesystemSkillStore(SKILLS_DIR);
  let loaded;
  try {
    loaded = await store.load(name);
  } catch {
    process.stderr.write(`skillfile approve: skill '${name}' not found in ${SKILLS_DIR}.\n`);
    return 66;
  }
  // Show the body for human review — running this command IS the human approval.
  process.stdout.write(`\n── reviewing '${name}' (signing approves it) ──\n${loaded.source}\n──────────────────────────────────────────────\n`);
  const priv = await readFile(keyFile, "utf8");
  // Arm secured mode + the public key so the store honors the v3 signature
  // (otherwise the unsecured path would v1-restamp it). Private key signs here;
  // the runtime never holds it.
  if (existsSync(pubFile)) setApprovalPublicKey(await readFile(pubFile, "utf8"));
  setSecuredMode(true);
  const signed = stampApprovalEd25519(loaded.source, priv);
  const info = await store.store(name, signed, { status: "Approved" });
  if (info.status === "Approved") {
    process.stdout.write(`✓ approved '${name}' — signed v3, version ${info.version}\n`);
    return 0;
  }
  process.stderr.write(
    `skillfile approve: '${name}' did not land Approved (status ${info.status}). ` +
    `The public key at ${pubFile} may not match the signing key.\n`,
  );
  return 1;
}

// v1.0 Gate #7 Phase 3 — force-re-approve migration (batch-assisted re-bless).
//
// Secured mode REJECTS pre-secured-mode approval tokens (v1 hash-stamps): they
// can't distinguish a human approval from an agent self-approval, so trusting
// them would launder illegitimate self-approvals. The default is therefore
// force-re-approve — existing Approved skills are NOT grandfathered; they must
// be re-signed with the operator's key. This command is the friction
// mitigation: instead of running `skillfile approve` N times, it sweeps the
// store, reports every Approved skill whose body fails the secured gate (the
// migration set), and — with `--apply` — re-signs the whole set in one pass.
//
// Dry-run by default: classification needs only the PUBLIC key (read-only).
// `--apply` additionally requires the private key (the operator's authorization).
async function cmdReapprove(args: string[]): Promise<number> {
  const apply = args.includes("--apply");
  const only = args.find((a) => !a.startsWith("-"));
  const keyFile = process.env["SKILLSCRIPT_APPROVAL_KEY_FILE"] ?? defaultApprovalKeyFile();
  const pubFile = process.env["SKILLSCRIPT_APPROVAL_PUBLIC_KEY_FILE"] ?? defaultApprovalPublicKeyFile();

  // Arm the public key + secured mode so the gate classifies bodies exactly as
  // the runtime would (v3 signature verified; v1/missing/tampered → fail).
  // Without arming, the unsecured gate would accept v1 stamps and the migration
  // set would come back empty — the silent-grandfather bug we must not ship.
  if (!existsSync(pubFile)) {
    process.stderr.write(
      `skillfile reapprove: no approval public key at ${pubFile}.\n` +
      `Start the runtime once in secured mode to provision a keypair, or set SKILLSCRIPT_APPROVAL_PUBLIC_KEY_FILE.\n`,
    );
    return 66;
  }
  setApprovalPublicKey(await readFile(pubFile, "utf8"));
  setSecuredMode(true);

  const store = new FilesystemSkillStore(SKILLS_DIR);
  const metas = await store.query();
  const approved = metas.filter((m) => m.status === "Approved" && (only === undefined || m.name === only));

  const needs: Array<{ name: string; reason: string; source: string }> = [];
  let alreadyValid = 0;
  for (const m of approved) {
    const loaded = await store.load(m.name);
    const gate = evaluateApprovalGate(loaded.source);
    if (gate.ok) { alreadyValid++; continue; }
    needs.push({ name: m.name, reason: gate.reason, source: loaded.source });
  }

  const scope = only ? `'${only}'` : `${approved.length} Approved skill${approved.length === 1 ? "" : "s"}`;
  if (needs.length === 0) {
    process.stdout.write(`✓ ${scope}: all carry a valid signature — nothing to migrate.\n`);
    return 0;
  }

  process.stdout.write(`\nMigration set — ${needs.length} Approved skill${needs.length === 1 ? "" : "s"} lack a valid signature (${alreadyValid} already valid):\n`);
  for (const item of needs) {
    process.stdout.write(`  • ${item.name}\n      ${item.reason}\n`);
  }

  if (!apply) {
    process.stdout.write(
      `\nDry run — nothing changed. Review each body (\`skillfile compile <name>\`) then re-bless:\n` +
      `  skillfile reapprove --apply${only ? ` ${only}` : ""}   # re-signs the set with your approval key\n` +
      `Or approve individually: skillfile approve <name>\n`,
    );
    return 0;
  }

  if (!existsSync(keyFile)) {
    process.stderr.write(
      `skillfile reapprove --apply: no approval private key at ${keyFile}.\n` +
      `Set SKILLSCRIPT_APPROVAL_KEY_FILE to the operator's private key, or run on the host that holds it.\n`,
    );
    return 66;
  }
  const priv = await readFile(keyFile, "utf8");
  let ok = 0;
  let fail = 0;
  for (const item of needs) {
    const signed = stampApprovalEd25519(item.source, priv);
    const info = await store.store(item.name, signed, { status: "Approved" });
    if (info.status === "Approved") {
      ok++;
      process.stdout.write(`  ✓ re-blessed '${item.name}' (v3, version ${info.version})\n`);
    } else {
      fail++;
      process.stderr.write(`  ✗ '${item.name}' did not land Approved (status ${info.status}) — public key may not match the signing key.\n`);
    }
  }
  process.stdout.write(`\nDone — ${ok} re-blessed${fail > 0 ? `, ${fail} failed` : ""}.\n`);
  return fail === 0 ? 0 : 1;
}

// v0.20.1 — secured-mode startup nudge. Scans the store for skills that are
// Approved but fail the gate (no/legacy/invalid signature) and warns once at
// boot, pointing at `skillfile reapprove`. Best-effort: never blocks startup.
async function warnStaleApprovals(skillStore: SkillStore): Promise<void> {
  if (!isSecuredMode()) return;
  try {
    const approved = await skillStore.query({ status: "Approved" });
    const stale: string[] = [];
    for (const m of approved) {
      const loaded = await skillStore.load(m.name);
      if (!evaluateApprovalGate(loaded.source).ok) stale.push(m.name);
    }
    if (stale.length === 0) return;
    const shown = stale.slice(0, 5).join(", ");
    const more = stale.length > 5 ? `, +${stale.length - 5} more` : "";
    process.stderr.write(
      `\n⚠  Secured mode: ${stale.length} stored skill${stale.length === 1 ? "" : "s"} ` +
      `${stale.length === 1 ? "is" : "are"} Approved but carry no valid signature — ` +
      `they will be REFUSED until re-approved.\n` +
      `   Re-bless the set:  skillfile reapprove --apply\n` +
      `   (${shown}${more})\n\n`,
    );
  } catch {
    /* best-effort — a scan failure must never block the runtime starting */
  }
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
interface ResolvedSkillSource {
  source: string;
  /** True when the ref resolved from the SkillStore (by-name), not a filesystem
   *  path. By-name dispatch is gated like the scheduler/MCP paths (refused
   *  outright when unapproved in secured mode); by-path is the ad-hoc escape. */
  fromStore: boolean;
}

async function loadSkillSourceResolved(ref: string): Promise<ResolvedSkillSource | null> {
  const candidates: Array<{ path: string; fromStore: boolean }> = [];
  if (isAbsolute(ref)) candidates.push({ path: ref, fromStore: false });
  else {
    candidates.push({ path: resolve(process.cwd(), ref), fromStore: false });
    if (ref.startsWith("examples/")) {
      candidates.push({ path: join(HOME_DIR, ref), fromStore: false });
    }
    if (!ref.includes("/") && !ref.endsWith(".skill") && !ref.endsWith(".skill.md")) {
      candidates.push({ path: join(SKILLS_DIR, `${ref}.skill.md`), fromStore: true });
    }
  }
  for (const c of candidates) {
    try {
      return { source: await readFile(c.path, "utf8"), fromStore: c.fromStore };
    } catch {
      /* try next */
    }
  }
  return null;
}

async function loadSkillSource(ref: string): Promise<string | null> {
  const r = await loadSkillSourceResolved(ref);
  return r === null ? null : r.source;
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
  // v0.17.4 — env-cascade for operator-config switches. Precedence:
  // CLI flag (most specific, per-invocation) > env var (per-process,
  // drop in `.env`) > JSON config (per-deployment) > built-in default.
  // This mirrors the standard layered-config pattern adopters expect
  // from any well-behaved Node service.
  const portStr = extractFlag(args, "--port") ?? process.env["SKILLSCRIPT_PORT"];
  const port = portStr !== undefined ? parseInt(portStr, 10) : fileConfig.dashboard?.port ?? 7878;
  // --host is the bind address inside the running process. 127.0.0.1 is
  // the safe default for local invocation; container deployments pass
  // --host 0.0.0.0 so the host-side port-forward can reach the listener
  // (host port mapping still enforces 127.0.0.1 externally).
  const host = extractFlag(args, "--host") ?? process.env["SKILLSCRIPT_HOST"] ?? fileConfig.dashboard?.host ?? "127.0.0.1";
  // v0.17.4 — env cascade for the v0.17.0 inbound caller-identity header.
  // Operator-config surface; env-natural for installer workflows.
  const mcpCallerIdentityHeader = process.env["SKILLSCRIPT_MCP_CALLER_IDENTITY_HEADER"] ?? fileConfig.dashboard?.mcpCallerIdentityHeader;
  // v0.17.4 — env cascade for the unsafe-shell posture switch.
  // Security-relevant; env-natural so operators can flip without
  // editing JSON.
  const envUnsafeShell = process.env["SKILLSCRIPT_ENABLE_UNSAFE_SHELL"];
  const enableUnsafeShell = envUnsafeShell !== undefined
    ? envUnsafeShell === "true"
    : fileConfig.enableUnsafeShell;
  const triggersFilePath = fileConfig.triggersFilePath ?? join(HOME_DIR, "triggers.json");
  // v0.4.3 — auto-discover connectors.json from HOME_DIR. Closes the
  // last-mile gap of the v0.4.x arc: pre-v0.4.3 the loader + lint +
  // runtime + allowlist all worked, but the canonical CLI entry point
  // didn't read connectors.json. --connectors <path> overrides the
  // default for non-standard layouts. Loader is graceful on missing.
  const connectorsConfigPath = extractFlag(args, "--connectors") ?? fileConfig.connectorsConfigPath ?? join(HOME_DIR, "connectors.json");
  // v0.17.4 — forceAlwaysDraft cascade: env var > config file > default
  // false. SKILLSCRIPT_FORCE_ALWAYS_DRAFT=true forces every outside-MCP
  // skill_write to land Draft regardless of body declaration. Closes
  // the agent-self-approval path for adopters wanting a human approval
  // gate. Drop a `.env` with the value, restart — done.
  const envForceAlwaysDraft = process.env["SKILLSCRIPT_FORCE_ALWAYS_DRAFT"];
  const forceAlwaysDraft = envForceAlwaysDraft !== undefined
    ? envForceAlwaysDraft === "true"
    : fileConfig.forceAlwaysDraft;
  // v0.18.7 — env cascade for three previously-hidden operator knobs.
  // Each follows the same cascade shape: env > config > default. Parsing
  // errors (non-numeric / non-positive) are silently ignored — the
  // config-layer schema parser is the authoritative validator for these
  // fields, and env values failing here fall through to config/default.
  const envPollSecondsRaw = process.env["SKILLSCRIPT_POLL_INTERVAL_SECONDS"];
  const envPollSeconds = envPollSecondsRaw !== undefined ? Number(envPollSecondsRaw) : undefined;
  const pollIntervalSeconds = envPollSeconds !== undefined && Number.isFinite(envPollSeconds) && envPollSeconds > 0
    ? envPollSeconds
    : fileConfig.pollIntervalSeconds;
  const envAbsoluteTimeoutRaw = process.env["SKILLSCRIPT_ABSOLUTE_TIMEOUT_MS"];
  const envAbsoluteTimeout = envAbsoluteTimeoutRaw !== undefined ? Number(envAbsoluteTimeoutRaw) : undefined;
  const absoluteTimeoutMs = envAbsoluteTimeout !== undefined && Number.isInteger(envAbsoluteTimeout) && envAbsoluteTimeout > 0
    ? envAbsoluteTimeout
    : fileConfig.absoluteTimeoutMs;
  const envMaxRecursionRaw = process.env["SKILLSCRIPT_MAX_RECURSION_DEPTH"];
  const envMaxRecursion = envMaxRecursionRaw !== undefined ? Number(envMaxRecursionRaw) : undefined;
  const maxRecursionDepth = envMaxRecursion !== undefined && Number.isInteger(envMaxRecursion) && envMaxRecursion >= 1
    ? envMaxRecursion
    : fileConfig.maxRecursionDepth;
  // v0.18.8 — shell binary allowlist. Comma-separated env value, trimmed.
  // Default-deny: when neither env nor config is set, leave undefined →
  // runtime refuses ALL shell() ops. Empty env string is an explicit
  // empty list (also refuses all) — distinct from undefined for
  // observability (operator can declare "no shell at all" intentionally).
  const envShellAllowlistRaw = process.env["SKILLSCRIPT_SHELL_ALLOWLIST"];
  const shellAllowlist = envShellAllowlistRaw !== undefined
    ? envShellAllowlistRaw.split(",").map((b) => b.trim()).filter((b) => b.length > 0)
    : fileConfig.shellAllowlist;
  // v1.0 Gate #7 — filesystem path allowlist (env > config.json), same shape as
  // SKILLSCRIPT_SHELL_ALLOWLIST. Default-deny when unset.
  const envFsAllowlistRaw = process.env["SKILLSCRIPT_FS_ALLOWLIST"];
  const fsAllowlist = envFsAllowlistRaw !== undefined
    ? envFsAllowlistRaw.split(",").map((p) => p.trim()).filter((p) => p.length > 0)
    : fileConfig.fsAllowlist;
  // v0.19.0 — event ingress (memory `ceaf4579`). Two env knobs:
  //   - SKILLSCRIPT_EVENT_INGRESS_ENABLED=true  (opt-in; default off)
  //   - SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN=… (optional bearer-token;
  //     when set, every POST /event requires Authorization: Bearer <token>)
  const envEventIngressEnabled = process.env["SKILLSCRIPT_EVENT_INGRESS_ENABLED"];
  const eventIngressEnabled = envEventIngressEnabled !== undefined
    ? envEventIngressEnabled === "true"
    : false;
  const eventIngressAuthToken = process.env["SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN"];
  const wired = bootstrap({
    skillsDir: fileConfig.skillsDir ?? SKILLS_DIR,
    traceDir: fileConfig.traceDir ?? TRACE_DIR,
    dataDbPath: fileConfig.dataDbPath ?? DATA_DB,
    triggersFilePath,
    connectorsConfigPath,
    mode: opts.mode,
    ...(pollIntervalSeconds !== undefined ? { pollIntervalSeconds } : {}),
    ...(absoluteTimeoutMs !== undefined ? { absoluteTimeoutMs } : {}),
    ...(maxRecursionDepth !== undefined ? { maxRecursionDepth } : {}),
    ...(shellAllowlist !== undefined ? { shellAllowlist } : {}),
    ...(fsAllowlist !== undefined ? { fsAllowlist } : {}),
    ...(enableUnsafeShell !== undefined ? { enableUnsafeShell } : {}),
    ...(forceAlwaysDraft === true ? { forceAlwaysDraft: true } : {}),
    // Scheduler-fired skills record traces by default; `fires` / `health` /
    // `health_metrics` (MCP) all read from the trace store.
    trace: { mode: "on" },
  });
  // Register declarative `# Triggers:` headers BEFORE arming the tick loop
  // so the first tick can fire any minute-aligned cron entries.
  await wireDeclarativeTriggers(wired);
  // v0.20.1 — when secured mode is armed, loudly flag any stored skill that's
  // Approved-but-unsigned (e.g. a pre-secured v1 corpus) so the operator runs
  // `reapprove` instead of discovering refusals skill-by-skill at runtime.
  await warnStaleApprovals(wired.skillStore);
  wired.scheduler.start();
  // v0.2.7: dashboard mounts the SPA; serve runs headless on /rpc only.
  const server = new DashboardServer({
    mcpServer: wired.mcpServer,
    port,
    bindAddress: host,
    mountSpa: opts.mode === "dashboard",
    ...(mcpCallerIdentityHeader !== undefined ? { mcpCallerIdentityHeader } : {}),
    // v0.19.0 — event ingress, off-by-default, scheduler reference required
    eventIngressEnabled,
    ...(eventIngressAuthToken !== undefined ? { eventIngressAuthToken } : {}),
    ...(eventIngressEnabled ? { scheduler: wired.scheduler } : {}),
    // v0.20.2 — in-browser approval (passcode session-unlock). Mounts /unlock +
    // /approve only when SKILLSCRIPT_APPROVAL_PASSCODE is set + secured + keyed.
    skillStore: wired.skillStore,
    approvalKeyFile: process.env["SKILLSCRIPT_APPROVAL_KEY_FILE"] ?? defaultApprovalKeyFile(),
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
