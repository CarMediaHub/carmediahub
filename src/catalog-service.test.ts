import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./database.js";
import { CatalogService } from "./catalog-service.js";

test("persists catalog entries inside the current user and installation scope", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-catalog-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', 'now', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Default'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('a', 'org', 'a', 'hash', 'member', 'en', 'now'), ('b', 'org', 'b', 'hash', 'member', 'en', 'now');");
    const catalog = new CatalogService(database.db);
    const base = { deploymentId: "dep", organizationId: "org", deviceId: "device", sessionId: "session" };
    const first = { ...base, userId: "a", installationId: "wdr" };
    const otherUser = { ...base, userId: "b", installationId: "wdr" };
    const entry = catalog.register(first, { subjectType: "media", subjectId: "one", title: "Road trip", category: "video", route: "/stream" });
    assert.equal(catalog.query(first, { keyword: "road" })[0]?.id, entry.id);
    assert.deepEqual(catalog.query(otherUser), []);
    assert.equal(catalog.queryUser("org", "a", { keyword: "road" })[0]?.id, entry.id);
    catalog.register(first, { subjectType: "media", subjectId: "two", title: "Unrelated", category: "video", route: "/other" });
    catalog.register(first, { subjectType: "media", subjectId: "three", title: "Road second", category: "video", route: "/road-two" });
    assert.equal(catalog.query(first, { keyword: "road", limit: 1 }).length, 1);
    assert.equal(catalog.queryUserPage("org", "a", { keyword: "road", limit: 1, offset: 1 }).total, 2);
    assert.equal(catalog.queryUserPage("org", "a", { keyword: "road", limit: 1, offset: 1 }).entries.length, 1);
    assert.deepEqual(catalog.queryUser("org", "b"), []);
    assert.equal(catalog.remove(otherUser, entry.id), false);
    assert.equal(catalog.remove(first, entry.id), true);
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
