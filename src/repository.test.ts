import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDatabase } from "./database.js";
import { Repository } from "./repository.js";
import { ensureServerKey } from "./security.js";

test("managed component versions require health before activation and preserve rollback history", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-component-rollback-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    repository.registerComponent({ id: "alist", version: "1.0.0", executable: "alist/1.0.0/alist", checksum: `sha256:${"a".repeat(64)}` });
    assert.deepEqual(repository.componentById("alist")?.version, "1.0.0");
    repository.registerComponent({ id: "alist", version: "2.0.0", executable: "alist/2.0.0/alist", checksum: `sha256:${"b".repeat(64)}` });
    assert.deepEqual(repository.componentById("alist")?.version, "1.0.0");
    assert.equal(repository.activateComponentVersion("alist", "2.0.0"), false);
    assert.equal(repository.updateComponentVersionHealth("alist", "2.0.0", "healthy"), true);
    assert.equal(repository.activateComponentVersion("alist", "2.0.0"), true);
    assert.deepEqual(repository.componentById("alist")?.version, "2.0.0");
    assert.equal(repository.updateComponentVersionHealth("alist", "1.0.0", "healthy"), true);
    assert.equal(repository.activateComponentVersion("alist", "1.0.0"), true);
    assert.deepEqual(repository.componentById("alist")?.version, "1.0.0");
    assert.deepEqual(repository.componentVersions("alist").map((item) => item.version).sort(), ["1.0.0", "2.0.0"]);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("audit events are scoped to the administrator organization while retaining system events", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-audit-scope-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    const currentUser = database.db.prepare("SELECT id, organization_id FROM users WHERE username = ?").get("admin") as { id: string; organization_id: string };
    database.db.prepare("INSERT INTO deployments (id, created_at, locale) VALUES (?, ?, ?)").run("other-deployment", new Date().toISOString(), "en");
    database.db.prepare("INSERT INTO organizations (id, deployment_id, name) VALUES (?, ?, ?)").run("other-org", "other-deployment", "Other");
    database.db.prepare("INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("other-user", "other-org", "other", "hash", "admin", "en", new Date().toISOString());
    repository.audit(currentUser.id, "audit.current", "current");
    repository.audit("other-user", "audit.other", "other");
    repository.audit(undefined, "audit.system", "system");
    const events = repository.auditEvents({ organizationId: currentUser.organization_id, limit: 20 });
    assert.deepEqual(new Set(events.map((event) => event.type)), new Set(["audit.current", "audit.system"]));
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("rejects component records without a verifiable identity or checksum", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-component-validation-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    const valid = { id: "alist", version: "1.0.0", executable: "alist/alist", checksum: "a".repeat(64) };
    assert.throws(() => repository.registerComponent({ ...valid, id: "../alist" }), /identity/);
    assert.throws(() => repository.registerComponent({ ...valid, version: "latest" }), /identity/);
    assert.throws(() => repository.registerComponent({ ...valid, checksum: "not-a-digest" }), /identity/);
    assert.throws(() => repository.registerComponent({ ...valid, executable: "alist\\alist" }), /relative path/);
    repository.registerComponent(valid);
    assert.equal(repository.componentById("alist")?.version, "1.0.0");
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("entry key revocation is restricted to its owning user", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-entry-key-scope-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    const admin = repository.bootstrap("admin", "correct horse battery staple", "en");
    const member = repository.createUser({ organizationId: admin.organizationId, username: "member", password: "correct horse battery staple", role: "member", locale: "en" });
    const application = repository.applications().find((item) => item.route === "/system");
    assert.ok(application);
    const issued = repository.createEntryKey(application.id, admin.id);
    assert.equal(repository.revokeEntryKey(issued.id, member.id), false);
    assert.equal(repository.resolveEntryKey(issued.key)?.userId, admin.id);
    assert.equal(repository.revokeEntryKey(issued.id, admin.id), true);
    assert.equal(repository.resolveEntryKey(issued.key), undefined);
    assert.equal(repository.revokeEntryKey(issued.id, admin.id), false);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("entry key expiry requires a future canonical UTC timestamp", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-entry-key-expiry-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    const admin = repository.bootstrap("admin", "correct horse battery staple", "en");
    const application = repository.applications().find((item) => item.route === "/system");
    assert.ok(application);
    assert.throws(() => repository.createEntryKey(application.id, admin.id, "tomorrow"), /expiry/);
    assert.throws(() => repository.createEntryKey(application.id, admin.id, new Date(Date.now() - 1000).toISOString()), /expiry/);
    const issued = repository.createEntryKey(application.id, admin.id, new Date(Date.now() + 60_000).toISOString());
    assert.equal(repository.resolveEntryKey(issued.key)?.userId, admin.id);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("application registration rejects missing or inactive plugin installations", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-application-scope-"));
  const database = openDatabase(dataDir);
  const repository = new Repository(database.db, Buffer.alloc(32, 7));
  try {
    repository.bootstrap("admin", "correct horse battery staple", "en");
    assert.throws(() => repository.addApplication({ name: "Orphan", category: "adapter", route: "/apps/orphan", installationId: "plugin_missing", vehicleSupported: false }), /installed plugin/);
    assert.doesNotThrow(() => repository.addApplication({ name: "System", category: "system", route: "/apps/system-extra", installationId: "core-management", vehicleSupported: false }));
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("revoking a user also revokes the user's entry keys", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-revoke-entry-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, Buffer.alloc(32, 7));
    const admin = repository.bootstrap("admin", "correct horse battery staple", "en");
    const member = repository.createUser({ organizationId: admin.organizationId, username: "member", password: "correct horse battery staple", role: "member", locale: "en" });
    const application = repository.applications().find((item) => item.route === "/system");
    assert.ok(application);
    const issued = repository.createEntryKey(application.id, member.id);
    assert.ok(repository.resolveEntryKey(issued.key));
    assert.equal(repository.revokeUser(member.id, admin.organizationId), "revoked");
    assert.equal(repository.resolveEntryKey(issued.key), undefined);
    assert.equal(repository.entryKeys(member.id)[0]?.revokedAt !== null, true);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("entry keys cannot be issued to a revoked user", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-entry-revoked-user-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, Buffer.alloc(32, 8));
    const admin = repository.bootstrap("admin", "correct horse battery staple", "en");
    const member = repository.createUser({ organizationId: admin.organizationId, username: "member", password: "correct horse battery staple", role: "member", locale: "en" });
    const application = repository.applications().find((item) => item.route === "/system");
    assert.ok(application);
    assert.equal(repository.revokeUser(member.id, admin.organizationId), "revoked");
    assert.throws(() => repository.createEntryKey(application.id, member.id), /User is unavailable/);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("password change verifies the old password and revokes other sessions", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-password-change-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    const admin = repository.bootstrap("admin", "old password 123", "en");
    const first = repository.login("admin", "old password 123", "desktop");
    const second = repository.login("admin", "old password 123", "vehicle");
    assert.ok(first && typeof first !== "string" && second && typeof second !== "string");
    const current = repository.sessionContext(first.token);
    assert.ok(current);
    assert.equal(repository.changePassword(admin.id, "wrong password 123", "new password 123", current.sessionId), false);
    assert.equal(repository.changePassword(admin.id, "old password 123", "new password 123", current.sessionId), true);
    assert.ok(repository.login("admin", "new password 123", "new-device"));
    assert.equal(repository.session(second.token), undefined);
    assert.ok(repository.session(first.token));
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("verified plugin package records retain multiple versions", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-plugin-package-versions-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    const base = { packageId: "example-plugin", digest: "a".repeat(64), location: "plugins/example-plugin/", workerEntry: "./worker.js" } as const;
    repository.registerVerifiedPluginPackage({ ...base, packageVersion: "1.0.0" });
    repository.registerVerifiedPluginPackage({ ...base, packageVersion: "1.1.0", location: "plugins/example-plugin/1.1.0/" });
    assert.deepEqual(repository.verifiedPluginPackages().map((item) => item.packageVersion).sort(), ["1.0.0", "1.1.0"]);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("plugin upgrade keeps installation identity and data scope", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-plugin-upgrade-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    const manifest = { id: "upgrade-plugin", version: "1.0.0", sdk: "^0.1.0", name: { en: "Upgrade", "zh-CN": "升级", ko: "업그레이드" }, description: { en: "Upgrade", "zh-CN": "升级", ko: "업그레이드" }, category: "official", runtime: "isolated-worker", capabilities: ["history"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const;
    const installation = repository.installPlugin(manifest);
    repository.registerVerifiedPluginPackage({ packageId: manifest.id, packageVersion: "2.0.0", digest: "b".repeat(64), location: "plugins/upgrade-plugin/2.0.0/hash", workerEntry: "./worker.js" });
    const upgraded = repository.upgradePlugin(installation.id, { ...manifest, version: "2.0.0", capabilities: ["history", "media"] });
    assert.equal(upgraded?.id, installation.id);
    assert.equal(upgraded?.packageVersion, "2.0.0");
    assert.deepEqual(repository.pluginCapabilities(installation.id), ["history"]);
    assert.equal(repository.applications().filter((app) => app.installationId === installation.id).length, 1);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("plugin rollback restores the previous manifest and grants", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-plugin-rollback-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    const previous = { id: "rollback-plugin", version: "1.0.0", sdk: "^0.1.0", name: { en: "Rollback", "zh-CN": "回滚", ko: "롤백" }, description: { en: "Rollback", "zh-CN": "回滚", ko: "롤백" }, category: "official", runtime: "isolated-worker", capabilities: ["history"], routes: [{ path: "/health", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const;
    const installation = repository.installPlugin(previous);
    repository.registerVerifiedPluginPackage({ packageId: previous.id, packageVersion: "2.0.0", digest: "b".repeat(64), location: "plugins/rollback-plugin/2.0.0/hash", workerEntry: "./worker.js" });
    repository.upgradePlugin(installation.id, { ...previous, version: "2.0.0", name: { ...previous.name, en: "Broken" } });
    assert.equal(repository.pluginManifest(installation.id)?.version, "2.0.0");
    const restored = repository.rollbackPlugin(installation.id, previous, ["history"]);
    assert.equal(restored?.packageVersion, "1.0.0");
    assert.equal(repository.pluginManifest(installation.id)?.name.en, "Rollback");
    assert.deepEqual(repository.pluginCapabilities(installation.id), ["history"]);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("expired browser sessions cancel queued tasks during reconciliation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-browser-expiry-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    const user = database.db.prepare("SELECT id, organization_id FROM users LIMIT 1").get() as { id: string; organization_id: string };
    const scope = { deploymentId: "dep", organizationId: user.organization_id, userId: user.id, deviceId: "vehicle", sessionId: "session", installationId: "plugin" };
    repository.createBrowserSession(scope, { name: "expiry", purpose: "test", ttlSeconds: 30 });
    const session = repository.browserSessions(scope)[0]!;
    const task = repository.createBrowserTask(scope, { sessionId: session.id, kind: "navigate-and-capture", input: { target: "fixture" } });
    database.db.prepare("UPDATE browser_sessions SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), session.id);
    assert.equal(repository.browserSessions(scope)[0]?.status, "expired");
    assert.equal(repository.browserTasks(scope).find((item) => item.id === task.id)?.status, "cancelled");
    assert.equal(repository.claimBrowserTask(scope), undefined);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("service bindings are scoped to the declared plugin installation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-binding-scope-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    repository.registerComponent({ id: "alist", version: "1.0.0", executable: "alist/alist", checksum: "c".repeat(64) });
    const manifest = { id: "adapter-one", version: "0.1.0", sdk: "^0.1.0", name: { en: "Adapter", "zh-CN": "适配器", ko: "어댑터" }, description: { en: "Adapter", "zh-CN": "适配器", ko: "어댑터" }, category: "adapter", runtime: "isolated-worker", capabilities: ["network"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const;
    const installation = repository.installPlugin(manifest);
    repository.bindService({ componentId: "alist", name: "adapter-one-service", endpoint: "http://127.0.0.1:5244", installationId: installation.id });
    const secondInstallation = repository.installPlugin({ ...manifest, id: "adapter-two" });
    repository.bindService({ componentId: "alist", name: "shared-service-name", endpoint: "http://127.0.0.1:5244", installationId: installation.id });
    repository.bindService({ componentId: "alist", name: "shared-service-name", endpoint: "http://127.0.0.1:5245", installationId: secondInstallation.id });
    assert.deepEqual(repository.serviceBindingByName("shared-service-name", installation.id), { endpoint: "http://127.0.0.1:5244/" });
    assert.deepEqual(repository.serviceBindingByName("shared-service-name", secondInstallation.id), { endpoint: "http://127.0.0.1:5245/" });
    assert.deepEqual(repository.serviceBindingByName("adapter-one-service", installation.id), { endpoint: "http://127.0.0.1:5244/" });
    assert.equal(repository.serviceBindingByName("adapter-one-service", "plugin_other"), undefined);
    assert.throws(() => repository.bindService({ componentId: "unknown", name: "unknown-service", endpoint: "http://127.0.0.1:5244" }), /not registered/);
    assert.throws(() => repository.bindService({ componentId: "alist", name: "disabled-service", endpoint: "http://127.0.0.1:5244", installationId: "plugin_missing" }));
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("plugin bindings prefer an installation override and fall back to a Core global binding", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-binding-fallback-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    repository.registerComponent({ id: "alist", version: "1.0.0", executable: "alist/alist", checksum: "c".repeat(64) });
    repository.bindService({ componentId: "alist", name: "shared-service", endpoint: "http://127.0.0.1:5244" });
    assert.deepEqual(repository.serviceBindingByName("shared-service", "plugin_missing"), undefined);
    const manifest = { id: "adapter-override", version: "0.1.0", sdk: "^0.1.0", name: { en: "Adapter", "zh-CN": "适配器", ko: "어댑터" }, description: { en: "Adapter", "zh-CN": "适配器", ko: "어댑터" }, category: "adapter", runtime: "isolated-worker", capabilities: ["network"], serviceBindings: ["shared-service"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const;
    const installation = repository.installPlugin(manifest);
    repository.bindService({ componentId: "alist", name: "shared-service", endpoint: "http://127.0.0.1:5245", installationId: installation.id });
    assert.deepEqual(repository.serviceBindingByName("shared-service", installation.id), { endpoint: "http://127.0.0.1:5245/" });
    const approvedFallback = repository.installPlugin({ ...manifest, id: "adapter-fallback" });
    assert.deepEqual(repository.serviceBindingByName("shared-service", approvedFallback.id), { endpoint: "http://127.0.0.1:5244/" });
    const unapproved = repository.installPlugin({ ...manifest, id: "adapter-unapproved", serviceBindings: [] });
    assert.deepEqual(repository.serviceBindingByName("shared-service", unapproved.id), undefined);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("capability grants can only be reduced from the manifest declaration", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-capability-grant-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    const installation = repository.installPlugin({ id: "grant-test", version: "0.1.0", sdk: "^0.1.0", name: { en: "Grant", "zh-CN": "授权", ko: "권한" }, description: { en: "Grant", "zh-CN": "授权", ko: "권한" }, category: "official", runtime: "isolated-worker", capabilities: ["media", "history"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } });
    assert.deepEqual(repository.pluginCapabilities(installation.id), ["media", "history"]);
    assert.equal(repository.updatePluginCapabilities(installation.id, ["media"]), true);
    assert.deepEqual(repository.pluginCapabilities(installation.id), ["media"]);
    assert.equal(repository.pluginHasCapability(installation.id, "history"), false);
    assert.equal(repository.updatePluginCapabilities(installation.id, ["network"]), false);
    assert.deepEqual(repository.pluginCapabilities(installation.id), ["media"]);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("browser sessions are opaque, bounded, persistent, and isolated by user and installation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-browser-session-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    const admin = repository.bootstrap("admin", "correct horse battery staple", "en");
    const member = repository.createUser({ organizationId: admin.organizationId, username: "member", password: "correct horse battery staple", role: "member", locale: "en" });
    const manifest = (id: string) => ({ id, version: "0.1.0", sdk: "^0.1.0", name: { en: id, "zh-CN": id, ko: id }, description: { en: id, "zh-CN": id, ko: id }, category: "official", runtime: "isolated-worker", capabilities: ["browser"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const);
    const first = repository.installPlugin(manifest("browser-one"));
    const second = repository.installPlugin(manifest("browser-two"));
    const firstScope = repository.runtimeScope(admin.id, first.id);
    const secondUserScope = repository.runtimeScope(member.id, first.id);
    const secondInstallationScope = repository.runtimeScope(admin.id, second.id);
    assert.ok(firstScope && secondUserScope && secondInstallationScope);
    const session = repository.createBrowserSession(firstScope, { name: "youtube", purpose: "authorized media extraction", expiresInSeconds: 60 });
    assert.match(session.id, /^browser_[0-9a-f-]{36}$/u);
    assert.equal("profilePath" in session, false);
    assert.equal(repository.browserSessions(firstScope).length, 1);
    assert.equal(repository.browserSessions(secondUserScope).length, 0);
    assert.equal(repository.browserSessions(secondInstallationScope).length, 0);
    assert.equal(repository.revokeBrowserSession(secondUserScope, session.id), false);
    assert.equal(repository.revokeBrowserSession(firstScope, session.id), true);
    assert.equal(repository.browserSessions(firstScope)[0]?.status, "revoked");
    assert.throws(() => repository.createBrowserSession(firstScope, { name: "Bad Name", purpose: "x" }));
    assert.throws(() => repository.createBrowserSession(firstScope, { name: "valid", purpose: "x", expiresInSeconds: 5 }));
    const active = repository.createBrowserSession(firstScope, { name: "valid", purpose: "bounded", expiresInSeconds: 60 });
    database.db.prepare("UPDATE browser_sessions SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), active.id);
    assert.equal(repository.browserSessions(firstScope).find((item) => item.id === active.id)?.status, "expired");
    const persisted = repository.createBrowserSession(firstScope, { name: "persisted", purpose: "restart check" });
    const task = repository.createBrowserTask(firstScope, { sessionId: persisted.id, kind: "navigate-and-capture", input: { target: "fixture", label: "Restart" } });
    assert.equal(task.status, "queued");
    assert.equal(repository.revokeBrowserSession(firstScope, persisted.id), true);
    assert.equal(repository.browserTasks(firstScope).find((item) => item.id === task.id)?.status, "cancelled");
    const persistedReplacement = repository.createBrowserSession(firstScope, { name: "persisted-replacement", purpose: "restart check" });
    const replacementTask = repository.createBrowserTask(firstScope, { sessionId: persistedReplacement.id, kind: "navigate-and-capture", input: { target: "fixture" } });
    assert.equal(repository.browserTasks(secondUserScope).length, 0);
    assert.equal(repository.cancelBrowserTask(secondUserScope, replacementTask.id), undefined);
    database.close();
    const reopened = openDatabase(dataDir);
    try {
      const afterRestart = new Repository(reopened.db, ensureServerKey(dataDir));
      const restoredScope = afterRestart.runtimeScope(admin.id, first.id);
      assert.ok(restoredScope);
      assert.equal(afterRestart.browserSessions(restoredScope).some((item) => item.id === persistedReplacement.id), true);
      assert.equal(afterRestart.browserTasks(restoredScope).some((item) => item.id === replacementTask.id), true);
      assert.equal(afterRestart.disablePlugin(first.id), true);
      assert.equal(afterRestart.browserSessions(restoredScope).find((item) => item.id === persistedReplacement.id)?.status, "revoked");
      assert.equal(afterRestart.browserTasks(restoredScope).find((item) => item.id === replacementTask.id)?.status, "cancelled");
    } finally { reopened.close(); }
  } finally { try { database.close(); } catch {} fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("disabled plugin installations can be re-enabled without changing their grants", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-plugin-enable-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    const admin = repository.bootstrap("admin", "correct horse battery staple", "en");
    const installation = repository.installPlugin({ id: "enable-test", version: "0.1.0", sdk: "^0.1.0", name: { en: "Enable", "zh-CN": "启用", ko: "활성화" }, description: { en: "Enable", "zh-CN": "启用", ko: "활성화" }, category: "official", runtime: "isolated-worker", capabilities: ["history"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } });
    const application = repository.applications().find((item) => item.installationId === installation.id);
    assert.ok(application);
    const issued = repository.createEntryKey(application.id, admin.id);
    assert.ok(repository.resolveEntryKey(issued.key));
    assert.equal(repository.disablePlugin(installation.id), true);
    assert.equal(repository.pluginInstallation(installation.id)?.status, "disabled");
    assert.equal(repository.resolveEntryKey(issued.key), undefined);
    assert.equal(repository.enablePlugin(installation.id), true);
    assert.equal(repository.pluginInstallation(installation.id)?.status, "installed");
    assert.deepEqual(repository.pluginCapabilities(installation.id), ["history"]);
    assert.equal(repository.resolveEntryKey(issued.key), undefined);
    assert.equal(repository.entryKeys(admin.id).find((item) => item.id === issued.id)?.revokedAt !== null, true);
    assert.equal(repository.enablePlugin(installation.id), false);
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("uninstall revokes remote media sources for the disabled installation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-plugin-uninstall-sources-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    const admin = repository.bootstrap("admin", "correct horse battery staple", "en");
    const installation = repository.installPlugin({ id: "uninstall-source-test", version: "0.1.0", sdk: "^0.1.0", name: { en: "Uninstall", "zh-CN": "卸载", ko: "제거" }, description: { en: "Uninstall", "zh-CN": "卸载", ko: "제거" }, category: "official", runtime: "isolated-worker", capabilities: ["media-source"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } });
    database.db.prepare("INSERT INTO remote_media_sources (id, organization_id, user_id, installation_id, name, binding, root_path, source_handle, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("remote_source_test", admin.organizationId, admin.id, installation.id, "Source", "webdav", "/media", `remote_source_${"a".repeat(43)}`, new Date().toISOString());
    assert.equal(repository.disablePlugin(installation.id), true);
    assert.equal(repository.uninstallPlugin(installation.id), true);
    const row = database.db.prepare("SELECT revoked_at FROM remote_media_sources WHERE id = ?").get("remote_source_test") as { revoked_at?: string | null } | undefined;
    assert.equal(typeof row?.revoked_at, "string");
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("migrates legacy global binding names to scoped uniqueness", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-binding-migration-"));
  const legacy = new DatabaseSync(path.join(dataDir, "carmediahub.sqlite"));
  legacy.exec(`CREATE TABLE managed_components (id TEXT PRIMARY KEY, version TEXT NOT NULL, executable TEXT NOT NULL, checksum TEXT NOT NULL, installed_at TEXT NOT NULL, health TEXT NOT NULL);
    CREATE TABLE service_bindings (id TEXT PRIMARY KEY, component_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE, endpoint TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO managed_components VALUES ('alist', '1.0.0', 'alist/alist', 'sha256:test', '2026-01-01T00:00:00.000Z', 'unknown');
    INSERT INTO service_bindings VALUES ('binding_legacy', 'alist', 'legacy-service', 'http://127.0.0.1:5244/', '2026-01-01T00:00:00.000Z');`);
  legacy.close();
  const database = openDatabase(dataDir);
  try {
    const columns = database.db.prepare("PRAGMA table_info(service_bindings)").all() as Array<{ name?: string }>;
    assert.ok(columns.some((column) => column.name === "installation_id"));
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    const first = repository.installPlugin({ id: "adapter-one", version: "0.1.0", sdk: "^0.1.0", name: { en: "Adapter", "zh-CN": "适配器", ko: "어댑터" }, description: { en: "Adapter", "zh-CN": "适配器", ko: "어댑터" }, category: "adapter", runtime: "isolated-worker", capabilities: ["network"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } });
    repository.bindService({ componentId: "alist", name: "legacy-service", endpoint: "http://127.0.0.1:5245", installationId: first.id });
    assert.deepEqual(repository.serviceBindingByName("legacy-service", first.id), { endpoint: "http://127.0.0.1:5245/" });
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
