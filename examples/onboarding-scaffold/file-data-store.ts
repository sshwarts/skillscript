// Onboarding scaffold: file-backed DataStore.
//
// JSON file as the substrate; simple JS substring + token match for "fts"
// queries; reranks by recency. Adopters copy this file and modify for
// their concrete substrate (e.g., swap the JSON file for a Postgres
// table, the substring match for actual full-text search, etc.).
//
// **Scope.** Implements `query()` + `write()` + `get()` per the DataStore contract.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  DataStore,
  DataWrite,
  DataWriteRecord,
  PortableData,
  QueryFilters,
  ManifestInfo,
  StaticCapabilities,
} from "skillscript-runtime/connectors";

export interface FileDataStoreConfig {
  /** Absolute path to the JSON file holding the data records. */
  filePath: string;
}

interface FileDataRecord extends PortableData {
  /** Optional substrate-specific fields go in `metadata`; everything top-level matches PortableData. */
}

export class FileDataStore implements DataStore {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "data_store",
      implementation: "FileDataStore",
      contract_version: "1.0.0",
      features: {
        // FTS is the baseline query mode — declared via `manifest().supported_modes`,
        // not a feature flag. Flags are the closed `DataStoreFeature` set.
        supports_writes: true,
        supports_semantic: false,
        supports_rerank: false,
      },
    };
  }

  constructor(private readonly config: FileDataStoreConfig) {}

  async query(filters: QueryFilters): Promise<PortableData[]> {
    const records = this.loadFile();
    const queryTerms = filters.query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);

    // Simple substring + token match: a record matches if any query term
    // appears in summary or detail. Adopters wire real FTS for production.
    const scored = records
      .map((r) => {
        const haystack = `${r.summary} ${r.detail ?? ""}`.toLowerCase();
        const hits = queryTerms.filter((t) => haystack.includes(t)).length;
        return { record: r, hits };
      })
      .filter((s) => s.hits > 0);

    // Tie-break by recency (created_at descending) so newer matches surface first.
    scored.sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      const aTime = a.record.created_at ?? 0;
      const bTime = b.record.created_at ?? 0;
      return bTime - aTime;
    });

    return scored.slice(0, filters.limit).map((s) => s.record);
  }

  async write(entry: DataWrite): Promise<DataWriteRecord> {
    const records = this.loadFile();
    const id = randomUUID();
    const created_at = Math.floor(Date.now() / 1000);
    const firstLine = entry.content.split("\n")[0] ?? entry.content;
    const summary = firstLine.length > 200 ? firstLine.slice(0, 197) + "..." : firstLine;
    const newRecord: FileDataRecord = {
      id,
      summary,
      detail: entry.content,
      created_at,
      ...(entry.tags !== undefined ? { domain_tags: entry.tags } : {}),
      ...(entry.recipients !== undefined || entry.expires_at !== undefined || entry.metadata !== undefined
        ? {
            metadata: {
              ...(entry.metadata ?? {}),
              ...(entry.recipients !== undefined ? { recipients: entry.recipients } : {}),
              ...(entry.expires_at !== undefined ? { expires_at: entry.expires_at } : {}),
            },
          }
        : {}),
    } as FileDataRecord;
    records.push(newRecord);
    writeFileSync(this.config.filePath, JSON.stringify(records, null, 2), "utf8");
    return { id, created_at };
  }

  /**
   * Direct lookup by id (v0.13.8 DataStore contract). Null-on-miss —
   * never throws for an unknown id.
   */
  async get(id: string): Promise<PortableData | null> {
    return this.loadFile().find((r) => r.id === id) ?? null;
  }

  async manifest(): Promise<ManifestInfo> {
    return {
      capabilities_version: "1",
      manifest: {
        kind: "file-data-store",
        supported_modes: ["fts"],
        file_path: this.config.filePath,
        record_count: this.loadFile().length,
        supports_write: true,
        // strict-filters: the bridge enforces every non-base filter
        // key in `query()` calls against this declared set, throwing
        // UnsupportedFilterError for unknowns. This reference impl's
        // substring scorer doesn't actually filter on any field (it
        // ignores everything beyond `query` + `limit`), so the honest
        // declaration is `[]`. Adopters who extend `query()` to honor
        // `domain_tags` / `payload_type` / etc. should add those names
        // here so the bridge stops rejecting them. Callers that need
        // to pass advisory filters this impl ignores can opt out per-
        // call via `permissive_filters: true`.
        supported_filters: [],
      },
    };
  }

  private loadFile(): FileDataRecord[] {
    if (!existsSync(this.config.filePath)) return [];
    try {
      const raw = readFileSync(this.config.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`FileDataStore: '${this.config.filePath}' top-level must be an array of data records.`);
      }
      return parsed as FileDataRecord[];
    } catch (err) {
      throw new Error(`FileDataStore: failed to read '${this.config.filePath}': ${(err as Error).message}`);
    }
  }
}
