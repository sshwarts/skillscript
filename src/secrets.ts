/**
 * Secret references (v0.25.0). A skill names a secret with `{{secret.NAME}}`;
 * the runtime resolves it ONLY at a sink (a `shell(...)` op or a `$`
 * connector dispatch) and injects the value use-only — the resolved value
 * never binds to a skill variable, never lands in a trace, an emit, an
 * `# Output:`, or any other readable surface. This is deliberately distinct
 * from `${VAR}` readable substitution (`substituteRuntime`), which resolves
 * the skill var scope (inputs / `$set` / op outputs / built-ins) and CANNOT
 * reach a secret: `substituteRuntime` never touches a `{{...}}` marker, so a
 * marker that slips onto a readable surface stays an inert literal rather
 * than leaking a value.
 *
 * Source abstraction. `SecretProvider.resolve(name, ctx)` is the single seam.
 * The `.env`-backed `EnvSecretProvider` ships today; a vault-backed provider
 * drops in later with no caller change because `ctx` ALREADY carries the
 * principal (`skillName`) that a per-script-sealed vault provider will key on.
 * Nothing about the call sites assumes the env backing.
 *
 * See the dev-log secret-references design (memory 232bcfc9) for the full
 * arc; this module is its first buildable slice.
 */

/**
 * Resolution context handed to a {@link SecretProvider}. Carries the
 * principal so a future per-script-sealed vault provider can authorize the
 * fetch. {@link EnvSecretProvider} ignores it (the .env namespace is
 * runtime-global), but the field is part of the contract from day one so
 * swapping in a vault provider needs no signature change.
 */
export interface SecretResolveCtx {
  /** Name of the skill requesting the secret. A vault provider keys
   * per-script sealing on this; the env provider ignores it. */
  skillName?: string;
}

/**
 * Resolves a named secret to its plaintext value at a sink. The one seam
 * between the runtime and wherever secrets actually live.
 */
export interface SecretProvider {
  /**
   * Resolve a named secret to its plaintext value. MUST fail closed — throw
   * (ideally {@link SecretNotProvisionedError}) when the secret is missing
   * rather than returning `""` or a placeholder, which would silently hand an
   * empty credential to the sink.
   */
  resolve(name: string, ctx: SecretResolveCtx): Promise<string>;
}

/** Thrown by a provider when a referenced secret has no provisioned value. */
export class SecretNotProvisionedError extends Error {
  constructor(
    public readonly secretName: string,
    /** Operator-facing remediation (how to provision it). */
    public readonly remediation: string,
  ) {
    super(`Secret '${secretName}' is referenced but not provisioned. ${remediation}`);
    this.name = "SecretNotProvisionedError";
  }
}

/**
 * Environment-variable secret backing. A `{{secret.NAME}}` marker resolves
 * the env var `SKILLSCRIPT_SECRET_NAME`. The prefix is deliberate: it scopes
 * which environment is secret-reachable, so a skill cannot pull an arbitrary
 * process env var (`{{secret.PATH}}` looks for `SKILLSCRIPT_SECRET_PATH`, not
 * `$PATH`). The operator provisions secrets in `.env`; a skill author names
 * them but cannot read them back.
 */
export class EnvSecretProvider implements SecretProvider {
  /** Env prefix that scopes which vars are reachable as secrets. */
  static readonly PREFIX = "SKILLSCRIPT_SECRET_";

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(name: string, _ctx: SecretResolveCtx): Promise<string> {
    const key = EnvSecretProvider.PREFIX + name;
    const value = this.env[key];
    if (value === undefined || value === "") {
      throw new SecretNotProvisionedError(
        name,
        `Set ${key} in the runtime environment (the operator's .env) and restart the runtime. ` +
          `Secrets are operator-provisioned; a skill author references them by name but cannot set or read them.`,
      );
    }
    return value;
  }
}

/**
 * Op kinds permitted to contain `{{secret.NAME}}` markers — the "sinks."
 * A marker in any OTHER position (emit, `$set`, `# Output:`, conditions,
 * `file_*`, notify) is a lint tier-1 error, because the value would land on a
 * readable or emittable surface. Adding a new sink (e.g. a future `notify`
 * that needs a key) is two edits with no redesign: wire that handler to call
 * {@link expandSecretMarkers} and append its op kind here. Kept minimal on
 * purpose (Scott 2026-06-28: "don't design yourself into a corner" — a list,
 * not a rewrite). This is the single source of truth shared by lint + runtime.
 */
export const SECRET_SINK_OP_KINDS: readonly string[] = ["shell", "$"];

/**
 * Secret placement marker: `{{secret.NAME}}`, whitespace-tolerant inside the
 * braces. NAME is an identifier (`[A-Za-z_]\w*`); the `secret.` namespace is
 * reserved. Double-brace + reserved namespace keeps it disjoint from `${VAR}`
 * / `$(VAR)` readable refs so the two resolution passes never collide.
 * Global flag: used for both scan and replace.
 */
const SECRET_MARKER = /\{\{\s*secret\.([A-Za-z_]\w*)\s*\}\}/g;

/** True iff `text` contains at least one `{{secret.NAME}}` marker. */
export function hasSecretMarker(text: string): boolean {
  SECRET_MARKER.lastIndex = 0;
  return SECRET_MARKER.test(text);
}

/** Count of `{{secret.NAME}}` marker occurrences in `text` (NOT deduped).
 * Used by the lint backstop to compare source markers against the markers the
 * op-AST scan accounted for — a surplus means a marker sits in a position the
 * parser dropped (e.g. a malformed `emit {{secret.X}}` with no parens). */
export function countSecretMarkers(text: string): number {
  const m = text.match(SECRET_MARKER);
  return m ? m.length : 0;
}

/** Distinct secret names referenced by `{{secret.NAME}}` markers in `text`. */
export function extractSecretRefs(text: string): string[] {
  // SECRET_MARKER is a shared global regex; `matchAll` copies its `lastIndex`,
  // so reset first or a prior `.test()` (hasSecretMarker) would start the scan
  // mid-string and miss leading markers.
  SECRET_MARKER.lastIndex = 0;
  const names = new Set<string>();
  for (const m of text.matchAll(SECRET_MARKER)) names.add(m[1]!);
  return [...names];
}

/**
 * Detects any `{{secret.…}}` occurrence that is NOT a well-formed static
 * `{{secret.NAME}}` marker — a dynamic interior (`{{secret.${VAR}}}`), an
 * empty name, a filter/extra content, etc. The secret name MUST be a
 * compile-time literal: a dynamically-built name would let `${VAR}`
 * substitution choose (or fabricate) the secret at runtime, evading the
 * declare-before-spend gate and the approver-visible `# Requires` reach.
 * Returns the offending raw substrings (empty when all markers are static).
 * (Perry red-team `d8a5ad0a` Bug A, fix #3.)
 */
export function findMalformedSecretMarkers(text: string): string[] {
  const out: string[] = [];
  // `[^}]*` so a `{{secret.${NM}}}` dynamic interior is captured (not skipped).
  const anyMarker = /\{\{\s*secret\.[^}]*\}\}/g;
  for (const m of text.matchAll(anyMarker)) {
    if (!/^\{\{\s*secret\.[A-Za-z_]\w*\s*\}\}$/.test(m[0])) out.push(m[0]);
  }
  return out;
}

/**
 * Replace every `{{secret.NAME}}` marker in `text` with its resolved value.
 * Async — a vault provider does I/O. Returns `text` unchanged when it holds
 * no markers, so a sink handler may call this unconditionally on any input.
 * Fails closed: an unprovisioned secret throws (never substitutes empty).
 *
 * The returned string is USE-ONLY: pass it straight to the sink (spawn argv,
 * connector arg) and never bind it to a var, emit it, or write it to a trace.
 * Resolve happens here, at the sink boundary, precisely so the value's
 * lifetime is the single dispatch call.
 */
export async function expandSecretMarkers(
  text: string,
  provider: SecretProvider,
  ctx: SecretResolveCtx,
  /** Optional sink for each resolved value — lets a caller build a redaction
   * set so a leaked value can be scrubbed from error/trace output (Perry
   * Bug B fix #2, belt-and-suspenders). */
  onResolve?: (name: string, value: string) => void,
): Promise<string> {
  if (!hasSecretMarker(text)) return text;
  // Resolve each distinct name once (a marker may repeat), then splice.
  const resolved = new Map<string, string>();
  for (const name of extractSecretRefs(text)) {
    const value = await provider.resolve(name, ctx);
    resolved.set(name, value);
    onResolve?.(name, value);
  }
  return text.replace(SECRET_MARKER, (_m, name: string) => resolved.get(name)!);
}

/**
 * {@link expandSecretMarkers} over a list (the `shell(...)` argv form, where
 * each element is substituted independently). Markerless elements pass
 * through untouched.
 */
export async function expandSecretMarkersInList(
  items: string[],
  provider: SecretProvider,
  ctx: SecretResolveCtx,
  onResolve?: (name: string, value: string) => void,
): Promise<string[]> {
  const out: string[] = [];
  for (const item of items) out.push(await expandSecretMarkers(item, provider, ctx, onResolve));
  return out;
}
