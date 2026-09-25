import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateComponentReleaseMatrix } from "./validate-component-release-matrix.mjs";

function release(platform, componentId = "ffmpeg", version = "7.0.0") {
  return { release: { schemaVersion: 1, keyId: "0123456789abcdef", componentId, version, artifactId: `ffmpeg-${platform}`, sha256: crypto.createHash("sha256").update(platform).digest("hex"), platform, provenance: { sourceUrl: "https://ffmpeg.org/download.html", licenseSpdx: "LGPL-2.1" } }, signature: "AQ==" };
}

test("accepts a complete FFmpeg platform matrix", () => {
  const matrix = { schemaVersion: 1, componentId: "ffmpeg", version: "7.0.0", platforms: ["windows-x64", "linux-x64", "linux-arm64"], releases: [release("windows-x64"), release("linux-x64"), release("linux-arm64")] };
  assert.deepEqual(validateComponentReleaseMatrix(matrix), { componentId: "ffmpeg", version: "7.0.0", platforms: ["linux-arm64", "linux-x64", "windows-x64"] });
});

test("rejects missing, duplicate, mismatched, and incomplete records", () => {
  const base = { schemaVersion: 1, componentId: "ffmpeg", version: "7.0.0", platforms: ["windows-x64", "linux-x64"], releases: [release("windows-x64"), release("linux-x64")] };
  assert.throws(() => validateComponentReleaseMatrix({ ...base, releases: [release("windows-x64")] }), /one record per platform/u);
  assert.throws(() => validateComponentReleaseMatrix({ ...base, releases: [release("windows-x64"), release("windows-x64")] }), /missing or duplicated/u);
  assert.throws(() => validateComponentReleaseMatrix({ ...base, releases: [release("windows-x64"), release("linux-x64", "rclone")] }), /componentId does not match/u);
  const incomplete = release("linux-x64"); delete incomplete.release.provenance;
  assert.throws(() => validateComponentReleaseMatrix({ ...base, releases: [release("windows-x64"), incomplete] }), /provenance is incomplete/u);
});

test("CLI validates a matrix without reading PATH or environment configuration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-matrix-"));
  try {
    const matrixPath = path.join(root, "ffmpeg.json");
    fs.writeFileSync(matrixPath, JSON.stringify({ schemaVersion: 1, componentId: "ffmpeg", version: "7.0.0", platforms: ["linux-x64"], releases: [release("linux-x64")] }));
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "validate-component-release-matrix.mjs"), "--matrix", matrixPath], { encoding: "utf8", env: {} });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /linux-x64/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
