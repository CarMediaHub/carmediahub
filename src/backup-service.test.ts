import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackupSnapshot, restoreBackupSnapshot, verifyBackupSnapshot } from "./backup-service.js";

test("creates and verifies an atomic offline Core snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-backup-"));
  const dataDir = path.join(root, "data");
  const destination = path.join(root, "snapshot");
  fs.mkdirSync(path.join(dataDir, "secrets"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "plugins", "wdr", "1.0.0"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "components"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "carmediahub.sqlite"), "sqlite-state");
  fs.writeFileSync(path.join(dataDir, "carmediahub.sqlite-wal"), "wal-state");
  fs.writeFileSync(path.join(dataDir, "carmediahub.sqlite-shm"), "shm-state");
  fs.writeFileSync(path.join(dataDir, "secrets", "session-hmac.key"), "secret");
  fs.writeFileSync(path.join(dataDir, "plugins", "wdr", "1.0.0", "manifest.json"), "{}\n");
  const manifest = createBackupSnapshot(dataDir, destination);
  assert.equal(manifest.files.length, 5);
  assert.deepEqual(verifyBackupSnapshot(destination), manifest);
  assert.equal(fs.existsSync(`${destination}.tmp`), false);
  const restored = path.join(root, "restored");
  restoreBackupSnapshot(destination, restored);
  assert.equal(fs.readFileSync(path.join(restored, "carmediahub.sqlite"), "utf8"), "sqlite-state");
  assert.equal(fs.readFileSync(path.join(restored, "plugins", "wdr", "1.0.0", "manifest.json"), "utf8"), "{}\n");
});

test("rejects destination inside data and detects snapshot tampering", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-backup-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "carmediahub.sqlite"), "state");
  assert.throws(() => createBackupSnapshot(dataDir, path.join(dataDir, "backup")), /outside data directory/);
  const destination = path.join(root, "snapshot");
  createBackupSnapshot(dataDir, destination);
  fs.writeFileSync(path.join(destination, "carmediahub.sqlite"), "tampered");
  assert.throws(() => verifyBackupSnapshot(destination), /digest mismatch/);
});

test("rejects restore into an existing non-empty data directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-backup-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "carmediahub.sqlite"), "state");
  const snapshot = path.join(root, "snapshot");
  createBackupSnapshot(dataDir, snapshot);
  const target = path.join(root, "target");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "existing"), "keep");
  assert.throws(() => restoreBackupSnapshot(snapshot, target), /new empty directory/);
  assert.throws(() => restoreBackupSnapshot(snapshot, path.join(snapshot, "restored")), /outside snapshot/);
});

test("rejects manifest paths outside the managed state allowlist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-backup-"));
  const snapshot = path.join(root, "snapshot");
  fs.mkdirSync(snapshot, { recursive: true });
  fs.writeFileSync(path.join(snapshot, "carmediahub.sqlite"), "state");
  fs.writeFileSync(path.join(snapshot, "backup-manifest.json"), JSON.stringify({ schemaVersion: 1, product: "carmediahub-core", source: "offline-snapshot", createdAt: new Date().toISOString(), files: [{ path: "unexpected.txt", bytes: 5, sha256: "0".repeat(64) }] }));
  assert.throws(() => verifyBackupSnapshot(snapshot), /manifest file entry is invalid/);
});

test("rejects symbolic links in managed backup directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-backup-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "components"), { recursive: true });
  fs.symlinkSync(path.join(root, "outside"), path.join(dataDir, "components", "link"), "junction");
  assert.throws(() => createBackupSnapshot(dataDir, path.join(root, "snapshot")), /symbolic links/);
});
