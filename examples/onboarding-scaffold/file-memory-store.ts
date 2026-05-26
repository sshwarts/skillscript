// Onboarding scaffold: file-backed MemoryStore. v0.7.3.
//
// JSON file as the substrate; simple JS substring + token match for "fts"
// queries; reranks by recency. Adopters copy this file and modify for
// their concrete substrate (e.g., swap the JSON file for a Postgres
// table, the substring match for actual full-text search, etc.).
//
// **Scope.** Read-only `query()` per the v0.7.2 MemoryStore contract.
// `write()` is deferred to v0.8.x bundled with the auth model — when
// that lands, extend this file with the matching `write()` method.

import { readFileSync, existsSync } from "node:fs";
import type {
  MemoryStore,
  PortableMemory,
  QueryFilters,
  ManifestInfo,
  StaticCapabilities,
} from "skillscript-runtime/connectors";

export interface FileMemoryStoreConfig {
  /** Absolute path to the JSON file holding the memory array. */
  filePath: string;
}

interface FileMemoryRecord extends PortableMemory {
  /** Optional substrate-specific fields go in `metadata`; everything top-level matches PortableMemory. */
}

export class FileMemoryStore implements MemoryStore {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "memory_store",
      implementation: "FileMemoryStore",
      contract_version: "1.0.0",
      features: {
        supports_fts: true,
        supports_semantic: false,
        supports_rerank: false,
      },
    };
  }

  constructor(private readonly config: FileMemoryStoreConfig) {}

  async query(filters: QueryFilters): Promise<PortableMemory[]> {
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

  async manifest(): Promise<ManifestInfo> {
    return {
      capabilities_version: "1",
      manifest: {
        kind: "file-memory-store",
        file_path: this.config.filePath,
        record_count: this.loadFile().length,
      },
    };
  }

  private loadFile(): FileMemoryRecord[] {
    if (!existsSync(this.config.filePath)) return [];
    try {
      const raw = readFileSync(this.config.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`FileMemoryStore: '${this.config.filePath}' top-level must be an array of memory records.`);
      }
      return parsed as FileMemoryRecord[];
    } catch (err) {
      throw new Error(`FileMemoryStore: failed to read '${this.config.filePath}': ${(err as Error).message}`);
    }
  }
}
