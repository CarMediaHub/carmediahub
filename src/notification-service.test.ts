import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./database.js";
import { NotificationService } from "./notification-service.js";

test("notifications persist and stay isolated by user and installation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-notification-"));
  const database = openDatabase(dataDir);
  try {
    database.db.prepare("INSERT INTO deployments (id, created_at, locale) VALUES (?, ?, ?)").run("deployment", new Date().toISOString(), "en");
    database.db.prepare("INSERT INTO organizations (id, deployment_id, name) VALUES (?, ?, ?)").run("org", "deployment", "Organization");
    database.db.prepare("INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("user-a", "org", "a", "hash", "admin", "en", new Date().toISOString());
    const service = new NotificationService(database.db);
    const first = service.publish({ organizationId: "org", userId: "user-a", installationId: "plugin-a" }, { severity: "info", title: "Ready" });
    assert.equal(service.list({ organizationId: "org", userId: "user-a", installationId: "plugin-a" }).length, 1);
    assert.deepEqual(service.list({ organizationId: "org", userId: "user-a", installationId: "plugin-b" }), []);
    assert.deepEqual(service.listUser("org", "user-a")[0]?.id, first.id);
    assert.equal(service.markRead({ organizationId: "org", userId: "user-a", installationId: "plugin-a" }, first.id), true);
    assert.equal(service.list({ organizationId: "org", userId: "user-a", installationId: "plugin-a" }, { unreadOnly: true }).length, 0);
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
