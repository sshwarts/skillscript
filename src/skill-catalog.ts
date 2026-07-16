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
import type { ParsedSkill, TriggerDecl, OutputDecl } from "./parser.js";
import { evaluateApprovalGate } from "./approval.js";
import { extractEffectfulFootprint } from "./skill-surface.js";

/** Empty effectful footprint — the parse-fail fallback (no AST to walk). */
const EMPTY_FOOTPRINT: SkillEntry["effectful_footprint"] = {
  connectors: [], builtins: [], shell_binaries: [],
  unsafe_shell: 0, file_writes: 0, file_reads: 0, notifies: 0,
};

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
  // v0.18.6 — author filter threaded through to SkillStore.query so
  // substrates that natively track authorship can filter at the
  // substrate layer; bundled stores ignore unknown filter keys and the
  // catalog layer re-filters in-memory below (graceful degradation per
  // Perry's spec, thread 1f278e5e).
  const storeFilter: { status: typeof status; author?: string } = { status };
  if (filter.author !== undefined) storeFilter.author = filter.author;
  const metas = await skillStore.query(storeFilter);

  const entries: SkillEntry[] = [];
  for (const meta of metas) {
    if (filter.name_prefix !== undefined && !meta.name.startsWith(filter.name_prefix)) {
      continue;
    }
    if (filter.domain_tags !== undefined && filter.domain_tags.length > 0) {
      const skillTags = (meta.metadata_bag?.["domain_tags"] as string[] | undefined) ?? meta.metadata_bag?.["tags"] as string[] | undefined ?? [];
      if (!filter.domain_tags.every((t) => skillTags.includes(t))) continue;
    }
    // v0.18.6 — in-memory author filter for substrates that returned
    // unfiltered metas. AND-composes with the substrate-level filter
    // above: substrates that honored it already filtered, so this is a
    // no-op for them; substrates that didn't get the filter applied
    // here. Either way the user sees only matching authors.
    if (filter.author !== undefined && meta.author !== filter.author) {
      continue;
    }

    let parsed;
    let source = "";
    try {
      const loaded = await skillStore.load(meta.name);
      source = loaded.source;
      parsed = parse(source);
    } catch {
      // Skill loaded but parse failed — surface a minimal entry so
      // adopter dashboards can still see the skill exists. gate_ok reflects the
      // already-loaded source (empty when load itself failed → false).
      entries.push({
        name: meta.name,
        category: "headless",
        description: meta.description ?? "",
        tags: meta.tags ?? [],
        status: meta.status,
        gate_ok: evaluateApprovalGate(source).ok,
        vars: [],
        output: [],
        triggers: [],
        returns: [],
        requires: [],
        secret_requires: [],
        effectful_footprint: EMPTY_FOOTPRINT,
        ...(meta.author !== undefined ? { author: meta.author } : { author: null }),
      });
      continue;
    }

    // Description precedence: what the store populated → the parsed `# Description:`
    // frontmatter (the runtime already has it, so any SkillStore that doesn't
    // surface description — e.g. a custom AMP-backed store — still shows the real
    // one) → the first-prose heuristic as a last resort.
    const entry = buildEntry(meta.name, meta.description ?? parsed.description ?? extractFirstProse(source), meta.status, parsed, meta.author);
    // v0.20.1 — approval-gate result (source already in hand, so this is free).
    entry.gate_ok = evaluateApprovalGate(source).ok;

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
  parsed: ParsedSkill,
  author?: string,
): SkillEntry {
  return {
    name,
    category: deriveCategory(parsed.outputs, parsed.triggers),
    description,
    // `# Tags:` straight off the frontmatter (parsed.tags is [] when untagged).
    // Body-projection, so this is authoritative regardless of what the store
    // tracks — same reasoning as vars/returns above.
    tags: parsed.tags,
    status,
    // Status-based default; buildSkillCatalog overrides with the real
    // evaluateApprovalGate(source) result (it has the source in hand).
    gate_ok: status === "Approved",
    vars: renderVars(parsed.vars),
    output: renderOutputs(parsed.outputs),
    triggers: renderTriggers(parsed.triggers),
    // v0.21.0 — preflight contract mirror. returns/requires straight off the
    // frontmatter; effectful_footprint walks the AST (same op enumeration the
    // capability gate uses). All free — the source is already parsed.
    returns: parsed.returns,
    requires: parsed.requires,
    secret_requires: parsed.secretRequires,
    effectful_footprint: extractEffectfulFootprint(parsed),
    // v0.18.6 — surface author when the substrate populated it; null
    // when not (substrate-neutral graceful degradation).
    author: author ?? null,
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
 * Parser's `TriggerSource` → v0.9.8 discriminated union.
 *
 * v0.19.0 — collapsed to cron + event per memory `ceaf4579`. Pre-v0.19.0
 * the parser accepted session/agent-event/file-watch/sensor as stubs; all
 * gone. Each remaining source maps 1:1 to a discriminated-union arm.
 */
function renderTriggers(parsedTriggers: TriggerDecl[]): SkillEntry["triggers"] {
  return parsedTriggers.map((t): SkillEntry["triggers"][number] => {
    if (t.source === "cron") return { kind: "cron", expression: t.name };
    // t.source === "event" — the only other case post-v0.19.0
    return { kind: "event", event_name: t.name };
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
