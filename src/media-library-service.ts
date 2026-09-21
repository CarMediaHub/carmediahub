import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret, keyedHash } from "./security.js";

const mediaTypes: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".mp3": "audio/mpeg", ".m4a": "audio/mp4" };
const now = () => new Date().toISOString();

export interface MediaRoot { id: string; name: string; createdAt: string; }
export interface MediaItem { id: string; title: string; contentType: string; size: number; updatedAt: string; }
export type MediaPlaybackMode = "direct-range" | "remux" | "transcode";
export interface MediaProbe { mediaId: string; contentType: string; size: number; updatedAt: string; container?: string; seekable: boolean; availableModes: readonly MediaPlaybackMode[]; recommendedMode: MediaPlaybackMode; }
export interface MediaRead { data: string; completed: boolean; }
export interface PlaybackScope { organizationId: string; userId: string; deviceId: string; installationId: string; }
export interface PlaybackSession { sessionId: string; mediaId: string; expiresAt: string; }

interface IndexedMediaItem extends MediaItem { relativePath: string; }

/** Core-owned media root registry. Plugins receive no filesystem path or root handle. */
export class MediaLibraryService {
  constructor(private readonly db: DatabaseSync, private readonly key: Buffer) {}

  addRoot(organizationId: string, installationId: string, name: string, selectedPath: string): MediaRoot {
    if (!/^[A-Za-z0-9_-]{3,128}$/u.test(installationId)) throw new Error("Media root installation is invalid");
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(name.trim())) throw new Error("Media root name is invalid");
    const resolved = fs.realpathSync(selectedPath);
    if (!fs.statSync(resolved).isDirectory()) throw new Error("Selected media root is not a directory");
    const root = { id: `media_root_${crypto.randomUUID()}`, name: name.trim(), createdAt: now() };
    this.db.prepare("INSERT INTO media_roots (id, organization_id, installation_id, name, protected_path, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(root.id, organizationId, installationId, root.name, encryptSecret(resolved, this.key), root.createdAt);
    return root;
  }

  roots(organizationId: string, installationId?: string): MediaRoot[] {
    const filter = installationId === undefined ? "" : " AND installation_id = ?";
    const values = installationId === undefined ? [organizationId] : [organizationId, installationId];
    return (this.db.prepare(`SELECT id, name, created_at FROM media_roots WHERE organization_id = ?${filter} AND revoked_at IS NULL ORDER BY created_at DESC`).all(...values) as Array<Record<string, string>>)
      .map((row) => ({ id: row.id ?? "", name: row.name ?? "", createdAt: row.created_at ?? "" }));
  }

  list(organizationId: string, installationId: string, rootId: string, limit = 200): MediaItem[] {
    const root = this.rootPath(organizationId, installationId, rootId);
    return this.index(root, rootId, limit).map(({ relativePath: _relativePath, ...item }) => item);
  }

  revoke(organizationId: string, rootId: string): boolean {
    const result = this.db.prepare("UPDATE media_roots SET revoked_at = ? WHERE id = ? AND organization_id = ? AND revoked_at IS NULL").run(now(), rootId, organizationId);
    return result.changes === 1;
  }

  createPlayback(scope: PlaybackScope, mediaId: string): PlaybackSession {
    if (!/^[A-Za-z0-9_-]{20,128}$/u.test(mediaId)) throw new Error("Media item is unavailable");
    const exists = this.findItem(scope.organizationId, scope.installationId, mediaId);
    if (exists === undefined) throw new Error("Media item is unavailable");
    const sessionId = `playback_${crypto.randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    this.db.prepare("INSERT INTO playback_sessions (token_hash, organization_id, user_id, device_id, installation_id, media_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(keyedHash(sessionId, this.key), scope.organizationId, scope.userId, scope.deviceId, scope.installationId, mediaId, expiresAt, now());
    return { sessionId, mediaId, expiresAt };
  }

  probe(scope: PlaybackScope, mediaId: string): MediaProbe {
    const item = this.findItem(scope.organizationId, scope.installationId, mediaId);
    if (item === undefined) throw new Error("Media item is unavailable");
    const extension = path.extname(item.title).toLowerCase().replace(/^\./u, "");
    return {
      mediaId: item.id,
      contentType: item.contentType,
      size: item.size,
      updatedAt: item.updatedAt,
      ...(extension.length === 0 ? {} : { container: extension }),
      seekable: item.contentType.startsWith("video/") || item.contentType.startsWith("audio/"),
      availableModes: ["direct-range"],
      recommendedMode: "direct-range"
    };
  }

  revokePlaybackForUser(userId: string): void { this.db.prepare("UPDATE playback_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now(), userId); }
  revokePlaybackForInstallation(installationId: string): void { this.db.prepare("UPDATE playback_sessions SET revoked_at = ? WHERE installation_id = ? AND revoked_at IS NULL").run(now(), installationId); }

  read(organizationId: string, installationId: string, mediaId: string, start: number, end: number): MediaRead {
    if (!/^[A-Za-z0-9_-]{20,128}$/u.test(mediaId) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start >= 262_144) throw new Error("Media read request is invalid");
    for (const root of this.roots(organizationId, installationId)) {
      const rootPath = this.rootPath(organizationId, installationId, root.id);
      const item = this.index(rootPath, root.id, 1000).find((candidate) => candidate.id === mediaId);
      if (item === undefined) continue;
      if (start >= item.size) throw new Error("Media range is unavailable");
      const location = path.resolve(rootPath, item.relativePath);
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

  readWithPlayback(scope: PlaybackScope, sessionId: string, mediaId: string, start: number, end: number): MediaRead {
    const row = this.db.prepare("SELECT media_id FROM playback_sessions WHERE token_hash = ? AND organization_id = ? AND user_id = ? AND device_id = ? AND installation_id = ? AND expires_at > ? AND revoked_at IS NULL").get(keyedHash(sessionId, this.key), scope.organizationId, scope.userId, scope.deviceId, scope.installationId, now()) as { media_id?: string } | undefined;
    if (row?.media_id !== mediaId) throw new Error("Playback session is unavailable");
    return this.read(scope.organizationId, scope.installationId, mediaId, start, end);
  }

  private index(root: string, rootId: string, limit: number): IndexedMediaItem[] {
    const maximum = Math.min(Math.max(limit, 1), 1000);
    const items: IndexedMediaItem[] = [];
    const visit = (directory: string, relativeDirectory: string, depth: number): void => {
      if (items.length >= maximum || depth > 32) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (items.length >= maximum || entry.isSymbolicLink()) continue;
        const relativePath = relativeDirectory === "" ? entry.name : path.posix.join(relativeDirectory, entry.name);
        const location = path.resolve(root, ...relativePath.split("/"));
        if (!location.startsWith(root + path.sep)) continue;
        if (entry.isDirectory()) {
          visit(location, relativePath, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        const contentType = mediaTypes[extension];
        if (contentType === undefined) continue;
        const stat = fs.statSync(location);
        const id = keyedHash(`${rootId}\0${relativePath}\0${stat.size}\0${stat.mtimeMs}`, this.key);
        items.push({ id, title: entry.name, contentType, size: stat.size, updatedAt: stat.mtime.toISOString(), relativePath });
      }
    };
    visit(root, "", 0);
    return items;
  }

  private findItem(organizationId: string, installationId: string, mediaId: string): MediaItem | undefined {
    for (const root of this.roots(organizationId, installationId)) {
      const item = this.index(this.rootPath(organizationId, installationId, root.id), root.id, 1000).find((candidate) => candidate.id === mediaId);
      if (item !== undefined) return item;
    }
    return undefined;
  }

  private rootPath(organizationId: string, installationId: string, rootId: string): string {
    const row = this.db.prepare("SELECT protected_path FROM media_roots WHERE id = ? AND organization_id = ? AND installation_id = ? AND revoked_at IS NULL").get(rootId, organizationId, installationId) as { protected_path?: string } | undefined;
    if (row?.protected_path === undefined) throw new Error("Media root is unavailable");
    const root = decryptSecret(row.protected_path, this.key);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error("Media root is unavailable");
    return fs.realpathSync(root);
  }
}
