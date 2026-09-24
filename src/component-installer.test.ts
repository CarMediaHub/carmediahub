import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installStagedComponent } from "./component-installer.js";
import { loadComponentCatalog } from "./components.js";

test("installs only a checksum-verified binary from the managed staging directory", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-component-"));
  try {
    const staging = path.join(dataDir, "staging");
    fs.mkdirSync(staging, { recursive: true });
    const artifact = path.join(staging, "ffmpeg-7");
    fs.writeFileSync(artifact, "verified component");
    const digest = crypto.createHash("sha256").update("verified component").digest("hex");
    const catalog = loadComponentCatalog(path.resolve(import.meta.dirname, ".."));
    const installed = installStagedComponent(dataDir, catalog, { componentId: "ffmpeg", version: "7.0.0", artifactId: "ffmpeg-7", sha256: digest });
    const executable = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    assert.equal(installed.executable, `ffmpeg/7.0.0/${executable}`);
    assert.equal(fs.readFileSync(path.join(dataDir, "components", "ffmpeg", "7.0.0", executable), "utf8"), "verified component");
    assert.throws(() => installStagedComponent(dataDir, catalog, { componentId: "ffmpeg", version: "7.0.1", artifactId: "ffmpeg-7", sha256: "0".repeat(64) }));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("installs a directory artifact and preserves companion runtime files", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-component-dir-"));
  try {
    const staging = path.join(dataDir, "staging", "ffmpeg-dir");
    fs.mkdirSync(path.join(staging, "lib"), { recursive: true });
    const executableName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    fs.writeFileSync(path.join(staging, executableName), "verified executable");
    fs.writeFileSync(path.join(staging, "lib", "avcodec.dll"), "verified library");
    const digest = crypto.createHash("sha256")
      .update(`${executableName}\0${crypto.createHash("sha256").update("verified executable").digest("hex")}\n`)
      .update(`lib/avcodec.dll\0${crypto.createHash("sha256").update("verified library").digest("hex")}\n`)
      .digest("hex");
    const catalog = loadComponentCatalog(path.resolve(import.meta.dirname, ".."));
    const installed = installStagedComponent(dataDir, catalog, { componentId: "ffmpeg", version: "7.0.0", artifactId: "ffmpeg-dir", sha256: digest });
    assert.equal(fs.readFileSync(path.join(dataDir, "components", "ffmpeg", "7.0.0", executableName), "utf8"), "verified executable");
    assert.equal(fs.readFileSync(path.join(dataDir, "components", "ffmpeg", "7.0.0", "lib", "avcodec.dll"), "utf8"), "verified library");
    assert.equal(installed.checksum, digest);
    fs.writeFileSync(path.join(staging, "lib", "avcodec.dll"), "tampered");
    assert.throws(() => installStagedComponent(dataDir, catalog, { componentId: "ffmpeg", version: "7.0.1", artifactId: "ffmpeg-dir", sha256: digest }), /checksum mismatch/u);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("rejects a directory artifact without its catalog executable", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-component-dir-"));
  try {
    const staging = path.join(dataDir, "staging", "missing-executable");
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, "avcodec.dll"), "library");
    const digest = crypto.createHash("sha256")
      .update(`avcodec.dll\0${crypto.createHash("sha256").update("library").digest("hex")}\n`)
      .digest("hex");
    const catalog = loadComponentCatalog(path.resolve(import.meta.dirname, ".."));
    assert.throws(() => installStagedComponent(dataDir, catalog, { componentId: "ffmpeg", version: "7.0.0", artifactId: "missing-executable", sha256: digest }), /missing its catalog executable/u);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
