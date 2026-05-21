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

import { compile } from "./compile.js";
import { execute } from "./runtime.js";
import { lint, formatLintResult } from "./lint.js";
import { audit, formatAuditResult } from "./audit.js";
import type { ProvenanceBlock } from "./provenance.js";
import { renderSidecarProvenance } from "./provenance.js";
import { Registry } from "./connectors/registry.js";
import { FilesystemSkillStore } from "./connectors/skill-store.js";
import { OllamaLocalModel } from "./connectors/local-model.js";
import { SqliteMemoryStore } from "./connectors/memory-store.js";
import { parse, type SkillOp } from "./parser.js";
import { FilesystemTraceStore } from "./trace.js";
import { healthMetrics } from "./metrics.js";
import { McpServer } from "./mcp-server.js";
import { DashboardServer } from "./dashboard/server.js";
import { Scheduler } from "./scheduler.js";
import { createHash } from "node:crypto";

const HOME_DIR = process.env["SKILLSCRIPT_HOME"] ?? join(homedir(), ".skillscript");
const SKILLS_DIR = join(HOME_DIR, "skills");
const MEMORY_DB = join(HOME_DIR, "memory.db");
const EXAMPLES_DIR = join(HOME_DIR, "examples");
const PLUGINS_DIR = join(HOME_DIR, "plugins");
const TRACE_DIR = join(HOME_DIR, "traces");

const VERSION = "0.1.0-dev";

function usage(): string {
  return `skillfile v${VERSION} — Skillscript runtime + compiler CLI

Usage:
  skillfile init                        Scaffold ~/.skillscript/ tree + bundled example
  skillfile run <path|name> [opts]      Compile + execute a skill end-to-end
  skillfile compile <path|name> [opts]  Render the compiled artifact (no execution)
  skillfile audit <provenance-path>     Detect recompile-staleness via .provenance.json sidecar
  skillfile lint <path|name>            Run static validation, print findings
  skillfile list [--status STATUS]      List available skills in the configured SkillStore
  skillfile fires <skill> [opts]        List recent trace records for a skill
  skillfile diagram <skill>             Emit mermaid graph of the skill's control flow
  skillfile sign <skill>                Content-hash sign the skill source
  skillfile verify <skill> <hash>       Verify the skill matches a signature
  skillfile replay <trace_id> [opts]    Re-run a recorded trace
  skillfile health [opts]               Aggregate metrics across all traces
  skillfile dashboard [--port N]        Start the browser dashboard (localhost-only)
  skillfile register-trigger <skill> --source <kind> --name <expr>
                                        Register a trigger (CLI-only for safety)
  skillfile unregister-trigger <id>     Unregister a trigger by id
  skillfile list-triggers [--skill X] [--source Y]
                                        List registered triggers

Run/compile options:
  --input KEY=value (repeatable)        Provide a value for a declared input
  --format prompt|prose                 Render format (default: prompt)
  --mechanical                          Preview mode — \`$\`/\`~\`/\`>\` ops don't dispatch (run only)
  --inline-provenance                   Embed provenance block in artifact (compile only; default: sidecar)
  --sidecar <path>                      Write provenance to this path (compile only; default: <output>.provenance.json)

Fires options:
  --limit N                             Cap results (default: 20)
  --human                               Pretty-print summary instead of JSON

Replay options:
  --connectors current                  Re-run against today's wired connectors (default; debug)

Health options:
  --skill X                             Restrict to one skill
  --connector Y                         Restrict to one connector
  --since-ms N                          Window start (default: 24h ago)
  --human                               Pretty-print instead of JSON

Audit options:
  --json                                Emit structured JSON instead of pretty-printed text

Examples:
  skillfile init
  skillfile run examples/hello.skill.md
  skillfile run hello --input WHO=Scott
  skillfile compile examples/hello.skill.md --format prose
  skillfile audit support-response.provenance.json

Config:
  SKILLSCRIPT_HOME    Override config root (default ~/.skillscript)
  OLLAMA_BASE_URL     Override Ollama endpoint (default http://localhost:11434)
`;
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

  switch (cmd) {
    case "init":    return await cmdInit();
    case "run":     return await cmdRun(rest);
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
    case "dashboard":           return await cmdDashboard(rest);
    case "register-trigger":    return await cmdRegisterTrigger(rest);
    case "unregister-trigger":  return await cmdUnregisterTrigger(rest);
    case "list-triggers":       return await cmdListTriggers(rest);
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
  await copyScaffoldFile(join(scaffoldRoot, "examples", "hello.skill.md"), join(EXAMPLES_DIR, "hello.skill.md"));
  await copyScaffoldFile(join(scaffoldRoot, "connectors.json"), join(HOME_DIR, "connectors.json"));

  process.stdout.write(`Initialized ${HOME_DIR}
  skills/       ${SKILLS_DIR}
  examples/     ${EXAMPLES_DIR}
  plugins/      ${PLUGINS_DIR}
  config.toml   ${join(HOME_DIR, "config.toml")}
  connectors.json ${join(HOME_DIR, "connectors.json")}

Next:
  skillfile run examples/hello.skill.md
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
    classes: [FilesystemSkillStore, SqliteMemoryStore, OllamaLocalModel],
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
  const registry = new Registry();
  registry.registerSkillStore("primary", new FilesystemSkillStore(SKILLS_DIR));
  if (existsSync(MEMORY_DB) || existsSync(dirname(MEMORY_DB))) {
    registry.registerMemoryStore("primary", new SqliteMemoryStore({ dbPath: MEMORY_DB }));
  }
  const ollamaUrl = process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
  registry.registerLocalModel("default", new OllamaLocalModel({ baseUrl: ollamaUrl, defaultModelTag: "gemma2:9b" }));
  registry.registerLocalModel("gemma2", new OllamaLocalModel({ baseUrl: ollamaUrl, defaultModelTag: "gemma2:9b" }));
  registry.registerLocalModel("qwen", new OllamaLocalModel({ baseUrl: ollamaUrl, defaultModelTag: "qwen2.5:7b" }));
  return registry;
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

async function cmdRegisterTrigger(args: string[]): Promise<number> {
  const skill = args.find((a) => !a.startsWith("--"));
  const source = extractFlag(args, "--source");
  const name = extractFlag(args, "--name");
  const expiresAtStr = extractFlag(args, "--expires-at");
  if (skill === undefined || source === undefined || name === undefined) {
    process.stderr.write(`Usage: skillfile register-trigger <skill> --source <cron|session|event|agent-event|file-watch|sensor> --name <expr> [--expires-at <unix-seconds>]\n`);
    return 64;
  }
  const allowedSources = ["cron", "session", "event", "agent-event", "file-watch", "sensor"];
  if (!allowedSources.includes(source)) {
    process.stderr.write(`--source must be one of: ${allowedSources.join(", ")} (got '${source}')\n`);
    return 64;
  }
  const skillStore = new FilesystemSkillStore(SKILLS_DIR);
  const traceStore = new FilesystemTraceStore(TRACE_DIR);
  const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
  const reg = scheduler.registerTrigger({
    skillName: skill,
    source: source as Parameters<typeof scheduler.registerTrigger>[0]["source"],
    name,
    declarative: false,
    ...(expiresAtStr !== undefined ? { expiresAt: parseInt(expiresAtStr, 10) } : {}),
  });
  // NOTE: registration is in-memory on the Scheduler instance, which dies
  // when this command exits. For persistent registration across runs,
  // operators run `skillfile dashboard` (long-lived) or wire their own
  // Scheduler with persistent storage. v1.x candidate: persistent trigger
  // registry on disk so CLI register-trigger survives process exit.
  process.stdout.write(JSON.stringify(reg, null, 2) + "\n");
  process.stderr.write(`\nnote: trigger lives in-memory; restart with \`skillfile dashboard\` to persist across the session.\n`);
  return 0;
}

async function cmdUnregisterTrigger(args: string[]): Promise<number> {
  const id = args[0];
  if (id === undefined) {
    process.stderr.write("Usage: skillfile unregister-trigger <trigger_id>\n");
    return 64;
  }
  const skillStore = new FilesystemSkillStore(SKILLS_DIR);
  const traceStore = new FilesystemTraceStore(TRACE_DIR);
  const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
  const removed = scheduler.unregisterTrigger(id);
  process.stdout.write(JSON.stringify({ trigger_id: id, removed }, null, 2) + "\n");
  return removed ? 0 : 1;
}

async function cmdListTriggers(args: string[]): Promise<number> {
  const skill = extractFlag(args, "--skill");
  const source = extractFlag(args, "--source");
  const skillStore = new FilesystemSkillStore(SKILLS_DIR);
  const traceStore = new FilesystemTraceStore(TRACE_DIR);
  const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
  const filter: { skillName?: string; source?: Parameters<typeof scheduler.listTriggers>[0] extends infer F ? F extends { source?: infer S } ? S : never : never } = {};
  if (skill !== undefined) filter.skillName = skill;
  if (source !== undefined) {
    filter.source = source as NonNullable<typeof filter.source>;
  }
  const triggers = scheduler.listTriggers(filter);
  process.stdout.write(JSON.stringify(triggers, null, 2) + "\n");
  return 0;
}

async function cmdDashboard(args: string[]): Promise<number> {
  const portStr = extractFlag(args, "--port");
  const port = portStr !== undefined ? parseInt(portStr, 10) : 7878;
  const skillStore = new FilesystemSkillStore(SKILLS_DIR);
  const traceStore = new FilesystemTraceStore(TRACE_DIR);
  const scheduler = new Scheduler({ registry: new Registry(), skillStore, traceStore });
  const mcpServer = new McpServer({ skillStore, scheduler, traceStore });
  const server = new DashboardServer({ mcpServer, port });
  await server.start();
  process.stdout.write(`dashboard running on http://127.0.0.1:${port}\nctrl-C to stop\n`);
  // Hold open until SIGINT/SIGTERM.
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => { void server.stop().then(resolve); });
    process.on("SIGTERM", () => { void server.stop().then(resolve); });
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
