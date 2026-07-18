// v0.23.x — `bootstrapFromEnv()`: one blessed entry point that wires a runtime
// + DashboardServer exactly the way the `skillfile dashboard` / `skillfile
// serve` CLI does — loading `$SKILLSCRIPT_HOME/.env`, `skillscript.config.json`,
// and `connectors.json`, resolving the full SKILLSCRIPT_* env cascade, then
// bootstrap()ing and assembling the DashboardServer.
//
// Most adopters run the CLI once for `init`, then operate via the web
// dashboard. This helper is the programmatic equivalent: an adopter calls it,
// gets a fully-wired runtime + server, and swaps only the substrates they
// customize — closing the silent CLI-vs-programmatic wiring asymmetry where
// each capability the CLI auto-wires had to be hand-assembled (and each
// omission failed silently). Adopter wishlist 82e17077.

import { homedir } from "node:os";
import { join } from "node:path";
import { bootstrap, wireDeclarativeTriggers, type BootstrapResult, type BootstrapOpts } from "./bootstrap.js";
import { DashboardServer } from "./dashboard/server.js";
import { loadSkillscriptConfig } from "./runtime-config.js";
import { loadEnvFile } from "./dotenv-loader.js";
import { isSecuredMode, evaluateApprovalGate } from "./approval.js";
import type { SkillStore } from "./connectors/types.js";

export interface BootstrapFromEnvOptions {
  /** "dashboard" mounts the SPA at `/`; "serve" runs headless on `/rpc`. Default "dashboard". */
  mode?: "serve" | "dashboard";
  /** Config root. Default `$SKILLSCRIPT_HOME` ?? `~/.skillscript`. */
  home?: string;
  /** Override the skillscript.config.json path (default `<home>/skillscript.config.json`). */
  configPath?: string;
  /** Override the connectors.json path (default `<home>/connectors.json`). */
  connectorsConfigPath?: string;
  /** Override the HTTP port (else env `SKILLSCRIPT_PORT` / config / 7878). */
  port?: number;
  /** Override the bind address (else env `SKILLSCRIPT_HOST` / config / 127.0.0.1). */
  host?: string;
  /**
   * Pass-through to `bootstrap()`, merged LAST so it wins over the env/config
   * resolution. This is how you inject CUSTOM in-process substrate instances —
   * `overrides: { skillStore: new MyRemoteSkillStore(...) }` — while letting
   * everything else auto-wire from `$SKILLSCRIPT_HOME`. (A custom substrate that
   * IS expressible declaratively can instead use the `connectors.json`
   * `{ type: "custom", module, export }` form and skip this.)
   */
  overrides?: Partial<BootstrapOpts>;
}

export interface BootstrapFromEnvResult {
  /** The wired runtime (registry, mcpServer, scheduler, skillStore, traceStore). */
  wired: BootstrapResult;
  /** The assembled DashboardServer — NOT started. Call `server.start()` + `wired.scheduler.start()`. */
  server: DashboardServer;
}

/**
 * Wire a runtime + DashboardServer from the environment, exactly as the CLI
 * `dashboard` / `serve` commands do. Returns both UNSTARTED — the caller decides
 * when to `scheduler.start()` + `server.start()` (and is responsible for
 * `wired.registry.disposeAll()` on shutdown to reap connector children).
 *
 * Resolution precedence per knob: explicit option > `SKILLSCRIPT_*` env >
 * `skillscript.config.json` > built-in default. Secured mode + approval keys +
 * the shell/fs allowlists + timeouts are resolved inside `bootstrap()`; the
 * dashboard auth token / approval passcode / caller-identity header are resolved
 * inside `DashboardServer`. This helper layers the config-file values + home
 * paths on top.
 */
export async function bootstrapFromEnv(opts: BootstrapFromEnvOptions = {}): Promise<BootstrapFromEnvResult> {
  const home = opts.home ?? process.env["SKILLSCRIPT_HOME"] ?? join(homedir(), ".skillscript");
  // Load `<home>/.env` so SKILLSCRIPT_* vars are populated — the CLI does this
  // at startup; a programmatic adopter would otherwise miss it. Missing file is
  // a no-op (per dotenv-loader).
  loadEnvFile({ path: join(home, ".env") });

  const mode = opts.mode ?? "dashboard";
  const configPath = opts.configPath ?? join(home, "skillscript.config.json");
  const { config: fileConfig } = loadSkillscriptConfig({ path: configPath });

  const triggersFilePath = fileConfig.triggersFilePath ?? join(home, "triggers.json");
  const connectorsConfigPath = opts.connectorsConfigPath ?? fileConfig.connectorsConfigPath ?? join(home, "connectors.json");

  // env ?? config per knob, so `bootstrap()`'s own env resolution (opts win over
  // env there) preserves the env > config > default precedence the CLI uses.
  const enableUnsafeShell = boolEnv(process.env["SKILLSCRIPT_ENABLE_UNSAFE_SHELL"]) ?? fileConfig.enableUnsafeShell;
  const forceAlwaysDraft = boolEnv(process.env["SKILLSCRIPT_FORCE_ALWAYS_DRAFT"]) ?? fileConfig.forceAlwaysDraft;
  const pollIntervalSeconds = posIntEnv(process.env["SKILLSCRIPT_POLL_INTERVAL_SECONDS"]) ?? fileConfig.pollIntervalSeconds;
  const absoluteTimeoutMs = posIntEnv(process.env["SKILLSCRIPT_ABSOLUTE_TIMEOUT_MS"]) ?? fileConfig.absoluteTimeoutMs;
  const maxDeadlineSeconds = posIntEnv(process.env["SKILLSCRIPT_MAX_DEADLINE_SECONDS"]) ?? fileConfig.maxDeadlineSeconds;
  const supervisorAgent = strEnv(process.env["SKILLSCRIPT_SUPERVISOR_AGENT"]) ?? fileConfig.supervisorAgent;
  const supervisorSkill = strEnv(process.env["SKILLSCRIPT_SUPERVISOR_SKILL"]) ?? fileConfig.supervisorSkill;
  const maxRecursionDepth = posIntEnv(process.env["SKILLSCRIPT_MAX_RECURSION_DEPTH"], 1) ?? fileConfig.maxRecursionDepth;
  const shellAllowlist = listEnv(process.env["SKILLSCRIPT_SHELL_ALLOWLIST"]) ?? fileConfig.shellAllowlist;
  const fsAllowlist = listEnv(process.env["SKILLSCRIPT_FS_ALLOWLIST"]) ?? fileConfig.fsAllowlist;

  const wired = bootstrap({
    skillsDir: fileConfig.skillsDir ?? join(home, "skills"),
    traceDir: fileConfig.traceDir ?? join(home, "traces"),
    dataDbPath: fileConfig.dataDbPath ?? join(home, "data.db"),
    triggersFilePath,
    connectorsConfigPath,
    mode,
    ...(pollIntervalSeconds !== undefined ? { pollIntervalSeconds } : {}),
    ...(absoluteTimeoutMs !== undefined ? { absoluteTimeoutMs } : {}),
    ...(maxDeadlineSeconds !== undefined ? { maxDeadlineSeconds } : {}),
    ...(supervisorAgent !== undefined ? { supervisorAgent } : {}),
    ...(supervisorSkill !== undefined ? { supervisorSkill } : {}),
    ...(maxRecursionDepth !== undefined ? { maxRecursionDepth } : {}),
    ...(shellAllowlist !== undefined ? { shellAllowlist } : {}),
    ...(fsAllowlist !== undefined ? { fsAllowlist } : {}),
    ...(enableUnsafeShell !== undefined ? { enableUnsafeShell } : {}),
    ...(forceAlwaysDraft === true ? { forceAlwaysDraft: true } : {}),
    // Scheduler-fired skills record traces by default.
    trace: { mode: "on" },
    // Adopter overrides win last — notably custom substrate INSTANCES
    // (e.g. overrides.skillStore = new MyRemoteSkillStore(...)).
    ...opts.overrides,
  });
  await wireDeclarativeTriggers(wired);
  await warnStaleApprovals(wired.skillStore);

  const server = new DashboardServer({
    mcpServer: wired.mcpServer,
    mountSpa: mode === "dashboard",
    // Scheduler is passed unconditionally: the /event route gates on its own
    // enable flag, but the dashboard /approve route needs the scheduler to
    // re-register a skill's declarative triggers on approval.
    scheduler: wired.scheduler,
    skillStore: wired.skillStore,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.host !== undefined ? { bindAddress: opts.host } : {}),
    // port / host / mcpCallerIdentityHeader / eventIngress* / dashboard auth
    // token / approval passcode / approval key file are all resolved from env by
    // DashboardServer itself.
  });

  return { wired, server };
}

/** Warn (best-effort) when secured mode is on and stored Approved skills lack a valid signature. */
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

// ─── env coercion helpers (mirror the CLI's cascade semantics) ───────────────

function boolEnv(raw: string | undefined): boolean | undefined {
  return raw !== undefined ? raw === "true" : undefined;
}
function posIntEnv(raw: string | undefined, min = 0): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= (min || 1) ? n : undefined;
}
function listEnv(raw: string | undefined): string[] | undefined {
  return raw !== undefined ? raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : undefined;
}
function strEnv(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}
