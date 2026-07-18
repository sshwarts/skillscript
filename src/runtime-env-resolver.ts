/**
 * v0.19.1 — shared resolver for ALL operator-controllable runtime knobs
 * exposed as `SKILLSCRIPT_*` env vars. Closes the systemic issue surfaced
 * by adopter CR `f2549ddf` + follow-up `aeccddac`: pre-v0.19.1 each
 * env→option translation lived inside the CLI cascade, so programmatic
 * adopters using `bootstrap()` / `DashboardServer` directly hit silent
 * default-off behavior on every SKILLSCRIPT_* knob. Two releases in a
 * row reproduced the same bug (v0.18.8 shell allowlist patched
 * feature-specifically in v0.18.9, then v0.19.0 added two new env vars
 * with the same gap).
 *
 * Architecture: one centralized resolver, called by:
 *   - CLI cascade (cli.ts) to fill unset CLI options
 *   - `bootstrap()` to fill unset `BootstrapOpts` fields
 *   - `DashboardServer` constructor to fill unset config fields
 * New SKILLSCRIPT_* knobs added to the resolver inherit env support on
 * ALL paths automatically — no per-feature CLI patches required.
 *
 * Perry's explicit-wins guard (from memory `42de3d72` v0.18.9):
 *   - opts.X === undefined → env fallback applies
 *   - opts.X === any defined value (incl. false / [] / 0) → authoritative
 * Adopters who explicitly pass `shellAllowlist: []` or
 * `eventIngressEnabled: false` to assert deny-all / off-posture get
 * exactly that, regardless of ambient env. The resolver returns a
 * partial config; consumers MUST `??`-merge per field, not bulk-spread.
 *
 * `.env` auto-loading remains CLI-only by design (adopter recommendation
 * from `8f2d8931`). Programmatic adopters either `process.loadEnvFile()`
 * themselves or set env in their launch environment before calling
 * `bootstrap()` / `new DashboardServer()`.
 */

export interface RuntimeEnvConfig {
  // Network / bind
  port?: number;
  host?: string;
  // Identity
  mcpCallerIdentityHeader?: string;
  // Posture switches
  enableUnsafeShell?: boolean;
  forceAlwaysDraft?: boolean;
  // Runtime tuning
  pollIntervalSeconds?: number;
  absoluteTimeoutMs?: number;
  /** Operator run-deadline ceiling in SECONDS (SKILLSCRIPT_MAX_DEADLINE_SECONDS). */
  maxDeadlineSeconds?: number;
  maxRecursionDepth?: number;
  // Autonomous-fire failure supervision (SKILLSCRIPT_SUPERVISOR_*). Both unset =
  // feature off. When set, the scheduler's trace-sweeper routes non-clean fires
  // to the supervisor's handler skill. Config source-of-truth (a safety control,
  // not a dashboard toggle): must be present at boot, before the first fire.
  /** Agent id the supervisor handler skill runs as / reports to (SKILLSCRIPT_SUPERVISOR_AGENT). */
  supervisorAgent?: string;
  /** Name of the approved handler skill the sweeper routes failures to (SKILLSCRIPT_SUPERVISOR_SKILL). */
  supervisorSkill?: string;
  // Shell allowlist
  shellAllowlist?: string[];
  // Filesystem path allowlist (file_read/file_write)
  fsAllowlist?: string[];
  // Event ingress
  eventIngressEnabled?: boolean;
  eventIngressAuthToken?: string;
  // Gate #7 approval boundary
  securedMode?: boolean;
  approvalKeyFile?: string;
  approvalPublicKeyFile?: string;
}

/**
 * Read all `SKILLSCRIPT_*` env vars from the supplied env (defaults to
 * `process.env`) and return a typed partial config. Invalid values
 * (non-numeric for numeric fields, etc.) silently fall through —
 * consistent with the pre-v0.19.1 CLI cascade behavior. The
 * `skillscript.config.json` schema parser is the authoritative
 * validator for these fields; env values failing this resolver's
 * lightweight parse are treated as unset.
 */
export function resolveRuntimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEnvConfig {
  const config: RuntimeEnvConfig = {};

  // SKILLSCRIPT_PORT — positive integer
  const portRaw = env["SKILLSCRIPT_PORT"];
  if (portRaw !== undefined) {
    const n = Number(portRaw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) config.port = n;
  }

  // SKILLSCRIPT_HOST — bind address
  const hostRaw = env["SKILLSCRIPT_HOST"];
  if (typeof hostRaw === "string" && hostRaw !== "") config.host = hostRaw;

  // SKILLSCRIPT_MCP_CALLER_IDENTITY_HEADER — string
  const headerRaw = env["SKILLSCRIPT_MCP_CALLER_IDENTITY_HEADER"];
  if (typeof headerRaw === "string" && headerRaw !== "") config.mcpCallerIdentityHeader = headerRaw;

  // SKILLSCRIPT_ENABLE_UNSAFE_SHELL — boolean ("true"/"false")
  const unsafeRaw = env["SKILLSCRIPT_ENABLE_UNSAFE_SHELL"];
  if (unsafeRaw === "true") config.enableUnsafeShell = true;
  else if (unsafeRaw === "false") config.enableUnsafeShell = false;

  // SKILLSCRIPT_FORCE_ALWAYS_DRAFT — boolean
  const forceDraftRaw = env["SKILLSCRIPT_FORCE_ALWAYS_DRAFT"];
  if (forceDraftRaw === "true") config.forceAlwaysDraft = true;
  else if (forceDraftRaw === "false") config.forceAlwaysDraft = false;

  // SKILLSCRIPT_POLL_INTERVAL_SECONDS — positive number
  const pollRaw = env["SKILLSCRIPT_POLL_INTERVAL_SECONDS"];
  if (pollRaw !== undefined) {
    const n = Number(pollRaw);
    if (Number.isFinite(n) && n > 0) config.pollIntervalSeconds = n;
  }

  // SKILLSCRIPT_ABSOLUTE_TIMEOUT_MS — positive integer
  const timeoutRaw = env["SKILLSCRIPT_ABSOLUTE_TIMEOUT_MS"];
  if (timeoutRaw !== undefined) {
    const n = Number(timeoutRaw);
    if (Number.isInteger(n) && n > 0) config.absoluteTimeoutMs = n;
  }

  // SKILLSCRIPT_MAX_DEADLINE_SECONDS — positive integer (operator run-deadline
  // ceiling; bounds every run even one with no # Deadline). Stored as seconds.
  const maxDeadlineRaw = env["SKILLSCRIPT_MAX_DEADLINE_SECONDS"];
  if (maxDeadlineRaw !== undefined) {
    const n = Number(maxDeadlineRaw);
    if (Number.isInteger(n) && n > 0) config.maxDeadlineSeconds = n;
  }

  // SKILLSCRIPT_SUPERVISOR_AGENT / SKILLSCRIPT_SUPERVISOR_SKILL — non-empty
  // strings. Wire the autonomous-fire failure supervisor (agent + handler skill).
  const supervisorAgentRaw = env["SKILLSCRIPT_SUPERVISOR_AGENT"];
  if (supervisorAgentRaw !== undefined && supervisorAgentRaw.trim() !== "") {
    config.supervisorAgent = supervisorAgentRaw.trim();
  }
  const supervisorSkillRaw = env["SKILLSCRIPT_SUPERVISOR_SKILL"];
  if (supervisorSkillRaw !== undefined && supervisorSkillRaw.trim() !== "") {
    config.supervisorSkill = supervisorSkillRaw.trim();
  }

  // SKILLSCRIPT_MAX_RECURSION_DEPTH — positive integer >= 1
  const recurseRaw = env["SKILLSCRIPT_MAX_RECURSION_DEPTH"];
  if (recurseRaw !== undefined) {
    const n = Number(recurseRaw);
    if (Number.isInteger(n) && n >= 1) config.maxRecursionDepth = n;
  }

  // SKILLSCRIPT_SHELL_ALLOWLIST — comma-separated string list
  // (explicit empty string → empty list — operator explicitly declared
  // no shell binaries; same observable behavior as undefined, but
  // intent differs for operator-side audit).
  const allowlistRaw = env["SKILLSCRIPT_SHELL_ALLOWLIST"];
  if (allowlistRaw !== undefined) {
    config.shellAllowlist = allowlistRaw
      .split(",")
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
  }

  // SKILLSCRIPT_FS_ALLOWLIST — comma-separated filesystem roots that file_read /
  // file_write may touch (Gate #7 third allowlist). Same parse + default-deny
  // semantics as the shell allowlist.
  const fsAllowlistRaw = env["SKILLSCRIPT_FS_ALLOWLIST"];
  if (fsAllowlistRaw !== undefined) {
    config.fsAllowlist = fsAllowlistRaw
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  // SKILLSCRIPT_EVENT_INGRESS_ENABLED — boolean
  const ingressRaw = env["SKILLSCRIPT_EVENT_INGRESS_ENABLED"];
  if (ingressRaw === "true") config.eventIngressEnabled = true;
  else if (ingressRaw === "false") config.eventIngressEnabled = false;

  // SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN — string (any non-empty value)
  const tokenRaw = env["SKILLSCRIPT_EVENT_INGRESS_AUTH_TOKEN"];
  if (typeof tokenRaw === "string" && tokenRaw !== "") config.eventIngressAuthToken = tokenRaw;

  // SKILLSCRIPT_SECURED_MODE — boolean. The Gate #7 approval boundary: when on,
  // only v3-signed skills execute effectfully.
  const securedRaw = env["SKILLSCRIPT_SECURED_MODE"];
  if (securedRaw === "true") config.securedMode = true;
  else if (securedRaw === "false") config.securedMode = false;

  // SKILLSCRIPT_APPROVAL_KEY_FILE — path to the operator's Ed25519 PRIVATE key
  // (read only by the approve flow; the runtime never loads it).
  const keyFileRaw = env["SKILLSCRIPT_APPROVAL_KEY_FILE"];
  if (typeof keyFileRaw === "string" && keyFileRaw !== "") config.approvalKeyFile = keyFileRaw;

  // SKILLSCRIPT_APPROVAL_PUBLIC_KEY_FILE — path to the Ed25519 PUBLIC key
  // (non-secret; the runtime reads it to verify v3 tokens).
  const pubFileRaw = env["SKILLSCRIPT_APPROVAL_PUBLIC_KEY_FILE"];
  if (typeof pubFileRaw === "string" && pubFileRaw !== "") config.approvalPublicKeyFile = pubFileRaw;

  return config;
}

/**
 * v0.19.1 — single-field resolver helper. Returns the explicit option
 * when defined (per Perry's explicit-wins guard); otherwise the env
 * value; otherwise the default. Encapsulates the precedence in one
 * place so consumers don't reimplement it per field.
 *
 *   const port = pickEnvOption(opts.port, envCfg.port, 7878);
 *
 * Critical: `undefined` is the ONLY value that falls back. Defined
 * values (`false`, `0`, `[]`, `""`) are authoritative — adopters
 * passing those to assert specific posture get exactly that.
 */
export function pickEnvOption<T>(explicit: T | undefined, fromEnv: T | undefined, fallback: T): T {
  if (explicit !== undefined) return explicit;
  if (fromEnv !== undefined) return fromEnv;
  return fallback;
}

/**
 * v0.19.1 — same as `pickEnvOption` but returns `undefined` when neither
 * explicit nor env is set (no fallback). Used for fields where
 * "unset" is itself a meaningful state — e.g., `shellAllowlist`
 * undefined means default-deny; `eventIngressAuthToken` undefined
 * means no auth required.
 */
export function pickEnvOptionalOption<T>(explicit: T | undefined, fromEnv: T | undefined): T | undefined {
  if (explicit !== undefined) return explicit;
  return fromEnv;
}
