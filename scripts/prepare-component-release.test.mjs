import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { prepareComponentRelease } from "./prepare-component-release.mjs";

test("stages an explicit component and returns an unsigned digest-bound release", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-release-"));
  try {
    const artifact = path.join(root, "ffmpeg.exe");
    fs.writeFileSync(artifact, "component binary");
    const prepared = prepareComponentRelease({ dataDir: path.join(root, "data"), artifact, componentId: "ffmpeg", artifactId: "ffmpeg-7", version: "7.0.0", platform: "windows-x64", keyId: "0123456789abcdef", sourceUrl: "https://example.invalid/ffmpeg", licenseSpdx: "LGPL-2.1" });
    assert.equal(fs.readFileSync(prepared.stagingPath, "utf8"), "component binary");
    assert.equal(prepared.release.sha256, crypto.createHash("sha256").update("component binary").digest("hex"));
    assert.equal(prepared.release.keyId, "0123456789abcdef");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rejects symlinked artifacts and existing staging targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-release-"));
  try {
    const source = path.join(root, "source");
    const link = path.join(root, "link");
    fs.writeFileSync(source, "binary");
    fs.symlinkSync(source, link, "file");
    assert.throws(() => prepareComponentRelease({ dataDir: path.join(root, "data"), artifact: link, componentId: "ffmpeg", artifactId: "one", version: "7.0.0", platform: "linux-x64", keyId: "0123456789abcdef" }), /regular file/u);
    const first = prepareComponentRelease({ dataDir: path.join(root, "data"), artifact: source, componentId: "ffmpeg", artifactId: "one", version: "7.0.0", platform: "linux-x64", keyId: "0123456789abcdef" });
    assert.ok(first.stagingPath);
    assert.throws(() => prepareComponentRelease({ dataDir: path.join(root, "data"), artifact: source, componentId: "ffmpeg", artifactId: "one", version: "7.0.1", platform: "linux-x64", keyId: "0123456789abcdef" }), /already exists/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("stages a directory artifact with a stable multi-file tree digest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-release-dir-"));
  try {
    const artifact = path.join(root, "ffmpeg");
    fs.mkdirSync(path.join(artifact, "lib"), { recursive: true });
    fs.writeFileSync(path.join(artifact, "ffmpeg.exe"), "exe");
    fs.writeFileSync(path.join(artifact, "lib", "avcodec-61.dll"), "dll");
    const prepared = prepareComponentRelease({ dataDir: path.join(root, "data"), artifact, componentId: "ffmpeg", artifactId: "ffmpeg-dir", version: "7.0.0", platform: "windows-x64", keyId: "0123456789abcdef" });
    assert.equal(fs.readFileSync(path.join(prepared.stagingPath, "ffmpeg.exe"), "utf8"), "exe");
    assert.equal(fs.readFileSync(path.join(prepared.stagingPath, "lib", "avcodec-61.dll"), "utf8"), "dll");
    const expected = crypto.createHash("sha256")
      .update("ffmpeg.exe\0" + crypto.createHash("sha256").update("exe").digest("hex") + "\n")
      .update("lib/avcodec-61.dll\0" + crypto.createHash("sha256").update("dll").digest("hex") + "\n")
      .digest("hex");
    assert.equal(prepared.release.sha256, expected);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rejects unsupported entries inside a directory artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-release-dir-"));
  try {
    const artifact = path.join(root, "ffmpeg");
    fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(artifact, "ffmpeg.exe"), "exe");
    fs.symlinkSync(path.join(artifact, "ffmpeg.exe"), path.join(artifact, "alias.exe"), "file");
    assert.throws(() => prepareComponentRelease({ dataDir: path.join(root, "data"), artifact, componentId: "ffmpeg", artifactId: "ffmpeg-dir", version: "7.0.0", platform: "windows-x64", keyId: "0123456789abcdef" }), /unsupported file type/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI writes the requested unsigned record and requires a key fingerprint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-release-cli-"));
  try {
    const artifact = path.join(root, "component.bin");
    const output = path.join(root, "release.json");
    fs.writeFileSync(artifact, "cli component");
    const script = path.join(import.meta.dirname, "prepare-component-release.mjs");
    const result = spawnSync(process.execPath, [script, "--data-dir", path.join(root, "data"), "--artifact", artifact, "--component-id", "ffmpeg", "--artifact-id", "ffmpeg-cli", "--version", "7.0.0", "--platform", "linux-x64", "--key-id", "0123456789abcdef", "--output", output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).release.keyId, "0123456789abcdef");
    const missingKey = spawnSync(process.execPath, [script, "--data-dir", path.join(root, "other-data"), "--artifact", artifact, "--component-id", "ffmpeg", "--artifact-id", "ffmpeg-missing-key", "--version", "7.0.0", "--platform", "linux-x64"], { encoding: "utf8" });
    assert.notEqual(missingKey.status, 0);
    assert.match(missingKey.stderr, /keyId is required/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("requires component provenance fields to be provided as a complete pair", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-release-provenance-"));
  try {
    const artifact = path.join(root, "component.bin");
    fs.writeFileSync(artifact, "component");
    const base = { dataDir: path.join(root, "data"), artifact, componentId: "ffmpeg", artifactId: "provenance", version: "7.0.0", platform: "linux-x64", keyId: "0123456789abcdef" };
    assert.throws(() => prepareComponentRelease({ ...base, sourceUrl: "https://ffmpeg.org" }), /provided together/u);
    assert.throws(() => prepareComponentRelease({ ...base, licenseSpdx: "LGPL-2.1" }), /provided together/u);
    const complete = prepareComponentRelease({ ...base, sourceUrl: "https://ffmpeg.org", licenseSpdx: "LGPL-2.1" });
    assert.deepEqual(complete.release.provenance, { sourceUrl: "https://ffmpeg.org", licenseSpdx: "LGPL-2.1" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
