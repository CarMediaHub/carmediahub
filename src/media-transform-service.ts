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
  input.executor.register("media.remux", handler);
  input.executor.register("media.transcode", handler);
}

export interface TransformOutputRead { data: string; completed: boolean; contentType: string; size: number; }
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
