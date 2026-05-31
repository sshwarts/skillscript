// v0.14.1 — Substrate-side strict-filters enforcement for `$ data_read`
// query dispatch. Closes the silent-scope-leak class surfaced by the
// Phase 1 v4 cold-adopter dogfood: pre-v0.14.1, substrates silently
// dropped filter keys outside their declared `supported_filters` manifest,
// so authors who wrote `query=... vault=...` against a substrate that
// didn't honor `vault` got back unscoped results. Now: strict default at
// the bridge boundary throws `UnsupportedFilterError`; adopters opt out
// per-call with `permissive_filters: true`.
//
// Pattern: defaults-over-knobs for security-relevant surfaces (sibling to
// the F1 mutation-gate runtime enforcement). Aware adopters opt out;
// naive adopters get protection.

import { UnsupportedFilterError } from "../errors.js";
import type { QueryFilters } from "./types.js";

/**
 * Base shape keys defined on the `QueryFilters` contract surface. The
 * enforcer ignores these — they're the canonical query shape, not
 * substrate-specific extensions. Adopter filters outside this set are
 * checked against the substrate's `supported_filters` manifest.
 */
const BASE_QUERY_FILTER_KEYS: ReadonlySet<string> = new Set([
  "query",
  "limit",
  "mode",
  "permissive_filters",
]);

/**
 * Validate a `QueryFilters` object against the substrate's declared
 * `supported_filters` set. Throws `UnsupportedFilterError` when any
 * non-base-shape key is absent from `supportedKeys`, unless the caller
 * passed `permissive_filters: true` on the query.
 *
 * Empty / undefined `supportedKeys` means the substrate hasn't declared
 * any extension filters — under strict default, every non-base key
 * throws. Adopters who don't know what their substrate supports should
 * either query the manifest or pass `permissive_filters: true`.
 *
 * Bundle-side: called by `DataStoreMcpConnector.dispatchQuery` before
 * forwarding to `dataStore.query()`. Custom McpConnector forks that
 * expose retrieval surfaces should call the same helper.
 */
export function enforceSupportedFilters(
  filters: QueryFilters,
  supportedKeys: readonly string[] | undefined,
  substrateName: string,
  target?: string,
): void {
  if (filters.permissive_filters === true) return;
  const supported = new Set(supportedKeys ?? []);
  const unsupported: string[] = [];
  for (const key of Object.keys(filters)) {
    if (BASE_QUERY_FILTER_KEYS.has(key)) continue;
    if (supported.has(key)) continue;
    unsupported.push(key);
  }
  if (unsupported.length === 0) return;
  throw new UnsupportedFilterError(unsupported, [...supported], substrateName, target);
}
