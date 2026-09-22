import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
      return { outputId, contentType: payload.container === "ts" ? "video/mp2t" : "video/mp4", bytes: fs.statSync(output).size };
    } catch (error) {
      try { fs.rmSync(output, { force: true }); } catch { /* best effort cleanup */ }
      throw error;
    }
  };
  input.executor.register("media.remux", handler);
  input.executor.register("media.transcode", handler);
}
