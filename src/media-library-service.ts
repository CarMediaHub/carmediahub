import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret, keyedHash } from "./security.js";

const mediaTypes: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".mp3": "audio/mpeg", ".m4a": "audio/mp4" };
const now = () => new Date().toISOString();

export interface MediaRoot { id: string; name: string; createdAt: string; }
export interface MediaItem { id: string; title: string; contentType: string; size: number; updatedAt: string; }
export interface MediaRead { data: string; completed: boolean; }

/** Core-owned media root registry. Plugins receive no filesystem path or root handle. */
export class MediaLibraryService {
  constructor(private readonly db: DatabaseSync, private readonly key: Buffer) {}

  addRoot(organizationId: string, name: string, selectedPath: string): MediaRoot {
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(name.trim())) throw new Error("Media root name is invalid");
    const resolved = fs.realpathSync(selectedPath);
    if (!fs.statSync(resolved).isDirectory()) throw new Error("Selected media root is not a directory");
    const root = { id: `media_root_${crypto.randomUUID()}`, name: name.trim(), createdAt: now() };
    this.db.prepare("INSERT INTO media_roots (id, organization_id, name, protected_path, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(root.id, organizationId, root.name, encryptSecret(resolved, this.key), root.createdAt);
    return root;
  }

  roots(organizationId: string): MediaRoot[] {
    return (this.db.prepare("SELECT id, name, created_at FROM media_roots WHERE organization_id = ? AND revoked_at IS NULL ORDER BY created_at DESC").all(organizationId) as Array<Record<string, string>>)
      .map((row) => ({ id: row.id ?? "", name: row.name ?? "", createdAt: row.created_at ?? "" }));
  }

  list(organizationId: string, rootId: string, limit = 200): MediaItem[] {
    const root = this.rootPath(organizationId, rootId);
    const maximum = Math.min(Math.max(limit, 1), 1000);
    const items: MediaItem[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (items.length >= maximum || !entry.isFile() || entry.isSymbolicLink()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      const contentType = mediaTypes[extension];
      if (contentType === undefined) continue;
      const location = path.resolve(root, entry.name);
      if (!location.startsWith(root + path.sep)) continue;
      const stat = fs.statSync(location);
      const id = keyedHash(`${rootId}\0${entry.name}\0${stat.size}\0${stat.mtimeMs}`, this.key);
      items.push({ id, title: entry.name, contentType, size: stat.size, updatedAt: stat.mtime.toISOString() });
    }
    return items.sort((left, right) => left.title.localeCompare(right.title));
  }

  revoke(organizationId: string, rootId: string): boolean {
    const result = this.db.prepare("UPDATE media_roots SET revoked_at = ? WHERE id = ? AND organization_id = ? AND revoked_at IS NULL").run(now(), rootId, organizationId);
    return result.changes === 1;
  }

  read(organizationId: string, mediaId: string, start: number, end: number): MediaRead {
    if (!/^[A-Za-z0-9_-]{20,128}$/u.test(mediaId) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start >= 262_144) throw new Error("Media read request is invalid");
    for (const root of this.roots(organizationId)) {
      const item = this.list(organizationId, root.id, 1000).find((candidate) => candidate.id === mediaId);
      if (item === undefined) continue;
      if (start >= item.size) throw new Error("Media range is unavailable");
      const rootPath = this.rootPath(organizationId, root.id);
      const location = path.resolve(rootPath, item.title);
      if (!location.startsWith(rootPath + path.sep) || fs.lstatSync(location).isSymbolicLink()) throw new Error("Media range is unavailable");
      const count = Math.min(end, item.size - 1) - start + 1;
      const handle = fs.openSync(location, "r");
      try {
        const bytes = Buffer.allocUnsafe(count);
        fs.readSync(handle, bytes, 0, count, start);
        return { data: bytes.toString("base64"), completed: start + count >= item.size };
      } finally { fs.closeSync(handle); }
    }
    throw new Error("Media item is unavailable");
  }

  private rootPath(organizationId: string, rootId: string): string {
    const row = this.db.prepare("SELECT protected_path FROM media_roots WHERE id = ? AND organization_id = ? AND revoked_at IS NULL").get(rootId, organizationId) as { protected_path?: string } | undefined;
    if (row?.protected_path === undefined) throw new Error("Media root is unavailable");
    const root = decryptSecret(row.protected_path, this.key);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error("Media root is unavailable");
    return fs.realpathSync(root);
  }
}
