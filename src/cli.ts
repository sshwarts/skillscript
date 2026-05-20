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
import { lint } from "./lint.js";
import { Registry } from "./connectors/registry.js";
import { FilesystemSkillStore } from "./connectors/skill-store.js";
import { OllamaLocalModel } from "./connectors/local-model.js";
import { SqliteMemoryStore } from "./connectors/memory-store.js";

const HOME_DIR = process.env["SKILLSCRIPT_HOME"] ?? join(homedir(), ".skillscript");
const SKILLS_DIR = join(HOME_DIR, "skills");
const MEMORY_DB = join(HOME_DIR, "memory.db");
const EXAMPLES_DIR = join(HOME_DIR, "examples");
const PLUGINS_DIR = join(HOME_DIR, "plugins");

const VERSION = "0.1.0-dev";

function usage(): string {
  return `skillfile v${VERSION} — Skillscript runtime + compiler CLI

Usage:
  skillfile init                        Scaffold ~/.skillscript/ tree + bundled example
  skillfile run <path|name> [opts]      Compile + execute a skill end-to-end
  skillfile compile <path|name> [opts]  Render the compiled artifact (no execution)
  skillfile lint <path|name>            Run static validation, print findings
  skillfile list [--status STATUS]      List available skills in the configured SkillStore

Run/compile options:
  --input KEY=value (repeatable)        Provide a value for a declared input
  --format prompt|prose                 Render format (default: prompt)
  --mechanical                          Preview mode — \`$\`/\`~\`/\`>\` ops don't dispatch (run only)

Examples:
  skillfile init
  skillfile run examples/hello.skill
  skillfile run hello --input WHO=Scott
  skillfile compile examples/hello.skill --format prose

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
    case "lint":    return await cmdLint(rest);
    case "list":    return await cmdList(rest);
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
  await copyScaffoldFile(join(scaffoldRoot, "examples", "hello.skill"), join(EXAMPLES_DIR, "hello.skill"));
  await copyScaffoldFile(join(scaffoldRoot, "connectors.json"), join(HOME_DIR, "connectors.json"));

  process.stdout.write(`Initialized ${HOME_DIR}
  skills/       ${SKILLS_DIR}
  examples/     ${EXAMPLES_DIR}
  plugins/      ${PLUGINS_DIR}
  config.toml   ${join(HOME_DIR, "config.toml")}
  connectors.json ${join(HOME_DIR, "connectors.json")}

Next:
  skillfile run examples/hello.skill
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
    });
    const result = await execute(compiled.parsed, compiled.resolvedVariables, compiled.targetOrder, {
      registry,
      ...(opts.mechanical ? { mechanical: true } : {}),
    });
    for (const line of result.emissions) {
      process.stdout.write(`${line}\n`);
    }
    if (result.errors.length > 0) {
      process.stderr.write(`\n${result.errors.length} error(s):\n`);
      for (const e of result.errors) {
        process.stderr.write(`  [${e.target}/${e.opKind}] ${e.message}\n`);
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
    });
    process.stdout.write(`${compiled.output}\n`);
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
  const result = lint(source);
  if (result.findings.length === 0) {
    process.stdout.write("OK: no findings.\n");
    return 0;
  }
  for (const f of result.findings) {
    const where = f.block ? ` (target: ${f.block})` : "";
    process.stdout.write(`[${f.severity}] ${f.rule}${where}: ${f.message}\n`);
  }
  process.stdout.write(`\n${result.errorCount} error(s), ${result.warningCount} warning(s).\n`);
  return result.errorCount > 0 ? 1 : 0;
}

async function cmdList(args: string[]): Promise<number> {
  const statusFilter = extractFlag(args, "--status");
  const store = new FilesystemSkillStore(SKILLS_DIR);
  const metas = await store.query(
    statusFilter !== undefined ? { status: statusFilter as "draft" | "approved" | "disabled" } : undefined,
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
  error?: string;
}

function parseRunCompileArgs(args: string[]): RunCompileOpts {
  const opts: RunCompileOpts = { inputs: {}, format: "prompt", mechanical: false };
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
    } else if (a.startsWith("--")) {
      return { ...opts, error: `unknown flag '${a}'` };
    } else if (opts.skillRef === undefined) {
      opts.skillRef = a;
    } else {
      return { ...opts, error: `unexpected positional argument '${a}'` };
    }
  }
  if (opts.skillRef === undefined) return { ...opts, error: "missing skill path or name" };
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
 *   2. Otherwise, treat it as a name and look up `<SKILLS_DIR>/<name>.skill`.
 *   3. If neither hits, return null.
 *
 * `examples/<name>.skill` paths are resolved against either the working
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
    if (!ref.includes("/") && !ref.endsWith(".skill")) {
      candidates.push(join(SKILLS_DIR, `${ref}.skill`));
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

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`skillfile: unexpected error: ${err.message}\n`);
  process.exit(2);
});
