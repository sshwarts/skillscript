// Effectful-footprint extraction — "what does this skill touch?"
//
// Walks a parsed skill's ops and summarizes its effectful surface: the MCP
// connectors it dispatches to, the built-in `$` ops it uses, the shell binaries
// it invokes, and its file/notify footprint. Derived statically from the AST
// (the same effectful op classes the capability gate enumerates), so it needs
// no execution. Serves two callers: `skill_preflight` (the cold-author / pre-
// execution contract check) and the dashboard approval UX (the human approver's
// least-privilege "what does it touch" checklist).

import type { ParsedSkill, SkillOp } from "./parser.js";

export interface EffectfulFootprint {
  /** Distinct MCP connectors dispatched to (`$ <connector>.<tool> ...`). */
  connectors: string[];
  /** Distinct built-in `$` ops (data_write / skill_write / data_read / llm / execute_skill / ...). */
  builtins: string[];
  /** Distinct shell binaries invoked (`bash` for any `unsafe=true` op). */
  shell_binaries: string[];
  /** Count of `shell(..., unsafe=true)` ops (full-bash interpretation). */
  unsafe_shell: number;
  /** Count of `file_write(...)` ops. */
  file_writes: number;
  /** Count of `file_read(...)` ops. */
  file_reads: number;
  /** Count of `notify(...)` (agent-wake) ops. */
  notifies: number;
}

/** Recursively visit every op, descending into foreach / if / elif / else bodies. */
function walkOps(ops: SkillOp[], visit: (op: SkillOp) => void): void {
  for (const op of ops) {
    visit(op);
    if (op.foreachBody) walkOps(op.foreachBody, visit);
    if (op.ifBranches) for (const b of op.ifBranches) walkOps(b.body, visit);
    if (op.ifElseBody) walkOps(op.ifElseBody, visit);
  }
}

function firstToken(s: string): string {
  return s.trim().split(/\s+/)[0] ?? "";
}

/**
 * v0.23.0 — the unique qualified connector-tool references a skill dispatches:
 * each `$ <connector>.<tool>` op as `{ connector, tool }`, de-duplicated. Used
 * by skill_preflight to surface the input schema (and observed output shape)
 * for ONLY the tools this skill calls — selective by construction. Bare-form
 * `$ <tool>` (no connector prefix) is excluded; its owning connector resolves
 * at dispatch.
 */
export function extractConnectorToolRefs(parsed: ParsedSkill): Array<{ connector: string; tool: string }> {
  const seen = new Map<string, { connector: string; tool: string }>();
  for (const target of parsed.targets.values()) {
    walkOps(target.ops, (op) => {
      if (op.kind !== "$" || op.mcpConnector === undefined) return;
      const tool = firstToken(op.body);
      if (tool.length === 0) return;
      seen.set(`${op.mcpConnector}.${tool}`, { connector: op.mcpConnector, tool });
    });
  }
  return [...seen.values()].sort((a, b) =>
    a.connector.localeCompare(b.connector) || a.tool.localeCompare(b.tool));
}

export function extractEffectfulFootprint(parsed: ParsedSkill): EffectfulFootprint {
  const connectors = new Set<string>();
  const builtins = new Set<string>();
  const shellBins = new Set<string>();
  let unsafeShell = 0;
  let fileWrites = 0;
  let fileReads = 0;
  let notifies = 0;

  for (const target of parsed.targets.values()) {
    walkOps(target.ops, (op) => {
      switch (op.kind) {
        case "$": {
          // `$ <connector>.<tool>` → a connector dispatch; bare `$ <builtin>`
          // (data_write / skill_write / data_read / llm / execute_skill / …) →
          // the builtin name is the first token of the body.
          if (op.mcpConnector !== undefined) {
            connectors.add(op.mcpConnector);
          } else {
            const t = firstToken(op.body);
            if (t.length > 0) builtins.add(t);
          }
          break;
        }
        case "shell": {
          if (op.policy === "unsafe") {
            unsafeShell++;
            shellBins.add("bash");
          } else {
            const bin = op.argv?.[0] ?? firstToken(op.body);
            if (bin.length > 0) shellBins.add(bin);
          }
          break;
        }
        case "file_write": fileWrites++; break;
        case "file_read": fileReads++; break;
        case "notify": notifies++; break;
        default: break;
      }
    });
  }

  return {
    connectors: [...connectors].sort(),
    builtins: [...builtins].sort(),
    shell_binaries: [...shellBins].sort(),
    unsafe_shell: unsafeShell,
    file_writes: fileWrites,
    file_reads: fileReads,
    notifies,
  };
}

// ── Control-flow "flow" (lanes + plain-language steps) ──────────────────────
// A reading-order projection of the skill for the dashboard's approval view,
// aimed at a NON-PROGRAMMER approver: the point is understanding what the skill
// DOES, without reading skillscript. Each target is a "lane"; each op inside it
// is a "step" described in plain language ("Write to the data store", "Ask the
// local model", "Run a bash command"), with loops and branches nested. Same
// static parse as the footprint — a different projection. The CLI's
// `skillfile diagram` still emits Mermaid text from the same parse (renderMermaid
// in cli.ts); this is the human-readable second output, drawn as HTML by the SPA.

/** A single step: one op, described for a human, with `mutation`/`shell` steps
 * toned for attention. Container ops carry nested `children` (foreach body) or
 * `branches` (if / elif / else). */
export interface FlowStep {
  label: string;
  detail?: string;
  tone: "normal" | "mutation" | "shell";
  /** The variable this step saves its result into (`-> VAR`), if any — lets a
   * reader trace where a value is produced vs. where it's consumed. */
  produces?: string;
  /** When the step runs/includes another skill, its name — so the UI can link
   * through to that skill's own review view ("see what it does"). */
  ref?: { skill: string };
  children?: FlowStep[];
  branches?: Array<{ label: string; steps: FlowStep[] }>;
}
/** A target rendered as a lane: its steps in order, plus which targets it needs. */
export interface FlowLane {
  id: string;
  isEntry: boolean;
  deps: string[];
  steps: FlowStep[];
}
export interface SkillFlow {
  /** Lanes in reading (dependency) order — a needed target precedes its dependents. */
  lanes: FlowLane[];
  entry: string | null;
  /** True when the skill exceeded the lane cap and the flow was truncated. */
  truncated: boolean;
}

/** Lane cap — beyond this the flow stops being a readable orientation aid. */
const MAX_FLOW_LANES = 40;

/** Built-in `$` ops → plain language. Unlisted builtins fall back to their name. */
const BUILTIN_STEP: Record<string, { label: string; tone: FlowStep["tone"] }> = {
  data_read: { label: "Read from the data store", tone: "normal" },
  data_write: { label: "Write to the data store", tone: "mutation" },
  llm: { label: "Ask the local model", tone: "normal" },
  json_parse: { label: "Parse JSON", tone: "normal" },
  execute_skill: { label: "Run another skill", tone: "normal" },
  skill_read: { label: "Read a skill", tone: "normal" },
  skill_list: { label: "List skills", tone: "normal" },
  skill_write: { label: "Write a skill", tone: "mutation" },
};

function humanizeToolName(tool: string): string {
  return tool.replace(/_/g, " ");
}

/** Pull the binary + a short command snippet out of a `shell(command="…")` op. */
function shellCommand(op: SkillOp): { binary: string; snippet: string | undefined } {
  if (op.argv && op.argv.length > 0) {
    return { binary: op.argv[0] ?? "", snippet: op.argv.join(" ") };
  }
  const m = op.body.match(/command\s*=\s*"([^"]*)"/) ?? op.body.match(/command\s*=\s*'([^']*)'/);
  const cmd = (m?.[1] ?? op.body).trim();
  return { binary: firstToken(cmd), snippet: cmd === "" ? undefined : cmd };
}

function clip(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** A `$set` value shown only when it's a plain literal — computed expressions
 * (variable references / filters) are raw skillscript, noise to a reader, so
 * they're dropped and the step reads simply as "Set X". */
function literalSetValue(v: string | undefined): string | undefined {
  if (v === undefined || v === "") return undefined;
  if (v.includes("${") || v.includes("$(")) return undefined;
  return clip(v.replace(/^["']|["']$/g, ""), 60);
}

/** Value of a `key="…"` (or `key='…'`) kwarg in an op body. `key` comes from a
 * fixed internal list, so building the RegExp from it is safe. */
function argValue(body: string, key: string): string | undefined {
  return body.match(new RegExp(key + '\\s*=\\s*"([^"]*)"'))?.[1]
    ?? body.match(new RegExp(key + "\\s*=\\s*'([^']*)'"))?.[1];
}

/** The most human-meaningful argument to show for a step — the "what" (the
 * query it reads, the prompt it asks, the content it writes). First match wins. */
const PRIMARY_ARG_KEYS = ["query", "prompt", "content", "message", "text", "url", "path", "name", "mode"];
function primaryArg(body: string): string | undefined {
  for (const k of PRIMARY_ARG_KEYS) {
    const v = argValue(body, k);
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/** Describe one op as a human-readable step. Leaf steps also carry the variable
 * they produce (`-> VAR`) so a reader can trace data flow — see where a value is
 * created and where (or whether) it's used. */
function describeStep(op: SkillOp): FlowStep {
  const step = describeStepBody(op);
  if (op.outputVar !== undefined && op.outputVar !== "" && step.children === undefined && step.branches === undefined) {
    step.produces = op.outputVar;
  }
  return step;
}

function describeStepBody(op: SkillOp): FlowStep {
  switch (op.kind) {
    case "foreach":
      return {
        label: `For each ${op.foreachIter ?? "item"} in ${op.foreachList ?? "the list"}`,
        tone: "normal",
        children: (op.foreachBody ?? []).map(describeStep),
      };
    case "if": {
      const branches = (op.ifBranches ?? []).map((b, i) => ({
        label: `${i === 0 ? "If" : "Otherwise, if"} ${clip(b.cond, 60)}`,
        steps: b.body.map(describeStep),
      }));
      if (op.ifElseBody) branches.push({ label: "Otherwise", steps: op.ifElseBody.map(describeStep) });
      return { label: "Depending on the result", tone: "normal", branches };
    }
    case "shell": {
      const { binary, snippet } = shellCommand(op);
      if (op.policy === "unsafe") {
        return { label: "Run a full bash command", detail: clip(snippet, 70), tone: "shell" };
      }
      return { label: binary ? `Run ${binary}` : "Run a shell command", detail: clip(snippet, 70), tone: "shell" };
    }
    case "file_read":
      return { label: "Read a file", detail: clip(op.fileParams?.path, 60), tone: "normal" };
    case "file_write":
      return { label: "Write a file", detail: clip(op.fileParams?.path, 60), tone: "mutation" };
    case "notify":
      return { label: "Send a notification", tone: "mutation" };
    case "emit":
      return { label: "Produce output", tone: "normal" };
    case "inline": {
      const name = op.ampParams?.skillName;
      const step: FlowStep = { label: name ? `Include the ${name} skill` : "Include a skill", tone: "normal" };
      if (name) step.ref = { skill: name };
      return step;
    }
    case "$set":
      return { label: `Set ${op.setName ?? "a value"}`, detail: literalSetValue(op.setValue), tone: "normal" };
    case "$append":
      return { label: `Add to ${op.setName ?? "a value"}`, detail: literalSetValue(op.setValue), tone: "normal" };
    case "?":
      return { label: "Check a condition", tone: "normal" };
    case "$": {
      const tool = firstToken(op.body);
      // A composed skill: name it, and carry a ref so the UI can link through.
      if (op.mcpConnector === undefined && tool === "execute_skill") {
        const child = argValue(op.body, "skill_name") ?? argValue(op.body, "skill");
        const step: FlowStep = { label: child ? `Run the ${child} skill` : "Run another skill", tone: "normal" };
        if (child) step.ref = { skill: child };
        return step;
      }
      const detail = clip(primaryArg(op.body), 60);
      if (op.mcpConnector !== undefined) {
        return { label: humanizeToolName(tool), detail: detail ?? `via ${op.mcpConnector}`, tone: "normal" };
      }
      const known = BUILTIN_STEP[tool];
      if (known !== undefined) {
        return { label: known.label, detail, tone: known.tone };
      }
      return { label: tool === "" ? "Run an operation" : humanizeToolName(tool), detail, tone: "normal" };
    }
    default:
      return { label: String(op.kind), tone: "normal" };
  }
}

/** Order targets so a needed target precedes its dependents (Kahn's algorithm),
 * falling back to declaration order for any leftovers (e.g. a dependency cycle,
 * which compile rejects anyway). */
function orderLanes(names: string[], depsOf: (n: string) => string[]): string[] {
  const present = new Set(names);
  const indeg = new Map(names.map((n) => [n, 0]));
  for (const n of names) for (const d of depsOf(n)) if (present.has(d)) indeg.set(n, (indeg.get(n) ?? 0) + 1);
  const queue = names.filter((n) => (indeg.get(n) ?? 0) === 0);
  const ordered: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    ordered.push(n);
    for (const m of names) {
      if (seen.has(m)) continue;
      if (depsOf(m).includes(n)) {
        indeg.set(m, (indeg.get(m) ?? 1) - 1);
        if ((indeg.get(m) ?? 0) <= 0) queue.push(m);
      }
    }
  }
  for (const n of names) if (!seen.has(n)) ordered.push(n); // cycle leftovers, declaration order
  return ordered;
}

/**
 * Project a parsed skill into reading-order lanes of plain-language steps.
 * Body-only skills (no targets) return an empty lane list — the dashboard shows
 * no flow for those (there is nothing to walk).
 */
export function buildSkillFlow(parsed: ParsedSkill): SkillFlow {
  const allNames = [...parsed.targets.keys()];
  const truncated = allNames.length > MAX_FLOW_LANES;
  const names = truncated ? allNames.slice(0, MAX_FLOW_LANES) : allNames;
  const included = new Set(names);

  const ordered = orderLanes(names, (n) => parsed.targets.get(n)?.deps ?? []);
  const lanes: FlowLane[] = ordered.map((name) => {
    const target = parsed.targets.get(name)!;
    return {
      id: name,
      isEntry: parsed.entryTarget === name,
      deps: target.deps.filter((d) => included.has(d)),
      steps: target.ops.map(describeStep),
    };
  });

  const entry = parsed.entryTarget !== null && included.has(parsed.entryTarget)
    ? parsed.entryTarget
    : null;

  return { lanes, entry, truncated };
}
