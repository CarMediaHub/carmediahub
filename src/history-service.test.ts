import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./database.js";
import { HistoryService } from "./history-service.js";

test("persists history inside the current user and installation scope", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-history-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', 'now', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Default'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('a', 'org', 'a', 'hash', 'member', 'en', 'now'), ('b', 'org', 'b', 'hash', 'member', 'en', 'now');");
    const history = new HistoryService(database.db);
    const base = { deploymentId: "dep", organizationId: "org", deviceId: "device", sessionId: "session" };
    const first = { ...base, userId: "a", installationId: "wdr" };
    const otherUser = { ...base, userId: "b", installationId: "wdr" };
    const otherPlugin = { ...base, userId: "a", installationId: "other" };
    history.record(first, { subjectType: "media", subjectId: "one", route: "/stream", title: "Road trip", category: "video", sourceDevice: "vehicle" });
    assert.equal(history.query(first, { keyword: "road" }).length, 1);
    assert.equal(history.query(otherUser).length, 0);
    assert.equal(history.query(otherPlugin).length, 0);
    assert.equal(history.queryUser("org", "a", { keyword: "road" }).length, 1);
    assert.equal(history.queryUser("org", "b").length, 0);
    assert.equal(history.clear(first, { category: "audio" }), 0);
    assert.equal(history.clear(first, { category: "video" }), 1);
    assert.equal(history.query(first).length, 0);
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
