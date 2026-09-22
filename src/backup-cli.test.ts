import assert from "node:assert/strict";
import test from "node:test";
import { parseBackupCommand } from "./backup-cli.js";

test("parses explicit offline backup and restore commands", () => {
  assert.deepEqual(parseBackupCommand(["backup", "--data-dir", "data", "--output", "snapshot"]), { action: "backup", dataDir: "data", output: "snapshot" });
  assert.deepEqual(parseBackupCommand(["restore", "--snapshot", "snapshot", "--data-dir", "new-data"]), { action: "restore", snapshot: "snapshot", dataDir: "new-data" });
});

test("rejects ambiguous or incomplete backup commands", () => {
  assert.throws(() => parseBackupCommand(["backup", "--data-dir", "data"]), /--output/);
  assert.throws(() => parseBackupCommand(["restore", "--data-dir", "new-data"]), /--snapshot/);
  assert.throws(() => parseBackupCommand(["backup", "--data-dir", "data", "--output", "snapshot", "--snapshot", "other"]), /does not accept/);
  assert.throws(() => parseBackupCommand(["backup", "--data-dir", "data", "--output"]), /requires a value/);
});
