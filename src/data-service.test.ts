import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./database.js";
import { createPluginDataStore, deletePluginData, exportPluginData } from "./data-service.js";

test("persistent plugin data is isolated by user and installation", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-data-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('deployment', '2026-01-01T00:00:00.000Z', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'deployment', 'Organization'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user-a', 'org', 'a', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z'), ('user-b', 'org', 'b', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z');");
    const base = { deploymentId: "deployment", organizationId: "org", deviceId: "device", sessionId: "session" };
    const first = createPluginDataStore(database.db, { ...base, userId: "user-a", installationId: "wdr" });
    const otherUser = createPluginDataStore(database.db, { ...base, userId: "user-b", installationId: "wdr" });
    const otherInstallation = createPluginDataStore(database.db, { ...base, userId: "user-a", installationId: "other" });
    await first.put("history", "road-trip", { position: 42 });
    const migration = await first.migrate({ version: 1, name: "initial-history" });
    assert.deepEqual(await first.migrations(), [migration]);
    assert.deepEqual(await first.migrate({ version: 1, name: "initial-history" }), migration);
    await assert.rejects(() => first.migrate({ version: 1, name: "other" }));
    assert.deepEqual((await first.get("history", "road-trip"))?.value, { position: 42 });
    assert.equal(await otherUser.get("history", "road-trip"), undefined);
    assert.equal(await otherInstallation.get("history", "road-trip"), undefined);
    assert.equal(await first.delete("history", "road-trip"), true);
    assert.equal(await first.get("history", "road-trip"), undefined);
    const exported = exportPluginData(database.db, { ...base, userId: "user-a", installationId: "wdr" });
    assert.deepEqual(exported.collections, []);
    await first.put("settings", "layout", { compact: true });
    const withData = exportPluginData(database.db, { ...base, userId: "user-a", installationId: "wdr" });
    assert.deepEqual(withData.collections[0], { name: "settings", records: [{ key: "layout", value: { compact: true }, updatedAt: withData.collections[0]?.records[0]?.updatedAt }] });
    await first.put("settings", "part_alpha", { value: 1 });
    await first.put("settings", "part-beta", { value: 2 });
    assert.deepEqual((await first.list("settings", { prefix: "part_" })).map((record) => record.key), ["part_alpha"]);
    assert.equal(deletePluginData(database.db, { ...base, userId: "user-a", installationId: "wdr" }), 3);
    assert.deepEqual(exportPluginData(database.db, { ...base, userId: "user-a", installationId: "wdr" }).collections, []);
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
