import { readFile, readdir, writeFile, mkdir, stat, unlink, appendFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { createHash } from "node:crypto";
import type {
  SkillStore,
  SkillSource,
  SkillMeta,
  SkillStatus,
  SkillFilter,
  VersionInfo,
  StaticCapabilities,
  ManifestInfo,
} from "./types.js";
import { SkillNotFoundError, VersionNotFoundError, StorageConflictError } from "../errors.js";
import { stampApprovalToken } from "../approval.js";

const CONTRACT_VERSION = "1.0.0";

/**
 * Filesystem-backed SkillStore. Skills live as `*.skill.md` files under a
 * directory. Per-skill version history lives in a sidecar `*.versions.jsonl`
 * (append-only, one JSON object per line).
 *
 * Limitations of the filesystem substrate (acknowledged):
 *   - `load(name, version)` cannot return historical bytes — only the current
 *     file content is on disk. If `version` is supplied and doesn't match
 *     the current file's hash, throws `VersionNotFoundError`. A
 *     content-addressed substrate (git-backed, S3, etc.) would preserve
 *     bytes per version.
 *   - `versions()` reads the `.jsonl` sidecar if present, else synthesizes
 *     one entry from the file's mtime (for legacy files written before
 *     T2's versioning landed).
 *   - `query()` reads every file's headers on each call. Fine for small
 *     stores; a larger substrate caches metadata.
 *
 * `version` string format: first 12 chars of `content_hash` — short, stable,
 * shareable. Consumers MUST treat `version` as opaque (equality only).
 */
export class FilesystemSkillStore implements SkillStore {
  static staticCapabilities(): StaticCapabilities {
    return {
      connector_type: "skill_store",
      implementation: "FilesystemSkillStore",
      contract_version: CONTRACT_VERSION,
      features: {
        supports_writes: true,
        supports_versioning: true,
        supports_tag_filter: false,
        supports_audit_trail: true,
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

  async load(name: string, version?: string): Promise<SkillSource> {
    const path = this.pathFor(name);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillNotFoundError(name, "FilesystemSkillStore");
      }
      throw err;
    }
    const content_hash = hashSource(source);
    const versionLabel = shortHash(content_hash);
    if (version !== undefined && version !== versionLabel) {
      throw new VersionNotFoundError(name, version, "FilesystemSkillStore");
    }
    const meta = await this.buildMeta(name, source);
    return {
      name,
      version: versionLabel,
      content_hash,
      source,
      metadata: meta,
    };
  }

  async query(filter?: SkillFilter): Promise<SkillMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const metas: SkillMeta[] = [];
    for (const entry of entries) {
      // `.skill.md` is the source convention (committed, authored). The
      // bare `.skill` extension is reserved for compiled artifacts emitted
      // alongside `.skill.provenance.json` sidecars — derived, gitignored.
      if (!entry.endsWith(".skill.md")) continue;
      const name = entry.slice(0, -".skill.md".length);
      try {
        const source = await readFile(join(this.rootDir, entry), "utf8");
        metas.push(await this.buildMeta(name, source));
      } catch {
        // Unreadable file — skip.
      }
    }
    metas.sort((a, b) => a.name.localeCompare(b.name));
    return applyFilter(metas, filter);
  }

  async metadata(name: string): Promise<SkillMeta> {
    let source: string;
    try {
      source = await readFile(this.pathFor(name), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillNotFoundError(name, "FilesystemSkillStore");
      }
      throw err;
    }
    return this.buildMeta(name, source);
  }

  async versions(name: string): Promise<VersionInfo[]> {
    const sidecar = this.versionsPathFor(name);
    let lines: string[];
    try {
      const body = await readFile(sidecar, "utf8");
      lines = body.split("\n").filter((l) => l.trim() !== "");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // No sidecar — verify the skill file itself exists. If neither
      // exists, it's a not-found. If the file exists but no sidecar,
      // synthesize a single legacy entry from current state.
      const meta = await this.metadata(name).catch((e) => {
        if (e instanceof SkillNotFoundError) throw e;
        throw e;
      });
      const fileStat = await stat(this.pathFor(name));
      return [{
        name,
        version: meta.version,
        content_hash: meta.content_hash,
        status: meta.status,
        changed_at: Math.floor(fileStat.mtimeMs / 1000),
      }];
    }
    const out: VersionInfo[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as VersionInfo);
      } catch {
        // Skip malformed; resilient to partial-write tear at append time.
      }
    }
    return out;
  }

  async store(name: string, source: string, metadata?: Partial<SkillMeta>): Promise<VersionInfo> {
    if (!/^[A-Za-z0-9][\w\-.]*$/.test(name)) {
      throw new StorageConflictError(name, "name contains characters unsafe for filesystem path", "FilesystemSkillStore");
    }
    await mkdir(this.rootDir, { recursive: true });
    const content_hash = hashSource(source);
    const version = shortHash(content_hash);
    const status = metadata?.status ?? extractStatus(source) ?? "Draft";
    const nowSec = Math.floor(Date.now() / 1000);

    await writeFile(this.pathFor(name), source, "utf8");
    const info: VersionInfo = {
      name,
      version,
      content_hash,
      status,
      changed_at: nowSec,
      ...(metadata?.author !== undefined ? { changed_by: metadata.author } : {}),
    };
    await appendFile(this.versionsPathFor(name), JSON.stringify(info) + "\n", "utf8");
    return info;
  }

  async delete(name: string): Promise<void> {
    let removed = false;
    for (const p of [this.pathFor(name), this.versionsPathFor(name)]) {
      try {
        await unlink(p);
        removed = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    if (!removed) {
      throw new SkillNotFoundError(name, "FilesystemSkillStore");
    }
  }

  async update_status(name: string, status: SkillStatus): Promise<VersionInfo> {
    const path = this.pathFor(name);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillNotFoundError(name, "FilesystemSkillStore");
      }
      throw err;
    }
    const previous_status = extractStatus(source) ?? "Draft";
    // v0.9.0 — transitions to Approved stamp `# Status: Approved vN:<token>`
    // automatically; transitions to Draft/Disabled strip any prior token.
    // Adopter dashboards can supplant this with a stronger `f()` by calling
    // `registerApprovalFn("v2", hmacSha256Fn)` etc. before update_status.
    let updated: string;
    if (status === "Approved") {
      const stamped = stampApprovalToken(rewriteStatusHeader(source, "Approved"));
      updated = stamped;
    } else {
      updated = rewriteStatusHeader(source, status);
    }
    await writeFile(path, updated, "utf8");
    const content_hash = hashSource(updated);
    const version = shortHash(content_hash);
    const info: VersionInfo = {
      name,
      version,
      content_hash,
      status,
      previous_status,
      changed_at: Math.floor(Date.now() / 1000),
    };
    await appendFile(this.versionsPathFor(name), JSON.stringify(info) + "\n", "utf8");
    return info;
  }

  private pathFor(name: string): string {
    return join(this.rootDir, `${name}.skill.md`);
  }

  private versionsPathFor(name: string): string {
    return join(this.rootDir, `${name}.versions.jsonl`);
  }

  private async buildMeta(name: string, source: string): Promise<SkillMeta> {
    const content_hash = hashSource(source);
    const version = shortHash(content_hash);
    const status = extractStatus(source) ?? "Draft";
    const description = extractHeader(source, "Description");
    const fileStat = await stat(this.pathFor(name)).catch(() => null);
    const updated_at = fileStat ? Math.floor(fileStat.mtimeMs / 1000) : 0;
    const meta: SkillMeta = {
      name,
      version,
      content_hash,
      status,
      created_at: updated_at,
      updated_at,
    };
    if (description !== null) meta.description = description;
    return meta;
  }
}

function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function shortHash(content_hash: string): string {
  return content_hash.slice(0, 12);
}

function extractHeader(body: string, key: string): string | null {
  const re = new RegExp(`^#\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m");
  const m = re.exec(body);
  return m ? m[1]! : null;
}

function extractStatus(source: string): SkillStatus | null {
  // v0.9.0 — split on whitespace; first token is the enum, remainder may
  // be an approval token (`vN:<token>`). Substrate doesn't need to verify
  // the token here — that's the runtime's job at dispatch time.
  const raw = extractHeader(source, "Status");
  if (raw === null) return null;
  const first = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first === "draft") return "Draft";
  if (first === "approved") return "Approved";
  if (first === "disabled") return "Disabled";
  return null;
}

/**
 * Rewrite or insert the `# Status:` header. If absent, inserts after the
 * `# Skill:` line (or at the top of the file as a fallback). Optional
 * trailing token (v0.9.0) lets the dashboard's approval path stamp
 * `# Status: Approved v1:<token>` in one call.
 */
function rewriteStatusHeader(source: string, status: SkillStatus, token?: string): string {
  const line = token !== undefined && token.length > 0 ? `# Status: ${status} ${token}` : `# Status: ${status}`;
  const re = /^#\s*Status\s*:\s*.+?\s*$/m;
  if (re.test(source)) {
    return source.replace(re, line);
  }
  const skillLineRe = /^(#\s*Skill\s*:\s*.+?)\s*$/m;
  if (skillLineRe.test(source)) {
    return source.replace(skillLineRe, `$1\n${line}`);
  }
  return `${line}\n${source}`;
}

function applyFilter(metas: SkillMeta[], filter?: SkillFilter): SkillMeta[] {
  if (filter === undefined) return metas;
  let out = metas;
  if (filter.status !== undefined) {
    const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
    out = out.filter((m) => wanted.includes(m.status));
  }
  if (filter.name_pattern !== undefined) {
    const pat = new RegExp(filter.name_pattern);
    out = out.filter((m) => pat.test(m.name));
  }
  if (filter.since !== undefined) {
    const since = filter.since;
    out = out.filter((m) => m.updated_at >= since);
  }
  if (filter.offset !== undefined) {
    out = out.slice(filter.offset);
  }
  if (filter.limit !== undefined) {
    out = out.slice(0, filter.limit);
  }
  return out;
}
