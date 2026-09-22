import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./database.js";
import { JobExecutor } from "./job-executor.js";
import { PluginJobService } from "./job-service.js";
import { MediaLibraryService } from "./media-library-service.js";
import { cleanupExpiredTransformOutputs, readHlsAsset, readTransformOutput, registerMediaTransformHandlers, revokeHlsForInstallation, revokeHlsForUser } from "./media-transform-service.js";

const ffmpegCandidates = process.platform === "win32"
  ? ["F:/dev_env/bin/ffmpeg.exe"]
  : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
const ffmpegPath = ffmpegCandidates.find((candidate) => fs.existsSync(candidate));

test("runs a verified FFmpeg remux through the scoped media job", { skip: ffmpegPath === undefined }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-media-transform-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-media-source-"));
  const managedExecutable = path.join(dataDir, "components", "ffmpeg", "7.0.0", path.basename(ffmpegPath!));
  fs.mkdirSync(path.dirname(managedExecutable), { recursive: true });
  fs.copyFileSync(ffmpegPath!, managedExecutable);
  const sourceFile = path.join(sourceRoot, "clip.mp4");
  execFileSync(ffmpegPath!, ["-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.1", "-an", sourceFile], { stdio: "ignore" });
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(managedExecutable)).digest("hex");
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', 'now', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Default'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'user', 'hash', 'admin', 'en', 'now');");
    const media = new MediaLibraryService(database.db, Buffer.alloc(32, 1));
    const root = media.addRoot("org", "plugin", "Media", sourceRoot);
    const item = media.list("org", "plugin", root.id)[0]!;
    const jobs = new PluginJobService(database.db);
    const executor = new JobExecutor(jobs);
    registerMediaTransformHandlers({ executor, jobs, media, dataDir, database: database.db, ffmpeg: { id: "ffmpeg", version: "7.0.0", executable: `ffmpeg/7.0.0/${path.basename(managedExecutable)}`, checksum } });
    const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "plugin" };
    const job = jobs.enqueueMediaTransform(scope, "media.remux", { mediaId: item.id, mode: "remux", container: "mp4" });
    const completed = await executor.runOnce(scope);
    assert.equal(completed?.status, "succeeded");
    const outputId = (completed?.result as { outputId: string }).outputId;
    const output = readTransformOutput(database.db, dataDir, scope, outputId, 0, 1023);
    assert.equal(output.contentType, "video/mp4");
    assert.ok(Buffer.from(output.data, "base64").byteLength > 0);
    const files = fs.readdirSync(path.join(dataDir, "media-transforms"));
    assert.equal(files.length, 1);
    assert.ok(fs.statSync(path.join(dataDir, "media-transforms", files[0]!)).size > 0);
    database.db.prepare("UPDATE media_transform_outputs SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", outputId);
    assert.equal(cleanupExpiredTransformOutputs(database.db, dataDir, "2026-01-01T00:00:00.000Z"), 1);
    assert.throws(() => readTransformOutput(database.db, dataDir, scope, outputId, 0, 10), /unavailable/);
    assert.equal(jobs.list(scope).some((candidate) => candidate.id === job.id), true);
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("runs a scoped HLS job and reads only validated playlist and segment assets", { skip: ffmpegPath === undefined }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-media-hls-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-media-hls-source-"));
  const managedExecutable = path.join(dataDir, "components", "ffmpeg", "7.0.0", path.basename(ffmpegPath!));
  fs.mkdirSync(path.dirname(managedExecutable), { recursive: true });
  fs.copyFileSync(ffmpegPath!, managedExecutable);
  const sourceFile = path.join(sourceRoot, "clip.mp4");
  execFileSync(ffmpegPath!, ["-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.4", "-an", sourceFile], { stdio: "ignore" });
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(managedExecutable)).digest("hex");
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', 'now', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Default'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'user', 'hash', 'admin', 'en', 'now');");
    const media = new MediaLibraryService(database.db, Buffer.alloc(32, 2));
    const root = media.addRoot("org", "plugin", "Media", sourceRoot);
    const item = media.list("org", "plugin", root.id)[0]!;
    const jobs = new PluginJobService(database.db);
    const executor = new JobExecutor(jobs);
    registerMediaTransformHandlers({ executor, jobs, media, dataDir, database: database.db, ffmpeg: { id: "ffmpeg", version: "7.0.0", executable: `ffmpeg/7.0.0/${path.basename(managedExecutable)}`, checksum } });
    const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "plugin" };
    const job = jobs.enqueueHls(scope, { mediaId: item.id, segmentDurationSeconds: 2 });
    const completed = await executor.runOnce(scope);
    assert.equal(completed?.status, "succeeded");
    const result = completed?.result as { sessionId: string; playlistAsset: string };
    assert.equal(result.playlistAsset, "playlist.m3u8");
    const playlist = readHlsAsset(database.db, dataDir, scope, result.sessionId, result.playlistAsset, 0, 262143);
    assert.match(Buffer.from(playlist.data, "base64").toString("utf8"), /#EXTM3U/u);
    const segment = fs.readdirSync(path.join(dataDir, "media-hls", result.sessionId)).find((name) => /^segment_\d{5}\.ts$/u.test(name));
    assert.ok(segment);
    const segmentData = readHlsAsset(database.db, dataDir, scope, result.sessionId, segment!, 0, 1023);
    assert.equal(segmentData.contentType, "video/mp2t");
    assert.ok(Buffer.from(segmentData.data, "base64").byteLength > 0);
    assert.throws(() => readHlsAsset(database.db, dataDir, scope, result.sessionId, "../secret", 0, 10), /invalid/);
    revokeHlsForInstallation(database.db, "other-installation");
    assert.doesNotThrow(() => readHlsAsset(database.db, dataDir, scope, result.sessionId, result.playlistAsset, 0, 10));
    revokeHlsForUser(database.db, "user");
    assert.throws(() => readHlsAsset(database.db, dataDir, scope, result.sessionId, result.playlistAsset, 0, 10), /unavailable/);
    const second = jobs.enqueueHls(scope, { mediaId: item.id, segmentDurationSeconds: 2 });
    const secondCompleted = await executor.runOnce(scope);
    assert.equal(secondCompleted?.status, "succeeded");
    const secondSession = (secondCompleted?.result as { sessionId: string }).sessionId;
    database.db.prepare("UPDATE media_hls_sessions SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", result.sessionId);
    database.db.prepare("UPDATE media_hls_sessions SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", secondSession);
    assert.equal(cleanupExpiredTransformOutputs(database.db, dataDir, "2026-01-01T00:00:00.000Z"), 2);
    assert.throws(() => readHlsAsset(database.db, dataDir, scope, result.sessionId, result.playlistAsset, 0, 10), /unavailable/);
    assert.equal(jobs.list(scope).some((candidate) => candidate.id === job.id), true);
    assert.equal(jobs.list(scope).some((candidate) => candidate.id === second.id), true);
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});
