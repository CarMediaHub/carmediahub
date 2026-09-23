import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PlaybackScope, MediaSourceItem, MediaSourceListResult, MediaSourceProbe, MediaSourceStat, MediaSourcePlaybackSession, MediaRead } from "./media-library-service.js";

export interface RemoteWebDavBinding { endpoint: string; }
export interface RemoteWebDavCredential { name: "cookie" | "authorization"; value: string; }
export interface RemoteWebDavSource { sourceHandle: string; binding: string; rootPath: string; credentialRef?: string; }
export interface RemoteWebDavHealth { healthy: boolean; status: "ok" | "unavailable"; diagnostic: "none" | "binding" | "credential" | "upstream"; }
interface RemoteItem { itemHandle: string; name: string; kind: "directory" | "file"; size?: number; contentType?: string; updatedAt?: string; href: string; }

const maxRange = 262_144;
const sourceHandlePattern = /^remote_source_[A-Za-z0-9_-]{32,96}$/u;
const itemHandlePattern = /^remote_item_[A-Za-z0-9_-]{32,96}$/u;
const sessionPattern = /^remote_playback_[A-Za-z0-9_-]{32,96}$/u;

function xmlDecode(value: string): string { return value.replace(/&(?:amp|lt|gt|quot|apos);/gu, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" }[entity] ?? entity)); }
function tag(block: string, name: string): string | undefined { const match = block.match(new RegExp(`<[^>]*${name}[^>]*>([\\s\\S]*?)</[^>]*${name}>`, "iu")); return match?.[1] === undefined ? undefined : xmlDecode(match[1].replace(/<[^>]+>/gu, "").trim()); }
function safeLimit(value: number | undefined): number { return Math.min(Math.max(value ?? 200, 1), 500); }

/** Core-only, read-only WebDAV adapter. It never returns endpoint, href or credentials. */
export class RemoteWebDavProvider {
  private readonly sources = new Map<string, { scope: PlaybackScope; source: RemoteWebDavSource }>();
  private readonly items = new Map<string, { scope: PlaybackScope; sourceHandle: string; item: RemoteItem }>();
  private readonly sessions = new Map<string, { scope: PlaybackScope; sourceHandle: string; itemHandle: string; expiresAt: number }>();

  constructor(private readonly resolveBinding: (name: string, installationId: string) => RemoteWebDavBinding | undefined, private readonly resolveCredential: (scope: PlaybackScope, ref: string) => RemoteWebDavCredential | undefined, private readonly db?: DatabaseSync) {}

  register(scope: PlaybackScope, input: { binding: string; rootPath: string; credentialRef?: string; sourceHandle?: string; name?: string }): RemoteWebDavSource {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(input.binding) || !input.rootPath.startsWith("/") || input.rootPath.includes("\\") || input.rootPath.split("/").includes("..")) throw new Error("Invalid WebDAV source");
    const source: RemoteWebDavSource = { sourceHandle: input.sourceHandle ?? `remote_source_${crypto.randomBytes(32).toString("base64url")}`, binding: input.binding, rootPath: this.normalizePath(input.rootPath), ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }) };
    if (!sourceHandlePattern.test(source.sourceHandle)) throw new Error("Invalid WebDAV source handle");
    this.sources.set(this.scopeKey(scope, source.sourceHandle), { scope, source });
    if (this.db !== undefined) this.db.prepare("INSERT INTO remote_media_sources (id, organization_id, user_id, installation_id, name, binding, root_path, source_handle, credential_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(`remote_source_${crypto.randomUUID()}`, scope.organizationId, scope.userId, scope.installationId, input.name?.trim() || "Remote media", source.binding, source.rootPath, source.sourceHandle, input.credentialRef ?? null, new Date().toISOString());
    return source;
  }

  restore(): void {
    if (this.db === undefined) return;
    const rows = this.db.prepare("SELECT organization_id, user_id, installation_id, binding, root_path, source_handle, credential_ref FROM remote_media_sources WHERE revoked_at IS NULL").all() as Array<Record<string, string | null>>;
    for (const row of rows) {
      if (typeof row.organization_id !== "string" || typeof row.user_id !== "string" || typeof row.installation_id !== "string" || typeof row.binding !== "string" || typeof row.root_path !== "string" || typeof row.source_handle !== "string") continue;
      const scope: PlaybackScope = { organizationId: row.organization_id, userId: row.user_id, deviceId: "restored", installationId: row.installation_id };
      const source: RemoteWebDavSource = { sourceHandle: row.source_handle, binding: row.binding, rootPath: row.root_path, ...(row.credential_ref === null ? {} : { credentialRef: row.credential_ref }) };
      this.sources.set(this.scopeKey(scope, source.sourceHandle), { scope, source });
    }
  }

  revoke(scope: PlaybackScope, sourceHandle: string): boolean {
    this.source(scope, sourceHandle);
    this.sources.delete(this.scopeKey(scope, sourceHandle));
    if (this.db === undefined) return true;
    return this.db.prepare("UPDATE remote_media_sources SET revoked_at = ? WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND source_handle = ? AND revoked_at IS NULL").run(new Date().toISOString(), scope.organizationId, scope.userId, scope.installationId, sourceHandle).changes === 1;
  }

  listRegistered(scope: PlaybackScope): Array<{ sourceHandle: string; name: string; binding: string; createdAt: string }> {
    if (this.db === undefined) return [];
    return (this.db.prepare("SELECT source_handle, name, binding, created_at FROM remote_media_sources WHERE organization_id = ? AND user_id = ? AND installation_id = ? AND revoked_at IS NULL ORDER BY created_at DESC").all(scope.organizationId, scope.userId, scope.installationId) as Array<Record<string, string>>).map((row) => ({ sourceHandle: row.source_handle ?? "", name: row.name ?? "", binding: row.binding ?? "", createdAt: row.created_at ?? "" }));
  }

  async list(scope: PlaybackScope, sourceHandle: string, limit?: number): Promise<MediaSourceListResult> {
    const source = this.source(scope, sourceHandle);
    const response = await this.request(scope, source, "PROPFIND", source.rootPath, { Depth: "1" });
    if (response.status !== 207) throw new Error("WebDAV directory request failed");
    const parsed = this.parseMultiStatus(await response.text(), source.rootPath);
    const items = parsed.slice(0, safeLimit(limit)).map((item) => this.exposeItem(scope, sourceHandle, item));
    return { items };
  }

  async health(scope: PlaybackScope, sourceHandle: string): Promise<RemoteWebDavHealth> {
    try {
      const source = this.source(scope, sourceHandle);
      const response = await this.request(scope, source, "PROPFIND", source.rootPath, { Depth: "0" });
      return response.status === 207 ? { healthy: true, status: "ok", diagnostic: "none" } : { healthy: false, status: "unavailable", diagnostic: "upstream" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const diagnostic = message.includes("binding") ? "binding" : message.includes("credential") ? "credential" : "upstream";
      return { healthy: false, status: "unavailable", diagnostic };
    }
  }

  async stat(scope: PlaybackScope, sourceHandle: string, itemHandle: string): Promise<MediaSourceStat> {
    const item = this.item(scope, sourceHandle, itemHandle);
    return { sourceHandle, itemHandle, item: this.publicItem(item) };
  }

  async probe(scope: PlaybackScope, sourceHandle: string, itemHandle: string): Promise<MediaSourceProbe> {
    const item = this.item(scope, sourceHandle, itemHandle);
    const response = await this.request(scope, this.source(scope, sourceHandle), "HEAD", item.href);
    if (response.status < 200 || response.status >= 300) throw new Error("WebDAV media probe failed");
    const size = Number(response.headers.get("content-length") ?? item.size ?? 0);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0] ?? item.contentType ?? "application/octet-stream";
    return { sourceHandle, itemHandle, contentType, size: Number.isSafeInteger(size) && size >= 0 ? size : 0, seekable: true, availableModes: ["direct-range"], recommendedMode: "direct-range" };
  }

  async createPlayback(scope: PlaybackScope, sourceHandle: string, itemHandle: string): Promise<MediaSourcePlaybackSession> {
    this.item(scope, sourceHandle, itemHandle);
    const sessionId = `remote_playback_${crypto.randomBytes(32).toString("base64url")}`;
    const expiresAt = Date.now() + 600_000;
    this.sessions.set(this.scopeKey(scope, sessionId), { scope, sourceHandle, itemHandle, expiresAt });
    return { sessionId, sourceHandle, itemHandle, expiresAt: new Date(expiresAt).toISOString() };
  }

  async read(scope: PlaybackScope, sessionId: string, start: number, end: number): Promise<MediaRead> {
    if (!sessionPattern.test(sessionId) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start >= maxRange) throw new Error("WebDAV media range is invalid");
    const session = this.sessions.get(this.scopeKey(scope, sessionId));
    if (session === undefined || session.expiresAt <= Date.now()) throw new Error("WebDAV playback session is unavailable");
    const source = this.source(scope, session.sourceHandle);
    const item = this.item(scope, session.sourceHandle, session.itemHandle);
    const response = await this.request(scope, source, "GET", item.href, { Range: `bytes=${start}-${end}` });
    if (response.status !== 206) throw new Error("WebDAV media range was not honored");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxRange) throw new Error("WebDAV media response is too large");
    const total = Number(response.headers.get("content-range")?.match(/\/([0-9]+)$/u)?.[1] ?? item.size ?? (start + bytes.length));
    return { data: bytes.toString("base64"), completed: start + bytes.length >= total };
  }

  private async request(scope: PlaybackScope, source: RemoteWebDavSource, method: string, relativePath: string, extra: Record<string, string> = {}): Promise<Response> {
    const binding = this.resolveBinding(source.binding, scope.installationId);
    if (binding === undefined) throw new Error("WebDAV source binding is unavailable");
    const base = new URL(binding.endpoint);
    const target = new URL(relativePath, base);
    if (target.origin !== base.origin || target.username !== "" || target.password !== "" || target.hash !== "") throw new Error("WebDAV target is invalid");
    const headers = new Headers(extra);
    headers.set("accept", "*/*");
    if (source.credentialRef !== undefined) {
      const credential = this.resolveCredential(scope, source.credentialRef);
      if (credential === undefined) throw new Error("WebDAV credential is unavailable");
      headers.set(credential.name === "cookie" ? "cookie" : "authorization", credential.value);
    }
    const response = await fetch(target, { method, headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400) throw new Error("WebDAV redirect is not allowed");
    return response;
  }

  private parseMultiStatus(body: string, rootPath: string): RemoteItem[] {
    const results: RemoteItem[] = [];
    for (const block of body.match(/<[^>]*response[^>]*>[\s\S]*?<\/[^>]*response>/giu) ?? []) {
      const href = tag(block, "href");
      if (href === undefined) continue;
      const url = new URL(href, "http://carmediahub.invalid");
      const decoded = decodeURIComponent(url.pathname);
      if (decoded === this.normalizePath(rootPath) || !decoded.startsWith(`${this.normalizePath(rootPath).replace(/\/$/u, "")}/`)) continue;
      const name = tag(block, "displayname") ?? decodeURIComponent(decoded.split("/").filter(Boolean).pop() ?? "item");
      const length = Number(tag(block, "getcontentlength") ?? 0);
      const directory = /<[^>]*collection[^>]*>/iu.test(block);
      if (!directory && !Number.isSafeInteger(length)) continue;
      const modified = tag(block, "getlastmodified");
      const item: RemoteItem = { itemHandle: `remote_item_${crypto.randomBytes(32).toString("base64url")}`, name: name.slice(0, 160), kind: directory ? "directory" : "file", href: this.normalizePath(decoded) };
      if (!directory) { item.size = Math.max(length, 0); item.contentType = tag(block, "getcontenttype")?.split(";", 1)[0] ?? "application/octet-stream"; }
      if (modified !== undefined) item.updatedAt = modified;
      results.push(item);
    }
    return results;
  }

  private exposeItem(scope: PlaybackScope, sourceHandle: string, item: RemoteItem): MediaSourceItem { this.items.set(this.scopeKey(scope, item.itemHandle), { scope, sourceHandle, item }); return this.publicItem(item); }
  private publicItem(item: RemoteItem): MediaSourceItem { const { href: _href, ...publicItem } = item; return publicItem; }
  private source(scope: PlaybackScope, sourceHandle: string): RemoteWebDavSource { if (!sourceHandlePattern.test(sourceHandle)) throw new Error("WebDAV source is unavailable"); const record = this.sources.get(this.scopeKey(scope, sourceHandle)); if (record === undefined) throw new Error("WebDAV source is unavailable"); return record.source; }
  private item(scope: PlaybackScope, sourceHandle: string, itemHandle: string): RemoteItem { if (!itemHandlePattern.test(itemHandle)) throw new Error("WebDAV item is unavailable"); const record = this.items.get(this.scopeKey(scope, itemHandle)); if (record?.sourceHandle !== sourceHandle) throw new Error("WebDAV item is unavailable"); return record.item; }
  private scopeKey(scope: PlaybackScope, value: string): string { return `${scope.organizationId}:${scope.userId}:${scope.installationId}:${value}`; }
  private normalizePath(value: string): string { const path = new URL(value, "http://carmediahub.invalid").pathname; return `/${path.split("/").filter(Boolean).map((part) => encodeURIComponent(decodeURIComponent(part))).join("/")}${path.endsWith("/") ? "/" : ""}`; }
}
