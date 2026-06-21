import type { SkillStore } from "./connectors/types.js";

/**
 * Best-effort static reverse-dependency scan: which other stored skills
 * literally reference `target` via `$ execute_skill(... name="target")` or
 * `inline(... skill="target")`? Literal-name only — a runtime-resolved
 * `name="${VAR}"` reference can't be detected statically. Used by the delete
 * surfaces (CLI `skillfile delete` + the dashboard delete) to warn before
 * removing a skill other skills compose against. O(N) over the store; runs at
 * operator-action time, not on a hot path.
 */
export async function findStaticDependents(store: SkillStore, target: string): Promise<string[]> {
  let metas;
  try { metas = await store.query(); } catch { return []; }
  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:execute_skill\\([^)]*name|inline\\([^)]*skill)\\s*=\\s*"${esc}"`);
  const dependents: string[] = [];
  for (const m of metas) {
    if (m.name === target) continue;
    try {
      const loaded = await store.load(m.name);
      if (re.test(loaded.source)) dependents.push(m.name);
    } catch { /* skip unreadable */ }
  }
  return dependents.sort();
}
