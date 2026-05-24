// Source text → AST. The parser recognizes the full v1 grammar but performs
// no resolution against external state. Semantic analysis (variable resolution,
// data-skill inlining, topo-sort) lives in compile.ts.

export type OpKind = "$" | "$set" | "$append" | "?" | "@" | "!" | "??" | "foreach" | "if" | ">" | "~" | "&";

export interface SkillOp {
  kind: OpKind;
  body: string;
  outputVar?: string;
  mcpConnector?: string;
  retrievalParams?: {
    mode: string;
    query: string;
    /** Integer literal OR a `$(VAR)`-style ref string. Runtime substitutes refs then parses to int. */
    limit: number | string;
    connector: string;
    extra: Record<string, string>;
    /**
     * Op-level fallback (per language reference §9). When the retrieval
     * throws or returns an empty array, runtime binds this value (string)
     * to the output var instead of propagating the error.
     */
    fallback?: string;
  };
  localModelParams?: {
    prompt: string;
    model?: string;
    /** Integer literal OR a `$(VAR)`-style ref string. Runtime substitutes refs then parses to int. */
    maxTokens?: number | string;
    /**
     * Per-op timeout override in SECONDS (per decision 7 resolution chain).
     * Integer literal OR `$(VAR)` ref. Per-op wins over skill `# Timeout:`
     * header, connector default, and built-in fallback.
     */
    timeoutSeconds?: number | string;
    /**
     * Op-level fallback (per language reference §9). When the model call
     * throws or returns an empty (trimmed) response, runtime binds this
     * value to the output var instead of propagating the error.
     */
    fallback?: string;
  };
  /**
   * For `&` ops only: skill name + optional key=value args passed as inputs
   * when the target is procedural (runtime invocation), ignored when the
   * target is data-typed (compile-time inline). `outputVar` captures the
   * result of procedural invocations; absent for data inlines.
   */
  ampParams?: {
    skillName: string;
    args: Record<string, string>;
  };
  /**
   * For `@` ops only: when the literal first token of the body is `unsafe`,
   * the parser attaches `policy: "unsafe"` and strips the keyword from the
   * body. Lint flags every `@ unsafe` (tier-2); runtime refuses unless
   * `runtime.enable_unsafe_shell = true` (default false). Default `@` ops
   * (without the keyword) route through the structured-spawn sandbox per
   * decision 2 — one binary, no shell interpretation.
   */
  policy?: "unsafe";
  setName?: string;
  setValue?: string;
  /**
   * Top-level fallback (per language reference §9, extended 2026-05-21
   * for `$` ops via cold-agent corpus). On `$` throw or empty result,
   * runtime binds this value to the output var instead of propagating
   * the error. `~` and `>` ops carry fallback on their params bag for
   * type-specific coercion; `$` returns are heterogeneous (objects,
   * arrays, strings) so it lives at the op level.
   */
  fallback?: string;
  foreachIter?: string;
  foreachList?: string;
  foreachBody?: SkillOp[];
  ifBranches?: Array<{ cond: string; body: SkillOp[] }>;
  ifElseBody?: SkillOp[];
}

export interface SkillTarget {
  name: string;
  deps: string[];
  ops: SkillOp[];
  // `else:` body executed if any op in `ops` throws at runtime.
  elseBlock?: SkillOp[];
}

export interface SkillVar {
  name: string;
  default?: string;
  required: boolean;
}

export interface SkillRequire {
  namespace: "user-var" | "system-var";
  key: string;
  target: string;
  fallback: string | null;
  raw: string;
}

export type TriggerSource = "session" | "cron" | "event" | "agent-event" | "file-watch" | "sensor";

export interface TriggerDecl {
  source: TriggerSource;
  name: string;
}

export type OutputKind = "text" | "slack" | "prompt-context" | "template" | "file" | "card" | "none";

export interface OutputDecl {
  kind: OutputKind;
  target?: string;
}

export type SkillType = "procedural" | "data";
export type SkillStatusLiteral = "Draft" | "Approved" | "Disabled";

/**
 * Case-insensitive accept, canonical-form return. The `allowed` list defines
 * canonical form (the first match for any case-folded input). Returns `null`
 * when the input doesn't match any canonical entry. Used uniformly across
 * every enumerated frontmatter field per Section 1 Lexical conventions.
 */
function normalizeEnumValue<T extends string>(raw: string, allowed: readonly T[]): T | null {
  const lower = raw.toLowerCase();
  for (const candidate of allowed) {
    if (candidate.toLowerCase() === lower) return candidate;
  }
  return null;
}

export interface ParsedSkill {
  name: string | null;
  description: string | null;
  /**
   * `# Type:` header value. Procedural is the default (op-bearing,
   * dispatched at runtime). `data` marks a content-only skill whose body
   * inlines at every `& <name>` reference site at compile time.
   */
  type: SkillType;
  /** `# Status:` header value. Null when omitted; lint defaults to `Draft` semantics. */
  status: SkillStatusLiteral | null;
  /**
   * `# Timeout:` header value in SECONDS. Number literal OR `$(VAR)` ref
   * string (resolved at runtime). Null when omitted; runtime resolves via
   * the 4-level chain (per-op kwarg > skill header > connector default >
   * built-in 300s fallback).
   */
  timeout: number | string | null;
  vars: SkillVar[];
  /** Variable resolution declarations — `user-var:key -> VAR (fallback: X)` shape. */
  requires: SkillRequire[];
  /**
   * Capability requirements — `connector_type.feature_flag` tokens. The
   * linter's `unknown-capability` rule validates these against the
   * registered connector classes' `staticCapabilities()`. Empty when no
   * capability `# Requires:` clauses are authored.
   */
  requiredCapabilities: string[];
  useWhen: string | null;
  targets: Map<string, SkillTarget>;
  entryTarget: string | null;
  onError: string | null;
  triggers: TriggerDecl[];
  outputs: OutputDecl[];
  /**
   * `# Delivery-context:` value — human-readable explanation routed to
   * the receiving agent alongside an augment/template delivery so the
   * agent knows *why* it was notified. Augmenting/Template skills only;
   * a `unused-augmenting-header` lint warning fires when set on a skill
   * without an agent-bound output declaration. v0.2.6 addition.
   */
  deliveryContext: string | null;
  /**
   * `# Templates:` value — comma-separated names of Template skills the
   * receiving agent may fetch as follow-on actions. Surfaced alongside
   * the delivery so the agent can act on the augment with named next
   * steps. v0.2.6 addition.
   */
  templates: string[];
  /**
   * `# Autonomous: true` header — declarative authorship intent marker
   * for unattended-execution skills (cron-fired, agent-fired, etc.).
   * v0.4.2 addition. Today silences `unconfirmed-mutation` lint; the
   * header is reserved for the broader autonomous-skill category so
   * future rules + scheduling defaults + runtime_capabilities discovery
   * can hook into the same field without breaking-change.
   *
   * `true` = explicitly autonomous. `false` = explicitly interactive
   * (default). `null` = unspecified (treated as `false` for lint
   * purposes; preserved so authors can distinguish "I forgot the header"
   * from "I deliberately set it").
   */
  autonomous: boolean | null;
  parseErrors: string[];
}

// Regex grammar.
const REQUIRES_LINE = /^(user-var|system-var):([A-Za-z0-9_-]+)\s*(?:→|->)\s*([A-Za-z_][\w-]*)\s*(?:\(\s*fallback\s*:\s*(.+?)\s*\)\s*)?$/;
/** Capability token: `connector_type.feature_flag`. Matches one space-separated token of a capability `# Requires:` line. */
const CAPABILITY_TOKEN = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
/** `&` op: `& skill-name [arg=value ...] [-> VARNAME]`. Skill names follow the same charset as filesystem-safe identifiers (alphanumeric, hyphen, underscore). */
const AMPERSAND_OP_REGEX = /^&\s+([A-Za-z0-9][\w-]*)\s*(.*?)(?:\s*->\s*([A-Za-z_]\w*))?(?:\s+\(fallback\s*:\s*(.+?)\))?\s*$/s;
const SET_OP_REGEX = /^\$set\s+([A-Za-z_]\w*)\s*=\s*(.*)$/;
// v0.3.0 accumulator. `$append VAR <value>` — single-value append to a
// list-typed VAR. Form: `$append IDENT <space> <value>`. Mirrors $set
// in shape (var name + value) but the runtime mutates an outer-scope
// list rather than overwriting. See spec memory `9d6079bb` + `442cf4bb`.
const APPEND_OP_REGEX = /^\$append\s+([A-Za-z_]\w*)\s+(.+)$/;
const FOREACH_OP_REGEX = /^foreach\s+([A-Za-z_]\w*)\s+in\s+(.+?):\s*$/;
const IF_OP_REGEX = /^if\s+(.+?):\s*$/;
const ELIF_OP_REGEX = /^elif\s+(.+?):\s*$/;
// v0.2.11 Bug 14: any `WORD[ WORD...]:` form, used to detect unrecognized
// block-introducers AFTER the known set (if/elif/else/foreach) has been
// matched. Word-shape leading token plus optional args, ending in `:`.
// Excludes target headers (those are matched at depth-0 elsewhere).
const UNKNOWN_BLOCK_INTRODUCER_RE = /^[A-Za-z_][\w-]*(?:\s+.*)?:\s*$/;
/**
 * `>` and `~` ops accept optional trailing `(fallback: <value>)` per
 * language reference §9 (Error Handling, Layer 3). Fires when the op
 * throws or returns empty — runtime binds the fallback value to the
 * output var and continues without surfacing the error.
 *
 * Value is permissive (matching `# Requires:` cascade convention): bare
 * identifiers (`ip-based`), quoted strings (`"weather unavailable"`),
 * array literals (`[]`, `[a, b]`), and arbitrary text between the colon
 * and the closing paren are all accepted. Parser stores the raw form;
 * runtime applies `coerceLiteralValue` for `>` (binds array on `[...]`)
 * and the raw string for `~` (model response shape).
 */
const RETRIEVAL_OP_REGEX = /^>\s+(.+?)\s+->\s+([A-Za-z_]\w*)(?:\s+\(fallback\s*:\s*(.+?)\))?\s*$/s;
const LOCAL_MODEL_OP_REGEX = /^~\s+(.+?)\s+->\s+([A-Za-z_]\w*)(?:\s+\(fallback\s*:\s*(.+?)\))?\s*$/s;
const MCP_CONNECTOR_PREFIX = /^([a-z_][a-z0-9_-]*)\.(?=[A-Za-z_])([\s\S]*)$/;

// Narrow v1 condition grammar.
// v0.3.4: filter chain support — each `(REF)(|filter)?` became `(REF)(|filter)*`
// to match `substituteRuntime`'s chain capture (runtime.ts:1158). Closes the
// recurring "filter chain works in substitution but not conditions" gap named
// in dev-log §14. Runtime regex set mirrors this; both update together.
const COND_TRUTHY = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)*\)\s*$/;
/** `$(REF) ==/!= "literal"` — ref-vs-string equality. Filter chain on the ref side. */
const COND_EQ = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)*\)\s*(?:==|!=)\s*"[^"]*"\s*$/;
/**
 * `$(REF) ==/!= $(REF)` — ref-vs-ref equality. Extended 2026-05-21 per
 * language reference §5; surfaced by the cold-agent skills battery (a
 * sub-agent reached for `$(FP|trim) == $(LAST_FP|trim)` unprompted as
 * the natural change-detection pattern). Filter chain + dotted field
 * access permitted on either side.
 */
const COND_EQ_REF = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)*\)\s*(?:==|!=)\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)*\)\s*$/;
/**
 * `$(REF) </>/<=/>= "literal"` and `$(REF) </>/<=/>= $(REF)` — numeric
 * comparison. v0.2.5 addition per the orchestration carve-out: comparison
 * is orchestration; arithmetic + aggregates stay in tools. Both sides
 * coerce to number at runtime; non-numeric → TypeMismatchError. Filter
 * chain + dotted field access permitted on either side, matching
 * EQ/EQ_REF shape.
 */
const COND_CMP = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)*\)\s*(?:<=|>=|<|>)\s*"[^"]*"\s*$/;
const COND_CMP_REF = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)*\)\s*(?:<=|>=|<|>)\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)*\)\s*$/;
const COND_IN = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)*\)\s+(?:not\s+)?in\s+\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\)\s*$/;

function validateCondition(cond: string): boolean {
  return validateCompoundCondition(cond.trim());
}

// v0.3.2 — recursive structural decomposition matching runtime evalCondition.
// Order: strip parens → split on outermost OR → AND → not prefix → simple shape.
function validateCompoundCondition(cond: string): boolean {
  const stripped = stripOuterCondParens(cond);
  const orIdx = findOuterCondToken(stripped, "or");
  if (orIdx >= 0) {
    return validateCompoundCondition(stripped.slice(0, orIdx).trim())
      && validateCompoundCondition(stripped.slice(orIdx + 4).trim());
  }
  const andIdx = findOuterCondToken(stripped, "and");
  if (andIdx >= 0) {
    return validateCompoundCondition(stripped.slice(0, andIdx).trim())
      && validateCompoundCondition(stripped.slice(andIdx + 5).trim());
  }
  const lead = stripped.trimStart();
  if (lead.startsWith("not ")) return validateCompoundCondition(lead.slice(4));
  return COND_TRUTHY.test(stripped) || COND_EQ.test(stripped) || COND_EQ_REF.test(stripped) ||
         COND_CMP.test(stripped) || COND_CMP_REF.test(stripped) || COND_IN.test(stripped);
}

function findOuterCondToken(cond: string, token: string): number {
  let depth = 0;
  let inQuote: '"' | "'" | null = null;
  let bestIdx = -1;
  for (let i = 0; i < cond.length; i++) {
    const ch = cond[i]!;
    if (inQuote !== null) { if (ch === inQuote) inQuote = null; continue; }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    if (ch === " " && cond.slice(i + 1, i + 1 + token.length) === token) {
      const after = cond[i + 1 + token.length];
      if (after === " " || after === "\t") bestIdx = i;
    }
  }
  return bestIdx;
}

function stripOuterCondParens(cond: string): string {
  const trimmed = cond.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return trimmed;
  let depth = 0;
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length - 1; i++) {
    const ch = trimmed[i]!;
    if (inQuote !== null) { if (ch === inQuote) inQuote = null; continue; }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return trimmed;
    }
  }
  return trimmed.slice(1, -1).trim();
}

/** Detects `$(REF) = "literal"` — a single `=` in condition position. */
const SINGLE_EQ_IN_COND = /\$\([^)]+\)\s*=(?!=)\s*"[^"]*"/;

/**
 * If the condition contains `$(REF) = "..."` (single `=`), emit a specific
 * diagnostic suggesting `==`. Returns the diagnostic string when matched,
 * `null` otherwise. The grammar rejects single-`=` in condition position;
 * this surfaces the JS-shaped-bug pattern as a specific error rather than
 * the generic "unsupported condition" fallback.
 */
function detectSingleEqualsInCondition(cond: string): string | null {
  const m = SINGLE_EQ_IN_COND.exec(cond);
  if (m === null) return null;
  const fixed = cond.replace(/\$\(([^)]+)\)\s*=(?!=)\s*"([^"]*)"/, '$($1) == "$2"');
  return `\`=\` is not valid in a condition; use \`==\` for equality. rewrite as: \`${fixed}\``;
}

/**
 * Reserved identifiers per Section 1 Lexical conventions. Rejected as
 * variable names, target names (other than the special `default:` goal
 * declaration), skill names, and foreach iterator IDENTs. Case-sensitive
 * exact match — `default` is reserved; `Default` is allowed.
 */
const RESERVED_KEYWORDS_CURRENT = new Set([
  "default", "needs", "if", "elif", "else", "foreach", "in", "not", "unsafe",
]);
/**
 * Future-reserved — no current semantics. Reserved so v2 grammar additions
 * stay non-breaking.
 */
const RESERVED_KEYWORDS_FUTURE = new Set([
  "while", "for", "match", "try", "catch", "return",
]);
const ALL_RESERVED = new Set([...RESERVED_KEYWORDS_CURRENT, ...RESERVED_KEYWORDS_FUTURE]);

function checkReserved(name: string, positionLabel: string, suggestionExample: string): string | null {
  if (!ALL_RESERVED.has(name)) return null;
  const futureNote = RESERVED_KEYWORDS_FUTURE.has(name) ? " (future-reserved for v2 grammar)" : "";
  return `'${name}' is a reserved keyword${futureNote} and cannot be used as ${positionLabel}. Rename (e.g., ${suggestionExample}).`;
}

const INDENT_STEP = 4;

function leadingSpaces(rawLine: string): number {
  const m = /^( *)/.exec(rawLine);
  return m ? m[1]!.length : 0;
}

/**
 * Detect tab characters in indentation. Tabs are a parse error per Section 1
 * Lexical conventions — the language enforces spaces-only block structure
 * to eliminate editor-config debates. Returns the 1-indexed line numbers
 * where tabs appear in leading whitespace.
 */
function findTabIndentedLines(source: string): number[] {
  const offenders: number[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^[\t ]*/.exec(line);
    if (match !== null && match[0].includes("\t")) {
      offenders.push(i + 1);
    }
  }
  return offenders;
}

// Top-level comma split — preserves commas inside `[...]` list literals.
// v0.2.10 Bug 2: comma is a declaration boundary only when followed by
// IDENT then `=`/`,`/`:`/end. Once the current segment has `=`, commas
// stay value-internal unless the next IDENT is followed by `=` or `:`.
function splitVarsLine(value: string): string[] {
  const parts: string[] = [];
  let cur = "", depth = 0;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { cur += ch; q = ch; continue; }
    if (ch === "[" || ch === "{") { depth++; cur += ch; continue; }
    if (ch === "]" || ch === "}") { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (ch === "," && depth === 0) {
      const rest = value.slice(i + 1);
      const m = rest.match(/^\s*[A-Za-z_][\w-]*\s*([=,:]|$)/);
      if (m !== null && (!cur.includes("=") || m[1] === "=" || m[1] === ":")) {
        // v0.2.12 Bug 16: URL values (`https://...,https://...`) tripped
        // the IDENT-then-`:` boundary heuristic — `https:` looks identical
        // to a fresh declaration colon. Disambiguate via `://`: if the
        // matched IDENT+`:` is immediately followed by `//`, it's the
        // scheme half of a URL, not a declaration boundary.
        if (m[1] === ":") {
          const tail = rest.slice(m[0].length);
          if (tail.startsWith("//")) {
            cur += ch;
            continue;
          }
        }
        parts.push(cur); cur = ""; continue;
      }
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * Fold physical lines whose quoted-string values span line breaks into
 * single logical lines. Cold-author corpus (Perry's 2/3 minion-battery
 * hit, v0.2.2) showed multi-line `~ prompt="..."` strings are a common
 * authoring pattern — multi-step LLM prompts, JSON examples, multi-
 * paragraph instructions. Without folding, the line-iterating parse loop
 * treats each interior newline as a block break and mis-parses.
 *
 * Folding only engages on kwarg-bearing op lines (`~ `, `> `, `& `) —
 * the three op kinds whose values legitimately span newlines. Plain
 * frontmatter (`# Description: symbol's intraday drops`), target labels,
 * `!` literals, and shell `@` bodies are left untouched so that
 * apostrophes in natural English prose don't open phantom string scopes
 * that swallow the rest of the skill (Perry's v0.2.4 Bug D regression
 * from the v0.2.2 fix).
 */
function foldQuotedContinuations(lines: string[]): string[] {
  const out: string[] = [];
  let buffer: string | null = null;
  for (const line of lines) {
    if (buffer === null) {
      if (isKwargBearingLine(line) && hasUnclosedQuote(line)) {
        buffer = line;
      } else {
        out.push(line);
      }
    } else {
      buffer = buffer + "\n" + line;
      if (!hasUnclosedQuote(buffer)) {
        out.push(buffer);
        buffer = null;
      }
    }
  }
  // Unterminated quote at EOF: push the accumulated buffer as-is so the
  // downstream regex match fails cleanly with a malformed-op diagnostic
  // rather than swallowing content.
  if (buffer !== null) out.push(buffer);
  return out;
}

/**
 * Three op kinds use `key=value` kwarg args where the value may legitimately
 * span newlines. Everything else (frontmatter, target labels, `!` / `@` / `$`
 * op bodies, control-flow keywords) is single-line by convention and must
 * not engage the multi-line fold.
 */
function isKwargBearingLine(line: string): boolean {
  const stripped = line.replace(/^\s+/, "");
  return stripped.startsWith("~ ") || stripped.startsWith("> ") || stripped.startsWith("& ");
}

function hasUnclosedQuote(text: string): boolean {
  let inDouble = false;
  let inSingle = false;
  for (const ch of text) {
    if (!inSingle && ch === '"') inDouble = !inDouble;
    else if (!inDouble && ch === "'") inSingle = !inSingle;
  }
  return inDouble || inSingle;
}

/**
 * Split a `# Triggers:` header value into separate trigger entries.
 *
 * Cron expressions naturally contain commas (e.g. `30,45 9 * * 1-5`), so a
 * naive comma-split breaks legitimate multi-value cron schedules. Instead
 * split at comma + source-keyword boundaries — the next entry begins where
 * a known source token (cron/session/event/agent-event/file-watch/sensor)
 * appears after a comma. v0.2.2 fix per Perry's 3/3 minion-battery hit.
 *
 * Examples:
 *   `cron: 30,45 9 * * 1-5`                   → one entry
 *   `cron: 0 9 * * *, session: start`         → two entries
 *   `cron: 30,45 9 * * 1-5, cron: 0 16 * * 1-5` → two entries
 */
function splitTriggersLine(value: string): string[] {
  const sourcePattern = ["session", "cron", "event", "agent-event", "file-watch", "sensor"]
    .map((s) => s.replace(/-/g, "\\-"))
    .join("|");
  const splitRegex = new RegExp(`,\\s*(?=(?:${sourcePattern})\\s*:)`, "g");
  return value.split(splitRegex);
}

/**
 * `$set` and `>` / `~` arg-value quote-strip rules:
 *   - Matching outer `"..."` or `'...'`: stripped, inner whitespace preserved.
 *   - Mismatched / unquoted: verbatim, trailing whitespace trimmed.
 */
export function processSetValue(raw: string): string {
  const trimmed = raw.replace(/\s+$/, "");
  if (trimmed.length >= 2) {
    const first = trimmed[0]!;
    const last = trimmed[trimmed.length - 1]!;
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Tokenize whitespace-separated `key=value` pairs, respecting matching
 * single/double quotes and `[...]` brackets.
 */
export function tokenizeKeywordArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let bracketDepth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      current += ch;
      inQuote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") { bracketDepth++; current += ch; continue; }
    if (ch === "]" || ch === "}") { bracketDepth = Math.max(0, bracketDepth - 1); current += ch; continue; }
    if (/\s/.test(ch) && bracketDepth === 0) {
      if (current.trim() !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") tokens.push(current);
  return tokens;
}

function splitMcpConnectorPrefix(body: string): { connector: string | undefined; rest: string } {
  const m = MCP_CONNECTOR_PREFIX.exec(body);
  if (m === null) return { connector: undefined, rest: body };
  return { connector: m[1]!, rest: m[2]! };
}

function parseRetrievalArgs(
  argsStr: string,
  targetName: string,
): { params: NonNullable<SkillOp["retrievalParams"]>; errors: string[] } {
  const errors: string[] = [];
  const map: Record<string, string> = {};
  const tokens = tokenizeKeywordArgs(argsStr);
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq === -1) {
      errors.push(`Malformed \`>\` arg '${tok}' in target '${targetName}' — expected key=value`);
      continue;
    }
    const key = tok.slice(0, eq).trim();
    const rawValue = tok.slice(eq + 1);
    map[key] = processSetValue(rawValue);
  }
  for (const required of ["mode", "query", "limit"]) {
    if (!(required in map) || map[required] === "") {
      errors.push(`\`>\` op in target '${targetName}' missing required param '${required}'`);
    }
  }
  // Defer integer validation when the value contains a `$(VAR)` ref — runtime
  // substitutes + parses after the ref resolves. Literal numerics still
  // validate at parse time.
  let limit: number | string = 0;
  const rawLimit = map["limit"] ?? "";
  if (/\$\(/.test(rawLimit)) {
    limit = rawLimit;
  } else {
    const n = parseInt(rawLimit, 10);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push(`\`>\` op in target '${targetName}': 'limit' must be a positive integer or a \`$(VAR)\` ref (got '${rawLimit}')`);
    } else {
      limit = n;
    }
  }
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k === "mode" || k === "query" || k === "limit" || k === "connector") continue;
    extra[k] = v;
  }
  return {
    params: {
      mode: map["mode"] ?? "",
      query: map["query"] ?? "",
      limit,
      connector: map["connector"] ?? "primary",
      extra,
    },
    errors,
  };
}

function parseLocalModelArgs(
  argsStr: string,
  targetName: string,
): { params: NonNullable<SkillOp["localModelParams"]>; errors: string[] } {
  const errors: string[] = [];
  const map: Record<string, string> = {};
  const tokens = tokenizeKeywordArgs(argsStr);
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq === -1) {
      errors.push(`Malformed \`~\` arg '${tok}' in target '${targetName}' — expected key=value`);
      continue;
    }
    const key = tok.slice(0, eq).trim();
    const rawValue = tok.slice(eq + 1);
    map[key] = processSetValue(rawValue);
  }
  const recognized = new Set(["prompt", "model", "maxTokens", "timeoutSeconds"]);
  for (const key of Object.keys(map)) {
    if (!recognized.has(key)) {
      errors.push(`\`~\` op in target '${targetName}': unrecognized param '${key}' — strict grammar allows prompt/model/maxTokens/timeoutSeconds only. Interpolate context into the prompt string via $(...) instead.`);
    }
  }
  if (!("prompt" in map) || map["prompt"] === "") {
    errors.push(`\`~\` op in target '${targetName}' missing required param 'prompt'`);
  }
  // Defer integer validation when the value contains a `$(VAR)` ref.
  function deferInt(key: string): number | string | undefined {
    if (!(key in map)) return undefined;
    const raw = map[key]!;
    if (/\$\(/.test(raw)) return raw;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push(`\`~\` op in target '${targetName}': '${key}' must be a positive integer or a \`$(VAR)\` ref (got '${raw}')`);
      return undefined;
    }
    return n;
  }
  const maxTokens = deferInt("maxTokens");
  const timeoutSeconds = deferInt("timeoutSeconds");
  const params: NonNullable<SkillOp["localModelParams"]> = {
    prompt: map["prompt"] ?? "",
  };
  if ("model" in map && map["model"] !== "") params.model = map["model"]!;
  if (maxTokens !== undefined) params.maxTokens = maxTokens;
  if (timeoutSeconds !== undefined) params.timeoutSeconds = timeoutSeconds;
  return { params, errors };
}

interface ScopeFrame {
  // "unknown-block" — frame pushed for an unrecognized block-introducer
  // (v0.2.11 Bug 14: `parallel:`, `try:`, `catch X:`, etc.). Absorbs any
  // children at deeper indent so they don't cascade into "Mid-block indent
  // change" errors. The specific diagnostic was already emitted; this frame
  // just contains the fallout.
  kind: "main" | "target-else" | "foreach" | "if" | "elif" | "conditional-else" | "unknown-block";
  target: SkillTarget;
  opsBucket: SkillOp[];
  depth: number;
  ifOp?: SkillOp;
}

function popToDepth(stack: ScopeFrame[], targetDepth: number): void {
  while (stack.length > 0 && stack[stack.length - 1]!.depth > targetDepth) {
    stack.pop();
  }
}

/**
 * Parse a skill source string into an AST. Collects syntax errors in
 * `parseErrors`; never throws on bad input.
 */
/**
 * v0.4.2 — extract skill source from a markdown wrapper.
 *
 * `.skill.md` files contain prose + a fenced code block holding the
 * actual skill source. This helper scans for the first
 * ` ```skillscript ` or ` ```skill ` fenced block and returns its
 * contents. Cold-author LLMs (and humans) writing `.skill.md` will
 * naturally surround their skill code with markdown prose — the
 * extension promised markdown support; this delivers it.
 *
 * Semantics per Perry approval `efad035f`:
 *   - Fence label `skillscript` (primary) OR `skill` (alias)
 *   - First-block-wins: subsequent fenced blocks treated as illustrative
 *   - No-block files → returns `null` (caller surfaces `no-skill-code-block`)
 *
 * Callers that don't want extraction (loading `.skill` files, direct
 * string input, library API consumers) should NOT call this — they
 * pass raw source to `parse()` directly.
 */
export function extractSkillFromMarkdown(source: string): string | null {
  // Match ` ```skillscript ` or ` ```skill ` at line start, then content
  // up to the closing ` ``` ` fence. `m` flag for line-anchored `^` / `$`.
  // `[\s\S]` instead of `.` to match newlines in the body.
  const re = /^```(?:skillscript|skill)\s*\n([\s\S]*?)^```\s*$/m;
  const match = re.exec(source);
  if (match === null) return null;
  return match[1]!;
}

export function parse(source: string): ParsedSkill {
  // v0.4.2 — markdown unwrap. If the source has a ```skillscript or
  // ```skill fenced block, parse the block's contents; otherwise parse
  // the whole source as raw. Lenient by design: no error on missing
  // fence so existing pure-code files continue to work unchanged.
  // Cold authors who write markdown prose around their skill code get
  // their code extracted automatically.
  const extracted = extractSkillFromMarkdown(source);
  const effectiveSource = extracted !== null ? extracted : source;
  const lines = foldQuotedContinuations(effectiveSource.split("\n"));
  const result: ParsedSkill = {
    name: null,
    description: null,
    type: "procedural",
    status: null,
    timeout: null,
    vars: [],
    requires: [],
    requiredCapabilities: [],
    useWhen: null,
    targets: new Map(),
    entryTarget: null,
    onError: null,
    triggers: [],
    outputs: [],
    deliveryContext: null,
    templates: [],
    autonomous: null,
    parseErrors: [],
  };
  const tabLines = findTabIndentedLines(source);
  if (tabLines.length > 0) {
    const shown = tabLines.slice(0, 3).join(", ");
    const more = tabLines.length > 3 ? ` (+${tabLines.length - 3} more)` : "";
    result.parseErrors.push(
      `Tab characters in indentation at line ${shown}${more}. Skillscript requires spaces-only indentation — replace tabs with spaces (conventional indent is 4 spaces).`,
    );
  }
  let currentTarget: SkillTarget | null = null;
  let scopeStack: ScopeFrame[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "") {
      // v0.2.12 Bug 15. Blank lines must NOT reset currentTarget/scopeStack —
      // they're free-form whitespace authors use to visually section a long
      // target body. Pre-Bug-15 the reset silently truncated everything after
      // a blank line inside a nested `else:` / `foreach` body (compile passed
      // clean + lint passed clean + the rendered artifact stopped mid-body,
      // a production-broken-silently failure). Boundary detection between
      // targets is handled by the target-header path below (line ~830) which
      // re-anchors `currentTarget` and resets `scopeStack` whenever a
      // non-indented `target:` line appears. The `default:` path resets too.
      // So no blank-line reset is needed — and forcing one was a footgun.
      continue;
    }
    if (line.startsWith("#")) {
      const stripped = line.replace(/^#\s*/, "");
      const colonIdx = stripped.indexOf(":");
      if (colonIdx === -1) continue;
      const key = stripped.slice(0, colonIdx).trim().toLowerCase();
      const value = stripped.slice(colonIdx + 1).trim();
      if (key === "skill") {
        const diag = checkReserved(value, "a skill name", `${value}-task`);
        if (diag !== null) result.parseErrors.push(diag);
        result.name = value;
      } else if (key === "description") {
        result.description = value;
      } else if (key === "type") {
        const norm = normalizeEnumValue(value, ["procedural", "data"] as const);
        if (norm !== null) {
          result.type = norm;
        } else {
          result.parseErrors.push(`\`# Type:\` value must be 'procedural' or 'data' (got '${value}')`);
        }
      } else if (key === "status") {
        const norm = normalizeEnumValue(value, ["Draft", "Approved", "Disabled"] as const);
        if (norm !== null) {
          result.status = norm;
        } else {
          result.parseErrors.push(`\`# Status:\` value must be 'Draft', 'Approved', or 'Disabled' (got '${value}')`);
        }
      } else if (key === "autonomous") {
        // v0.4.2 — declarative authorship intent marker for unattended-
        // execution skills. Today silences `unconfirmed-mutation` lint;
        // the header is a category marker, future rules + scheduling +
        // discovery can hook into the same field. Per Perry 8a7356dc /
        // efad035f.
        const lower = value.toLowerCase();
        if (lower === "true") result.autonomous = true;
        else if (lower === "false") result.autonomous = false;
        else result.parseErrors.push(`\`# Autonomous:\` value must be 'true' or 'false' (got '${value}')`);
      } else if (key === "timeout") {
        // Per lesson ab6c19db: defer integer validation when value contains
        // `$(VAR)` ref. Runtime resolves via resolveIntParam at op dispatch.
        if (/\$\(/.test(value)) {
          result.timeout = value;
        } else {
          const n = parseInt(value, 10);
          if (!Number.isFinite(n) || n <= 0) {
            result.parseErrors.push(`\`# Timeout:\` must be a positive integer (seconds) or a \`$(VAR)\` ref (got '${value}').`);
          } else {
            result.timeout = n;
          }
        }
      } else if (key === "vars") {
        if (value.toLowerCase() === "(none)" || value === "") {
          result.vars = [];
        } else {
          result.vars = splitVarsLine(value).map((entry) => {
            const trimmed = entry.trim();
            const eq = trimmed.indexOf("=");
            const varName = eq === -1 ? trimmed : trimmed.slice(0, eq).trim();
            const diag = checkReserved(varName, "a variable name", `${varName}_value`);
            if (diag !== null) result.parseErrors.push(diag);
            if (eq === -1) {
              return { name: varName, required: true };
            }
            return {
              name: varName,
              default: trimmed.slice(eq + 1).trim(),
              required: false,
            };
          });
        }
      } else if (key === "use when") {
        result.useWhen = value;
      } else if (key === "onerror") {
        result.onError = value === "" ? null : value;
      } else if (key === "triggers") {
        if (value.toLowerCase() === "(none)" || value === "") continue;
        for (const raw of splitTriggersLine(value)) {
          const decl = raw.trim();
          if (decl === "") continue;
          const colon = decl.indexOf(":");
          if (colon === -1) {
            result.parseErrors.push(`Malformed \`# Triggers:\` declaration '${decl}' — expected '<source>: <name>'`);
            continue;
          }
          const rawSource = decl.slice(0, colon).trim();
          const name = decl.slice(colon + 1).trim();
          const allowed = ["session", "cron", "event", "agent-event", "file-watch", "sensor"] as const;
          const source = normalizeEnumValue(rawSource, allowed);
          if (source === null) {
            result.parseErrors.push(`Unsupported trigger source '${rawSource}' — allowed: ${allowed.join(", ")}`);
            continue;
          }
          if (name === "") {
            result.parseErrors.push(`\`# Triggers:\` declaration '${decl}' has empty name`);
            continue;
          }
          result.triggers.push({ source, name });
        }
      } else if (key === "output") {
        if (value.toLowerCase() === "(none)" || value === "") continue;
        for (const raw of splitVarsLine(value)) {
          const decl = raw.trim();
          if (decl === "") continue;
          const allowedKinds = ["text", "slack", "prompt-context", "template", "file", "card", "none"] as const;
          const colon = decl.indexOf(":");
          if (colon === -1) {
            const bareKind = normalizeEnumValue(decl, allowedKinds);
            if (bareKind === "text" || bareKind === "none") {
              result.outputs.push({ kind: bareKind });
            } else {
              result.parseErrors.push(`\`# Output:\` kind '${decl}' missing target — kinds 'slack', 'prompt-context', 'template', 'file', 'card' require '<kind>: <target>'. Only 'text' and 'none' are bare-only.`);
            }
            continue;
          }
          const rawKind = decl.slice(0, colon).trim();
          const target = decl.slice(colon + 1).trim();
          const kind = normalizeEnumValue(rawKind, allowedKinds);
          if (kind === null) {
            result.parseErrors.push(`Unsupported output kind '${rawKind}' — allowed: ${allowedKinds.join(", ")}`);
            continue;
          }
          if (kind === "text" || kind === "none") {
            result.parseErrors.push(`\`# Output:\` kind '${kind}' is bare-only — no target accepted (got '${target}'). Use '# Output: ${kind}' instead.`);
            continue;
          }
          if (target === "") {
            result.parseErrors.push(`\`# Output:\` kind '${kind}' requires a target after the colon`);
            continue;
          }
          result.outputs.push({ kind, target });
        }
      } else if (key === "delivery-context") {
        // Augmenting/Template-only — routed to the receiving agent alongside
        // the augment payload so they know *why* the delivery fired. Empty
        // value clears the field; the lint rule `unused-augmenting-header`
        // catches use on Headless skills. v0.2.6 addition.
        result.deliveryContext = value === "" ? null : value;
      } else if (key === "templates") {
        // Comma-separated Template-skill names the receiving agent may fetch
        // as follow-on actions. v0.2.6 addition.
        if (value.toLowerCase() === "(none)" || value === "") {
          result.templates = [];
        } else {
          result.templates = splitVarsLine(value)
            .map((s) => s.trim())
            .filter((s) => s !== "");
        }
      } else if (key === "requires") {
        if (value.toLowerCase() === "(none)" || value === "") continue;
        const match = REQUIRES_LINE.exec(value);
        if (match) {
          const [, namespace, k, target, fallback] = match;
          result.requires.push({
            namespace: namespace as "user-var" | "system-var",
            key: k!,
            target: target!,
            // v0.2.12 Bug 22: strip surrounding quotes on the fallback —
            // every other (fallback: "...") parse site routes through
            // processSetValue. Pre-fix, `(fallback: "stranger")` bound the
            // target var to the literal string `"stranger"` (quotes and all).
            fallback: fallback === undefined ? null : processSetValue(fallback),
            raw: value,
          });
        } else {
          // Try capability form: space-separated `connector_type.feature_flag`
          // tokens. Silently drop the line if it matches neither shape
          // (existing parser convention for unknown # Requires: dialects).
          const tokens = value.trim().split(/\s+/);
          if (tokens.length > 0 && tokens.every((t) => CAPABILITY_TOKEN.test(t))) {
            for (const t of tokens) result.requiredCapabilities.push(t);
          }
        }
      }
      continue;
    }
    if (!/^\s/.test(line) && /^(if|elif)\s+/.test(line)) {
      result.parseErrors.push("`if:` / `elif:` only valid inside a target body, not at top level");
      continue;
    }
    if (!/^\s/.test(line) && /^else:\s*$/.test(line)) {
      if (!currentTarget || scopeStack.length === 0) {
        result.parseErrors.push("`else:` block has no preceding target body to attach to");
        continue;
      }
      const top = scopeStack[scopeStack.length - 1]!;
      if (top.kind === "target-else") {
        result.parseErrors.push(`Nested or duplicate \`else:\` block in target '${currentTarget.name}'`);
        continue;
      }
      scopeStack.pop();
      currentTarget.elseBlock = [];
      scopeStack.push({
        kind: "target-else",
        target: currentTarget,
        opsBucket: currentTarget.elseBlock,
        depth: INDENT_STEP,
      });
      continue;
    }
    if (!/^\s/.test(line)) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const name = line.slice(0, colonIdx).trim();
      // v0.4.2 — strict-target-detection. Target names follow the
      // canonical identifier shape `[A-Za-z_][\w-]*`. Lines like
      // `## Use this:` or `Note that:` look like targets to the naive
      // colon-finder but are actually markdown prose. Silently treat
      // non-conforming names as comments instead of misparsing them
      // as malformed target declarations (the original cold-author
      // footgun from `fbf10206`). Pairs with markdown-extraction:
      // even without a fenced block, prose lines no longer cascade
      // into missing-dep errors.
      if (!/^[A-Za-z_][\w-]*$/.test(name)) continue;
      let depsStr = line.slice(colonIdx + 1).trim();
      // Accept `target: needs: dep1 dep2` form per language reference §1
      // overview ("declares targets and their dependencies (`needs:` keyword)").
      // The keyword is optional — the canonical/terse form is just
      // `target: dep1 dep2`. Both shapes parse to the same dep list.
      if (/^needs\s*:\s*/.test(depsStr)) {
        depsStr = depsStr.replace(/^needs\s*:\s*/, "");
      }
      // Separator: whitespace OR comma (or both). Cold-agent corpus
      // surfaced `target: needs: a, b, c` as a natural form alongside
      // `target: a b c`. Both shapes parse to the same dep list.
      const deps = depsStr === "" ? [] : depsStr.split(/[\s,]+/).filter((s) => s !== "");
      if (name === "default") {
        result.entryTarget = deps[0] ?? null;
        currentTarget = null;
        scopeStack = [];
        continue;
      }
      const targetReserved = checkReserved(name, "a target name", `${name}_target`);
      if (targetReserved !== null) result.parseErrors.push(targetReserved);
      currentTarget = { name, deps, ops: [] };
      scopeStack = [{
        kind: "main",
        target: currentTarget,
        opsBucket: currentTarget.ops,
        depth: INDENT_STEP,
      }];
      result.targets.set(name, currentTarget);
      continue;
    }
    if (!currentTarget || scopeStack.length === 0) continue;
    const lineIndent = leadingSpaces(rawLine);
    const stripped0 = line.replace(/^\s+/, "");
    // Conditional chain continuation: `elif:` / `else:` re-enters the same
    // if-frame depth. MUST run before popToDepth so the dedent doesn't fire
    // first and pop the if-body frame we're trying to extend.
    // v0.2.10 Bug 3: search DOWN the stack for the matching if/elif frame,
    // not just the top — nested control flow (if-in-elif then sibling else)
    // leaves inner frames above the if-frame we're continuing.
    let contIdx = -1;
    if (stripped0.startsWith("elif ") || /^else:\s*$/.test(stripped0)) {
      for (let i = scopeStack.length - 1; i >= 0; i--) {
        const f = scopeStack[i]!;
        if ((f.kind === "if" || f.kind === "elif") && f.depth === lineIndent + INDENT_STEP) { contIdx = i; break; }
      }
    }
    if (contIdx >= 0) {
      const preTop = scopeStack[contIdx]!;
      const ifOp = preTop.ifOp!;
      const continuationDepth = preTop.depth;
      scopeStack.length = contIdx;
      if (stripped0.startsWith("elif ")) {
        const elifMatch = ELIF_OP_REGEX.exec(stripped0);
        if (!elifMatch) {
          result.parseErrors.push(`Malformed \`elif\` op in target '${currentTarget.name}' — expected \`elif COND:\``);
          continue;
        }
        const cond = elifMatch[1]!.trim();
        const eqDiag = detectSingleEqualsInCondition(cond);
        if (eqDiag !== null) {
          result.parseErrors.push(`\`elif\` in target '${currentTarget.name}': ${eqDiag}`);
          // v0.3.4: sink-scope for parser-recovery consistency with
          // the `if` single-= path and the validateCondition rejection
          // path. Body lines drop into throwaway bucket; no cascade.
          const sinkBranch = { cond, body: [] };
          scopeStack.push({
            kind: "elif",
            target: currentTarget,
            opsBucket: sinkBranch.body,
            depth: continuationDepth,
            ifOp,
          });
          continue;
        }
        if (!validateCondition(cond)) {
          result.parseErrors.push(`Unsupported condition in \`elif\` (target '${currentTarget.name}'): \`${cond}\` — supported shapes: truthy \`$(REF)\`; \`$(REF) ==/!=/</>/<=/>= "literal"\` or \`$(REF) ==/!=/</>/<=/>= $(REF)\`; \`$(REF) (not) in $(REF)\`; composable with \`and\` / \`or\` / \`not\` and parens. Filters + dotted-field allowed inside \`$(REF)\` (e.g. \`$(ITEMS|length) > "0"\`). To access fields on parsed JSON, use \`$ json_parse $(VAR) -> P\` then refer to \`$(P.field)\` (the \`$(VAR|filter).field\` shape is not supported)`);
          // v0.3.3 Bug D: sink-scope so body lines don't cascade. Mirror
          // of the `if`-rejection path above. Synthetic branch isn't
          // appended to the real ifOp's ifBranches — body lines collect
          // into a throwaway bucket and drop at scope pop.
          const sinkBranch = { cond, body: [] };
          scopeStack.push({
            kind: "elif",
            target: currentTarget,
            opsBucket: sinkBranch.body,
            depth: continuationDepth,
            ifOp,
          });
          continue;
        }
        const newBranch = { cond, body: [] };
        ifOp.ifBranches!.push(newBranch);
        scopeStack.push({
          kind: "elif",
          target: currentTarget,
          opsBucket: newBranch.body,
          depth: continuationDepth,
          ifOp,
        });
      } else {
        ifOp.ifElseBody = [];
        scopeStack.push({
          kind: "conditional-else",
          target: currentTarget,
          opsBucket: ifOp.ifElseBody,
          depth: continuationDepth,
          ifOp,
        });
      }
      continue;
    }
    popToDepth(scopeStack, lineIndent);
    if (scopeStack.length === 0) continue;
    const topFrame = scopeStack[scopeStack.length - 1]!;
    if (topFrame.depth !== lineIndent) {
      result.parseErrors.push(
        `Mid-block indent change in target '${currentTarget.name}': line indented to ${lineIndent} spaces but enclosing block expects ${topFrame.depth}. Use consistent indentation within a block.`,
      );
      continue;
    }
    const opBucket = topFrame.opsBucket;
    // `needs: dep1 dep2` body-line form for declaring target deps. Only
    // recognized at the main target-body scope (not inside foreach/if/else
    // sub-blocks). Cold-agent corpus surfaced this as a natural authoring
    // style alongside `target: dep1 dep2` and `target: needs: dep1`.
    if (topFrame.kind === "main" && /^needs\s*:/.test(stripped0)) {
      const depsTail = stripped0.replace(/^needs\s*:\s*/, "");
      const newDeps = depsTail.split(/[\s,]+/).filter((s) => s !== "");
      for (const d of newDeps) currentTarget.deps.push(d);
      continue;
    }
    if (stripped0.startsWith("elif ")) {
      result.parseErrors.push(`\`elif\` without preceding \`if:\` in target '${currentTarget.name}'`);
      continue;
    }
    if (stripped0.startsWith("if ")) {
      const ifMatch = IF_OP_REGEX.exec(stripped0);
      if (!ifMatch) {
        result.parseErrors.push(`Malformed \`if\` op in target '${currentTarget.name}' — expected \`if COND:\``);
        continue;
      }
      const cond = ifMatch[1]!.trim();
      const eqDiag = detectSingleEqualsInCondition(cond);
      if (eqDiag !== null) {
        result.parseErrors.push(`\`if\` in target '${currentTarget.name}': ${eqDiag}`);
        // v0.3.4: same sink-scope treatment as the validateCondition
        // rejection path below — kills the indent cascade after a
        // rejected single-= condition. Parser-recovery should be
        // consistent across all condition-rejection paths.
        const sinkBranch = { cond, body: [] };
        const sinkIfOp: SkillOp = { kind: "if", body: stripped0, ifBranches: [sinkBranch] };
        scopeStack.push({
          kind: "if",
          target: currentTarget,
          opsBucket: sinkBranch.body,
          depth: lineIndent + INDENT_STEP,
          ifOp: sinkIfOp,
        });
        continue;
      }
      if (!validateCondition(cond)) {
        result.parseErrors.push(`Unsupported condition in \`if\` (target '${currentTarget.name}'): \`${cond}\` — supported shapes: truthy \`$(REF)\`; \`$(REF) ==/!=/</>/<=/>= "literal"\` or \`$(REF) ==/!=/</>/<=/>= $(REF)\`; \`$(REF) (not) in $(REF)\`; composable with \`and\` / \`or\` / \`not\` and parens. Filters + dotted-field allowed inside \`$(REF)\` (e.g. \`$(ITEMS|length) > "0"\`). To access fields on parsed JSON, use \`$ json_parse $(VAR) -> P\` then refer to \`$(P.field)\` (the \`$(VAR|filter).field\` shape is not supported)`);
        // v0.3.3 Bug D: push a sink scope frame so body lines (correctly
        // indented relative to the rejected `if`) don't cascade into
        // misleading `Mid-block indent change` errors. The synthetic ifOp
        // isn't added to the AST — the body lines collect into a
        // throwaway opsBucket that gets dropped at scope pop.
        const sinkBranch = { cond, body: [] };
        const sinkIfOp: SkillOp = { kind: "if", body: stripped0, ifBranches: [sinkBranch] };
        scopeStack.push({
          kind: "if",
          target: currentTarget,
          opsBucket: sinkBranch.body,
          depth: lineIndent + INDENT_STEP,
          ifOp: sinkIfOp,
        });
        continue;
      }
      const firstBranch = { cond, body: [] };
      const ifOp: SkillOp = {
        kind: "if",
        body: stripped0,
        ifBranches: [firstBranch],
      };
      opBucket.push(ifOp);
      scopeStack.push({
        kind: "if",
        target: currentTarget,
        opsBucket: firstBranch.body,
        depth: lineIndent + INDENT_STEP,
        ifOp,
      });
      continue;
    }
    if (stripped0.startsWith("> ")) {
      const match = RETRIEVAL_OP_REGEX.exec(stripped0);
      if (!match) {
        result.parseErrors.push(`Malformed \`>\` op in target '${currentTarget.name}' — expected \`> key=value ... -> VARNAME [(fallback: "value")]\``);
        continue;
      }
      const [, argsStr, outputVar, fallback] = match;
      const parsed = parseRetrievalArgs(argsStr!, currentTarget.name);
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) result.parseErrors.push(e);
        continue;
      }
      if (fallback !== undefined) parsed.params.fallback = processSetValue(fallback);
      opBucket.push({
        kind: ">",
        body: stripped0,
        outputVar: outputVar!,
        retrievalParams: parsed.params,
      });
      continue;
    }
    if (stripped0.startsWith("~ ")) {
      const match = LOCAL_MODEL_OP_REGEX.exec(stripped0);
      if (!match) {
        result.parseErrors.push(`Malformed \`~\` op in target '${currentTarget.name}' — expected \`~ key=value ... -> VARNAME [(fallback: "value")]\``);
        continue;
      }
      const [, argsStr, outputVar, fallback] = match;
      const parsed = parseLocalModelArgs(argsStr!, currentTarget.name);
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) result.parseErrors.push(e);
        continue;
      }
      if (fallback !== undefined) parsed.params.fallback = processSetValue(fallback);
      opBucket.push({
        kind: "~",
        body: stripped0,
        outputVar: outputVar!,
        localModelParams: parsed.params,
      });
      continue;
    }
    if (stripped0.startsWith("& ")) {
      const match = AMPERSAND_OP_REGEX.exec(stripped0);
      if (!match) {
        result.parseErrors.push(`Malformed \`&\` op in target '${currentTarget.name}' — expected \`& skill-name [key=value ...] [-> VARNAME]\``);
        continue;
      }
      const [, skillName, argsStr, outputVar, ampFallback] = match;
      const args: Record<string, string> = {};
      const tokens = tokenizeKeywordArgs(argsStr ?? "");
      let argError = false;
      for (const tok of tokens) {
        const eq = tok.indexOf("=");
        if (eq === -1) {
          result.parseErrors.push(`Malformed \`&\` arg '${tok}' in target '${currentTarget.name}' — expected key=value`);
          argError = true;
          continue;
        }
        args[tok.slice(0, eq).trim()] = processSetValue(tok.slice(eq + 1));
      }
      if (argError) continue;
      const ampOp: SkillOp = {
        kind: "&",
        body: stripped0,
        ampParams: { skillName: skillName!, args },
      };
      if (outputVar !== undefined) ampOp.outputVar = outputVar;
      if (ampFallback !== undefined) ampOp.fallback = processSetValue(ampFallback);
      opBucket.push(ampOp);
      continue;
    }
    if (stripped0.startsWith("foreach ")) {
      const fmatch = FOREACH_OP_REGEX.exec(stripped0);
      if (!fmatch) {
        result.parseErrors.push(`Malformed \`foreach\` op in target '${currentTarget.name}' — expected \`foreach IDENT in EXPR:\``);
        continue;
      }
      const [, iter, listExpr] = fmatch;
      const iterReserved = checkReserved(iter!, "a foreach iterator", `${iter}_item`);
      if (iterReserved !== null) result.parseErrors.push(iterReserved);
      const foreachOp: SkillOp = {
        kind: "foreach",
        body: stripped0,
        foreachIter: iter!,
        foreachList: listExpr!.trim(),
        foreachBody: [],
      };
      opBucket.push(foreachOp);
      scopeStack.push({
        kind: "foreach",
        target: currentTarget,
        opsBucket: foreachOp.foreachBody!,
        depth: lineIndent + INDENT_STEP,
      });
      continue;
    }
    const stripped = line.replace(/^\s+/, "");
    let kind: OpKind | null = null;
    let body = "";
    let mcpConnectorForOp: string | undefined = undefined;
    let atPolicy: "unsafe" | undefined = undefined;
    let atOutputVar: string | undefined = undefined;
    let atFallback: string | undefined = undefined;
    // Check `??` before `?`, `$set` before `$`.
    if (stripped.startsWith("?? ") || stripped === "??") {
      const tail = stripped.slice(3).trim();
      const m = /^(.+?)\s+->\s+([A-Za-z_]\w*)\s*$/.exec(tail);
      if (m !== null) {
        opBucket.push({ kind: "??", body: m[1]!.trim(), outputVar: m[2]! });
      } else {
        opBucket.push({ kind: "??", body: tail });
      }
      continue;
    } else if (stripped.startsWith("$set ") || stripped === "$set") {
      const match = SET_OP_REGEX.exec(stripped);
      if (match) {
        const [, setName, rawValue] = match;
        opBucket.push({
          kind: "$set",
          body: stripped,
          setName: setName!,
          setValue: processSetValue(rawValue!),
        });
      }
      continue;
    } else if (stripped.startsWith("$append ") || stripped === "$append") {
      const match = APPEND_OP_REGEX.exec(stripped);
      if (match) {
        const [, setName, rawValue] = match;
        opBucket.push({
          kind: "$append",
          body: stripped,
          setName: setName!,
          setValue: processSetValue(rawValue!),
        });
      } else {
        result.parseErrors.push(`Malformed \`$append\` op in target '${currentTarget.name}' — expected \`$append VAR <value>\` (value can be a literal, \`$(REF)\`, or filtered ref).`);
      }
      continue;
    } else if (stripped.startsWith("$ ") || stripped === "$") {
      const tail = stripped.slice(2).trim();
      // `$ <tool> args -> VAR [(fallback: <value>)]` — fallback optional.
      const dollarOutMatch = /^(.+?)\s+->\s+([A-Za-z_]\w*)(?:\s+\(fallback\s*:\s*(.+?)\))?\s*$/.exec(tail);
      if (dollarOutMatch !== null) {
        const bodyPart = dollarOutMatch[1]!.trim();
        const { connector, rest } = splitMcpConnectorPrefix(bodyPart);
        const dollarFallback = dollarOutMatch[3];
        opBucket.push({
          kind: "$",
          body: rest,
          outputVar: dollarOutMatch[2]!,
          ...(connector !== undefined ? { mcpConnector: connector } : {}),
          ...(dollarFallback !== undefined ? { fallback: processSetValue(dollarFallback) } : {}),
        });
        continue;
      }
      const { connector, rest } = splitMcpConnectorPrefix(tail);
      kind = "$";
      body = rest;
      mcpConnectorForOp = connector;
    } else if (stripped.startsWith("? ") || stripped === "?") {
      kind = "?";
      body = stripped.slice(2).trim();
    } else if (stripped.startsWith("@ ") || stripped === "@") {
      kind = "@";
      let tail = stripped.slice(2).trim();
      // Optional output binding: `-> VAR [(fallback: "...")]` at end of line.
      // v0.2.4 Bug F: the trailing `(fallback: ...)` clause is now supported
      // for parity with $/~/> ops — cold authors reach for op-level fallback
      // as a defensive-coding posture and previously hit silent
      // outputVar-not-bound failures.
      const outMatch = /^(.+?)\s+->\s+([A-Za-z_]\w*)(?:\s+\(fallback\s*:\s*(.+?)\))?\s*$/.exec(tail);
      if (outMatch !== null) {
        atOutputVar = outMatch[2]!;
        if (outMatch[3] !== undefined) atFallback = processSetValue(outMatch[3]);
        tail = outMatch[1]!.trim();
      }
      // `@ unsafe <command>` — `unsafe` as literal first token signals
      // opt-in full-shell exec (vs default structured-spawn sandbox).
      const unsafeMatch = /^unsafe(?:\s+(.*))?$/.exec(tail);
      if (unsafeMatch !== null) {
        atPolicy = "unsafe";
        body = (unsafeMatch[1] ?? "").trim();
      } else {
        body = tail;
      }
    } else if (stripped.startsWith("! ") || stripped === "!") {
      kind = "!";
      body = stripped.slice(2).trim();
    }
    if (kind !== null) {
      opBucket.push({
        kind,
        body,
        ...(mcpConnectorForOp !== undefined ? { mcpConnector: mcpConnectorForOp } : {}),
        ...(atPolicy !== undefined ? { policy: atPolicy } : {}),
        ...(atOutputVar !== undefined ? { outputVar: atOutputVar } : {}),
        ...(atFallback !== undefined ? { fallback: atFallback } : {}),
      });
      continue;
    }
    // v0.2.11 Bug 14: unrecognized block-introducer (e.g. `parallel:`,
    // `try:`, `catch X:`, `branch X:`). Pre-Bug-14 this fell silently to
    // the kind-null no-op branch, and the indented children below it
    // tripped "Mid-block indent change" — a confusing cascade. Now we
    // emit a specific diagnostic AND push an "unknown-block" frame to
    // absorb the children. Known body-scope introducers are if/elif/
    // else/foreach (all handled earlier in this dispatch).
    if (UNKNOWN_BLOCK_INTRODUCER_RE.test(stripped0)) {
      const keyword = stripped0.replace(/[:\s].*$/, "");
      result.parseErrors.push(
        `Unknown block-introducer '${keyword}:' in target '${currentTarget.name}'. ` +
        `Skillscript recognizes \`if COND:\`, \`elif COND:\`, \`else:\`, and \`foreach IT in $(LIST):\` ` +
        `at body scope (target-level \`else:\` is the error handler). ` +
        `Composition is via \`& skill-name\` (data-skill inline) or \`$ execute_skill skill_name="..."\` (in-skill invocation), not block syntax.`,
      );
      scopeStack.push({
        kind: "unknown-block",
        target: currentTarget,
        opsBucket: [],
        depth: lineIndent + INDENT_STEP,
      });
    }
  }

  if (result.entryTarget === null && result.targets.size > 0) {
    const names = Array.from(result.targets.keys());
    result.entryTarget = names[names.length - 1] ?? null;
  }
  return result;
}

// Toposort moved to compile.ts (semantic analysis). applyFilter moved to
// filters.ts (predictable filter-add location per ERD §2 modifiability).
