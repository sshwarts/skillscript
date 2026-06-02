// Pipe-filter implementations. `$(NAME|filter)` syntax dispatches here.

/** The names of every registered filter. Lint's `unknown-filter` rule consults this. */
export const KNOWN_FILTERS = ["url", "shell", "json", "trim", "length", "fallback", "isodate", "contains"] as const;
export type KnownFilter = (typeof KNOWN_FILTERS)[number];

/**
 * A single filter spec parsed from the `|filter` chain. `arg` is the
 * double-quoted string after `:` (e.g. `|default:"none"` → `{name:"default", arg:"none"}`).
 * v0.5.0 item 4 — only `fallback` accepts an arg; other filters that pass
 * an arg are tolerated by the parser but rejected at apply-time. Named
 * `fallback` (not `default`) to align vocabulary with op-level `(fallback:)`;
 * adjacent concept (coalesce-on-missing-ref) shares the universal word
 * "fallback" without conflating the syntactic site.
 */
export interface FilterSpec {
  name: string;
  arg?: string;
}

/**
 * Parse a filter chain string like `|trim|default:"none"|upper` into specs.
 * Empty / undefined input returns `[]`. Whitespace tolerant.
 */
export function parseFilterChain(chain: string | undefined): FilterSpec[] {
  if (!chain) return [];
  const out: FilterSpec[] = [];
  const re = /\|\s*([A-Za-z_]\w*)(?:\s*:\s*"([^"]*)")?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chain)) !== null) {
    const spec: FilterSpec = { name: m[1]! };
    if (m[2] !== undefined) spec.arg = m[2];
    out.push(spec);
  }
  return out;
}
//
// Adding a new filter:
//   1. Add a case in `applyFilter` below.
//   2. Document it in `docs/LANGUAGE_REFERENCE.md` under the pipe-filter section.
//   3. Lint rule `unknown-filter` already covers compile-time validation —
//      unknown filter names on resolved values throw, so authors discover typos
//      at compile time without runtime surprise.
//
// All filters operate on strings. The caller (parser at compile time, runtime
// substituter at execution time) stringifies the underlying value first.

/**
 * Apply a named pipe filter to a string value. Filters supported in v1:
 *
 *   url    — `encodeURIComponent`. For URL path or query embedding.
 *   shell  — POSIX single-quote shell-escape. Wraps in outer quotes; don't add your own.
 *   json   — `JSON.stringify`. Produces a quoted JSON string literal.
 *   trim   — strip leading/trailing whitespace. Useful on local-model outputs that
 *            often append a trailing newline that breaks `==` equality checks.
 *   length — count of items (if the value JSON-parses as an array) or characters
 *            (otherwise). Read-only projection — pairs with v0.2.5's numeric
 *            comparison operators for skills like `if $(ITEMS|length) > "0":`.
 *
 * Unknown filter names throw — typos are caught at compile time when the value
 * is already resolved, or at runtime for ambient refs.
 *
 * v0.3.3 — `|json_parse` filter removed. Use `$ json_parse $(VAR) -> P` op
 * instead, which binds the parsed structure so `$(P.field)` works via
 * resolveRef's dotted descent. Filter was string-in/string-out which couldn't
 * propagate parsed shape through `.field` access.
 */
export function applyFilter(value: string, filter: string, arg?: string): string {
  switch (filter) {
    case "url":
      return encodeURIComponent(value);
    case "shell":
      return `'${value.replace(/'/g, "'\\''")}'`;
    case "json":
      // v0.15.7 — idempotent. `applyFilter` receives all values as strings
      // (substituteRuntime pre-serializes structured values upstream of the
      // filter chain), so `|json` on a structured-pre-stringified value was
      // double-encoding — turning `'{"id":"abc"}'` into `'"{\\"id\\":\\"abc\\"}"'`.
      // Try JSON.parse first: if the input parses cleanly, it's already a
      // valid JSON representation — pass through. If it doesn't parse, treat
      // as a plain string and stringify once (the v0.3.x behavior, preserved
      // for the non-JSON path).
      //
      // Edge cases that pass through (previously would have been re-quoted):
      //   `"null"` / `"true"` / `"42"` — JSON-parseable, treated as already-JSON.
      // The rare author who literally wanted to JSON-escape the string "null"
      // (producing `"\"null\""`) hits a behavior change; documented in the
      // CHANGELOG. The common case — emit({text: "saw ${OBJ|json}"}) — is fixed.
      try {
        JSON.parse(value);
        return value;
      } catch {
        return JSON.stringify(value);
      }
    case "trim":
      return value.trim();
    case "fallback":
      // v0.5.0 item 4 — `fallback` is binding-aware: it consumes an
      // undefined ref upstream of the filter chain. By the time
      // applyFilter sees it, the ref has already resolved (otherwise
      // substituteRuntime would have substituted the fallback arg before
      // reaching this point). No-op.
      return value;
    case "isodate": {
      // v0.5.0 item 6: format an epoch timestamp as ISO-8601. Accepts
      // milliseconds OR seconds — disambiguates by magnitude (>= 10^12
      // → ms, otherwise seconds). Already-ISO strings pass through
      // unchanged. Useful for `$(EVENT.fired_at_unix|isodate)` style refs.
      const n = Number(value);
      if (Number.isFinite(n)) {
        const ms = n >= 1e12 ? n : n * 1000;
        return new Date(ms).toISOString();
      }
      // Non-numeric: try parsing as a date string. Round-trips ISO inputs.
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
      throw new Error(`|isodate filter: value '${value.slice(0, 40)}${value.length > 40 ? "..." : ""}' is not a recognizable timestamp (expected epoch ms/sec or ISO-8601 string).`);
    }
    case "length": {
      // Array-shaped JSON → element count. Anything else (including
      // JSON-parsed-but-not-array, or non-JSON strings) → character count.
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) return String(parsed.length);
      } catch {
        /* not JSON — fall through to string-length semantics */
      }
      return String(value.length);
    }
    case "contains": {
      // Boolean substring/membership check. Returns "true" on match, "" on
      // miss — the empty-string-as-falsy convention matches `isTruthy` in
      // runtime.ts so `if ${R|contains:"X"}:` evaluates as the author
      // intuits.
      //
      // Type-aware with JSON-string tolerance (mirrors `in` / `not in`
      // conditional operators):
      //   - LHS resolves to a JSON-parseable array → element membership
      //     (each element stringified, compared against `arg`)
      //   - LHS resolves to anything else (string, number, etc.) → substring
      //     match on the resolved-string form
      //
      // The two semantics let `${LIST|contains:"a"}` against ["a","b"]
      // return "true" (element match) without silent-false-positive on
      // ["alphabet"] (which substring-only would incorrectly match).
      // Symmetric with `if "a" in ${LIST}:` per the conditionals spec.
      if (arg === undefined) {
        throw new Error("|contains filter: requires a quoted arg (e.g., |contains:\"X\")");
      }
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.some((item) => String(item) === arg) ? "true" : "";
        }
      } catch {
        /* not JSON — fall through to substring semantics */
      }
      return value.includes(arg) ? "true" : "";
    }
    default:
      throw new Error(`Unknown filter '${filter}' — supported: ${KNOWN_FILTERS.join(", ")}`);
  }
}
