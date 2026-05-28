/**
 * v0.9.8 — `skill_list` evolution: build the agent-facing SkillCatalog
 * response from raw SkillStore metadata + parsed skill sources.
 *
 * Per Perry's audit thread `f0b8b832` + addendum `73c79a28` + lock `011feaf0`.
 * Category derivation from existing `# Output:` semantics; no new frontmatter
 * syntax. Filter mechanism AND-composes audience + status + trigger_kind +
 * domain_tags + name_prefix.
 */
import type { SkillCatalog, SkillEntry, SkillListFilter, SkillStore } from "./connectors/types.js";
import { parse } from "./parser.js";
import type { TriggerDecl, OutputDecl } from "./parser.js";

const DEFAULT_AUDIENCE: SkillListFilter["audience"] = "agent";
const DEFAULT_STATUS = "Approved";

/**
 * Build the catalog for a given SkillStore + filter.
 *
 * Loads + parses every skill matching the status filter; derives category,
 * vars, outputs, triggers; groups by audience-derived category. Cost is
 * O(N) load+parse calls per invocation. Typically called once at session
 * start, so the cost is acceptable for v1.0.
 *
 * Adopters with large stores who hit performance issues can fork this
 * function + cache parsed metadata in their SkillStore impl.
 */
export async function buildSkillCatalog(
  skillStore: SkillStore,
  filter: SkillListFilter = {},
): Promise<SkillCatalog> {
  const audience = filter.audience ?? DEFAULT_AUDIENCE;
  const status = filter.status ?? DEFAULT_STATUS;

  // Query the underlying store for status-filtered metas; the discovery
  // surface always defaults to Approved (cold authors don't see Drafts).
  const metas = await skillStore.query({ status });

  const entries: SkillEntry[] = [];
  for (const meta of metas) {
    if (filter.name_prefix !== undefined && !meta.name.startsWith(filter.name_prefix)) {
      continue;
    }
    if (filter.domain_tags !== undefined && filter.domain_tags.length > 0) {
      const skillTags = (meta.metadata_bag?.["domain_tags"] as string[] | undefined) ?? meta.metadata_bag?.["tags"] as string[] | undefined ?? [];
      if (!filter.domain_tags.every((t) => skillTags.includes(t))) continue;
    }

    let parsed;
    let source: string;
    try {
      const loaded = await skillStore.load(meta.name);
      source = loaded.source;
      parsed = parse(source);
    } catch {
      // Skill loaded but parse failed — surface a minimal entry so
      // adopter dashboards can still see the skill exists.
      entries.push({
        name: meta.name,
        category: "headless",
        description: meta.description ?? "",
        status: meta.status,
        vars: [],
        output: [],
        triggers: [],
      });
      continue;
    }

    const entry = buildEntry(meta.name, meta.description ?? extractFirstProse(source), meta.status, parsed);

    // trigger_kind filter — narrow to entries with at least one trigger of the requested kind
    if (filter.trigger_kind !== undefined && !entry.triggers.some((t) => t.kind === filter.trigger_kind)) {
      continue;
    }

    entries.push(entry);
  }

  return groupByAudience(entries, audience);
}

/**
 * Per-skill entry construction. Public for embedders who want to render
 * a single entry without going through buildSkillCatalog (e.g., unit-test
 * fixtures).
 */
export function buildEntry(
  name: string,
  description: string,
  status: SkillEntry["status"],
  parsed: { outputs: OutputDecl[]; triggers: TriggerDecl[]; vars: Array<{ name: string; default?: string; required?: boolean }> },
): SkillEntry {
  return {
    name,
    category: deriveCategory(parsed.outputs, parsed.triggers),
    description,
    status,
    vars: renderVars(parsed.vars),
    output: renderOutputs(parsed.outputs),
    triggers: renderTriggers(parsed.triggers),
  };
}

/**
 * Multi-output category derivation rule (Perry's lock `011feaf0` + v0.9.8.1
 * inference-branch fix per `ec74e5fd`):
 *   ANY output[i].kind === "agent"        → "augmenting"
 *   else ANY output[i].kind === "template" → "template"
 *   else IF no autonomous triggers        → "template" (agent-invokable inference)
 *   else                                  → "headless"
 *
 * The inference branch: text/file/none output + NO autonomous triggers
 * implies "I expect to be invoked" (e.g., `cut-release-tag`, `hello`,
 * agent-callable analyzers). Without it, these skills land in `headless`
 * and disappear from default agent discovery. Trigger-presence
 * disambiguates: text/file/none output + autonomous triggers (cron/session/
 * event) means "I fire myself and write to a substrate" → headless.
 */
function deriveCategory(outputs: OutputDecl[], triggers: TriggerDecl[]): SkillEntry["category"] {
  if (outputs.some((o) => o.kind === "agent")) return "augmenting";
  if (outputs.some((o) => o.kind === "template")) return "template";
  // v0.9.8.1 — agent-invokable inference branch
  if (triggers.length === 0) return "template";
  return "headless";
}

/**
 * `# Vars:` frontmatter → SkillEntry.vars per addendum `73c79a28`:
 *   `NAME` (bare)         → { required: true,  default: null }
 *   `NAME=`               → { required: false, default: "" }
 *   `NAME=value`          → { required: false, default: "value" }
 *
 * Parser preserves the distinction at AST level — bare entries omit the
 * `default` field entirely; `NAME=` entries have `default: ""`. Discovery
 * layer maps `undefined` → `null` for the wire shape.
 */
function renderVars(parsedVars: Array<{ name: string; default?: string; required?: boolean }>): SkillEntry["vars"] {
  return parsedVars.map((v) => ({
    name: v.name,
    required: v.default === undefined,
    default: v.default === undefined ? null : v.default,
  }));
}

function renderOutputs(parsedOutputs: OutputDecl[]): SkillEntry["output"] {
  return parsedOutputs.map((o) => (o.target !== undefined ? { kind: o.kind, target: o.target } : { kind: o.kind }));
}

/**
 * Parser's `TriggerSource` → v0.9.8 discriminated union. Phase-2 stub kinds
 * (`agent-event`, `file-watch`, `sensor`) map to `{ kind: "event", event_type }`
 * as the closest current shape; when their firing paths land, the union grows
 * additively (non-breaking via TS discriminated union semantics).
 */
function renderTriggers(parsedTriggers: TriggerDecl[]): SkillEntry["triggers"] {
  return parsedTriggers.map((t): SkillEntry["triggers"][number] => {
    if (t.source === "cron") return { kind: "cron", expression: t.name };
    if (t.source === "session") {
      const phase: "start" | "end" = t.name === "end" ? "end" : "start";
      return { kind: "session", phase };
    }
    // event / agent-event / file-watch / sensor — all event-family; map to
    // { kind: "event", event_type: name } until Phase 2 lands per-kind shapes.
    return { kind: "event", event_type: t.name };
  });
}

function groupByAudience(entries: SkillEntry[], audience: SkillListFilter["audience"]): SkillCatalog {
  const catalog: SkillCatalog = {};
  const audienceMode = audience ?? DEFAULT_AUDIENCE;
  const includeAugmenting = audienceMode === "agent" || audienceMode === "all";
  const includeTemplate = audienceMode === "agent" || audienceMode === "all";
  const includeHeadless = audienceMode === "all" || audienceMode === "headless";

  if (includeAugmenting) catalog.receives = entries.filter((e) => e.category === "augmenting");
  if (includeTemplate) catalog.skills = entries.filter((e) => e.category === "template");
  if (includeHeadless) catalog.headless = entries.filter((e) => e.category === "headless");
  return catalog;
}

/**
 * Fallback when SkillMeta.description isn't populated — grab the first
 * non-header, non-blank line as a description. Heuristic; adopters with
 * proper description handling override at the SkillStore layer.
 */
function extractFirstProse(source: string): string {
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return "";
}
