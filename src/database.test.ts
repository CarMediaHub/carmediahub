import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CORE_SCHEMA_VERSION, openDatabase } from "./database.js";

test("records the current Core schema version after initialization", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-schema-version-"));
  const database = openDatabase(dataDir);
  assert.equal((database.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, CORE_SCHEMA_VERSION);
  database.close();
});

test("rejects a database created by a newer Core", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-schema-future-"));
  const sqlite = new DatabaseSync(path.join(dataDir, "carmediahub.sqlite"));
  sqlite.exec(`PRAGMA user_version = ${CORE_SCHEMA_VERSION + 1}`);
  sqlite.close();
  assert.throws(() => openDatabase(dataDir), /Unsupported Core database schema version/);
});
