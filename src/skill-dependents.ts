import type { SkillStore } from "./connectors/types.js";
import { parse, type SkillOp } from "./parser.js";
import { SkillNotFoundError } from "./errors.js";

/**
 * Static reverse-dependency scan: which other stored skills reference `target`
 * via `$ execute_skill(... name="target")` / `& target` (inline compose)?
 * Literal-name only — a runtime-resolved `name="${VAR}"` reference can't be
 * detected statically. Used by the delete surfaces (CLI `skillfile delete` +
 * the dashboard delete) to warn before removing a skill others compose against.
 * O(N) over the store; runs at operator-action time, not on a hot path.
 *
 * Detection parses each body and inspects the ops, matching the SAME two
 * reference forms the `unknown-skill-reference` lint rule recognises
 * (`collectAmpRefsFromOps`). The previous text-regex matched only the
 * function-call source forms (`execute_skill(name=...)` / `inline(skill=...)`)
 * and silently MISSED the `$ execute_skill name="x"` bare-dispatch form — the
 * most common composition form — so a skill referenced that way was invisible
 * to the delete guard. Parsing keeps the guard in lockstep with what the
 * runtime actually treats as a composition reference (both dispatch and
 * function-call forms parse to the same ops).
 *
 * FAIL-CLOSED CONTRACT (2d2a7fd4): this function THROWS when the scan cannot be
 * completed — a `query()` failure, or an individual `load()` failure that is not
 * a clean not-found. It must never flatten "could not scan" into "no
 * dependents": that reads as "safe to delete" precisely during a store outage,
 * which is the window an operator is most likely to be clearing state. Callers
 * MUST treat a throw as "cannot verify → refuse the delete" (the `--force`
 * path is the documented override). An empty array means the scan RAN and found
 * nothing; only that answer authorizes a dependency-clean delete.
 */
export async function findStaticDependents(store: SkillStore, target: string): Promise<string[]> {
  const metas = await store.query();
  const dependents: string[] = [];
  for (const m of metas) {
    if (m.name === target) continue;
    let source: string;
    try {
      source = (await store.load(m.name)).source;
    } catch (err) {
      // A skill that vanished between query() and load() cannot be a
      // dependent — skip it. Any OTHER failure (transport, permission, a
      // torn read) means we could not determine whether it references
      // `target`, so we cannot assert the delete is safe → fail closed.
      if (err instanceof SkillNotFoundError) continue;
      throw err;
    }
    // parse() never throws (structured result even on bad input), so a
    // malformed body simply yields no references rather than aborting the scan.
    if (referencesSkill(parse(source).targets, target)) dependents.push(m.name);
  }
  return dependents.sort();
}

/** Does any op across these targets compose `target` by literal name? */
function referencesSkill(targets: Map<string, { ops: SkillOp[] }>, target: string): boolean {
  let found = false;
  for (const { ops } of targets.values()) {
    walkOps(ops, (op) => {
      if (found) return;
      if (op.kind === "inline" && op.ampParams?.skillName === target) { found = true; return; }
      if (op.kind === "$" && /^execute_skill\b/.test(op.body)) {
        // Accept `name` or the `skill_name` back-compat alias; quoted or bareword.
        const mm = /\b(?:skill_name|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w-]*))/.exec(op.body);
        const name = mm?.[1] ?? mm?.[2] ?? mm?.[3];
        if (name === target) found = true;
      }
    });
    if (found) break;
  }
  return found;
}

function walkOps(ops: SkillOp[], visit: (op: SkillOp) => void): void {
  for (const op of ops) {
    visit(op);
    if (op.foreachBody !== undefined) walkOps(op.foreachBody, visit);
    if (op.ifBranches !== undefined) for (const b of op.ifBranches) walkOps(b.body, visit);
    if (op.ifElseBody !== undefined) walkOps(op.ifElseBody, visit);
  }
}
