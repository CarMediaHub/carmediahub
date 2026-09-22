import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkDeploymentResources } from "./preflight-resources.mjs";

test("checks explicit bundle, config, data parent and free-space requirement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-preflight-"));
  const bundleRoot = path.join(root, "bundle");
  const configPath = path.join(root, "config", "core.json");
  const dataDir = path.join(root, "data", "instance");
  fs.mkdirSync(bundleRoot, { recursive: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, "{}\n");
  assert.deepEqual(checkDeploymentResources({ bundleRoot, configPath, dataDir, requiredFreeBytes: 1024 }, { statfs: () => ({ bavail: 8, bsize: 1024 }) }), { bundleRoot, configPath, dataDir, freeBytes: 8192, requiredFreeBytes: 1024 });
});

test("rejects unavailable paths, insufficient space and relative paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-preflight-invalid-"));
  const bundleRoot = path.join(root, "bundle");
  const configPath = path.join(root, "core.json");
  fs.mkdirSync(bundleRoot);
  fs.writeFileSync(configPath, "{}\n");
  assert.throws(() => checkDeploymentResources({ bundleRoot: "bundleRoot", configPath, dataDir: path.join(root, "data"), requiredFreeBytes: 0 }), /absolute path/);
  assert.throws(() => checkDeploymentResources({ bundleRoot, configPath, dataDir: path.join(root, "data"), requiredFreeBytes: 9000 }, { statfs: () => ({ bavail: 8, bsize: 1024 }) }), /insufficient free space/);
  assert.throws(() => checkDeploymentResources({ bundleRoot, configPath: path.join(root, "missing.json"), dataDir: path.join(root, "data"), requiredFreeBytes: 0 }), /configPath is unavailable/);
});

test("rejects symlinked release and data paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-preflight-link-"));
  const bundle = path.join(root, "bundle");
  const config = path.join(root, "core.json");
  const outside = path.join(root, "outside");
  fs.mkdirSync(bundle);
  fs.mkdirSync(outside);
  fs.writeFileSync(config, "{}\n");
  const linkedBundle = path.join(root, "linked-bundle");
  const linkedConfig = path.join(root, "linked-config.json");
  const linkedDataParent = path.join(root, "linked-data");
  try {
    fs.symlinkSync(bundle, linkedBundle, "junction");
    fs.symlinkSync(config, linkedConfig, "file");
    fs.symlinkSync(outside, linkedDataParent, "junction");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) { t.skip("symlinks are unavailable in this environment"); return; }
    throw error;
  }
  assert.throws(() => checkDeploymentResources({ bundleRoot: linkedBundle, configPath: config, dataDir: path.join(root, "data"), requiredFreeBytes: 0 }), /symbolic link/);
  assert.throws(() => checkDeploymentResources({ bundleRoot: bundle, configPath: linkedConfig, dataDir: path.join(root, "data"), requiredFreeBytes: 0 }), /symbolic link/);
  assert.throws(() => checkDeploymentResources({ bundleRoot: bundle, configPath: config, dataDir: path.join(linkedDataParent, "instance"), requiredFreeBytes: 0 }), /symbolic/);
});
