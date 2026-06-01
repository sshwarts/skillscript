// v0.15.4 — shared helper that suppresses node:sqlite's ExperimentalWarning
// at the actual load site. Called once-and-idempotent from the lazy-loader
// in SqliteDataStore + SqliteSkillStore (or anywhere else node:sqlite gets
// imported); first call installs the filter, subsequent calls are no-ops.
//
// Why here, not at the CLI entry: v0.15.1 filtered at src/cli.ts which
// covered `skillfile <cmd>` invocations but missed programmatic adopters
// running their own bootstrap. Phase 3 cold-adopter probe surfaced the
// re-emergence; v0.15.4 moves the filter to the substrate's load site so
// CLI consumers and programmatic consumers both see the suppression.
//
// Filter scope: narrow. Only the specific `node:sqlite` ExperimentalWarning
// is intercepted; every other process.emitWarning call passes through to
// the default handler unchanged. Programmatic consumers who want to see
// the warning (e.g., debugging build issues with experimental features)
// can restore the original handler — we expose `restoreSqliteWarning` for
// completeness, though we don't expect anyone to need it.

let installed = false;
let originalEmitWarning: typeof process.emitWarning | null = null;

export function suppressSqliteExperimentalWarning(): void {
  if (installed) return;
  originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = function suppressSqliteEmitWarning(warning: string | Error, ...rest: unknown[]) {
    const msg = warning instanceof Error ? warning.message : String(warning);
    let type: string | undefined;
    if (typeof rest[0] === "string") {
      type = rest[0];
    } else if (rest[0] !== null && typeof rest[0] === "object" && "type" in rest[0]) {
      type = (rest[0] as { type?: string }).type;
    }
    if (type === "ExperimentalWarning" && /\bSQLite\b/i.test(msg)) return;
    return (originalEmitWarning as (warning: string | Error, ...rest: unknown[]) => void)(warning, ...rest);
  } as typeof process.emitWarning;
  installed = true;
}

/**
 * Restore the original `process.emitWarning`. No-op if the suppressor
 * was never installed. Library consumers who want the SQLite warning
 * visible (e.g., debugging which node version's sqlite is loading) can
 * call this; default-CLI + default-bootstrap consumers won't.
 */
export function restoreSqliteWarning(): void {
  if (!installed || originalEmitWarning === null) return;
  process.emitWarning = originalEmitWarning;
  installed = false;
  originalEmitWarning = null;
}
