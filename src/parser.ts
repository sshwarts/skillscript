// Source text → AST. The parser recognizes the full v1 grammar but performs
// no resolution against external state. Semantic analysis (variable resolution,
// data-skill inlining, topo-sort) lives in compile.ts.

export type OpKind = "$" | "$set" | "?" | "@" | "!" | "??" | "foreach" | "if" | ">" | "~" | "&";

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
  parseErrors: string[];
}

// Regex grammar.
const REQUIRES_LINE = /^(user-var|system-var):([A-Za-z0-9_-]+)\s*(?:→|->)\s*([A-Za-z_][\w-]*)\s*(?:\(\s*fallback\s*:\s*(.+?)\s*\)\s*)?$/;
/** Capability token: `connector_type.feature_flag`. Matches one space-separated token of a capability `# Requires:` line. */
const CAPABILITY_TOKEN = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
/** `&` op: `& skill-name [arg=value ...] [-> VARNAME]`. Skill names follow the same charset as filesystem-safe identifiers (alphanumeric, hyphen, underscore). */
const AMPERSAND_OP_REGEX = /^&\s+([A-Za-z0-9][\w-]*)\s*(.*?)(?:\s*->\s*([A-Za-z_]\w*))?(?:\s+\(fallback\s*:\s*(.+?)\))?\s*$/s;
const SET_OP_REGEX = /^\$set\s+([A-Za-z_]\w*)\s*=\s*(.*)$/;
const FOREACH_OP_REGEX = /^foreach\s+([A-Za-z_]\w*)\s+in\s+(.+?):\s*$/;
const IF_OP_REGEX = /^if\s+(.+?):\s*$/;
const ELIF_OP_REGEX = /^elif\s+(.+?):\s*$/;
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

// Narrow v1 condition grammar. AND/OR, numeric comparisons, defined-checks
// are deliberately excluded — lint surfaces complexity-creep at authoring time.
const COND_TRUTHY = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)?\)\s*$/;
/** `$(REF) ==/!= "literal"` — ref-vs-string equality. */
const COND_EQ = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)?\)\s*(?:==|!=)\s*"[^"]*"\s*$/;
/**
 * `$(REF) ==/!= $(REF)` — ref-vs-ref equality. Extended 2026-05-21 per
 * language reference §5; surfaced by the cold-agent skills battery (a
 * sub-agent reached for `$(FP|trim) == $(LAST_FP|trim)` unprompted as
 * the natural change-detection pattern). Filters + dotted field access
 * permitted on either side.
 */
const COND_EQ_REF = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)?\)\s*(?:==|!=)\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)?\)\s*$/;
/**
 * `$(REF) </>/<=/>= "literal"` and `$(REF) </>/<=/>= $(REF)` — numeric
 * comparison. v0.2.5 addition per the orchestration carve-out: comparison
 * is orchestration; arithmetic + aggregates stay in tools. Both sides
 * coerce to number at runtime; non-numeric → TypeMismatchError. Filters +
 * dotted field access permitted on either side, matching EQ/EQ_REF shape.
 */
const COND_CMP = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)?\)\s*(?:<=|>=|<|>)\s*"[^"]*"\s*$/;
const COND_CMP_REF = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)?\)\s*(?:<=|>=|<|>)\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)?\)\s*$/;
const COND_IN = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)?\)\s+(?:not\s+)?in\s+\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\)\s*$/;

function validateCondition(cond: string): boolean {
  return COND_TRUTHY.test(cond) || COND_EQ.test(cond) || COND_EQ_REF.test(cond) ||
         COND_CMP.test(cond) || COND_CMP_REF.test(cond) || COND_IN.test(cond);
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
function splitVarsLine(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let bracketDepth = 0;
  for (const ch of value) {
    if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (ch === "," && bracketDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
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
    if (ch === "[") { bracketDepth++; current += ch; continue; }
    if (ch === "]") { bracketDepth = Math.max(0, bracketDepth - 1); current += ch; continue; }
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
  kind: "main" | "target-else" | "foreach" | "if" | "elif" | "conditional-else";
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
export function parse(source: string): ParsedSkill {
  const lines = foldQuotedContinuations(source.split("\n"));
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
      currentTarget = null;
      scopeStack = [];
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
      } else if (key === "requires") {
        if (value.toLowerCase() === "(none)" || value === "") continue;
        const match = REQUIRES_LINE.exec(value);
        if (match) {
          const [, namespace, k, target, fallback] = match;
          result.requires.push({
            namespace: namespace as "user-var" | "system-var",
            key: k!,
            target: target!,
            fallback: fallback === undefined ? null : fallback,
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
    if (
      (stripped0.startsWith("elif ") || /^else:\s*$/.test(stripped0)) &&
      (scopeStack[scopeStack.length - 1]!.kind === "if" || scopeStack[scopeStack.length - 1]!.kind === "elif") &&
      scopeStack[scopeStack.length - 1]!.depth === lineIndent + INDENT_STEP
    ) {
      const preTop = scopeStack[scopeStack.length - 1]!;
      const ifOp = preTop.ifOp!;
      const continuationDepth = preTop.depth;
      scopeStack.pop();
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
          continue;
        }
        if (!validateCondition(cond)) {
          result.parseErrors.push(`Unsupported condition in \`elif\` (target '${currentTarget.name}'): \`${cond}\` — v1 grammar is truthy / \`==\` / \`!=\` against quoted literals, or \`in\` / \`not in\` between two \`$(NAME)\` refs`);
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
        continue;
      }
      if (!validateCondition(cond)) {
        result.parseErrors.push(`Unsupported condition in \`if\` (target '${currentTarget.name}'): \`${cond}\` — v1 grammar is truthy / \`==\` / \`!=\` against quoted literals, or \`in\` / \`not in\` between two \`$(NAME)\` refs`);
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
