// Source text → AST. The parser recognizes the full v1 grammar but performs
// no resolution against external state. Semantic analysis (variable resolution,
// data-skill inlining, topo-sort) lives in compile.ts.

export type OpKind = "$" | "$set" | "?" | "@" | "!" | "??" | "foreach" | "if" | ">" | "~";

export interface SkillOp {
  kind: OpKind;
  body: string;
  outputVar?: string;
  mcpConnector?: string;
  retrievalParams?: {
    mode: string;
    query: string;
    limit: number;
    connector: string;
    extra: Record<string, string>;
  };
  localModelParams?: {
    prompt: string;
    model?: string;
    maxTokens?: number;
  };
  setName?: string;
  setValue?: string;
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

export type OutputKind = "text" | "slack" | "prompt-context" | "file" | "card" | "none";

export interface OutputDecl {
  kind: OutputKind;
  target?: string;
}

export interface ParsedSkill {
  name: string | null;
  description: string | null;
  vars: SkillVar[];
  requires: SkillRequire[];
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
const SET_OP_REGEX = /^\$set\s+([A-Za-z_]\w*)\s*=\s*(.*)$/;
const FOREACH_OP_REGEX = /^foreach\s+([A-Za-z_]\w*)\s+in\s+(.+?):\s*$/;
const IF_OP_REGEX = /^if\s+(.+?):\s*$/;
const ELIF_OP_REGEX = /^elif\s+(.+?):\s*$/;
const RETRIEVAL_OP_REGEX = /^>\s+(.+?)\s+->\s+([A-Za-z_]\w*)\s*$/;
const LOCAL_MODEL_OP_REGEX = /^~\s+(.+?)\s+->\s+([A-Za-z_]\w*)\s*$/;
const MCP_CONNECTOR_PREFIX = /^([a-z_][a-z0-9_-]*)\.(?=[A-Za-z_])([\s\S]*)$/;

// Narrow v1 condition grammar. AND/OR, numeric comparisons, defined-checks
// are deliberately excluded — lint surfaces complexity-creep at authoring time.
const COND_TRUTHY = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)?\)\s*$/;
const COND_EQ = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)?\)\s*(?:==|!=)\s*"[^"]*"\s*$/;
const COND_IN = /^\s*\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\|\s*[A-Za-z_]\w*)?\)\s+(?:not\s+)?in\s+\$\([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\)\s*$/;

function validateCondition(cond: string): boolean {
  return COND_TRUTHY.test(cond) || COND_EQ.test(cond) || COND_IN.test(cond);
}

const INDENT_STEP = 4;

function leadingSpaces(rawLine: string): number {
  const m = /^( *)/.exec(rawLine);
  return m ? m[1]!.length : 0;
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
  const limit = parseInt(map["limit"] ?? "", 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    errors.push(`\`>\` op in target '${targetName}': 'limit' must be a positive integer (got '${map["limit"] ?? ""}')`);
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
      limit: Number.isFinite(limit) ? limit : 0,
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
  const recognized = new Set(["prompt", "model", "maxTokens"]);
  for (const key of Object.keys(map)) {
    if (!recognized.has(key)) {
      errors.push(`\`~\` op in target '${targetName}': unrecognized param '${key}' — strict grammar allows prompt/model/maxTokens only. Interpolate context into the prompt string via $(...) instead.`);
    }
  }
  if (!("prompt" in map) || map["prompt"] === "") {
    errors.push(`\`~\` op in target '${targetName}' missing required param 'prompt'`);
  }
  let maxTokens: number | undefined;
  if ("maxTokens" in map) {
    const parsed = parseInt(map["maxTokens"]!, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push(`\`~\` op in target '${targetName}': 'maxTokens' must be a positive integer (got '${map["maxTokens"]}')`);
    } else {
      maxTokens = parsed;
    }
  }
  const params: NonNullable<SkillOp["localModelParams"]> = {
    prompt: map["prompt"] ?? "",
  };
  if ("model" in map && map["model"] !== "") params.model = map["model"]!;
  if (maxTokens !== undefined) params.maxTokens = maxTokens;
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
  const lines = source.split("\n");
  const result: ParsedSkill = {
    name: null,
    description: null,
    vars: [],
    requires: [],
    useWhen: null,
    targets: new Map(),
    entryTarget: null,
    onError: null,
    triggers: [],
    outputs: [],
    parseErrors: [],
  };
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
        result.name = value;
      } else if (key === "description") {
        result.description = value;
      } else if (key === "vars") {
        if (value.toLowerCase() === "(none)" || value === "") {
          result.vars = [];
        } else {
          result.vars = splitVarsLine(value).map((entry) => {
            const trimmed = entry.trim();
            const eq = trimmed.indexOf("=");
            if (eq === -1) {
              return { name: trimmed, required: true };
            }
            return {
              name: trimmed.slice(0, eq).trim(),
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
        for (const raw of splitVarsLine(value)) {
          const decl = raw.trim();
          if (decl === "") continue;
          const colon = decl.indexOf(":");
          if (colon === -1) {
            result.parseErrors.push(`Malformed \`# Triggers:\` declaration '${decl}' — expected '<source>: <name>'`);
            continue;
          }
          const source = decl.slice(0, colon).trim().toLowerCase();
          const name = decl.slice(colon + 1).trim();
          const allowed: TriggerSource[] = ["session", "cron", "event", "agent-event", "file-watch", "sensor"];
          if (!allowed.includes(source as TriggerSource)) {
            result.parseErrors.push(`Unsupported trigger source '${source}' — allowed: ${allowed.join(", ")}`);
            continue;
          }
          if (name === "") {
            result.parseErrors.push(`\`# Triggers:\` declaration '${decl}' has empty name`);
            continue;
          }
          result.triggers.push({ source: source as TriggerSource, name });
        }
      } else if (key === "output") {
        if (value.toLowerCase() === "(none)" || value === "") continue;
        for (const raw of splitVarsLine(value)) {
          const decl = raw.trim();
          if (decl === "") continue;
          const allowedKinds: OutputKind[] = ["text", "slack", "prompt-context", "file", "card", "none"];
          const colon = decl.indexOf(":");
          if (colon === -1) {
            if (decl === "text" || decl === "none") {
              result.outputs.push({ kind: decl as OutputKind });
            } else {
              result.parseErrors.push(`\`# Output:\` kind '${decl}' missing target — kinds 'slack', 'prompt-context', 'file', 'card' require '<kind>: <target>'. Only 'text' and 'none' are bare-only.`);
            }
            continue;
          }
          const kind = decl.slice(0, colon).trim().toLowerCase();
          const target = decl.slice(colon + 1).trim();
          if (!allowedKinds.includes(kind as OutputKind)) {
            result.parseErrors.push(`Unsupported output kind '${kind}' — allowed: ${allowedKinds.join(", ")}`);
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
          result.outputs.push({ kind: kind as OutputKind, target });
        }
      } else if (key === "requires") {
        if (value.toLowerCase() === "(none)" || value === "") continue;
        const match = REQUIRES_LINE.exec(value);
        if (!match) continue;
        const [, namespace, k, target, fallback] = match;
        result.requires.push({
          namespace: namespace as "user-var" | "system-var",
          key: k!,
          target: target!,
          fallback: fallback === undefined ? null : fallback,
          raw: value,
        });
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
      const depsStr = line.slice(colonIdx + 1).trim();
      const deps = depsStr === "" ? [] : depsStr.split(/\s+/);
      if (name === "default") {
        result.entryTarget = deps[0] ?? null;
        currentTarget = null;
        scopeStack = [];
        continue;
      }
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
    if (topFrame.depth !== lineIndent) continue;
    const opBucket = topFrame.opsBucket;
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
        result.parseErrors.push(`Malformed \`>\` op in target '${currentTarget.name}' — expected \`> key=value ... -> VARNAME\``);
        continue;
      }
      const [, argsStr, outputVar] = match;
      const parsed = parseRetrievalArgs(argsStr!, currentTarget.name);
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) result.parseErrors.push(e);
        continue;
      }
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
        result.parseErrors.push(`Malformed \`~\` op in target '${currentTarget.name}' — expected \`~ key=value ... -> VARNAME\``);
        continue;
      }
      const [, argsStr, outputVar] = match;
      const parsed = parseLocalModelArgs(argsStr!, currentTarget.name);
      if (parsed.errors.length > 0) {
        for (const e of parsed.errors) result.parseErrors.push(e);
        continue;
      }
      opBucket.push({
        kind: "~",
        body: stripped0,
        outputVar: outputVar!,
        localModelParams: parsed.params,
      });
      continue;
    }
    if (stripped0.startsWith("foreach ")) {
      const fmatch = FOREACH_OP_REGEX.exec(stripped0);
      if (!fmatch) {
        result.parseErrors.push(`Malformed \`foreach\` op in target '${currentTarget.name}' — expected \`foreach IDENT in EXPR:\``);
        continue;
      }
      const [, iter, listExpr] = fmatch;
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
    // Check `??` before `?`, `$set` before `$`.
    if (stripped.startsWith("?? ") || stripped === "??") {
      kind = "??";
      body = stripped.slice(3).trim();
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
      const dollarOutMatch = /^(.+?)\s+->\s+([A-Za-z_]\w*)\s*$/.exec(tail);
      if (dollarOutMatch !== null) {
        const bodyPart = dollarOutMatch[1]!.trim();
        const { connector, rest } = splitMcpConnectorPrefix(bodyPart);
        opBucket.push({
          kind: "$",
          body: rest,
          outputVar: dollarOutMatch[2]!,
          ...(connector !== undefined ? { mcpConnector: connector } : {}),
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
      body = stripped.slice(2).trim();
    } else if (stripped.startsWith("! ") || stripped === "!") {
      kind = "!";
      body = stripped.slice(2).trim();
    }
    if (kind !== null) {
      opBucket.push({
        kind,
        body,
        ...(mcpConnectorForOp !== undefined ? { mcpConnector: mcpConnectorForOp } : {}),
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
