import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareComponentRelease } from "./prepare-component-release.mjs";

test("stages an explicit component and returns an unsigned digest-bound release", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-release-"));
  try {
    const artifact = path.join(root, "ffmpeg.exe");
    fs.writeFileSync(artifact, "component binary");
    const prepared = prepareComponentRelease({ dataDir: path.join(root, "data"), artifact, componentId: "ffmpeg", artifactId: "ffmpeg-7", version: "7.0.0", platform: "windows-x64", sourceUrl: "https://example.invalid/ffmpeg", licenseSpdx: "LGPL-2.1" });
    assert.equal(fs.readFileSync(prepared.stagingPath, "utf8"), "component binary");
    assert.equal(prepared.release.sha256, crypto.createHash("sha256").update("component binary").digest("hex"));
    assert.equal(prepared.release.keyId, "replace-with-trusted-key-fingerprint");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rejects symlinked artifacts and existing staging targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-release-"));
  try {
    const source = path.join(root, "source");
    const link = path.join(root, "link");
    fs.writeFileSync(source, "binary");
    fs.symlinkSync(source, link, "file");
    assert.throws(() => prepareComponentRelease({ dataDir: path.join(root, "data"), artifact: link, componentId: "ffmpeg", artifactId: "one", version: "7.0.0", platform: "linux-x64" }), /regular file/u);
    const first = prepareComponentRelease({ dataDir: path.join(root, "data"), artifact: source, componentId: "ffmpeg", artifactId: "one", version: "7.0.0", platform: "linux-x64" });
    assert.ok(first.stagingPath);
    assert.throws(() => prepareComponentRelease({ dataDir: path.join(root, "data"), artifact: source, componentId: "ffmpeg", artifactId: "one", version: "7.0.1", platform: "linux-x64" }), /already exists/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
