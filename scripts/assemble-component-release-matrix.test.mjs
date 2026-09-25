import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assembleComponentReleaseMatrix } from "./assemble-component-release-matrix.mjs";

function release(platform) { return { release: { schemaVersion: 1, keyId: "0123456789abcdef", componentId: "ffmpeg", version: "7.0.0", artifactId: `ffmpeg-${platform}`, sha256: crypto.createHash("sha256").update(platform).digest("hex"), platform, provenance: { sourceUrl: "https://ffmpeg.org/download.html", licenseSpdx: "LGPL-2.1" } }, signature: "AQ==" }; }

test("assembles a complete matrix from signed records", () => {
  const matrix = assembleComponentReleaseMatrix({ componentId: "ffmpeg", version: "7.0.0", platforms: ["linux-x64", "windows-x64"], releases: [release("linux-x64"), release("windows-x64")] });
  assert.equal(matrix.releases.length, 2);
});

test("CLI rejects missing platforms and existing output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-assemble-"));
  try {
    const releases = path.join(root, "releases"); fs.mkdirSync(releases); fs.writeFileSync(path.join(releases, "linux.json"), JSON.stringify(release("linux-x64")));
    const output = path.join(root, "matrix.json"); const script = path.join(import.meta.dirname, "assemble-component-release-matrix.mjs");
    const missing = spawnSync(process.execPath, [script, "--component-id", "ffmpeg", "--version", "7.0.0", "--platforms", "linux-x64,windows-x64", "--release-dir", releases, "--output", output], { encoding: "utf8", env: {} });
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /one signed release|missing|duplicated/u);
    fs.writeFileSync(path.join(releases, "windows.json"), JSON.stringify(release("windows-x64")));
    const success = spawnSync(process.execPath, [script, "--component-id", "ffmpeg", "--version", "7.0.0", "--platforms", "linux-x64,windows-x64", "--release-dir", releases, "--output", output], { encoding: "utf8", env: {} });
    assert.equal(success.status, 0, success.stderr); assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).releases.length, 2);
    const duplicate = spawnSync(process.execPath, [script, "--component-id", "ffmpeg", "--version", "7.0.0", "--platforms", "linux-x64,windows-x64", "--release-dir", releases, "--output", output], { encoding: "utf8", env: {} });
    assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /already exists/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
