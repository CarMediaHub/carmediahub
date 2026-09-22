import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackupSnapshot, verifyBackupSnapshot } from "./backup-service.js";

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

test("rejects symbolic links in managed backup directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-backup-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "components"), { recursive: true });
  fs.symlinkSync(path.join(root, "outside"), path.join(dataDir, "components", "link"), "junction");
  assert.throws(() => createBackupSnapshot(dataDir, path.join(root, "snapshot")), /symbolic links/);
});
