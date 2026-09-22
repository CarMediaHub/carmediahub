import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ScopeContext } from "@carmediahub/sdk";
import { MediaLibraryService } from "./media-library-service.js";
import { runManagedComponent, type ManagedComponentRef } from "./managed-component-runner.js";
import { PluginJobService, type PluginJob } from "./job-service.js";
import { JobExecutor } from "./job-executor.js";

type TransformPayload = { mediaId: string; mode: "remux" | "transcode"; container?: "mp4" | "fmp4" | "ts"; videoCodec?: "copy" | "h264" | "h265"; audioCodec?: "copy" | "aac" | "opus" };
type HlsPayload = { mediaId: string; segmentDurationSeconds?: 2 | 4 | 6 };

const safeToken = /^[A-Za-z0-9_-]{20,128}$/u;

function outputExtension(payload: TransformPayload): string {
  return payload.container === "ts" ? "ts" : "mp4";
}

/** Registers the only Core-owned media handlers. It never interprets plugin-provided commands. */
export function registerMediaTransformHandlers(input: {
  executor: JobExecutor;
  jobs: PluginJobService;
  media: MediaLibraryService;
  dataDir: string;
  ffmpeg: ManagedComponentRef;
  database: DatabaseSync;
}): void {
  fs.mkdirSync(path.join(input.dataDir, "media-transforms"), { recursive: true });
  const handler = async (job: PluginJob, scope: ScopeContext, signal: AbortSignal): Promise<unknown> => {
    if (job.type !== "media.remux" && job.type !== "media.transcode") throw new Error("Unsupported media transform");
    const payload = job.payload as Partial<TransformPayload>;
    const mediaId = payload.mediaId;
    if (mediaId === undefined || !safeToken.test(mediaId) || (payload.mode !== "remux" && payload.mode !== "transcode")) throw new Error("Invalid media transform");
    const source = input.media.sourceLocation(scope, mediaId);
    const outputId = `transform_${crypto.randomUUID()}`;
    const extension = outputExtension(payload as TransformPayload);
    const output = path.join(input.dataDir, "media-transforms", `${outputId}.${extension}`);
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source.path, "-map", "0:v?", "-map", "0:a?"];
    if (job.type === "media.remux") args.push("-c", "copy");
    else args.push("-c:v", payload.videoCodec === "h265" ? "libx265" : payload.videoCodec === "copy" ? "copy" : "libx264", "-c:a", payload.audioCodec === "opus" ? "libopus" : payload.audioCodec === "copy" ? "copy" : "aac");
    if (payload.container === "fmp4") args.push("-movflags", "+frag_keyframe+empty_moov");
    args.push(output);
    try {
      const result = await runManagedComponent(input.dataDir, input.ffmpeg, { args, timeoutMs: 10 * 60 * 1000, maxOutputBytes: 256 * 1024, signal });
      if (result.exitCode !== 0 || !fs.existsSync(output)) throw new Error("FFmpeg failed");
      const bytes = fs.statSync(output).size;
      const createdAt = new Date().toISOString();
      input.database.prepare("INSERT INTO media_transform_outputs (id, organization_id, user_id, installation_id, file_name, content_type, bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(outputId, scope.organizationId, scope.userId, scope.installationId, path.basename(output), payload.container === "ts" ? "video/mp2t" : "video/mp4", bytes, createdAt, new Date(Date.now() + 60 * 60 * 1000).toISOString());
      return { outputId, contentType: payload.container === "ts" ? "video/mp2t" : "video/mp4", bytes };
    } catch (error) {
      try { fs.rmSync(output, { force: true }); } catch { /* best effort cleanup */ }
      throw error;
    }
  };
  const hlsHandler = async (job: PluginJob, scope: ScopeContext, signal: AbortSignal): Promise<unknown> => {
    if (job.type !== "media.hls") throw new Error("Unsupported HLS transform");
    const payload = job.payload as Partial<HlsPayload>;
    if (payload.mediaId === undefined || !safeToken.test(payload.mediaId)) throw new Error("Invalid HLS media");
    const duration = payload.segmentDurationSeconds === 2 || payload.segmentDurationSeconds === 6 ? payload.segmentDurationSeconds : 4;
    const source = input.media.sourceLocation(scope, payload.mediaId);
    const sessionId = `hls_${crypto.randomUUID()}`;
    const directory = path.join(input.dataDir, "media-hls", sessionId);
    const playlist = path.join(directory, "playlist.m3u8");
    fs.mkdirSync(directory, { recursive: true });
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source.path, "-map", "0:v:0?", "-map", "0:a:0?", "-c:v", "libx264", "-c:a", "aac", "-f", "hls", "-hls_time", String(duration), "-hls_playlist_type", "vod", "-hls_segment_filename", path.join(directory, "segment_%05d.ts"), playlist];
    try {
      const result = await runManagedComponent(input.dataDir, input.ffmpeg, { args, timeoutMs: 10 * 60 * 1000, maxOutputBytes: 256 * 1024, signal });
      if (result.exitCode !== 0 || !fs.existsSync(playlist)) throw new Error("FFmpeg HLS failed");
      const createdAt = new Date().toISOString();
      input.database.prepare("INSERT INTO media_hls_sessions (id, organization_id, user_id, installation_id, directory_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(sessionId, scope.organizationId, scope.userId, scope.installationId, sessionId, createdAt, new Date(Date.now() + 60 * 60 * 1000).toISOString());
      return { sessionId, playlistAsset: "playlist.m3u8", contentType: "application/vnd.apple.mpegurl" };
    } catch (error) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
      throw error;
    }
  };
  input.executor.register("media.remux", handler);
  input.executor.register("media.transcode", handler);
  input.executor.register("media.hls", hlsHandler);
}

export interface TransformOutputRead { data: string; completed: boolean; contentType: string; size: number; }

export function cleanupExpiredTransformOutputs(db: DatabaseSync, dataDir: string, nowIso = new Date().toISOString()): number {
  const rows = db.prepare("SELECT id, file_name FROM media_transform_outputs WHERE expires_at <= ? OR revoked_at IS NOT NULL").all(nowIso) as Array<{ id: string; file_name: string }>;
  const root = path.resolve(dataDir, "media-transforms");
  for (const row of rows) {
    const location = path.resolve(root, row.file_name);
    if (location.startsWith(root + path.sep) && fs.existsSync(location) && !fs.lstatSync(location).isSymbolicLink()) fs.rmSync(location, { force: true });
    db.prepare("DELETE FROM media_transform_outputs WHERE id = ?").run(row.id);
  }
  const hlsRows = db.prepare("SELECT id, directory_name FROM media_hls_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").all(nowIso) as Array<{ id: string; directory_name: string }>;
  const hlsRoot = path.resolve(dataDir, "media-hls");
  for (const row of hlsRows) {
    const location = path.resolve(hlsRoot, row.directory_name);
    if (location.startsWith(hlsRoot + path.sep) && fs.existsSync(location) && !fs.lstatSync(location).isSymbolicLink()) fs.rmSync(location, { recursive: true, force: true });
    db.prepare("DELETE FROM media_hls_sessions WHERE id = ?").run(row.id);
  }
  return rows.length + hlsRows.length;
}

export function readTransformOutput(db: DatabaseSync, dataDir: string, scope: ScopeContext, outputId: string, start: number, end: number): TransformOutputRead {
  if (!/^transform_[A-Za-z0-9-]{20,80}$/u.test(outputId) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start >= 262_144) throw new Error("Transform output range is invalid");
  const row = db.prepare("SELECT file_name, content_type, bytes FROM media_transform_outputs WHERE id = ? AND organization_id = ? AND user_id = ? AND installation_id = ? AND expires_at > ? AND revoked_at IS NULL").get(outputId, scope.organizationId, scope.userId, scope.installationId, new Date().toISOString()) as { file_name?: string; content_type?: string; bytes?: number } | undefined;
  if (row?.file_name === undefined || row.content_type === undefined || typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || start >= row.bytes) throw new Error("Transform output is unavailable");
  const size: number = row.bytes;
  const root = path.resolve(dataDir, "media-transforms"); const location = path.resolve(root, row.file_name);
  if (!location.startsWith(root + path.sep) || !fs.existsSync(location) || fs.lstatSync(location).isSymbolicLink()) throw new Error("Transform output is unavailable");
  const count = Math.min(end, size - 1) - start + 1; const handle = fs.openSync(location, "r");
  try { const bytes = Buffer.allocUnsafe(count); fs.readSync(handle, bytes, 0, count, start); return { data: bytes.toString("base64"), completed: start + count >= size, contentType: row.content_type, size }; } finally { fs.closeSync(handle); }
}

export function readTransformOutputForUser(db: DatabaseSync, dataDir: string, organizationId: string, userId: string, outputId: string, start: number, end: number): TransformOutputRead {
  const row = db.prepare("SELECT installation_id FROM media_transform_outputs WHERE id = ? AND organization_id = ? AND user_id = ? AND expires_at > ? AND revoked_at IS NULL").get(outputId, organizationId, userId, new Date().toISOString()) as { installation_id?: string } | undefined;
  if (row?.installation_id === undefined) throw new Error("Transform output is unavailable");
  const scope = { deploymentId: "output", organizationId, userId, deviceId: "output", sessionId: "output", installationId: row.installation_id };
  return readTransformOutput(db, dataDir, scope, outputId, start, end);
}

export function readHlsAsset(db: DatabaseSync, dataDir: string, scope: ScopeContext, sessionId: string, asset: string, start: number, end: number): TransformOutputRead {
  if (!/^hls_[A-Za-z0-9-]{20,80}$/u.test(sessionId) || !/^(?:playlist\.m3u8|segment_[0-9]{5}\.ts)$/u.test(asset) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start >= 262_144) throw new Error("HLS asset request is invalid");
  const row = db.prepare("SELECT directory_name FROM media_hls_sessions WHERE id = ? AND organization_id = ? AND user_id = ? AND installation_id = ? AND expires_at > ? AND revoked_at IS NULL").get(sessionId, scope.organizationId, scope.userId, scope.installationId, new Date().toISOString()) as { directory_name?: string } | undefined;
  if (row?.directory_name === undefined) throw new Error("HLS session is unavailable");
  const root = path.resolve(dataDir, "media-hls");
  const directory = path.resolve(root, row.directory_name);
  const location = path.resolve(directory, asset);
  if (!directory.startsWith(root + path.sep) || !location.startsWith(directory + path.sep) || !fs.existsSync(location) || fs.lstatSync(location).isSymbolicLink()) throw new Error("HLS asset is unavailable");
  const stat = fs.statSync(location); const size = stat.size;
  if (start >= size) throw new Error("HLS asset range is unavailable");
  const count = Math.min(end, size - 1) - start + 1; const handle = fs.openSync(location, "r");
  try { const bytes = Buffer.allocUnsafe(count); fs.readSync(handle, bytes, 0, count, start); return { data: bytes.toString("base64"), completed: start + count >= size, contentType: asset === "playlist.m3u8" ? "application/vnd.apple.mpegurl" : "video/mp2t", size }; } finally { fs.closeSync(handle); }
}
