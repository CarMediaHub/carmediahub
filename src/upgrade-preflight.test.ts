import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackupSnapshot } from "./backup-service.js";
import { openDatabase, CORE_SCHEMA_VERSION } from "./database.js";
import { checkUpgradePreflight } from "./upgrade-preflight.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-upgrade-preflight-"));
  const dataDir = path.join(root, "data");
  const bundleRoot = path.join(root, "bundle");
  fs.mkdirSync(bundleRoot);
  const database = openDatabase(dataDir);
  database.close();
  const snapshot = path.join(root, "snapshot");
  createBackupSnapshot(dataDir, snapshot);
  return { root, dataDir, bundleRoot, snapshot };
}

test("accepts a matching snapshot and compatible target schema", () => {
  const input = fixture();
  const result = checkUpgradePreflight({ ...input, targetBundleVersion: "0.2.0", targetSchemaVersion: CORE_SCHEMA_VERSION });
  assert.equal(result.bundleRoot, input.bundleRoot);
  assert.equal(result.dataDir, input.dataDir);
  assert.equal(result.snapshot, input.snapshot);
  assert.deepEqual({ ...result, snapshotCreatedAt: undefined }, {
    bundleRoot: input.bundleRoot,
    dataDir: input.dataDir,
    snapshot: input.snapshot,
    currentSchemaVersion: CORE_SCHEMA_VERSION,
    targetSchemaVersion: CORE_SCHEMA_VERSION,
    targetBundleVersion: "0.2.0",
    snapshotCreatedAt: undefined
  });
  assert.match(result.snapshotCreatedAt, /^\d{4}-/u);
});

test("rejects a newer database schema and a changed database", () => {
  const input = fixture();
  const database = openDatabase(input.dataDir);
  database.db.exec("PRAGMA user_version = 2");
  database.close();
  assert.throws(() => checkUpgradePreflight({ ...input, targetBundleVersion: "0.2.0", targetSchemaVersion: 1 }), /newer than target support/);

  const changed = fixture();
  const changedDb = openDatabase(changed.dataDir);
  changedDb.db.prepare("INSERT INTO deployments (id, created_at, locale) VALUES (?, ?, ?)").run("deployment", new Date().toISOString(), "en");
  changedDb.close();
  assert.throws(() => checkUpgradePreflight({ ...changed, targetBundleVersion: "0.2.0", targetSchemaVersion: CORE_SCHEMA_VERSION }), /does not match current data/);
});

test("rejects a snapshot inside the data directory", () => {
  const input = fixture();
  const nestedSnapshot = path.join(input.dataDir, "snapshot");
  fs.cpSync(input.snapshot, nestedSnapshot, { recursive: true });
  assert.throws(() => checkUpgradePreflight({ ...input, snapshot: nestedSnapshot, targetBundleVersion: "0.2.0", targetSchemaVersion: CORE_SCHEMA_VERSION }), /outside data directory/);
});
