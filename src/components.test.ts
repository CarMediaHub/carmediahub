import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import test from "node:test";
import path from "node:path";
import { componentExecutableName, currentPlatformKey, loadComponentCatalog, resolveInstalledExecutable, resolveManagedExecutable } from "./components.js";

test("loads the built-in component catalog without environment discovery", () => {
  const catalog = loadComponentCatalog(path.resolve(import.meta.dirname, ".."));
  assert.deepEqual(catalog.map((item) => item.id), ["alist", "rclone", "ffmpeg", "sevenzip", "mihomo"]);
  assert.ok(catalog[2]!.platforms.includes(currentPlatformKey()));
  assert.ok(resolveManagedExecutable("C:/cmh-data", catalog[2]!).endsWith(`components\\ffmpeg\\ffmpeg${process.platform === "win32" ? ".exe" : ""}`) || resolveManagedExecutable("C:/cmh-data", catalog[2]!).endsWith(`components/ffmpeg/ffmpeg${process.platform === "win32" ? ".exe" : ""}`));
  assert.equal(componentExecutableName(catalog[2]!), `ffmpeg${process.platform === "win32" ? ".exe" : ""}`);
});

test("resolves only an existing verified component installation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-component-path-"));
  try {
    const executable = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const location = path.join(dataDir, "components", "ffmpeg", "7.0.0");
    fs.mkdirSync(location, { recursive: true });
    fs.writeFileSync(path.join(location, executable), "binary");
    const record = { id: "ffmpeg", version: "7.0.0", executable: `ffmpeg/7.0.0/${executable}` };
    assert.equal(resolveInstalledExecutable(dataDir, record), path.join(location, executable));
    assert.throws(() => resolveInstalledExecutable(dataDir, { ...record, executable: `ffmpeg/7.0.0/../../secret/${executable}` }));
    assert.throws(() => resolveInstalledExecutable(dataDir, { ...record, executable: `C:/outside/${executable}` }));
    fs.unlinkSync(path.join(location, executable));
    assert.throws(() => resolveInstalledExecutable(dataDir, record));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("rejects executable and parent directory symlinks", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-component-links-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-component-outside-"));
  try {
    const location = path.join(dataDir, "components", "ffmpeg", "7.0.0");
    fs.mkdirSync(location, { recursive: true });
    const executable = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const target = path.join(outside, executable);
    fs.writeFileSync(target, "outside");
    const record = { id: "ffmpeg", version: "7.0.0", executable: `ffmpeg/7.0.0/${executable}` };
    fs.symlinkSync(target, path.join(location, executable), "file");
    assert.throws(() => resolveInstalledExecutable(dataDir, record), /unavailable/);
    fs.unlinkSync(path.join(location, executable));
    fs.rmSync(path.join(dataDir, "components", "ffmpeg"), { recursive: true, force: true });
    fs.symlinkSync(path.join(outside, "missing-parent"), path.join(dataDir, "components", "ffmpeg"), "junction");
    assert.throws(() => resolveInstalledExecutable(dataDir, record), /unavailable/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
