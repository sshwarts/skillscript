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
