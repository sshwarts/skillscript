// v0.23.0 — observed output-shape capture (connector-discovery ring, phase 1).
//
// When a `$ <connector>.<tool>` op dispatches under approval and returns, we
// record the SHAPE of the value the skill binds — keys + types, NOT values —
// keyed by `connector.tool`. A later author calling the same tool sees its
// last-observed return shape in skill_preflight without an approve-fire-to-see
// detour. Internal runtime cache (lives in the bundled trace store); not an
// adopter contract.

/** A shallow keys-and-types description of a runtime value. JSON-serializable. */
export interface ObservedShape {
  kind: "object" | "array" | "string" | "number" | "boolean" | "null";
  /** Object only: top-level key → JS type name (string/number/boolean/object/array/null). */
  keys?: Record<string, string>;
  /** Array only: the shape of the first element (one level deep). */
  element?: ObservedShape;
}

/** A stored observation: the shape plus when + where it was seen. */
export interface ObservedShapeRecord {
  connector: string;
  tool: string;
  shape: ObservedShape;
  observed_at_ms: number;
  /** Skill that produced the observation (provenance; may be omitted). */
  observed_from?: string;
}

/** Cap on object keys captured, so a pathological wide object can't bloat the cache. */
const MAX_KEYS = 50;

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // string | number | boolean | object | undefined | function | symbol | bigint
}

/**
 * Describe a value's shape, keys + types only, bounded to ~two levels
 * (object keys one level; array element one level). Never captures values.
 */
export function describeValueShape(value: unknown): ObservedShape {
  const t = typeName(value);
  if (t === "object") {
    const keys: Record<string, string> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n >= MAX_KEYS) break;
      keys[k] = typeName(v);
      n++;
    }
    return { kind: "object", keys };
  }
  if (t === "array") {
    const arr = value as unknown[];
    const first = arr.find((x) => x !== undefined && x !== null);
    return first !== undefined ? { kind: "array", element: describeValueShape(first) } : { kind: "array" };
  }
  // Scalars (and the never-expected function/symbol/bigint) collapse to a kind.
  const kind = (["string", "number", "boolean", "null"].includes(t) ? t : "string") as ObservedShape["kind"];
  return { kind };
}

/** Map key for a (connector, tool) pair. */
export function shapeKey(connector: string, tool: string): string {
  return `${connector}.${tool}`;
}

/**
 * Whether a bound value carries enough information to be worth recording. We
 * capture objects, non-empty arrays, non-empty text, and numeric/boolean
 * scalars. The non-text cases tell an author how to navigate (`$(R.field)`,
 * `$(R[0])`); the text case is just as important — many MCP tools (web search,
 * fetch, summarizers) return a formatted STRING, and "it's text, not an object
 * you can dot into" is exactly the answer an author needs. We skip only the
 * shapeless cases — nullish, empty string, empty array — to keep any prior
 * good observation rather than overwrite it with nothing.
 */
export function isShapeWorthRecording(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "object" || typeof value === "number" || typeof value === "boolean";
}
