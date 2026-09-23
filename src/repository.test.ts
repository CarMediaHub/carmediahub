import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDatabase } from "./database.js";
import { Repository } from "./repository.js";
import { ensureServerKey } from "./security.js";

test("service bindings are scoped to the declared plugin installation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-binding-scope-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    repository.registerComponent({ id: "alist", version: "1.0.0", executable: "alist/alist", checksum: "sha256:test" });
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
    assert.throws(() => repository.bindService({ componentId: "alist", name: "disabled-service", endpoint: "http://127.0.0.1:5244", installationId: "plugin_missing" }));
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("plugin bindings prefer an installation override and fall back to a Core global binding", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-binding-fallback-"));
  const database = openDatabase(dataDir);
  try {
    const repository = new Repository(database.db, ensureServerKey(dataDir));
    repository.bootstrap("admin", "correct horse battery staple", "en");
    repository.registerComponent({ id: "alist", version: "1.0.0", executable: "alist/alist", checksum: "sha256:test" });
    repository.bindService({ componentId: "alist", name: "shared-service", endpoint: "http://127.0.0.1:5244" });
    assert.deepEqual(repository.serviceBindingByName("shared-service", "plugin_missing"), { endpoint: "http://127.0.0.1:5244/" });
    const manifest = { id: "adapter-override", version: "0.1.0", sdk: "^0.1.0", name: { en: "Adapter", "zh-CN": "适配器", ko: "어댑터" }, description: { en: "Adapter", "zh-CN": "适配器", ko: "어댑터" }, category: "adapter", runtime: "isolated-worker", capabilities: ["network"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const;
    const installation = repository.installPlugin(manifest);
    repository.bindService({ componentId: "alist", name: "shared-service", endpoint: "http://127.0.0.1:5245", installationId: installation.id });
    assert.deepEqual(repository.serviceBindingByName("shared-service", installation.id), { endpoint: "http://127.0.0.1:5245/" });
    assert.deepEqual(repository.serviceBindingByName("shared-service", "plugin_other"), { endpoint: "http://127.0.0.1:5244/" });
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
    repository.bootstrap("admin", "correct horse battery staple", "en");
    const installation = repository.installPlugin({ id: "enable-test", version: "0.1.0", sdk: "^0.1.0", name: { en: "Enable", "zh-CN": "启用", ko: "활성화" }, description: { en: "Enable", "zh-CN": "启用", ko: "활성화" }, category: "official", runtime: "isolated-worker", capabilities: ["history"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } });
    assert.equal(repository.disablePlugin(installation.id), true);
    assert.equal(repository.pluginInstallation(installation.id)?.status, "disabled");
    assert.equal(repository.enablePlugin(installation.id), true);
    assert.equal(repository.pluginInstallation(installation.id)?.status, "installed");
    assert.deepEqual(repository.pluginCapabilities(installation.id), ["history"]);
    assert.equal(repository.enablePlugin(installation.id), false);
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
