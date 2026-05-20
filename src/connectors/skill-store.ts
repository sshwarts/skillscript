import { readFile, readdir, access, writeFile, mkdir, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { constants } from "node:fs";
import type {
  SkillStore,
  SkillRecord,
  SkillSummary,
  StaticCapabilities,
  ManifestInfo,
} from "./types.js";

const CONTRACT_VERSION = "1.0.0";

/**
 * Filesystem-backed SkillStore. Skills live as `*.skill` files under a
 * directory. The filename (sans extension) is the canonical skill name;
 * the body's `# Skill:` header is informational but the filename wins on
 * lookups. This makes "what skill exists at what name" obvious from `ls`.
 *
 * T1 baseline: load + exists + list. Status transitions / save semantics
 * land in T2 (the full SkillStore surface plus capabilities discovery).
 */
export class FilesystemSkillStore implements SkillStore {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "skill_store",
      implementation: "FilesystemSkillStore",
      contract_version: CONTRACT_VERSION,
      features: {
        supports_writes: true,
        supports_tag_filter: false,
        supports_versioning: false,
        supports_audit_trail: false,
        supports_atomic_status_transitions: false,
      },
    };
  }

  constructor(private readonly rootDir: string) {}

  async manifest(): Promise<ManifestInfo> {
    return {
      capabilities_version: "1",
      manifest: {
        kind: "filesystem",
        root_dir: this.rootDir,
      },
    };
  }

  async load(name: string): Promise<SkillRecord | null> {
    const path = this.pathFor(name);
    try {
      const body = await readFile(path, "utf8");
      const st = await stat(path);
      const description = this.extractHeader(body, "Description");
      const status = this.extractHeader(body, "Status");
      const record: SkillRecord = {
        name,
        body,
        createdAt: Math.floor(st.mtimeMs / 1000),
      };
      if (description !== null) record.description = description;
      if (status !== null) record.status = status;
      return record;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await access(this.pathFor(name), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async list(filter?: { status?: string }): Promise<SkillSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const summaries: SkillSummary[] = [];
    for (const entry of entries) {
      if (extname(entry) !== ".skill") continue;
      const name = basename(entry, ".skill");
      try {
        const body = await readFile(join(this.rootDir, entry), "utf8");
        const description = this.extractHeader(body, "Description");
        const status = this.extractHeader(body, "Status");
        if (filter?.status !== undefined && status !== filter.status) continue;
        const summary: SkillSummary = { name };
        if (description !== null) summary.description = description;
        if (status !== null) summary.status = status;
        summaries.push(summary);
      } catch {
        // Unreadable file — skip silently.
      }
    }
    summaries.sort((a, b) => a.name.localeCompare(b.name));
    return summaries;
  }

  /** Helper for authoring tools — writes a `.skill` file to the store. */
  async save(name: string, body: string): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.pathFor(name), body, "utf8");
  }

  private pathFor(name: string): string {
    return join(this.rootDir, `${name}.skill`);
  }

  private extractHeader(body: string, key: string): string | null {
    const re = new RegExp(`^#\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m");
    const m = re.exec(body);
    return m ? m[1]! : null;
  }
}
