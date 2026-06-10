// Source text → AST. The parser recognizes the full v1 grammar but performs
// no resolution against external state. Semantic analysis (variable resolution,
// data-skill inlining, topo-sort) lives in compile.ts.

export type OpKind = "$" | "$set" | "$append" | "?" | "shell" | "emit" | "foreach" | "if" | "inline" | "file_read" | "file_write" | "notify";

/**
 * Runtime-intrinsic function-call names. Closed set of ops the language
 * implements directly (no MCP dispatch). Function-call grammar:
 * `verb(kwarg=value, ...) [-> BINDING]`.
 *
 * Anything else with function-call shape is rejected by parser with a
 * remediation pointing at `$ tool args -> R` for MCP dispatch.
 */
export const RUNTIME_INTRINSIC_FN_NAMES = [
  "emit",          // output to skill consumer
  "inline",        // compile-time skill composition
  "execute_skill", // runtime skill invocation (dispatches via $ execute_skill)
  "shell",         // local subprocess
  "file_read",     // read file contents at runtime
  "file_write",    // write file contents at runtime
  "notify",        // mid-skill synchronous agent alert via AgentConnector(s)
] as const;

export interface SkillOp {
  kind: OpKind;
  body: string;
  outputVar?: string;
  mcpConnector?: string;
  /**
   * `inline` ops only: skill name + optional key=value args passed as inputs
   * when the target is procedural (runtime invocation), ignored when the
   * target is data-typed (compile-time inline). `outputVar` captures the
   * result of procedural invocations; absent for data inlines.
   */
  ampParams?: {
    skillName: string;
    args: Record<string, string>;
  };
  /**
   * `shell` ops only: when `unsafe=true` kwarg is set, the runtime routes
   * through full-shell exec (vs default structured-spawn sandbox). Refused
   * unless `runtime.enable_unsafe_shell = true` (default false). Default
   * `shell(...)` ops route through structured spawn — one binary, no shell
   * interpretation.
   */
  policy?: "unsafe";
  /**
   * v0.19.11 — `shell` ops only: explicit argv form. When set, the
   * runtime spawns `argv[0]` with `argv.slice(1)` as arguments DIRECTLY
   * — no tokenization, no quote-stripping, no shell. Each element is
   * exactly one argv token; `${VAR}` substitution happens per element
   * and the result does NOT get re-split, so an arg with spaces stays
   * one arg. Strictly safer than `unsafe=true` (no shell process; no
   * metacharacter interpretation; injection-surface zero).
   *
   * Mutually exclusive with `body` (command=) and with `policy=unsafe`.
   * Closes Perry's `adc87d52` cold-author-safety finding — the safe
   * path for args-with-spaces was previously obscure (file roundtrip
   * trick); `argv` makes it discoverable + first-class.
   */
  argv?: string[];
  setName?: string;
  setValue?: string;
  /**
   * Op-level fallback. On op throw or empty result, runtime binds this value
   * to the output var instead of propagating the error.
   */
  fallback?: string;
  foreachIter?: string;
  foreachList?: string;
  foreachBody?: SkillOp[];
  ifBranches?: Array<{ cond: string; body: SkillOp[] }>;
  ifElseBody?: SkillOp[];
  /**
   * `file_read` / `file_write` op params. `path` is the filesystem path
   * (may contain `${VAR}` substitutions resolved at runtime). `content` is
   * the body to write (file_write only).
   */
  fileParams?: { path: string; content?: string };
  /**
   * `notify` op params. `agent` is the target agent identifier (required,
   * may contain `${VAR}` substitutions resolved at runtime). `message` is
   * the explicit message body (optional — runtime defaults to the joined
   * accumulated emissions when absent). `connectors` is an optional
   * restriction list — when present, only AgentConnectors whose registered
   * name is in this list are dispatched to.
   */
  notifyParams?: {
    agent: string;
    message?: string;
    connectors?: string[];
    /** Adopter-defined routing vocab; flows to `meta.event_type`. */
    event_type?: string;
    /** Reply-correlation primitive; flows to `meta.correlation_id`. */
    correlation_id?: string;
  };
  /**
   * Inline `approved="reason"` kwarg captured on mutation-class function-call
   * ops. Author intent marker; lint's `unconfirmed-mutation` rule accepts
   * presence (any non-empty string) as per-op authorization when
   * `# Autonomous: true` is not declared.
   */
  approved?: string;
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

// v0.19.0 — trigger model collapse (Scott + Perry, memory `ceaf4579`).
// Two primitives only: `cron` (time-based) + `event` (external-signal HTTP
// ingress). The removed sources (`session`, `agent-event`, `file-watch`,
// `sensor`) were either parse-only stubs that never fired or substrate-
// coupled concepts that belong outside the runtime. Anything external
// becomes an adapter that POSTs to `/event` — including what would have
// been a session/agent-event/file-watch/sensor trigger.
export type TriggerSource = "cron" | "event";

export interface TriggerDecl {
  source: TriggerSource;
  name: string;
}

export type OutputKind = "text" | "agent" | "template" | "file" | "none";

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
   * v0.9.0 — approval token from the `# Status: Approved <vN:token>` form.
   * Null when the header is omitted, Draft/Disabled, or naked `Approved`
   * (no token suffix). Runtime rejects Approved-without-token at execution
   * time; the human-approval dashboard stamps a real token via `f(body)`.
   */
  approvalToken: string | null;
  /**
   * `# Timeout:` header value in SECONDS. Number literal OR `$(VAR)` ref
   * string (resolved at runtime). Null when omitted; runtime resolves via
   * the 4-level chain (per-op kwarg > skill header > connector default >
   * built-in 300s fallback).
   */
  timeout: number | string | null;
  vars: SkillVar[];
  /**
   * v0.17.3 — `# Returns: X, Y, Z` declared export surface. The variables
   * whose final-state propagates from the child to the caller's bound
   * `R` (via `execute_skill(...) -> R`). Internal scratch vars NOT listed
   * here stay local to the child execution, never serialized into the
   * caller's `final_vars` or the top-level MCP `execute_skill` response.
   * Empty array when the header is omitted — caller sees `outputs` +
   * `transcript` + execution metadata but no declared `final_vars`.
   * Comma-separated identifiers, same split rules as `# Vars:`.
   * Closes Perry's `1ea3d625` Finding 2 (compound state propagation
   * blew the MCP token budget; the empirical pre-flight from skillscript
   * showed zero existing skills reach `${R.final_vars.X}`, so the
   * default-export-outputs-only cut is migration-free).
   */
  returns: string[];
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
   * v0.19.4 — body-text-as-output template. Text between end of
   * frontmatter and first target is a declarative output template;
   * runtime renders it (interpolating vars + $set-bound targets via
   * substituteRuntime) and publishes the result into the canonical
   * output channel. `null` when no template content was authored —
   * preserves the legacy emit-only path exactly. Per Perry+CC
   * sign-off in c7ddfc50 / 920078c8 / ad0b868e.
   *
   * Pin 4 disambiguation: a target is `<name>:` with the immediately
   * following non-blank line indented (op-block). Bare `<name>:` alone
   * with no following op-block (and content-after-colon without a
   * following op-block) reads as template text. `default:` is special
   * (entry-point declaration) — always exits the template region.
   */
  outputTemplate: string | null;
  /**
   * v0.19.4 — line numbers (1-indexed) where bare `<word>:` alone
   * appears in the template region without a following op-block. The
   * tier-2 `template-looks-like-target` lint reads this list to flag
   * genuinely-ambiguous lines for the author to disambiguate.
   */
  templateAmbiguousLines: number[];
  /**
   * v0.9.2 — true iff the source contained an explicit `default: <target>`
   * declaration. False when the parser's last-target fallback fired
   * (legacy behavior preserved for back-compat; lint surfaces the
   * absence as `missing-default-target` tier-1 per P0.9).
   */
  entryTargetExplicit: boolean;
  /**
   * `# Event-type:` value — author-defined routing vocabulary; flows to
   * `meta.event_type` on lifecycle-hook deliveries as the frontmatter
   * fallback. `notify(event_type=...)` kwarg takes precedence per-emit.
   * Augmenting/Template skills only; a `unused-augmenting-header` lint
   * warning fires when set on a skill without an agent-bound output
   * declaration. v0.2.6 introduced as `# Delivery-context:`; renamed in
   * v0.9.6 for vocab consistency between skill-author and receiver-agent
   * surfaces.
   */
  eventType: string | null;
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
// v0.7.2 — `(.*)` widened to `([\s\S]*)` so multi-line triple-quote
// (`"""..."""`) values fold into a single $set value capture. Without the
// dotall-equivalent, the `.` excludes newlines and the regex stops at the
// first line's `"""` opening.
const SET_OP_REGEX = /^\$set\s+([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/;
// v0.3.0 accumulator. `$append VAR <value>` — single-value append to a
// list-typed VAR. Form: `$append IDENT <space> <value>`. Mirrors $set
// in shape (var name + value) but the runtime mutates an outer-scope
// list rather than overwriting. See spec memory `9d6079bb` + `442cf4bb`.
// v0.7.2 — `(.+)` widened to `([\s\S]+)` for same multi-line reason.
const APPEND_OP_REGEX = /^\$append\s+([A-Za-z_]\w*)\s+([\s\S]+)$/;
const FOREACH_OP_REGEX = /^foreach\s+([A-Za-z_]\w*)\s+in\s+(.+?):\s*$/;
const IF_OP_REGEX = /^if\s+(.+?):\s*$/;
const ELIF_OP_REGEX = /^elif\s+(.+?):\s*$/;
// v0.2.11 Bug 14: any `WORD[ WORD...]:` form, used to detect unrecognized
// block-introducers AFTER the known set (if/elif/else/foreach) has been
// matched. Word-shape leading token plus optional args, ending in `:`.
// Excludes target headers (those are matched at depth-0 elsewhere).
const UNKNOWN_BLOCK_INTRODUCER_RE = /^[A-Za-z_][\w-]*(?:\s+.*)?:\s*$/;

/**
 * v0.9.4 — N1 extract `approved="..."` kwarg from a `$` op body.
 * Function-call op grammar extracts kwargs into the op AST; the `$`
 * op grammar leaves kwargs in the body string by design. But the
 * `approved=` kwarg has cross-cutting lint semantics
 * (unconfirmed-mutation honors it per docs) so it needs explicit AST
 * surface for `$` ops too. Returns the captured reason string, or
 * undefined when no `approved=` kwarg is present.
 */
function extractApprovedKwarg(body: string): string | undefined {
  // Match `approved="..."` (double-quoted) or `approved='...'` (single).
  // Word-boundary on the left so we don't match `pre_approved=`.
  const m = /\bapproved\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(body);
  if (m === null) return undefined;
  return m[1] ?? m[2] ?? "";
}
// P0.5 detect missing-space dispatch: `$<word> args` where `<word>` isn't
// `set`/`append` (the only legitimate no-space `$`-prefix verbs).
const NO_SPACE_DISPATCH_RE = /^\$(?!set\b|append\b)\w+\s/;
const MCP_CONNECTOR_PREFIX = /^([a-z_][a-z0-9_-]*)\.(?=[A-Za-z_])([\s\S]*)$/;

// Narrow v1 condition grammar.
// v0.3.4: filter chain support — each `(REF)(|filter)?` became `(REF)(|filter)*`
// to match `substituteRuntime`'s chain capture. Closes the recurring "filter
// chain works in substitution but not conditions" gap named in dev-log §14.
// v0.7.0: REF_PATTERN accepts both `$(REF)` (legacy) and `${REF}` (canonical).
// Both forms have identical semantics; migration tool rewrites old → new.
const REF_PATTERN = "\\$(?:\\([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*(?:\\s*\\|\\s*[A-Za-z_]\\w*(?:\\s*:\\s*\"[^\"]*\")?)*\\)|\\{[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*(?:\\s*\\|\\s*[A-Za-z_]\\w*(?:\\s*:\\s*\"[^\"]*\")?)*\\})";
const REF_PATTERN_NO_FILTER = "\\$(?:\\([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*\\)|\\{[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*\\})";
const COND_TRUTHY = new RegExp(`^\\s*${REF_PATTERN}\\s*$`);
/** `$(REF) ==/!= "literal"` — ref-vs-string equality. Filter chain on the ref side. */
const COND_EQ = new RegExp(`^\\s*${REF_PATTERN}\\s*(?:==|!=)\\s*"[^"]*"\\s*$`);
/**
 * `$(REF) ==/!= $(REF)` — ref-vs-ref equality. Extended 2026-05-21 per
 * language reference §5. Filter chain + dotted field access permitted on
 * either side.
 */
const COND_EQ_REF = new RegExp(`^\\s*${REF_PATTERN}\\s*(?:==|!=)\\s*${REF_PATTERN}\\s*$`);
/**
 * `$(REF) </>/<=/>= "literal"` and `$(REF) </>/<=/>= $(REF)` — numeric
 * comparison. v0.2.5 addition per the orchestration carve-out: comparison
 * is orchestration; arithmetic + aggregates stay in tools. Both sides
 * coerce to number at runtime; non-numeric → TypeMismatchError. Filter
 * chain + dotted field access permitted on either side, matching
 * EQ/EQ_REF shape.
 */
const COND_CMP = new RegExp(`^\\s*${REF_PATTERN}\\s*(?:<=|>=|<|>)\\s*"[^"]*"\\s*$`);
const COND_CMP_REF = new RegExp(`^\\s*${REF_PATTERN}\\s*(?:<=|>=|<|>)\\s*${REF_PATTERN}\\s*$`);
const COND_IN = new RegExp(`^\\s*${REF_PATTERN}\\s+(?:not\\s+)?in\\s+${REF_PATTERN_NO_FILTER}\\s*$`);

// Parser resource caps. The "parser never throws on bad input" contract
// requires bounded recursion + length-capped regex application — without
// these guards, adversarial input crashes the host (stack overflow via
// `a and b and c and ...` deeply-chained AND; CPU exhaustion via
// REF_PATTERN's nested `*` quantifiers backtracking on near-valid input).
// Length cap is upstream of regex application (smaller risk than regex
// refactor, which is deferred). Depth cap is downstream of the length
// check; both must hold.
const MAX_CONDITION_LENGTH = 4096;
const MAX_CONDITION_DEPTH = 64;

function validateCondition(cond: string): boolean {
  const trimmed = cond.trim();
  if (trimmed.length > MAX_CONDITION_LENGTH) return false;
  return validateCompoundCondition(trimmed, 0);
}

// Recursive structural decomposition matching runtime evalCondition.
// Order: strip parens → split on outermost OR → AND → not prefix → simple shape.
// `depth` is incremented per recursive call and capped at MAX_CONDITION_DEPTH —
// adversarial input like `a and b and c and ... (1000 ANDs)` would otherwise
// blow the JS stack.
function validateCompoundCondition(cond: string, depth: number): boolean {
  if (depth > MAX_CONDITION_DEPTH) return false;
  const stripped = stripOuterCondParens(cond);
  const orIdx = findOuterCondToken(stripped, "or");
  if (orIdx >= 0) {
    return validateCompoundCondition(stripped.slice(0, orIdx).trim(), depth + 1)
      && validateCompoundCondition(stripped.slice(orIdx + 4).trim(), depth + 1);
  }
  const andIdx = findOuterCondToken(stripped, "and");
  if (andIdx >= 0) {
    return validateCompoundCondition(stripped.slice(0, andIdx).trim(), depth + 1)
      && validateCompoundCondition(stripped.slice(andIdx + 5).trim(), depth + 1);
  }
  const lead = stripped.trimStart();
  if (lead.startsWith("not ")) return validateCompoundCondition(lead.slice(4), depth + 1);
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

/** Detects `$(REF) = "literal"` or `${REF} = "literal"` — single `=` in condition position. */
const SINGLE_EQ_IN_COND = /\$(?:\([^)]+\)|\{[^}]+\})\s*=(?!=)\s*"[^"]*"/;

/**
 * If the condition contains `$(REF) = "..."` or `${REF} = "..."` (single `=`),
 * emit a specific diagnostic suggesting `==`. Returns the diagnostic string
 * when matched, `null` otherwise.
 */
function detectSingleEqualsInCondition(cond: string): string | null {
  const m = SINGLE_EQ_IN_COND.exec(cond);
  if (m === null) return null;
  const fixed = cond
    .replace(/\$\(([^)]+)\)\s*=(?!=)\s*"([^"]*)"/, '$($1) == "$2"')
    .replace(/\$\{([^}]+)\}\s*=(?!=)\s*"([^"]*)"/, '${$1} == "$2"');
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
 * v0.19.4 — Pin 4 disambiguation lookahead. From the line at `fromIdx`,
 * scan forward until the first non-blank line; return true if it is
 * indented (the op-block that confirms a target header), false otherwise.
 * Trailing-whitespace-only lines count as blank. End-of-source counts as
 * "no following op-block" → false.
 */
function nextNonBlankLineIsIndented(lines: string[], fromIdx: number): boolean {
  for (let j = fromIdx + 1; j < lines.length; j++) {
    const next = lines[j]!.replace(/\s+$/, "");
    if (next === "") continue;
    return /^\s/.test(next);
  }
  return false;
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

// v0.17.5 — Reserved envelope-field names that a caller's bound `R`
// (from `execute_skill ... -> R`) always exposes at top level. Declared
// `# Returns:` names must NOT collide with these — collision would
// silently shadow the structural field at substitution time. Per
// Perry's `e01f4148` non-optional condition on the v0.17.5 returns-fix
// ring. Source-of-truth alignment with `ExecuteSkillResult`
// (src/composition.ts) and `RESERVED_ENVELOPE_FIELDS` re-export from
// the runtime side — keep in sync if either side grows.
export const RESERVED_ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "skill_name",
  "outputs",
  "transcript",
  "errors",
  "target_order",
  "fallbacks",
  "agent_delivery_receipts",
  "final_vars",
]);

// v0.17.2 — Strip one layer of matched surrounding quotes from a `# Vars:`
// default value. Closes the silent quote-leak Perry hit in dogfood (`1ea3d625`):
// `# Vars: LOCATION="Valdese"` bound the literal 9-char `"Valdese"` (quotes
// included), which URL-encoded with the quotes and broke downstream wttr.in
// lookup. The split is "one layer of matched surrounding quotes" — quotes that
// were doing real delimiting (e.g., for spaced values like `MSG="hello world"`)
// disappear, and bare values stay bare. Mismatched / unbalanced quotes pass
// through unchanged. Back-compat-positive: existing skills get more correct,
// not less — `LOCATION=""` (two literal quote chars) starts binding empty
// string, which is what their fallback paths want.
function stripMatchedQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return s.slice(1, -1);
  }
  return s;
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
  // v0.7.2 — triple-quote folding engages regardless of op kind. Three
  // consecutive `"` chars don't accidentally appear in natural English
  // prose, so the "phantom-scope from apostrophe" risk that gates single-
  // quote folding to kwarg-bearing ops doesn't apply. inTripleAccum tracks
  // which fold mode the buffer is in so we know which closing condition
  // to test against.
  let inTripleAccum = false;
  for (const line of lines) {
    if (buffer === null) {
      if (hasUnclosedTriple(line)) {
        buffer = line;
        inTripleAccum = true;
      } else if (isKwargBearingLine(line) && hasUnclosedQuote(line)) {
        buffer = line;
        inTripleAccum = false;
      } else {
        out.push(line);
      }
    } else {
      buffer = buffer + "\n" + line;
      const closed = inTripleAccum ? !hasUnclosedTriple(buffer) : !hasUnclosedQuote(buffer);
      if (closed) {
        out.push(buffer);
        buffer = null;
        inTripleAccum = false;
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
 * v0.7.2 — true if `text` contains an odd number of `"""` triple-quote
 * delimiters (i.e., an unterminated triple-quote literal). Scans the
 * string counting non-overlapping `"""` occurrences.
 */
function hasUnclosedTriple(text: string): boolean {
  let count = 0;
  for (let i = 0; i <= text.length - 3; ) {
    if (text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      count++;
      i += 3;
    } else {
      i++;
    }
  }
  return count % 2 === 1;
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
  // v0.19.0 — trigger sources collapsed to cron + event (was 6 before).
  const sourcePattern = ["cron", "event"].join("|");
  const splitRegex = new RegExp(`,\\s*(?=(?:${sourcePattern})\\s*:)`, "g");
  return value.split(splitRegex);
}

/**
 * `$set` / `>` / `~` / kwarg arg-value quote-strip rules:
 *   - Matching outer `"..."`: stripped + interpret \n/\t/\\/\" escapes (v0.7.2).
 *   - Matching outer `'...'`: stripped, no escape interpretation (literal).
 *   - Mismatched / unquoted: verbatim, trailing whitespace trimmed.
 *
 * v0.7.2 — escape interpretation in double-quoted strings closes the R4
 * cold-author footgun where `$set X = "line1\nline2"` stored literal
 * `\n` bytes. Bash/Python/JS/Go all interpret these escapes; skillscript
 * not interpreting was the surprise. Single-quoted strings reserved for
 * v0.8+ explicit literal-pass-through semantics if a real use case
 * surfaces.
 */
export function processSetValue(raw: string): string {
  const trimmed = raw.replace(/\s+$/, "");
  // v0.7.2 — triple-quote `"""..."""` multi-line literal. Check before the
  // single-quote pair check; a value like `"""abc"""` shouldn't be shortened
  // to `""abc""` via the `"..."` branch.
  // v0.16.6 — apply Python `textwrap.dedent` pattern: strip the common
  // leading whitespace of all non-empty lines + strip leading/trailing
  // blank lines. Without it, authors writing the body indented inside the
  // call site get that indent literally in the rendered string (bad for
  // prose, bad for prompts). Per Perry's `98d6b60b` design directive.
  if (trimmed.length >= 6 && trimmed.startsWith('"""') && trimmed.endsWith('"""')) {
    return dedentTripleQuoteBody(interpretDoubleQuotedEscapes(trimmed.slice(3, -3)));
  }
  if (trimmed.length >= 2) {
    const first = trimmed[0]!;
    const last = trimmed[trimmed.length - 1]!;
    if (first === '"' && last === '"') {
      return interpretDoubleQuotedEscapes(trimmed.slice(1, -1));
    }
    if (first === "'" && last === "'") {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * v0.7.2 — interpret common escape sequences in double-quoted string
 * literals: `\n` → newline, `\t` → tab, `\\` → literal backslash,
 * `\"` → literal quote. Other `\X` sequences pass through verbatim
 * (no over-eager interpretation; future v0.8+ may add `\r` / `\0` /
 * etc. if cold-author demand surfaces).
 *
 * v0.15.0 — exported so runtime's `coerceKwargValue` can apply the same
 * interpretation to `$` op kwarg values. Pre-v0.15.0 this only ran via
 * `processSetValue` ($set + function-call kwargs), leaving `$ skill_write
 * source="..."` with literal `\n` / `\"` bytes in the value.
 */
/**
 * v0.16.6 — Apply the Python `textwrap.dedent` pattern to a multi-line
 * triple-quote body. Two passes:
 *
 *   1. Strip a leading blank line (whitespace-only) and a trailing blank
 *      line. The natural author shape `text="""\n  body\n  """` leaves
 *      the leading `\n` immediately after the opening delimiter and a
 *      trailing whitespace line before the closing — neither belongs in
 *      the output.
 *
 *   2. Compute the common leading-whitespace prefix across all non-empty
 *      lines, then strip that prefix from each line. Lines that are
 *      blank-or-whitespace-only do NOT constrain the prefix calculation
 *      (their indentation is treated as flexible).
 *
 * Dedent runs BEFORE `${VAR}` substitution per the design directive
 * (substituted multi-line values keep their own whitespace; the template
 * looks like the output).
 *
 * Single-line bodies (no embedded `\n`) pass through unchanged.
 */
export function dedentTripleQuoteBody(body: string): string {
  const lines = body.split("\n");
  if (lines.length === 1) return body; // single-line literal — no dedent.
  // Strip a leading whitespace-only line, then a trailing whitespace-only
  // line. These come from the natural `"""\n  body\n  """` shape.
  if (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  if (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  // Compute common leading whitespace prefix across non-empty lines.
  let commonIndent: string | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = /^[ \t]*/.exec(line);
    const indent = m !== null ? m[0] : "";
    if (commonIndent === null) {
      commonIndent = indent;
      continue;
    }
    let i = 0;
    while (i < commonIndent.length && i < indent.length && commonIndent[i] === indent[i]) i++;
    commonIndent = commonIndent.slice(0, i);
    if (commonIndent === "") break;
  }
  if (commonIndent === null || commonIndent.length === 0) {
    return lines.join("\n");
  }
  return lines.map((line) => line.startsWith(commonIndent!) ? line.slice(commonIndent!.length) : line).join("\n");
}

export function interpretDoubleQuotedEscapes(s: string): string {
  return s.replace(/\\(["\\nt])/g, (match, ch: string) => {
    switch (ch) {
      case '"': return '"';
      case "\\": return "\\";
      case "n": return "\n";
      case "t": return "\t";
      default: return match;
    }
  });
}

/**
 * Tokenize whitespace-separated `key=value` pairs, respecting matching
 * single/double quotes and `[...]` brackets.
 */
export function tokenizeKeywordArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let inTriple = false;  // v0.7.2 — triple-quote `"""..."""` state
  let bracketDepth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    // Triple-quote state takes precedence: inside `"""..."""`, single `"`
    // and whitespace are content, not delimiters.
    if (inTriple) {
      current += ch;
      if (ch === '"' && input[i + 1] === '"' && input[i + 2] === '"') {
        current += input[i + 1]!;
        current += input[i + 2]!;
        i += 2;
        inTriple = false;
      }
      continue;
    }
    if (inQuote) {
      current += ch;
      // v0.15.0 — recognize `\"`, `\'`, `\\` as escapes inside a quoted
      // string. Without this, `text="he said \"hi\""` closes the value at
      // the first `\"` and the trailing `hi\""` lands as separate tokens
      // (or worse, silent truncation when feeding to a $ dispatch op).
      // Mirrors processSetValue's interpretDoubleQuotedEscapes for the
      // outer-tokenization layer; the value still gets fed to escape
      // interpretation downstream (processSetValue / coerceKwargValue).
      if (ch === "\\" && i + 1 < input.length) {
        const next = input[i + 1]!;
        if (next === inQuote || next === "\\") {
          current += next;
          i++;
          continue;
        }
      }
      if (ch === inQuote) inQuote = null;
      continue;
    }
    // Check for triple-quote OPEN before single-quote (greedy match).
    if (ch === '"' && input[i + 1] === '"' && input[i + 2] === '"') {
      current += '"""';
      i += 2;
      inTriple = true;
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

/**
 * v0.7.0 — paren-balanced extraction. Given text and the index of an opening
 * `(`, return the substring between matched parens plus the index of the
 * closing `)`. Quote-aware (skips parens inside `"..."`/`'...'`). Returns
 * null on unbalanced parens.
 */
function extractParenBody(text: string, openIdx: number): { body: string; endIdx: number } | null {
  if (text[openIdx] !== "(") return null;
  let depth = 1;
  let inQuote: '"' | "'" | null = null;
  let inTriple = false;  // v0.7.2 — `"""..."""` state
  for (let i = openIdx + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (inTriple) {
      if (ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
        i += 2;
        inTriple = false;
      }
      continue;
    }
    if (inQuote !== null) {
      // v0.15.0 — recognize `\"`, `\'`, `\\` as escapes inside a quoted
      // string (parallel to tokenizeKeywordArgs). Without this,
      // `emit(text="he said \"hi\"")` mis-closes the inner quote and the
      // paren-balance walker treats `)` as content.
      if (ch === "\\" && i + 1 < text.length) {
        const next = text[i + 1]!;
        if (next === inQuote || next === "\\") {
          i++;
          continue;
        }
      }
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      i += 2;
      inTriple = true;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { body: text.slice(openIdx + 1, i), endIdx: i };
    }
  }
  return null;
}

/**
 * v0.7.0 — split a function-call argument list on top-level commas.
 * Respects matched single/double quotes and `[...]`/`{...}`/`(...)` nesting.
 * v0.16.7 — also tracks triple-quote `"""..."""` state. Inside a triple-
 * quote body, embedded single `"` chars are literal content, not toggle
 * delimiters. Without this, a triple-quote body containing an odd number
 * of `"` chars (e.g. `"""... "two-word"... "unbalanced` followed by a
 * comma at the closing `"""`) was unbalancing inQuote and causing
 * embedded commas to split args mid-body. Per Perry's `c497b479` finding.
 */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let inQuote: '"' | "'" | null = null;
  let inTriple = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    // Triple-quote state takes precedence over single-quote state: inside
    // `"""..."""`, single `"` chars are content (mirrors tokenizeKeywordArgs
    // discipline).
    if (inTriple) {
      cur += ch;
      if (ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
        cur += text[i + 1]!;
        cur += text[i + 2]!;
        i += 2;
        inTriple = false;
      }
      continue;
    }
    if (inQuote !== null) {
      cur += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    // Check for triple-quote OPEN before single-quote (greedy match).
    if (ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      cur += '"""';
      i += 2;
      inTriple = true;
      continue;
    }
    if (ch === '"' || ch === "'") { cur += ch; inQuote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; cur += ch; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (ch === "," && depth === 0) {
      const t = cur.trim();
      if (t !== "") parts.push(t);
      cur = "";
      continue;
    }
    cur += ch;
  }
  const t = cur.trim();
  if (t !== "") parts.push(t);
  return parts;
}

/** v0.7.0 — prefix probe for function-call shape: `name(`. */
const FN_CALL_PREFIX = /^([a-z_][\w]*)\s*\(/;

function splitMcpConnectorPrefix(body: string): { connector: string | undefined; rest: string } {
  const m = MCP_CONNECTOR_PREFIX.exec(body);
  if (m === null) return { connector: undefined, rest: body };
  return { connector: m[1]!, rest: m[2]! };
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
    approvalToken: null,
    timeout: null,
    vars: [],
    returns: [],
    requires: [],
    requiredCapabilities: [],
    useWhen: null,
    targets: new Map(),
    entryTarget: null,
    entryTargetExplicit: false,
    onError: null,
    triggers: [],
    outputs: [],
    outputTemplate: null,
    templateAmbiguousLines: [],
    eventType: null,
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

  // v0.19.4 / v0.19.8 — body-text-as-output template.
  // `templateLines` accumulates from anywhere in the source: prose between
  // frontmatter and the first target (top template), AND prose after the
  // last target body (bottom template — added v0.19.8). Pin 4 is applied
  // uniformly: a column-0 `<name>:` line is a target only if followed by
  // an indented op-block. Otherwise it's template text, regardless of
  // position. Closes Perry's `349a1d49` template-anywhere design.
  const templateLines: string[] = [];
  // Track whether template content appears both before AND after any
  // target so we can flag multi-region templates as a parse error
  // (Perry's "one template region per skill" recommendation).
  let hasTargetOrDefaultBeenSeen = false;
  let templateContentBeforeTarget = false;
  let templateContentAfterTarget = false;

  const recordTemplate = (rawLine: string, line: string): void => {
    templateLines.push(rawLine);
    const isNonBlank = line !== "";
    if (isNonBlank) {
      if (hasTargetOrDefaultBeenSeen) templateContentAfterTarget = true;
      else templateContentBeforeTarget = true;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const line = rawLine.replace(/\s+$/, "");

    // === v0.19.4 / v0.19.8 template capture ===
    // Pin 4 applied uniformly: column-0 `<name>:` is a target only when
    // followed by indented op-block. Anything else (column-0 prose,
    // column-0 `<name>:` without op-block) is template text at any
    // position. Indented lines inside a target body fall through to the
    // existing op-walking logic; indented lines outside a target body
    // are either pre-target template prose or post-target orphans
    // (v0.19.7 error).

    if (line === "") {
      // Only capture blanks as template-eligible when we're outside a
      // target body. Inside a target body, blanks are Bug 15
      // whitespace (visual sectioning of long target bodies) and must
      // NOT contaminate the bottom template.
      if (currentTarget === null) {
        recordTemplate(rawLine, line);
      }
      continue;
    }
    if (!line.startsWith("#")) {
      if (!/^\s/.test(line)) {
        // Top-level control-flow keywords (`if`/`elif`/`else:`) are
        // hard parse errors per existing guards below; do NOT swallow
        // them as template content. Fall through.
        if (/^(if|elif)\s+/.test(line) || /^else:\s*$/.test(line)) {
          // fall through to existing top-level if/elif/else guard
        } else {
          const identColon = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
          if (identColon !== null) {
            const isDefault = identColon[1] === "default";
            const hasOpBlock = nextNonBlankLineIsIndented(lines, i);
            const afterColon = identColon[2]!.trim();
            if (isDefault || hasOpBlock) {
              // Real target or `default:` declaration — fall through
              // to existing target-handling logic below. Mark that we
              // crossed the first-target boundary so any subsequent
              // template content is classified as "after target."
              hasTargetOrDefaultBeenSeen = true;
            } else {
              // Pin 4: content-after-colon without an op-block is
              // template prose. Bare `<word>:` alone without an
              // op-block is ambiguous — capture as template AND
              // record for tier-2 lint A6.
              if (afterColon === "") {
                result.templateAmbiguousLines.push(i + 1);
              }
              recordTemplate(rawLine, line);
              continue;
            }
          } else {
            // Plain template text — no identifier-colon shape.
            recordTemplate(rawLine, line);
            continue;
          }
        }
      } else {
        // Indented line outside a target body (currentTarget === null
        // AND scopeStack empty). Two sub-cases:
        //   - Pre-first-target: legacy v0.19.4 top template behavior —
        //     captured as indented template prose (rare but legal).
        //   - Post-target: falls through to the v0.19.7 orphan-indented-op
        //     parse error (loud; closes Perry's 9a62c1f2 silent-drop).
        if (!hasTargetOrDefaultBeenSeen && (currentTarget === null || scopeStack.length === 0)) {
          recordTemplate(rawLine, line);
          continue;
        }
      }
    }
    // === end template capture ===

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
        // v0.9.0 — `# Status: Approved` MAY carry a trailing approval token
        // of the form `vN:<hex>` (e.g. `Approved v1:a1b2c3d4`). Split on the
        // first run of whitespace: first segment is the status enum, anything
        // after is the token. Naked `Approved` parses cleanly here but is
        // rejected at runtime as unapproved until a real token is stamped.
        const parts = value.split(/\s+/);
        const statusRaw = parts[0] ?? "";
        const tokenRaw = parts.slice(1).join(" ").trim();
        const norm = normalizeEnumValue(statusRaw, ["Draft", "Approved", "Disabled"] as const);
        if (norm !== null) {
          result.status = norm;
          if (tokenRaw.length > 0) {
            if (norm !== "Approved") {
              result.parseErrors.push(`\`# Status:\` only 'Approved' may carry an approval token (got status '${norm}' with token '${tokenRaw}')`);
            } else {
              result.approvalToken = tokenRaw;
            }
          }
        } else {
          result.parseErrors.push(`\`# Status:\` value must be 'Draft', 'Approved', or 'Disabled' (got '${statusRaw}')`);
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
        if (/\$[(\{]/.test(value)) {
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
              default: stripMatchedQuotes(trimmed.slice(eq + 1).trim()),
              required: false,
            };
          });
        }
      } else if (key === "returns") {
        // v0.17.3 — declared export surface. Comma-separated identifier
        // list. Simpler split than `# Vars:` because entries are bare
        // names (no `=value` to nest commas in). Empty / `(none)` → empty
        // array (no declared exports; caller sees outputs + transcript
        // only).
        if (value.toLowerCase() === "(none)" || value === "") {
          result.returns = [];
        } else {
          const names: string[] = [];
          for (const entry of value.split(",")) {
            const trimmed = entry.trim();
            if (trimmed === "") continue;
            // # Returns: doesn't accept defaults — only identifiers.
            // `# Returns: X=foo` is a parse error; the export surface is
            // a declaration of which vars are public, not a definition.
            const eq = trimmed.indexOf("=");
            if (eq !== -1) {
              result.parseErrors.push(
                `\`# Returns: ${trimmed}\` — \`# Returns:\` declares export names only; no defaults. Did you mean \`# Vars: ${trimmed}\` (input default) or \`# Returns: ${trimmed.slice(0, eq).trim()}\` (export declaration)?`,
              );
              continue;
            }
            const diag = checkReserved(trimmed, "a return name", `${trimmed}_value`);
            if (diag !== null) result.parseErrors.push(diag);
            // v0.17.5 — reserved-name guard against envelope-field
            // collisions. With declared returns spread onto the caller's
            // `R` top level (`${R.SUMMARY}` is canonical access), a name
            // matching a structural envelope field would silently shadow
            // it — the exact silent-wrong class this design exists to
            // kill. Per Perry's `e01f4148` v0.17.5 ack: "treat the guard
            // as part of the fix, not a follow-up."
            if (RESERVED_ENVELOPE_FIELDS.has(trimmed)) {
              result.parseErrors.push(
                `\`# Returns: ${trimmed}\` — '${trimmed}' collides with a reserved result-envelope field (one of: ${Array.from(RESERVED_ENVELOPE_FIELDS).sort().join(", ")}). The caller's bound \`-> R\` always exposes these structural fields; declaring a return with the same name would silently shadow them. Rename the variable.`,
              );
              continue;
            }
            names.push(trimmed);
          }
          result.returns = names;
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
          // v0.19.0 — only cron + event remain (memory `ceaf4579`).
          const allowed = ["cron", "event"] as const;
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
          const allowedKinds = ["text", "agent", "template", "file", "none"] as const;
          const colon = decl.indexOf(":");
          if (colon === -1) {
            const bareKind = normalizeEnumValue(decl, allowedKinds);
            if (bareKind === "text" || bareKind === "none") {
              result.outputs.push({ kind: bareKind });
            } else {
              result.parseErrors.push(`\`# Output:\` kind '${decl}' missing target — kinds 'agent', 'template', 'file' require '<kind>: <target>'. Only 'text' and 'none' are bare-only.`);
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
      } else if (key === "event-type") {
        // Augmenting/Template-only — author-defined routing vocabulary
        // routed to the receiving agent as `meta.event_type` (frontmatter
        // fallback; notify(event_type=...) kwarg takes precedence per-emit).
        // Empty value clears the field; the lint rule
        // `unused-augmenting-header` catches use on Headless skills.
        // Renamed from `delivery-context` in v0.9.6 per audit Q9.
        result.eventType = value === "" ? null : value;
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
        result.entryTargetExplicit = true;
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
    // v0.19.7 — orphan indented op detection. An indented line outside
    // any target body was silently swallowed pre-v0.19.7 (the most common
    // pattern: an author writes ops directly under `default: <name>`
    // instead of defining a `<name>:` target first). Closes Perry's
    // `9a62c1f2` minion-test finding — silent-drop is the worst
    // authorability failure mode. Loud error here so the author can
    // self-correct.
    if (!currentTarget || scopeStack.length === 0) {
      result.parseErrors.push(
        `Indented op '${line.replace(/^\s+/, "")}' has no enclosing target body. ` +
        `If this is a target's op, declare the target first (\`<name>:\` on its own line, then the indented ops below). ` +
        `If you meant to specify the entry point with ops inline, that's not supported — use \`<name>:\` + ops, then a separate \`default: <name>\` line.`,
      );
      continue;
    }
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
      result.parseErrors.push(
        `Legacy \`>\` retrieval op in target '${currentTarget.name}' is no longer supported. ` +
        `Use \`$ data_read mode="fts|semantic|rerank" query="..." limit=N -> R\` (or qualify the connector: \`$ <connector>.data_read ...\`).`,
      );
      continue;
    }
    if (stripped0.startsWith("~ ")) {
      result.parseErrors.push(
        `Legacy \`~\` LocalModel op in target '${currentTarget.name}' is no longer supported. ` +
        `Use \`$ llm prompt="..." [maxTokens=N] [model="..."] -> R\` (op-level \`timeout=N\` kwarg and trailing \`(fallback: "value")\` are honored).`,
      );
      continue;
    }
    if (stripped0.startsWith("& ")) {
      result.parseErrors.push(
        `Legacy \`&\` inline op in target '${currentTarget.name}' is no longer supported. ` +
        `Use \`inline(skill="...")\` for compile-time data-skill inlines, or \`execute_skill(name="...", ...) -> R\` for runtime composition.`,
      );
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
    // v0.7.0 — function-call op grammar: `verb(kwarg=value, ...) [-> VAR] [(fallback: "...")]`
    // Closed runtime-intrinsic op set in RUNTIME_INTRINSIC_FN_NAMES. Unknown
    // function-call names are parse-errors with remediation pointing at `$`.
    {
      const fnPrefix = FN_CALL_PREFIX.exec(stripped0);
      if (fnPrefix !== null) {
        const fnName = fnPrefix[1]!;
        const parenOpenIdx = fnPrefix[0].length - 1;
        const parsed = extractParenBody(stripped0, parenOpenIdx);
        if (parsed === null) {
          result.parseErrors.push(
            `Malformed function-call op '${fnName}(...)' in target '${currentTarget.name}' — unbalanced parens.`,
          );
          continue;
        }
        // Parse comma-separated kwargs.
        const kwArgs: Record<string, string> = {};
        let argErr = false;
        for (const arg of splitTopLevelCommas(parsed.body)) {
          const eq = arg.indexOf("=");
          if (eq === -1) {
            result.parseErrors.push(
              `Malformed function-call arg '${arg}' in '${fnName}(...)' (target '${currentTarget.name}') — expected name=value.`,
            );
            argErr = true;
            continue;
          }
          const k = arg.slice(0, eq).trim();
          const v = arg.slice(eq + 1).trim();
          kwArgs[k] = processSetValue(v);
        }
        if (argErr) continue;
        // Trailing `-> VAR` and optional `(fallback: "...")`.
        const tail = stripped0.slice(parsed.endIdx + 1).trim();
        let outputVar: string | undefined;
        let fallback: string | undefined;
        if (tail !== "") {
          const tailMatch = /^(?:->\s*([A-Za-z_]\w*))?(?:\s*\(fallback\s*:\s*(.+?)\))?\s*$/.exec(tail);
          if (tailMatch !== null) {
            if (tailMatch[1] !== undefined) outputVar = tailMatch[1];
            if (tailMatch[2] !== undefined) fallback = processSetValue(tailMatch[2]);
          } else {
            result.parseErrors.push(
              `Malformed function-call op '${fnName}(...)' trailer in target '${currentTarget.name}': '${tail}' — expected '-> VAR' and/or '(fallback: "value")'.`,
            );
            continue;
          }
        }
        const approved = kwArgs["approved"];
        // Per-op dispatch — map function-call form to canonical AST shapes.
        if (fnName === "emit") {
          // v0.9.2 — P0.7 emit() doesn't return a value to bind. Pre-v0.9.2
          // the parser accepted `emit(text="hi") -> VAR` silently and the
          // runtime ignored the binding — qwen Test A surfaced this as a
          // silent-drop class issue. Reject explicitly with the canonical
          // fix in the message.
          if (outputVar !== undefined) {
            result.parseErrors.push(
              `\`emit(...)\` in target '${currentTarget.name}' cannot bind a result with \`-> ${outputVar}\`. ` +
              `\`emit\` writes to the skill's emission stream; it has no return value. ` +
              `Drop the \`-> ${outputVar}\` binding, or use a binding-shaped op like \`ask(...) -> R\` / \`$ tool ... -> R\` if you intended to capture a value.`,
            );
            continue;
          }
          const text = kwArgs["text"] ?? "";
          opBucket.push({
            kind: "emit",
            body: text,
            ...(approved !== undefined ? { approved } : {}),
          });
          continue;
        }
        if (fnName === "inline") {
          const skill = kwArgs["skill"] ?? "";
          opBucket.push({
            kind: "inline",
            body: stripped0,
            ampParams: { skillName: skill, args: {} },
            ...(outputVar !== undefined ? { outputVar } : {}),
            ...(fallback !== undefined ? { fallback } : {}),
            ...(approved !== undefined ? { approved } : {}),
          });
          continue;
        }
        if (fnName === "execute_skill") {
          // v0.15.2 — `name` is canonical, `skill_name` is back-compat alias.
          // Aligns the function-call kwarg with the MCP-wire kwarg + the
          // other `skill_*` tools (`skill_read({name})`, `skill_write({name})`,
          // etc.). Per Perry signoff thread 75abc8c0: silent alias, no
          // advisory. If both kwargs present with different values, fail
          // parse-time so the author picks one.
          const nameKwarg = kwArgs["name"];
          const skillNameKwarg = kwArgs["skill_name"];
          if (nameKwarg !== undefined && skillNameKwarg !== undefined && nameKwarg !== skillNameKwarg) {
            result.parseErrors.push(
              `\`execute_skill(...)\` in target '${currentTarget.name}': ambiguous kwargs — \`name\` and \`skill_name\` are aliases; supply only one (or matching values).`,
            );
            continue;
          }
          const skillName = nameKwarg ?? skillNameKwarg ?? "";
          const rest = Object.entries(kwArgs).filter(([k]) => k !== "name" && k !== "skill_name" && k !== "approved");
          const inner = rest.map(([k, v]) => /\s/.test(v) || v.startsWith("{") || v.startsWith("[") ? `${k}=${v}` : `${k}="${v}"`).join(" ");
          opBucket.push({
            kind: "$",
            body: `execute_skill skill_name="${skillName}"${inner ? " " + inner : ""}`,
            ...(outputVar !== undefined ? { outputVar } : {}),
            ...(fallback !== undefined ? { fallback } : {}),
            ...(approved !== undefined ? { approved } : {}),
          });
          continue;
        }
        if (fnName === "shell") {
          const command = kwArgs["command"];
          const unsafe = kwArgs["unsafe"] === "true";
          const argvRaw = kwArgs["argv"];
          // v0.19.11 — argv mutex enforcement. argv form is strictly
          // safer (no shell, no tokenization, no quote-stripping) and
          // doesn't compose with the string forms.
          if (argvRaw !== undefined && command !== undefined) {
            result.parseErrors.push(
              `\`shell(...)\` in target '${currentTarget.name}': \`argv=[...]\` and \`command="..."\` are mutually exclusive. Pick one form: argv for explicit-token-list dispatch (safer; no shell), command for whitespace-tokenized OR (with unsafe=true) bash.`,
            );
            continue;
          }
          if (argvRaw !== undefined && unsafe) {
            result.parseErrors.push(
              `\`shell(...)\` in target '${currentTarget.name}': \`argv=[...]\` does not compose with \`unsafe=true\`. argv form skips the shell entirely (execv-class spawn) so there's no bash to opt into. Drop \`unsafe=true\` when using argv.`,
            );
            continue;
          }
          if (argvRaw !== undefined) {
            // Parse the argv literal as a JSON array. Authors write
            // `argv=["bin", "arg with spaces", "${VAR}"]` — JSON shape so
            // quoting is unambiguous + element boundaries are explicit.
            let argv: string[];
            try {
              const parsed = JSON.parse(argvRaw) as unknown;
              if (!Array.isArray(parsed) || !parsed.every((e) => typeof e === "string")) {
                result.parseErrors.push(
                  `\`shell(argv=...)\` in target '${currentTarget.name}': argv must be a JSON array of strings. Got: ${argvRaw}.`,
                );
                continue;
              }
              if (parsed.length === 0) {
                result.parseErrors.push(
                  `\`shell(argv=[])\` in target '${currentTarget.name}': argv must have at least one element (the binary).`,
                );
                continue;
              }
              argv = parsed;
            } catch (err) {
              result.parseErrors.push(
                `\`shell(argv=...)\` in target '${currentTarget.name}': argv literal isn't valid JSON: ${(err as Error).message}. Shape: \`argv=["bin", "arg1", "arg2", ...]\` with each element JSON-quoted.`,
              );
              continue;
            }
            opBucket.push({
              kind: "shell",
              body: "",
              argv,
              ...(outputVar !== undefined ? { outputVar } : {}),
              ...(fallback !== undefined ? { fallback } : {}),
              ...(approved !== undefined ? { approved } : {}),
            });
            continue;
          }
          opBucket.push({
            kind: "shell",
            body: command ?? "",
            ...(unsafe ? { policy: "unsafe" as const } : {}),
            ...(outputVar !== undefined ? { outputVar } : {}),
            ...(fallback !== undefined ? { fallback } : {}),
            ...(approved !== undefined ? { approved } : {}),
          });
          continue;
        }
        if (fnName === "file_read") {
          const path = kwArgs["path"] ?? "";
          opBucket.push({
            kind: "file_read",
            body: stripped0,
            fileParams: { path },
            ...(outputVar !== undefined ? { outputVar } : {}),
            ...(fallback !== undefined ? { fallback } : {}),
          });
          continue;
        }
        if (fnName === "file_write") {
          const path = kwArgs["path"] ?? "";
          const content = kwArgs["content"] ?? "";
          opBucket.push({
            kind: "file_write",
            body: stripped0,
            fileParams: { path, content },
            ...(outputVar !== undefined ? { outputVar } : {}),
            ...(approved !== undefined ? { approved } : {}),
          });
          continue;
        }
        if (fnName === "notify") {
          // v0.8.0 — notify(agent, message?, connectors?) -> ACK. Mid-skill
          // synchronous agent alert via wired AgentConnector(s). `agent` is
          // required; `message` defaults to joined accumulated emissions at
          // dispatch time; `connectors` optionally restricts the fan-out.
          const agent = kwArgs["agent"] ?? "";
          const message = kwArgs["message"];
          const connectorsRaw = kwArgs["connectors"];
          // v0.9.6 — adopter-defined routing vocab + reply correlation per
          // audit Q8. Both are simple-string kwargs that flow verbatim into
          // DeliveryMeta. event_type takes precedence over the `# Event-type:`
          // frontmatter fallback at the runtime.
          const eventType = kwArgs["event_type"];
          const correlationId = kwArgs["correlation_id"];
          // `connectors` arrives as a JSON array literal string (per the v0.7.0
          // kwarg value grammar). Parse here; runtime sees a real string[].
          let connectors: string[] | undefined;
          if (connectorsRaw !== undefined) {
            try {
              const parsed = JSON.parse(connectorsRaw) as unknown;
              if (Array.isArray(parsed) && parsed.every((c) => typeof c === "string")) {
                connectors = parsed as string[];
              } else {
                result.parseErrors.push(
                  `notify(connectors=...) in target '${currentTarget.name}' must be a JSON array of strings (got: ${connectorsRaw}).`,
                );
              }
            } catch {
              result.parseErrors.push(
                `notify(connectors=...) in target '${currentTarget.name}' must be a JSON array literal (got: ${connectorsRaw}).`,
              );
            }
          }
          opBucket.push({
            kind: "notify",
            body: stripped0,
            notifyParams: {
              agent,
              ...(message !== undefined ? { message } : {}),
              ...(connectors !== undefined ? { connectors } : {}),
              ...(eventType !== undefined ? { event_type: eventType } : {}),
              ...(correlationId !== undefined ? { correlation_id: correlationId } : {}),
            },
            ...(outputVar !== undefined ? { outputVar } : {}),
            ...(fallback !== undefined ? { fallback } : {}),
            ...(approved !== undefined ? { approved } : {}),
          });
          continue;
        }
        // Unknown function-call name — runtime-intrinsic set is closed.
        result.parseErrors.push(
          `Unknown function-call op '${fnName}(...)' in target '${currentTarget.name}'. ` +
          `Runtime-intrinsic ops are: ${RUNTIME_INTRINSIC_FN_NAMES.join(", ")}. ` +
          `If this is an MCP tool, use \`$ ${fnName} args -> R\` shape instead.`,
        );
        continue;
      }
    }
    const stripped = line.replace(/^\s+/, "");
    let kind: OpKind | null = null;
    let body = "";
    let mcpConnectorForOp: string | undefined = undefined;
    // Check `??`/`$set` before bare `?`/`$`.
    if (stripped.startsWith("?? ") || stripped === "??") {
      result.parseErrors.push(
        `Legacy \`??\` ask op in target '${currentTarget.name}' is no longer supported. ` +
        `\`ask\` was removed in v0.16.0 — it conflated user-surfacing (which the runtime can't guarantee a channel for) with mutation-gating (already covered by \`approved="reason"\` per-op kwarg + \`# Autonomous: true\` skill flag). ` +
        `For input, use \`emit(text="...")\` and have the caller handle the round-trip. For mutation authorization, use \`approved=\` or \`# Autonomous:\`.`,
      );
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
      } else {
        // Malformed `$set` no longer silently drops. Diagnose the
        // specific shape so the author sees the cause, not a downstream
        // `undeclared-var` blaming the symptom. Sibling to v0.9.2 P0.8
        // (`$append VAR =`) + qwen-test P0.5 (`$<word>`) treatments.
        const tail = stripped.slice(4).trim();
        let detail: string;
        if (tail === "") {
          detail = "missing variable name and `=` assignment. Canonical: `$set VAR = value`.";
        } else if (!tail.includes("=")) {
          detail = `'${tail.slice(0, 40)}' has no \`=\` assignment. Canonical: \`$set VAR = value\` (the \`=\` is required).`;
        } else if (/^\d/.test(tail)) {
          detail = `'${tail.slice(0, 40)}' starts with a digit. Variable names must start with a letter or underscore.`;
        } else if (/^[A-Za-z_]\w*\.[A-Za-z_]/.test(tail)) {
          detail = `'${tail.slice(0, 40)}' uses dotted target. \`$set\` binds top-level variables only; dotted writes aren't supported. Bind a parent var first via \`$set PARENT = {...}\` then mutate via \`$ json_parse\` + structured ops.`;
        } else {
          detail = `'${tail.slice(0, 40)}' doesn't match the \`VAR = value\` shape. Variable names: \`[A-Za-z_]\\w*\`. Canonical: \`$set VAR = value\`.`;
        }
        result.parseErrors.push(`Malformed \`$set\` op in target '${currentTarget.name}': ${detail}`);
      }
      continue;
    } else if (stripped.startsWith("$append ") || stripped === "$append") {
      const match = APPEND_OP_REGEX.exec(stripped);
      if (match) {
        const [, setName, rawValue] = match;
        // v0.9.2 — P0.8 detect `$append VAR = "value"` shape. The regex
        // matches because `= "value"` is a valid `[\s\S]+` token, but the
        // `=` was almost certainly meant as a `$set`-style assignment.
        // The canonical mutation form is `$append VAR <value>`. Surface
        // explicitly rather than letting `= "value"` become a literal
        // value the runtime would render verbatim.
        if (/^=\s/.test(rawValue!)) {
          result.parseErrors.push(
            `\`$append\` op in target '${currentTarget.name}' has \`= ...\` value shape. ` +
            `Did you mean \`$set ${setName} = ...\` (replace) or \`$append ${setName} <...>\` (append)? ` +
            `The canonical append syntax is \`$append VAR <value>\`.`,
          );
          continue;
        }
        // v0.9.4 — N2 strip the canonical `<...>` operator wrapper. Per
        // language reference, `$append VAR <value>` is the canonical
        // shape and the angle brackets are the OPERATOR, not part of
        // the value. Pre-v0.9.4 the brackets were captured verbatim and
        // string-concat targets received `<"line">` literally, producing
        // silent wrong output (per R8 minion #3, finding N2 in 9086b3f8).
        let unwrappedValue = rawValue!;
        if (unwrappedValue.startsWith("<") && unwrappedValue.endsWith(">") && unwrappedValue.length >= 2) {
          unwrappedValue = unwrappedValue.slice(1, -1).trim();
        }
        opBucket.push({
          kind: "$append",
          body: stripped,
          setName: setName!,
          setValue: processSetValue(unwrappedValue),
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
        // v0.9.4 — N1 extract `approved="..."` kwarg from `$` op body so
        // lint rules (unconfirmed-mutation) can honor it per docs. The
        // function-call op grammar extracts kwargs into op fields; the
        // `$` op grammar leaves the whole body as a string by design,
        // but `approved=` is the one kwarg with cross-cutting lint
        // semantics that needs explicit AST surface.
        const approvedKwarg = extractApprovedKwarg(rest);
        opBucket.push({
          kind: "$",
          body: rest,
          outputVar: dollarOutMatch[2]!,
          ...(connector !== undefined ? { mcpConnector: connector } : {}),
          ...(dollarFallback !== undefined ? { fallback: processSetValue(dollarFallback) } : {}),
          ...(approvedKwarg !== undefined ? { approved: approvedKwarg } : {}),
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
      result.parseErrors.push(
        `Legacy \`@\` shell op in target '${currentTarget.name}' is no longer supported. ` +
        `Use \`shell(command="...") [-> R] [(fallback: "...")]\` (add \`unsafe=true\` kwarg for full-shell exec; runtime opt-in still required).`,
      );
      continue;
    } else if (stripped.startsWith("! ") || stripped === "!") {
      result.parseErrors.push(
        `Legacy \`!\` emit op in target '${currentTarget.name}' is no longer supported. ` +
        `Use \`emit(text="...")\`.`,
      );
      continue;
    }
    if (kind !== null) {
      // N1: extract `approved=` for the no-binding `$` op path.
      const approvedKwarg = kind === "$" ? extractApprovedKwarg(body) : undefined;
      opBucket.push({
        kind,
        body,
        ...(mcpConnectorForOp !== undefined ? { mcpConnector: mcpConnectorForOp } : {}),
        ...(approvedKwarg !== undefined ? { approved: approvedKwarg } : {}),
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
        `Composition is via \`inline(skill="...")\` (data-skill inline) or \`execute_skill(name="...")\` (in-skill invocation), not block syntax.`,
      );
      scopeStack.push({
        kind: "unknown-block",
        target: currentTarget,
        opsBucket: [],
        depth: lineIndent + INDENT_STEP,
      });
    } else if (NO_SPACE_DISPATCH_RE.test(stripped0)) {
      // v0.9.2 — P0.5 detect `$<word> args` (no space between `$` and tool
      // name). The canonical external-dispatch shape is `$ <tool> args`;
      // the no-space form historically silent-dropped because no op-prefix
      // branch matched it. Now: parse error with the canonical fix. Per
      // qwen single-shot finding `a3a20593`.
      const m = /^\$(\w+)/.exec(stripped0);
      const word = m?.[1] ?? "";
      result.parseErrors.push(
        `Op line \`${stripped0}\` in target '${currentTarget.name}' — \`$${word}\` is missing the space between \`$\` and the tool/connector name. ` +
        `Did you mean \`$ ${word} ...\` (external MCP dispatch)? ` +
        `\`$set\` / \`$append\` are the only no-space \`$\`-prefix ops (mutation statements).`,
      );
    }
  }

  if (result.entryTarget === null && result.targets.size > 0) {
    const names = Array.from(result.targets.keys());
    result.entryTarget = names[names.length - 1] ?? null;
  }

  // v0.19.7 — entry target points at a target that doesn't exist. Author
  // wrote `default: stamp` but never declared `stamp:`. Silent-drop pre-fix:
  // entryTarget would set to "stamp", template-only path would render the
  // body template (or fail with no-targets), and the missing target would
  // never be flagged. Loud parse error so the author can self-correct.
  // Closes Perry's `9a62c1f2` minion-test finding alongside the orphan-
  // indented-op guard.
  if (result.entryTarget !== null && !result.targets.has(result.entryTarget)) {
    result.parseErrors.push(
      `\`default: ${result.entryTarget}\` references a target that doesn't exist. ` +
      `Declared targets: ${result.targets.size === 0 ? "(none)" : Array.from(result.targets.keys()).map((n) => `'${n}'`).join(", ")}. ` +
      `Did you mean to declare \`${result.entryTarget}:\` as a target above the \`default:\` line?`,
    );
  }

  // v0.19.4 / v0.19.8 — finalize the body-text-as-output template.
  // Trim leading and trailing blank lines; internal blanks preserved.
  // Empty result collapses to `null` so legacy emit-only skills are
  // byte-equivalent to pre-v0.19.4 parse output. Template-anywhere
  // (v0.19.8) means content may originate pre-first-target OR
  // post-last-target — we concatenate in source order.
  if (templateLines.length > 0) {
    const joined = templateLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    if (joined !== "") result.outputTemplate = joined;
  }

  // v0.19.8 — multi-region template guard. Per Perry's `349a1d49`
  // recommendation: error on a skill that has body template content
  // both BEFORE any target AND AFTER all targets. Don't silently
  // concatenate; force the author to pick one location.
  if (templateContentBeforeTarget && templateContentAfterTarget) {
    result.parseErrors.push(
      `Skill has body-text-as-output template content in two places (before targets AND after targets). ` +
      `Pick one location: put the template either above all targets OR below them, not both. ` +
      `Concatenating across regions silently would hide the structural ambiguity.`,
    );
  }

  return result;
}

// Toposort moved to compile.ts (semantic analysis). applyFilter moved to
// filters.ts (predictable filter-add location per ERD §2 modifiability).
