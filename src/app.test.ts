import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp, filterGatewayHeaders } from "./app.js";
import { GatewayStreamQuota } from "./gateway-stream-quota.js";
import { openDatabase } from "./database.js";
import { totpCode } from "./security.js";
import { currentPlatformKey } from "./components.js";
import { canonicalPluginManifest } from "./plugin-release.js";
import { canonicalPluginPackageRelease } from "./plugin-package-release.js";

test("gateway forwards only protocol headers and never session or authorization material", () => {
  assert.deepEqual(filterGatewayHeaders({ range: "bytes=0-1", accept: "video/*", cookie: "cmh_session=secret", authorization: "Bearer secret", "x-cmh-device-class": "vehicle", "x-forwarded-for": "127.0.0.1" }), { range: "bytes=0-1", accept: "video/*" });
});

function pluginPackageDigest(root: string): string {
  const files = ["ui/index.html", "worker.js"];
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(`${file}\0${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")}\n`, "utf8");
  return hash.digest("hex");
}

test("bootstraps, authenticates, creates a key, and revokes it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-"));
  const app = await createApp({ dataDir });
  try {
    const home = await app.inject({ method: "GET", url: "/" });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /Initialize Core/);
    const admin = await app.inject({ method: "GET", url: "/admin/" });
    assert.equal(admin.statusCode, 200);
    assert.match(admin.body, /id="root"/);
    const bootstrap = await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple", locale: "en" } });
    assert.equal(bootstrap.statusCode, 201);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers["set-cookie"];
    assert.ok(cookie);
    const preferences = await app.inject({ method: "PATCH", url: "/api/me/preferences", headers: { cookie }, payload: { locale: "ko", timeZone: "Asia/Shanghai", theme: "dark", density: "compact" } });
    assert.equal(preferences.statusCode, 200);
    assert.equal(preferences.json().user.locale, "ko");
    assert.deepEqual({ timeZone: preferences.json().user.timeZone, theme: preferences.json().user.theme, density: preferences.json().user.density }, { timeZone: "Asia/Shanghai", theme: "dark", density: "compact" });
    assert.equal((await app.inject({ method: "PATCH", url: "/api/me/preferences", headers: { cookie }, payload: { locale: "fr" } })).statusCode, 400);
    const unauthenticatedSpeed = await app.inject({ method: "GET", url: "/api/diagnostics/speed/download?bytes=65536" });
    assert.equal(unauthenticatedSpeed.statusCode, 401);
    const invalidSpeed = await app.inject({ method: "GET", url: "/api/diagnostics/speed/download?bytes=1", headers: { cookie } });
    assert.equal(invalidSpeed.statusCode, 400);
    const speed = await app.inject({ method: "GET", url: "/api/diagnostics/speed/download?bytes=65536", headers: { cookie } });
    assert.equal(speed.statusCode, 200);
    assert.equal(speed.headers["cache-control"], "no-store, max-age=0");
    assert.equal(speed.headers["content-length"], "65536");
    assert.equal(Buffer.byteLength(speed.rawPayload), 65536);
    assert.equal((await app.inject({ method: "POST", url: "/api/components", headers: { cookie }, payload: { id: "alist", version: "1.0.0", executable: "alist/alist", checksum: "sha256:test" } })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: "/api/service-bindings", headers: { cookie }, payload: { componentId: "alist", name: "local-alist", endpoint: "http://127.0.0.1:5244" } })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: "/api/service-bindings", headers: { cookie }, payload: { componentId: "alist", name: "Bad", endpoint: "http://user:pass@127.0.0.1:5244/?token=secret" } })).statusCode, 400);
    const bindingId = ((await app.inject({ method: "GET", url: "/api/components", headers: { cookie } })).json().bindings as Array<{ id: string }>)[0]!.id;
    assert.equal((await app.inject({ method: "DELETE", url: `/api/service-bindings/${bindingId}`, headers: { cookie } })).statusCode, 204);
    assert.equal(((await app.inject({ method: "GET", url: "/api/components", headers: { cookie } })).json().bindings as Array<unknown>).length, 0);
    const audit = await app.inject({ method: "GET", url: "/api/audit?limit=10", headers: { cookie } });
    assert.equal(audit.statusCode, 200);
    assert.equal((audit.json().events as Array<{ type: string }>).some((event) => event.type === "serviceBinding.revoked"), true);
    assert.equal((await app.inject({ method: "GET", url: "/api/audit?limit=0", headers: { cookie } })).statusCode, 400);
    const notifications = await app.inject({ method: "GET", url: "/api/notifications?unreadOnly=true", headers: { cookie } });
    assert.equal(notifications.statusCode, 200);
    assert.deepEqual(notifications.json(), { notifications: [] });
    const apps = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
    const management = (apps.json() as { applications: Array<{ id: string; route: string }> }).applications.find((item) => item.route === "/system");
    assert.ok(management);
    const key = await app.inject({ method: "POST", url: "/api/keys", headers: { cookie }, payload: { applicationId: management.id } });
    assert.equal(key.statusCode, 201);
    const issued = key.json() as { id: string; key: string };
    const keyList = await app.inject({ method: "GET", url: "/api/keys", headers: { cookie } });
    assert.equal(keyList.statusCode, 200);
    assert.deepEqual((keyList.json() as { keys: Array<{ id: string; applicationName: string; revokedAt: string | null }> }).keys[0], {
      id: issued.id, applicationName: "Management", route: "/system", applicationId: management.id, expiresAt: null, revokedAt: null,
      createdAt: (keyList.json() as { keys: Array<{ createdAt: string }> }).keys[0].createdAt
    });
    const resolved = await app.inject({ method: "GET", url: `/k/${issued.key}` });
    assert.equal(resolved.statusCode, 302);
    assert.equal(resolved.headers.location, "/system");
    assert.match(String(resolved.headers["set-cookie"]), /cmh_entry=/);
    const revoke = await app.inject({ method: "POST", url: `/api/keys/${issued.id}/revoke`, headers: { cookie } });
    assert.equal(revoke.statusCode, 204);
    const revoked = await app.inject({ method: "GET", url: `/k/${issued.key}`, headers: { cookie } });
    assert.equal(revoked.statusCode, 404);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("rejects absolute managed component executables", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-"));
  const app = await createApp({ dataDir });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const response = await app.inject({ method: "POST", url: "/api/components", headers: { cookie: login.headers["set-cookie"] }, payload: { id: "ffmpeg", version: "1.0.0", executable: "C:/Windows/ffmpeg.exe", checksum: "abc" } });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("installs staged components only from a trusted signed release", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-"));
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  try {
    const artifact = "signed binary";
    fs.mkdirSync(path.join(dataDir, "staging"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "staging", "ffmpeg-signed"), artifact);
    const keyId = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
    const release = { schemaVersion: 1, keyId, componentId: "ffmpeg", version: "7.0.0", artifactId: "ffmpeg-signed", sha256: crypto.createHash("sha256").update(artifact).digest("hex"), platform: currentPlatformKey() };
    const canonical = Buffer.from(JSON.stringify({ artifactId: release.artifactId, componentId: release.componentId, keyId: release.keyId, platform: release.platform, schemaVersion: release.schemaVersion, sha256: release.sha256, version: release.version }), "utf8");
    const signed = { release, signature: crypto.sign(null, canonical, keyPair.privateKey).toString("base64") };
    const app = await createApp({ dataDir, componentTrustKeys: [publicKey] });
    try {
      await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
      const installed = await app.inject({ method: "POST", url: "/api/components/install", headers: { cookie: login.headers["set-cookie"] }, payload: signed });
      assert.equal(installed.statusCode, 201);
      assert.equal(installed.json().component.id, "ffmpeg");
    } finally { await app.close(); }
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("supports TOTP enrollment, second-factor login, and one-time recovery codes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-"));
  const app = await createApp({ dataDir });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const setup = await app.inject({ method: "POST", url: "/api/auth/totp/setup", headers: { cookie } });
    assert.equal(setup.statusCode, 200);
    const secret = setup.json().secret as string;
    const enable = await app.inject({ method: "POST", url: "/api/auth/totp/enable", headers: { cookie }, payload: { code: totpCode(secret) } });
    assert.equal(enable.statusCode, 200);
    const recovery = enable.json().recoveryCodes[0] as string;
    const withoutOtp = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    assert.equal(withoutOtp.json().code, "CMH.AUTH.TOTP_REQUIRED");
    const withRecovery = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple", otp: recovery } });
    assert.equal(withRecovery.statusCode, 200);
    const reused = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple", otp: recovery } });
    assert.equal(reused.json().code, "CMH.AUTH.TOTP_INVALID");
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("administrators manage organization users and revocation invalidates member sessions", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-"));
  const app = await createApp({ dataDir });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const adminLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = adminLogin.headers["set-cookie"];
    const create = await app.inject({ method: "POST", url: "/api/users", headers: { cookie }, payload: { username: "member", password: "another correct horse battery staple" } });
    assert.equal(create.statusCode, 201);
    const member = create.json().user as { id: string; role: string };
    assert.equal(member.role, "member");
    const memberLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "member", password: "another correct horse battery staple" } });
    assert.equal(memberLogin.statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/users", headers: { cookie: memberLogin.headers["set-cookie"] } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: `/api/users/${member.id}/revoke`, headers: { cookie } })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: memberLogin.headers["set-cookie"] } })).statusCode, 401);
    const users = await app.inject({ method: "GET", url: "/api/users", headers: { cookie } });
    assert.equal((users.json().users as Array<{ id: string; revokedAt: string | null }>).find((item) => item.id === member.id)?.revokedAt !== null, true);
    const admin = (users.json().users as Array<{ id: string }>).find((item) => item.id !== member.id);
    assert.ok(admin);
    assert.equal((await app.inject({ method: "POST", url: `/api/users/${admin.id}/revoke`, headers: { cookie } })).statusCode, 409);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("rate limits repeated credential failures and emits secure cookies when configured", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-"));
  const app = await createApp({ dataDir, cookieSecure: true });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "wrong password" } })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "wrong password" } })).statusCode, 429);
    const otherUser = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "unknown", password: "wrong password" } });
    assert.equal(otherUser.statusCode, 401);
    const successful = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" }, remoteAddress: "127.0.0.2" });
    assert.equal(successful.statusCode, 200);
    assert.match(String(successful.headers["set-cookie"]), /Secure/);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("registers SDK-validated plugin installations and disables their application route", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-"));
  const pluginKeyPair = crypto.generateKeyPairSync("ed25519");
  const pluginPublicKey = pluginKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const app = await createApp({ dataDir, pluginTrustKeys: [pluginPublicKey] });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const manifest = { id: "wdr-media", version: "0.1.0", sdk: "^0.1.0", name: { en: "WDR Media", "zh-CN": "WDR", ko: "WDR" }, description: { en: "Media", "zh-CN": "媒体", ko: "미디어" }, category: "official", runtime: "isolated-worker", capabilities: ["db", "history", "events"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" }, ui: { entry: "./ui/index.html", vehicleSupported: true } };
    const pluginKeyId = crypto.createHash("sha256").update(pluginPublicKey).digest("hex").slice(0, 16);
    const release = { keyId: pluginKeyId, manifest, signature: crypto.sign(null, canonicalPluginManifest(manifest), pluginKeyPair.privateKey).toString("base64") };
    const install = await app.inject({ method: "POST", url: "/api/plugins", headers: { cookie }, payload: release });
    assert.equal(install.statusCode, 201);
    const installation = install.json().installation as { id: string; status: string };
    assert.equal(installation.status, "installed");
    const listed = await app.inject({ method: "GET", url: "/api/plugins", headers: { cookie } });
    assert.equal(listed.json().installations.length, 1);
    const scopedJobs = await app.inject({ method: "GET", url: `/api/plugins/${installation.id}/jobs`, headers: { cookie } });
    assert.equal(scopedJobs.statusCode, 200);
    assert.deepEqual(scopedJobs.json().jobs, []);
    assert.equal((await app.inject({ method: "POST", url: `/api/plugins/${installation.id}/disable`, headers: { cookie } })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: `/api/plugins/${installation.id}/jobs`, headers: { cookie } })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } })).json().applications.some((item: { installationId: string }) => item.installationId === installation.id), false);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("admin task center exposes redacted organization jobs and cancels only its organization", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-admin-jobs-"));
  const app = await createApp({ dataDir });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const database = openDatabase(dataDir);
    const user = database.db.prepare("SELECT id, organization_id FROM users LIMIT 1").get() as { id: string; organization_id: string };
    database.db.prepare("INSERT INTO plugin_jobs (id, organization_id, user_id, installation_id, type, payload_json, status, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("job_admin_test", user.organization_id, user.id, "wdr", "media.transcode", JSON.stringify({ secret: "must-not-leak" }), "queued", 0, new Date().toISOString(), new Date().toISOString());
    database.close();
    const listed = await app.inject({ method: "GET", url: "/api/jobs", headers: { cookie } });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().jobs[0].id, "job_admin_test");
    assert.equal("payload" in listed.json().jobs[0], false);
    assert.equal((await app.inject({ method: "POST", url: "/api/jobs/job_admin_test/cancel", headers: { cookie } })).json().job.status, "cancelled");
    assert.equal((await app.inject({ method: "GET", url: "/api/jobs", headers: { cookie: "cmh_session=invalid" } })).statusCode, 401);
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("gateway starts the trusted WDR Worker and writes its response through the single public route", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-"));
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-wdr-media-"));
  fs.writeFileSync(path.join(mediaRoot, "drive.mp4"), "video");
  const pluginKeyPair = crypto.generateKeyPairSync("ed25519");
  const pluginPublicKey = pluginKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const packageRoot = path.resolve(import.meta.dirname, "..", "..", "carmediahub-plugins", "dist", "plugins", "official", "wdr-media", "src");
  const gatewayStreamQuota = new GatewayStreamQuota(1);
  const app = await createApp({ dataDir, pluginTrustKeys: [pluginPublicKey], trustedWorkerPackages: [{ packageId: "wdr-media", packageRoot, workerEntry: "./worker.js" }], gatewayStreamQuota });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const manifest = { id: "wdr-media", version: "0.1.0", sdk: "^0.1.0", name: { en: "WDR Media", "zh-CN": "WDR", ko: "WDR" }, description: { en: "Media", "zh-CN": "媒体", ko: "미디어" }, category: "official", runtime: "isolated-worker", capabilities: ["db", "storage", "media", "history", "events"], routes: [{ path: "/", methods: ["GET"] }, { path: "/stream", methods: ["GET"] }, { path: "/health", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" }, ui: { entry: "./ui/index.html", vehicleSupported: true } };
    const pluginKeyId = crypto.createHash("sha256").update(pluginPublicKey).digest("hex").slice(0, 16);
    const release = { keyId: pluginKeyId, manifest, signature: crypto.sign(null, canonicalPluginManifest(manifest), pluginKeyPair.privateKey).toString("base64") };
    const install = await app.inject({ method: "POST", url: "/api/plugins", headers: { cookie }, payload: release });
    assert.equal(install.statusCode, 201);
    const installationId = (install.json() as { installation: { id: string } }).installation.id;
    const root = await app.inject({ method: "POST", url: "/api/media-roots", headers: { cookie }, payload: { installationId, name: "WDR media", path: mediaRoot } });
    const rootId = root.json().root.id as string;
    const item = (await app.inject({ method: "GET", url: `/api/media-roots/${rootId}/items`, headers: { cookie } })).json().items[0] as { id: string };
    const sessionDatabase = openDatabase(dataDir);
    const session = sessionDatabase.db.prepare("SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1").get() as { id: string };
    sessionDatabase.db.close();
    const heldLease = gatewayStreamQuota.tryAcquire(session.id);
    assert.notEqual(heldLease, undefined);
    const limited = await app.inject({ method: "GET", url: `/apps/wdr-media/${installationId}/health`, headers: { cookie } });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, "CMH.GATEWAY.STREAM_LIMIT");
    heldLease?.release();
    assert.equal((await app.inject({ method: "PATCH", url: "/api/me/preferences", headers: { cookie }, payload: { locale: "ko" } })).statusCode, 200);
    const response = await app.inject({ method: "GET", url: `/apps/wdr-media/${installationId}/health`, headers: { cookie, "x-cmh-device-class": "vehicle", "x-cmh-input": "touch,remote", "x-cmh-viewport-width": "1920", "x-cmh-viewport-height": "1200", "x-cmh-fullscreen": "true", authorization: "Bearer should-not-reach-plugin" } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok", worker: "wdr-media", locale: "ko", entry: "navigation", display: { deviceClass: "vehicle", input: ["touch", "remote"], fullscreenAvailable: true, viewport: { width: 1920, height: 1200 } } });
    const invalid = await app.inject({ method: "GET", url: `/apps/wdr-media/${installationId}/health`, headers: { cookie, "x-cmh-device-class": "tablet", "x-cmh-input": "token", "x-cmh-viewport-width": "-1", "x-cmh-viewport-height": "99999", "x-cmh-fullscreen": "yes" } });
    assert.deepEqual(invalid.json().display, { deviceClass: "unknown", input: [], fullscreenAvailable: false, viewport: { width: 0, height: 0 } });
    const applications = (await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } })).json().applications as Array<{ id: string; installationId: string }>;
    const key = await app.inject({ method: "POST", url: "/api/keys", headers: { cookie }, payload: { applicationId: applications.find((item) => item.installationId === installationId)?.id } });
    const entry = await app.inject({ method: "GET", url: `/k/${key.json().key}` });
    const entryCookie = String(entry.headers["set-cookie"]).split(";", 1)[0];
    const keyed = await app.inject({ method: "GET", url: `/apps/wdr-media/${installationId}/health`, headers: { cookie: `${cookie}; ${entryCookie}` } });
    assert.equal(keyed.json().entry, "key");
    const stream = await app.inject({ method: "GET", url: `/apps/wdr-media/${installationId}/stream?id=${item.id}`, headers: { cookie, range: "bytes=1-3" } });
    assert.equal(stream.statusCode, 206);
    assert.equal(stream.headers["content-range"], "bytes 1-3/5");
    assert.equal(stream.body, "ide");
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(mediaRoot, { recursive: true, force: true });
  }
});

test("administrator installs only a signed staged plugin package", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-"));
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const source = path.join(dataDir, "staging", "plugins", "wdr-build");
  fs.mkdirSync(path.join(source, "ui"), { recursive: true });
  fs.writeFileSync(path.join(source, "worker.js"), "export {};\n");
  fs.writeFileSync(path.join(source, "ui", "index.html"), "<main></main>\n");
  const app = await createApp({ dataDir, pluginTrustKeys: [publicKey] });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const manifest = { id: "wdr-media", version: "0.1.0", sdk: "^0.1.0", name: { en: "WDR", "zh-CN": "WDR", ko: "WDR" }, description: { en: "Media", "zh-CN": "媒体", ko: "미디어" }, category: "official", runtime: "isolated-worker", capabilities: ["db"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const;
    const keyId = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
    const unsigned = { keyId, manifest, artifact: { id: "wdr-build", digest: pluginPackageDigest(source) } };
    const release = { ...unsigned, signature: crypto.sign(null, canonicalPluginPackageRelease(unsigned), pair.privateKey).toString("base64") };
    const response = await app.inject({ method: "POST", url: "/api/plugins/packages/install", headers: { cookie: login.headers["set-cookie"] }, payload: release });
    assert.equal(response.statusCode, 201);
    assert.match(response.json().package.location, /^plugins\/wdr-media\/0\.1\.0\//);
    await app.close();
    const restarted = await createApp({ dataDir, pluginTrustKeys: [publicKey] });
    await restarted.close();
  } finally {
    if (app.server.listening) await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("administrator manages Core-owned media roots without exposing their paths", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-"));
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-media-"));
  fs.writeFileSync(path.join(mediaRoot, "trip.mp4"), "video");
  const app = await createApp({ dataDir });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const created = await app.inject({ method: "POST", url: "/api/media-roots", headers: { cookie: login.headers["set-cookie"] }, payload: { installationId: "core-management", name: "Road media", path: mediaRoot } });
    assert.equal(created.statusCode, 201);
    assert.doesNotMatch(created.body, new RegExp(mediaRoot.replace(/[\\/]/gu, "[\\\\/]")));
    const rootId = created.json().root.id as string;
    const items = await app.inject({ method: "GET", url: `/api/media-roots/${rootId}/items`, headers: { cookie: login.headers["set-cookie"] } });
    assert.deepEqual(items.json().items.map((item: { title: string }) => item.title), ["trip.mp4"]);
    assert.equal((await app.inject({ method: "POST", url: `/api/media-roots/${rootId}/revoke`, headers: { cookie: login.headers["set-cookie"] } })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: `/api/media-roots/${rootId}/items`, headers: { cookie: login.headers["set-cookie"] } })).statusCode, 404);
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(mediaRoot, { recursive: true, force: true }); }
});
