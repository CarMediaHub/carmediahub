import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createApp } from "../src/app.js";
import { canonicalPluginManifest } from "../src/plugin-release.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import { runManagedComponent } from "../src/managed-component-runner.js";
import { computeInstalledComponentDigest } from "../src/components.js";

type Options = { ffmpeg: string; keep: boolean };

function parseArgs(argv: readonly string[]): Options {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let ffmpeg = "";
  let keep = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--ffmpeg") ffmpeg = args[++index] ?? "";
    else if (value === "--keep") keep = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (ffmpeg === "") throw new Error("Usage: pnpm smoke:media-http -- --ffmpeg <ffmpeg> [--keep]");
  return { ffmpeg: path.resolve(ffmpeg), keep };
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  if (result.status !== 0) throw new Error(`Command failed: ${command} ${args.join(" ")}\n${String(result.stderr)}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(import.meta.dirname, "..");
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cmh-media-http-smoke-"));
  const mediaRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "cmh-media-http-source-"));
  const componentDirectory = path.join(dataDir, "components", "ffmpeg", "1.0.0");
  const componentExecutable = path.join(componentDirectory, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  await fsp.mkdir(componentDirectory, { recursive: true });
  await fsp.copyFile(options.ffmpeg, componentExecutable);
  if (process.platform === "win32") {
    for (const entry of await fsp.readdir(path.dirname(options.ffmpeg), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".dll")) await fsp.copyFile(path.join(path.dirname(options.ffmpeg), entry.name), path.join(componentDirectory, entry.name));
    }
  }
  const componentChecksum = computeInstalledComponentDigest(dataDir, { id: "ffmpeg", version: "1.0.0", executable: `ffmpeg/1.0.0/${process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"}` });
  const sourcePath = path.join(mediaRoot, "smoke.mp4");
  run(options.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=8", "-t", "1", "-pix_fmt", "yuv420p", sourcePath]);

  const seed = openDatabase(dataDir);
  try {
    const repository = new Repository(seed.db, Buffer.alloc(32, 7));
    repository.registerComponent({ id: "ffmpeg", version: "1.0.0", executable: `ffmpeg/1.0.0/${process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"}`, checksum: `sha256:${componentChecksum}`, verified: true });
    repository.updateComponentHealth("ffmpeg", "healthy");
  } finally {
    seed.close();
  }
  await runManagedComponent(dataDir, { id: "ffmpeg", version: "1.0.0", executable: `ffmpeg/1.0.0/${process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"}`, checksum: componentChecksum, verified: true, provides: ["media-processing"] }, { args: ["-version"], requiredRole: "media-processing" });
  const manualHlsDirectory = path.join(dataDir, "manual-hls");
  await fsp.mkdir(manualHlsDirectory, { recursive: true });
  const manualHlsResult = await runManagedComponent(dataDir, { id: "ffmpeg", version: "1.0.0", executable: `ffmpeg/1.0.0/${process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"}`, checksum: componentChecksum, verified: true, provides: ["media-processing"] }, { args: ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath, "-map", "0:v:0?", "-map", "0:a:0?", "-c:v", "libx264", "-c:a", "aac", "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod", "-hls_segment_filename", path.join(manualHlsDirectory, "segment_%05d.ts"), path.join(manualHlsDirectory, "playlist.m3u8")], requiredRole: "media-processing" });
  if (manualHlsResult.exitCode !== 0 || !fs.existsSync(path.join(manualHlsDirectory, "playlist.m3u8"))) throw new Error(`Managed FFmpeg HLS preflight failed: ${manualHlsResult.stderr}`);

  const pluginKeyPair = crypto.generateKeyPairSync("ed25519");
  const pluginPublicKey = pluginKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const manifest = { id: "wdr-media", version: "0.1.0", sdk: "^0.1.0", name: { en: "WDR Media", "zh-CN": "WDR 媒体", ko: "WDR 미디어" }, description: { en: "Media", "zh-CN": "媒体", ko: "미디어" }, category: "official", runtime: "isolated-worker", capabilities: ["db", "storage", "media", "history", "catalog", "display", "jobs", "events"], routes: [{ path: "/", methods: ["GET"] }, { path: "/library", methods: ["GET"] }, { path: "/stream", methods: ["GET", "HEAD"] }, { path: "/health", methods: ["GET"] }, { path: "/hls", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" }, ui: { entry: "./ui/index.html", vehicleSupported: true } } as const;
  const keyId = crypto.createHash("sha256").update(pluginPublicKey).digest("hex").slice(0, 16);
  const release = { keyId, manifest, signature: crypto.sign(null, canonicalPluginManifest(manifest), pluginKeyPair.privateKey).toString("base64") };
  const packageRoot = path.join(root, "..", "carmediahub-plugins", "dist", "packages", "wdr-media");
  const app = await createApp({ dataDir, pluginTrustKeys: [pluginPublicKey], trustedWorkerPackages: [{ packageId: "wdr-media", packageVersion: "0.1.0", packageRoot, workerEntry: "./worker.js" }] });
  try {
    const bootstrap = await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "smoke-admin", password: "correct horse battery staple" } });
    if (bootstrap.statusCode !== 201) throw new Error(`bootstrap returned ${bootstrap.statusCode}`);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "smoke-admin", password: "correct horse battery staple" } });
    if (login.statusCode !== 200) throw new Error(`login returned ${login.statusCode}`);
    const cookie = login.headers["set-cookie"];
    const install = await app.inject({ method: "POST", url: "/api/plugins", headers: { cookie }, payload: release });
    if (install.statusCode !== 201) throw new Error(`plugin install returned ${install.statusCode}: ${install.body}`);
    const installationId = (install.json() as { installation: { id: string } }).installation.id;
    const rootResponse = await app.inject({ method: "POST", url: "/api/media-roots", headers: { cookie }, payload: { installationId, name: "HTTP smoke media", path: mediaRoot } });
    if (rootResponse.statusCode !== 201) throw new Error(`media root returned ${rootResponse.statusCode}: ${rootResponse.body}`);
    const mediaRootId = (rootResponse.json() as { root: { id: string } }).root.id;
    const item = ((await app.inject({ method: "GET", url: `/api/media-roots/${mediaRootId}/items`, headers: { cookie } })).json() as { items: Array<{ id: string }> }).items[0];
    if (item === undefined) throw new Error("media item was not indexed");
    const playlist = await app.inject({ method: "GET", url: `/apps/wdr-media/${installationId}/hls?id=${encodeURIComponent(item.id)}`, headers: { cookie } });
    if (playlist.statusCode !== 200 || playlist.headers["content-type"] !== "application/vnd.apple.mpegurl") {
      const jobs = await app.inject({ method: "GET", url: "/api/jobs", headers: { cookie } });
      throw new Error(`HLS playlist failed: ${playlist.statusCode} ${playlist.body}; jobs=${jobs.body}`);
    }
    const segment = playlist.body.match(/hls\?session=([^&]+)&asset=([^\r\n]+)/u);
    if (segment === null) throw new Error(`HLS playlist did not contain a segment: ${playlist.body}`);
    const segmentResponse = await app.inject({ method: "GET", url: `/apps/wdr-media/${installationId}/hls?session=${segment[1]}&asset=${segment[2]}`, headers: { cookie } });
    if (segmentResponse.statusCode !== 200 || segmentResponse.rawPayload.length === 0) throw new Error(`HLS segment failed: ${segmentResponse.statusCode}`);
    console.log(JSON.stringify({ playlistStatus: playlist.statusCode, segmentStatus: segmentResponse.statusCode, segmentBytes: segmentResponse.rawPayload.length, contentType: playlist.headers["content-type"] }, null, 2));
  } finally {
    await app.close();
    if (!options.keep) {
      await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      await fsp.rm(mediaRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } else console.log(JSON.stringify({ dataDir, mediaRoot }, null, 2));
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
