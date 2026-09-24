import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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
import { BrowserTargetRegistry } from "./browser-target-registry.js";

test("gateway forwards only protocol headers and never session or authorization material", () => {
  assert.deepEqual(filterGatewayHeaders({ range: "bytes=0-1", accept: "video/*", cookie: "cmh_session=secret", authorization: "Bearer secret", "x-cmh-device-class": "vehicle", "x-forwarded-for": "127.0.0.1" }), { range: "bytes=0-1", accept: "video/*" });
});

test("sets security headers for Core-owned responses without imposing CSP on plugin routes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-security-headers-"));
  const app = await createApp({ dataDir });
  try {
    const home = await app.inject({ method: "GET", url: "/" });
    assert.equal(home.headers["x-content-type-options"], "nosniff");
    assert.equal(home.headers["referrer-policy"], "same-origin");
    assert.equal(home.headers["x-frame-options"], "DENY");
    assert.match(String(home.headers["content-security-policy"]), /default-src 'self'/u);
    const plugin = await app.inject({ method: "GET", url: "/apps/example/content" });
    assert.equal(plugin.headers["x-content-type-options"], "nosniff");
    assert.equal(plugin.headers["content-security-policy"], undefined);
  } finally { await app.close(); try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may release a transient SQLite handle after the test tick. */ } }
});

test("exposes safe liveness, readiness, and diagnostic probes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-health-probes-"));
  const app = await createApp({ dataDir });
  try {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { status: "ok", initialized: false });

    const notReady = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(notReady.statusCode, 503);
    assert.deepEqual(notReady.json(), { status: "not_ready", initialized: false });

    const diagnostic = await app.inject({ method: "GET", url: "/health/diagnostic" });
    assert.equal(diagnostic.statusCode, 200);
    assert.deepEqual(diagnostic.json(), { status: "ok", initialized: false, components: { total: 0, healthy: 0, unhealthy: 0 }, plugins: { total: 0, enabled: 0, disabled: 0 } });

    assert.equal((await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple", locale: "fr" } })).statusCode, 400);
    const bootstrap = await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    assert.equal(bootstrap.statusCode, 201);
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: "ok", initialized: true });
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/health" })).json(), ready.json());
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("password change keeps the current HTTP session and revokes other sessions", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-password-http-"));
  const app = await createApp({ dataDir });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "old password 123" } });
    const first = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "old password 123", deviceLabel: "desktop" } });
    const second = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "old password 123", deviceLabel: "vehicle" } });
    const firstCookie = first.headers["set-cookie"];
    const secondCookie = second.headers["set-cookie"];
    const changed = await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: firstCookie }, payload: { currentPassword: "old password 123", newPassword: "new password 123" } });
    assert.equal(changed.statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: firstCookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: secondCookie } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "new password 123" } })).statusCode, 200);
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("component health checks verify the managed file digest without executing it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-component-health-"));
  const executable = path.join(dataDir, "components", "alist", "1.0.0", "alist");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "managed component", "utf8");
  const digest = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  const app = await createApp({ dataDir });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const catalog = await app.inject({ method: "GET", url: "/api/components/catalog", headers: { cookie } });
    assert.equal(catalog.statusCode, 200);
    assert.equal((catalog.json().components as Array<{ executablePath?: string; executable: string }>).some((component) => component.executablePath !== undefined || path.isAbsolute(component.executable)), false);
    assert.equal((await app.inject({ method: "POST", url: "/api/components", headers: { cookie }, payload: { id: "alist", version: "1.0.0", executable: "alist/1.0.0/alist", checksum: `sha256:${digest}` } })).statusCode, 201);
    const healthy = await app.inject({ method: "POST", url: "/api/components/alist/health", headers: { cookie } });
    assert.equal(healthy.statusCode, 200);
    assert.deepEqual(healthy.json().component, { id: "alist", health: "healthy" });
    fs.writeFileSync(executable, "tampered", "utf8");
    assert.deepEqual((await app.inject({ method: "POST", url: "/api/components/alist/health", headers: { cookie } })).json().component, { id: "alist", health: "unhealthy" });
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

function pluginPackageDigest(root: string): string {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(location);
      else if (entry.isFile()) files.push(path.relative(root, location).split(path.sep).join("/"));
    }
  };
  visit(root);
  files.sort();
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
    assert.equal((await app.inject({ method: "POST", url: "/api/users", headers: { cookie }, payload: { username: "invalid-locale", password: "correct horse battery staple", locale: "fr" } })).statusCode, 400);
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
    const upload = await app.inject({ method: "POST", url: "/api/diagnostics/speed/upload", headers: { cookie, "content-type": "application/octet-stream", "content-length": "65536" }, payload: Buffer.alloc(65536, 0) });
    assert.equal(upload.statusCode, 200);
    assert.deepEqual(upload.json(), { bytes: 65536 });
    const oversizedUpload = await app.inject({ method: "POST", url: "/api/diagnostics/speed/upload", headers: { cookie, "content-type": "application/octet-stream", "content-length": "32768" }, payload: Buffer.alloc(32768, 0) });
    assert.equal(oversizedUpload.statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/components", headers: { cookie }, payload: { id: "alist", version: "1.0.0", executable: "alist/alist", checksum: `sha256:${"a".repeat(64)}` } })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: "/api/service-bindings", headers: { cookie }, payload: { componentId: "alist", name: "local-alist", endpoint: "http://127.0.0.1:5244" } })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: "/api/service-bindings", headers: { cookie }, payload: { componentId: "alist", name: "health-check", endpoint: "http://127.0.0.1:1" } })).statusCode, 201);
    const health = await app.inject({ method: "POST", url: "/api/service-bindings/unknown/health", headers: { cookie } });
    assert.equal(health.statusCode, 404);
    const healthBinding = ((await app.inject({ method: "GET", url: "/api/components", headers: { cookie } })).json().bindings as Array<{ id: string; name: string }>).find((binding) => binding.name === "health-check");
    assert.ok(healthBinding);
    const unreachable = await app.inject({ method: "POST", url: `/api/service-bindings/${healthBinding.id}/health`, headers: { cookie } });
    assert.equal(unreachable.statusCode, 503);
    assert.equal(unreachable.json().reachable, false);
    assert.equal((await app.inject({ method: "POST", url: "/api/service-bindings", headers: { cookie }, payload: { componentId: "alist", name: "Bad", endpoint: "http://user:pass@127.0.0.1:5244/?token=secret" } })).statusCode, 400);
    const bindingId = ((await app.inject({ method: "GET", url: "/api/components", headers: { cookie } })).json().bindings as Array<{ id: string }>)[0]!.id;
    assert.equal((await app.inject({ method: "DELETE", url: `/api/service-bindings/${bindingId}`, headers: { cookie } })).statusCode, 204);
    for (const binding of (await app.inject({ method: "GET", url: "/api/components", headers: { cookie } })).json().bindings as Array<{ id: string }>) {
      await app.inject({ method: "DELETE", url: `/api/service-bindings/${binding.id}`, headers: { cookie } });
    }
    assert.equal(((await app.inject({ method: "GET", url: "/api/components", headers: { cookie } })).json().bindings as Array<unknown>).length, 0);
    const audit = await app.inject({ method: "GET", url: "/api/audit?limit=10", headers: { cookie } });
    assert.equal(audit.statusCode, 200);
    assert.equal((audit.json().events as Array<{ type: string }>).some((event) => event.type === "serviceBinding.revoked"), true);
    assert.equal((await app.inject({ method: "GET", url: "/api/audit?type=serviceBinding.revoked", headers: { cookie } })).json().events.every((event: { type: string }) => event.type === "serviceBinding.revoked"), true);
    assert.equal((await app.inject({ method: "GET", url: "/api/audit?keyword=local-alist", headers: { cookie } })).json().events.length > 0, true);
    const exported = await app.inject({ method: "GET", url: "/api/audit?type=serviceBinding.revoked&format=csv", headers: { cookie } });
    assert.equal(exported.statusCode, 200);
    assert.match(String(exported.headers["content-type"]), /text\/csv/);
    assert.match(String(exported.headers["content-disposition"]), /car-media-hub-audit\.csv/);
    assert.match(exported.body, /serviceBinding\.revoked/);
    assert.equal((await app.inject({ method: "GET", url: "/api/audit?limit=0", headers: { cookie } })).statusCode, 400);
    const notifications = await app.inject({ method: "GET", url: "/api/notifications?unreadOnly=true", headers: { cookie } });
    assert.equal(notifications.statusCode, 200);
    assert.deepEqual(notifications.json(), { notifications: [] });
    assert.equal((await app.inject({ method: "GET", url: "/api/history?limit=0", headers: { cookie } })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/catalog?offset=-1", headers: { cookie } })).statusCode, 400);
    const markedNotifications = await app.inject({ method: "POST", url: "/api/notifications/read-all", headers: { cookie } });
    assert.equal(markedNotifications.statusCode, 200);
    assert.deepEqual(markedNotifications.json(), { marked: 0 });
    const apps = await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
    const management = (apps.json() as { applications: Array<{ id: string; route: string }> }).applications.find((item) => item.route === "/system");
    assert.ok(management);
    const invalidKey = await app.inject({ method: "POST", url: "/api/keys", headers: { cookie }, payload: { applicationId: management.id, expiresAt: "tomorrow" } });
    assert.equal(invalidKey.statusCode, 400);
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
    assert.deepEqual(listed.json().installations[0].capabilities, ["db", "history", "events"]);
    assert.deepEqual(listed.json().installations[0].worker, { installationId: installation.id, state: "stopped", attempts: 0 });
    assert.equal(JSON.stringify(listed.json().installations[0].worker).includes("lastError"), false);
    const reduced = await app.inject({ method: "PATCH", url: `/api/plugins/${installation.id}/capabilities`, headers: { cookie }, payload: { capabilities: ["history"] } });
    assert.equal(reduced.statusCode, 200);
    assert.deepEqual(reduced.json().capabilities, ["history"]);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/plugins", headers: { cookie } })).json().installations[0].worker, { installationId: installation.id, state: "stopped", attempts: 0 });
    assert.equal((await app.inject({ method: "PATCH", url: `/api/plugins/${installation.id}/capabilities`, headers: { cookie }, payload: { capabilities: ["network"] } })).statusCode, 400);
    const scopedJobs = await app.inject({ method: "GET", url: `/api/plugins/${installation.id}/jobs`, headers: { cookie } });
    assert.equal(scopedJobs.statusCode, 200);
    assert.deepEqual(scopedJobs.json().jobs, []);
    const database = openDatabase(dataDir);
    const userRow = database.db.prepare("SELECT id, organization_id FROM users LIMIT 1").get() as { id: string; organization_id: string };
    database.db.prepare("INSERT INTO plugin_jobs (id, organization_id, user_id, installation_id, type, payload_json, status, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("job_disable_test", userRow.organization_id, userRow.id, installation.id, "history.cleanup", "{}", "queued", 0, new Date().toISOString(), new Date().toISOString());
    database.close();
    assert.equal((await app.inject({ method: "POST", url: `/api/plugins/${installation.id}/disable`, headers: { cookie } })).statusCode, 204);
    const afterDisable = openDatabase(dataDir);
    assert.equal((afterDisable.db.prepare("SELECT status FROM plugin_jobs WHERE id = ?").get("job_disable_test") as { status: string }).status, "cancelled");
    afterDisable.close();
    assert.equal((await app.inject({ method: "GET", url: `/api/plugins/${installation.id}/jobs`, headers: { cookie } })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } })).json().applications.some((item: { installationId: string }) => item.installationId === installation.id), false);
    assert.equal((await app.inject({ method: "POST", url: `/api/plugins/${installation.id}/enable`, headers: { cookie } })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } })).json().applications.some((item: { installationId: string }) => item.installationId === installation.id), true);
    const applicationId = (await app.inject({ method: "GET", url: "/api/apps", headers: { cookie } })).json().applications.find((item: { installationId: string }) => item.installationId === installation.id).id as string;
    assert.equal((await app.inject({ method: "POST", url: "/api/keys", headers: { cookie }, payload: { applicationId } })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: "/api/components", headers: { cookie }, payload: { id: "wdr-service", version: "1.0.0", executable: "wdr-service/bin", checksum: `sha256:${"a".repeat(64)}` } })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: "/api/service-bindings", headers: { cookie }, payload: { componentId: "wdr-service", name: "wdr-local", endpoint: "http://127.0.0.1:5244", installationId: installation.id } })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: `/api/plugins/${installation.id}/uninstall`, headers: { cookie } })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: `/api/plugins/${installation.id}/disable`, headers: { cookie } })).statusCode, 204);
    assert.equal((await app.inject({ method: "POST", url: `/api/plugins/${installation.id}/uninstall`, headers: { cookie } })).statusCode, 204);
    const uninstalled = (await app.inject({ method: "GET", url: "/api/plugins", headers: { cookie } })).json().installations.find((item: { id: string }) => item.id === installation.id);
    assert.equal(uninstalled.status, "uninstalled");
    const afterUninstall = openDatabase(dataDir);
    assert.equal((afterUninstall.db.prepare("SELECT COUNT(*) AS count FROM service_bindings WHERE installation_id = ?").get(installation.id) as { count: number }).count, 0);
    assert.equal((afterUninstall.db.prepare("SELECT COUNT(*) AS count FROM entry_keys k JOIN applications a ON a.id = k.application_id WHERE a.installation_id = ? AND k.revoked_at IS NOT NULL").get(installation.id) as { count: number }).count, 1);
    afterUninstall.close();
    assert.equal((await app.inject({ method: "POST", url: `/api/plugins/${installation.id}/enable`, headers: { cookie } })).statusCode, 404);
    const reinstall = await app.inject({ method: "POST", url: "/api/plugins", headers: { cookie }, payload: release });
    assert.equal(reinstall.statusCode, 201);
    assert.notEqual((reinstall.json() as { installation: { id: string } }).installation.id, installation.id);
    assert.equal((await app.inject({ method: "GET", url: "/api/plugins", headers: { cookie } })).json().installations.filter((item: { packageId: string }) => item.packageId === "wdr-media").length, 2);
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
    assert.deepEqual((await app.inject({ method: "POST", url: "/api/jobs/run", headers: { cookie }, payload: { limit: 10 } })).json().jobs, []);
    assert.equal((await app.inject({ method: "POST", url: "/api/jobs/run", headers: { cookie }, payload: { limit: 0 } })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/jobs", headers: { cookie: "cmh_session=invalid" } })).statusCode, 401);
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("admin browser center exposes redacted sessions and cancels scoped tasks", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-admin-browser-"));
  const app = await createApp({ dataDir });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const database = openDatabase(dataDir);
    const user = database.db.prepare("SELECT id, organization_id FROM users LIMIT 1").get() as { id: string; organization_id: string };
    const sessionId = `browser_${crypto.randomUUID()}`;
    const taskId = `browser_task_${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    database.db.prepare("INSERT INTO browser_sessions (id, organization_id, user_id, installation_id, name, purpose, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)").run(sessionId, user.organization_id, user.id, "browser-plugin", "authorized", "media extraction", new Date(Date.now() + 60_000).toISOString(), timestamp);
    database.db.prepare("INSERT INTO browser_tasks (id, organization_id, user_id, installation_id, session_id, kind, input_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)").run(taskId, user.organization_id, user.id, "browser-plugin", sessionId, "navigate-and-capture", JSON.stringify({ target: "fixture", label: "safe" }), timestamp, timestamp);
    database.close();
    const sessions = await app.inject({ method: "GET", url: "/api/browser/sessions", headers: { cookie } });
    assert.equal(sessions.statusCode, 200);
    assert.equal(sessions.json().sessions[0].id, sessionId);
    assert.equal("input" in sessions.json().sessions[0], false);
    const tasks = await app.inject({ method: "GET", url: "/api/browser/tasks", headers: { cookie } });
    assert.equal(tasks.statusCode, 200);
    assert.equal(tasks.json().tasks[0].id, taskId);
    assert.equal("input" in tasks.json().tasks[0], false);
    assert.equal((await app.inject({ method: "POST", url: `/api/browser/tasks/${taskId}/cancel`, headers: { cookie } })).json().task.status, "cancelled");
    assert.equal((await app.inject({ method: "POST", url: `/api/browser/sessions/${sessionId}/revoke`, headers: { cookie } })).json().revoked, true);
    assert.deepEqual((await app.inject({ method: "POST", url: "/api/browser/tasks/run", headers: { cookie }, payload: { limit: 10 } })).json().tasks, []);
    assert.equal((await app.inject({ method: "POST", url: "/api/browser/tasks/run", headers: { cookie }, payload: { limit: 0 } })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/browser/sessions", headers: { cookie: "cmh_session=invalid" } })).statusCode, 401);
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("admin browser target diagnostics expose only registered logical targets", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-admin-browser-targets-"));
  const targets = new BrowserTargetRegistry();
  targets.register({ id: "fixture", origins: ["https://fixture.example:443"] });
  const app = await createApp({ dataDir, browserTargetRegistry: targets });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const response = await app.inject({ method: "GET", url: "/api/browser/targets", headers: { cookie: login.headers["set-cookie"] } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { targets: [{ id: "fixture", origins: ["https://fixture.example"] }] });
    assert.equal((await app.inject({ method: "GET", url: "/api/browser/targets", headers: { cookie: "cmh_session=invalid" } })).statusCode, 401);
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("credential HTTP lifecycle requires secrets capability and never returns plaintext", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-credential-api-"));
  const pluginKeyPair = crypto.generateKeyPairSync("ed25519");
  const pluginPublicKey = pluginKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const app = await createApp({ dataDir, pluginTrustKeys: [pluginPublicKey] });
  const sign = (manifest: Record<string, unknown>) => {
    const keyId = crypto.createHash("sha256").update(pluginPublicKey).digest("hex").slice(0, 16);
    return { keyId, manifest, signature: crypto.sign(null, canonicalPluginManifest(manifest), pluginKeyPair.privateKey).toString("base64") };
  };
  const baseManifest = (id: string, capabilities: string[]) => ({ id, version: "0.1.0", sdk: "^0.1.0", name: { en: id, "zh-CN": id, ko: id }, description: { en: id, "zh-CN": id, ko: id }, category: "adapter", runtime: "isolated-worker", capabilities, routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const deniedInstall = await app.inject({ method: "POST", url: "/api/plugins", headers: { cookie }, payload: sign(baseManifest("no-secrets", ["network"])) });
    assert.equal(deniedInstall.statusCode, 201);
    const deniedId = (deniedInstall.json() as { installation: { id: string } }).installation.id;
    const allowedInstall = await app.inject({ method: "POST", url: "/api/plugins", headers: { cookie }, payload: sign(baseManifest("with-secrets", ["network", "secrets"])) });
    assert.equal(allowedInstall.statusCode, 201);
    const allowedId = (allowedInstall.json() as { installation: { id: string } }).installation.id;
    assert.equal((await app.inject({ method: "POST", url: "/api/credentials", headers: { cookie }, payload: { name: "BBC login", kind: "cookie", value: "session=do-not-return", installationId: deniedId } })).statusCode, 400);
    const created = await app.inject({ method: "POST", url: "/api/credentials", headers: { cookie }, payload: { name: "BBC login", kind: "cookie", value: "session=do-not-return", installationId: allowedId } });
    assert.equal(created.statusCode, 201);
    assert.equal(JSON.stringify(created.json()).includes("do-not-return"), false);
    const credentialId = (created.json() as { credential: { id: string } }).credential.id;
    const listed = await app.inject({ method: "GET", url: "/api/credentials", headers: { cookie } });
    assert.equal(listed.statusCode, 200);
    assert.equal(JSON.stringify(listed.json()).includes("do-not-return"), false);
    assert.equal((listed.json() as { credentials: Array<{ id: string }> }).credentials.some((item) => item.id === credentialId), true);
    const second = await app.inject({ method: "POST", url: "/api/credentials", headers: { cookie }, payload: { name: "Second login", kind: "authorization", value: "Bearer do-not-return", installationId: allowedId } });
    assert.equal(second.statusCode, 201);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/plugins/${allowedId}/capabilities`, headers: { cookie }, payload: { capabilities: ["network"] } })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/credentials", headers: { cookie } })).json().credentials.length, 0);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/credentials/${credentialId}`, headers: { cookie } })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/credentials", headers: { cookie } })).json().credentials.length, 0);
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
    const manifest = { id: "wdr-media", version: "0.1.0", sdk: "^0.1.0", name: { en: "WDR Media", "zh-CN": "WDR", ko: "WDR" }, description: { en: "Media", "zh-CN": "媒体", ko: "미디어" }, category: "official", runtime: "isolated-worker", capabilities: ["db", "storage", "media", "history", "events"], routes: [{ path: "/", methods: ["GET"] }, { path: "/stream", methods: ["GET"] }, { path: "/health", methods: ["GET", "HEAD"] }], worker: { entry: "./worker.js", protocol: "0.1" }, ui: { entry: "./ui/index.html", vehicleSupported: true } };
    const pluginKeyId = crypto.createHash("sha256").update(pluginPublicKey).digest("hex").slice(0, 16);
    const release = { keyId: pluginKeyId, manifest, signature: crypto.sign(null, canonicalPluginManifest(manifest), pluginKeyPair.privateKey).toString("base64") };
    const install = await app.inject({ method: "POST", url: "/api/plugins", headers: { cookie }, payload: release });
    assert.equal(install.statusCode, 201);
    const installationId = (install.json() as { installation: { id: string } }).installation.id;
    const probe = await app.inject({ method: "POST", url: `/api/plugins/${installationId}/health`, headers: { cookie } });
    assert.equal(probe.statusCode, 200);
    assert.deepEqual(probe.json(), { healthy: true, status: 200, worker: "running" });
    assert.equal((await app.inject({ method: "POST", url: "/api/components", headers: { cookie }, payload: { id: "wdr-service", version: "1.0.0", executable: "wdr-service/wdr-service", checksum: `sha256:${"a".repeat(64)}` } })).statusCode, 201);
    const scopedBinding = await app.inject({ method: "POST", url: "/api/service-bindings", headers: { cookie }, payload: { componentId: "wdr-service", name: "wdr-local", endpoint: "http://127.0.0.1:5244", installationId } });
    assert.equal(scopedBinding.statusCode, 201);
    const componentView = (await app.inject({ method: "GET", url: "/api/components", headers: { cookie } })).json() as { bindings: Array<{ name: string; installation_id: string | null }>; bindingGrants: Array<{ bindingId: string; scope: string; installationId: string | null; authorizedInstallations: string[] }> };
    const listedBindings = componentView.bindings;
    assert.deepEqual(listedBindings.find((binding) => binding.name === "wdr-local")?.installation_id, installationId);
    const scopedGrant = componentView.bindingGrants.find((grant) => grant.installationId === installationId);
    assert.deepEqual(scopedGrant?.scope, "installation");
    assert.deepEqual(scopedGrant?.authorizedInstallations, []);
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
    const head = await app.inject({ method: "HEAD", url: `/apps/wdr-media/${installationId}/health`, headers: { cookie } });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, "");
    const methodDenied = await app.inject({ method: "POST", url: `/apps/wdr-media/${installationId}/health`, headers: { cookie } });
    assert.equal(methodDenied.statusCode, 405);
    assert.equal(methodDenied.headers.allow, "GET, HEAD");
    const unknownRoute = await app.inject({ method: "GET", url: `/apps/wdr-media/${installationId}/not-declared`, headers: { cookie } });
    assert.equal(unknownRoute.statusCode, 404);
    assert.deepEqual(response.json(), { status: "ok", worker: "wdr-media", locale: "ko", entry: "navigation", display: { deviceClass: "vehicle", input: ["touch", "remote"], fullscreenAvailable: true, viewport: { width: 1920, height: 1200 } } });
    const runningInstallation = (await app.inject({ method: "GET", url: "/api/plugins", headers: { cookie } })).json().installations.find((candidate: { id: string }) => candidate.id === installationId);
    assert.deepEqual(runningInstallation.worker, { installationId, state: "running", attempts: 0 });
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
    const exportedData = await app.inject({ method: "GET", url: `/api/plugins/${installationId}/data/export`, headers: { cookie } });
    assert.equal(exportedData.statusCode, 200);
    assert.equal(exportedData.headers["cache-control"], "no-store");
    assert.equal((exportedData.json() as { scope: { userId: string }; collections: unknown[] }).scope.userId.length > 0, true);
    const missingConfirmation = await app.inject({ method: "DELETE", url: `/api/plugins/${installationId}/data`, headers: { cookie }, payload: { confirm: false } });
    assert.equal(missingConfirmation.statusCode, 400);
    const deletedData = await app.inject({ method: "DELETE", url: `/api/plugins/${installationId}/data`, headers: { cookie }, payload: { confirm: true } });
    assert.equal(deletedData.statusCode, 200);
    assert.equal((deletedData.json() as { deleted: number }).deleted >= 1, true);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(mediaRoot, { recursive: true, force: true });
  }
});

test("runs the browser contract Worker through Core Broker and enforces capability boundaries", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-browser-worker-"));
  const pluginKeyPair = crypto.generateKeyPairSync("ed25519");
  const pluginPublicKey = pluginKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const packageRoot = path.resolve(import.meta.dirname, "..", "..", "carmediahub-plugins", "dist", "plugins", "browser-bridge", "browser-session-contract-example", "src");
  const trustedWorkerPackages = [
    { packageId: "browser-session-contract-example", packageRoot, workerEntry: "./worker.js" },
    { packageId: "browser-session-no-capability", packageRoot, workerEntry: "./worker.js" }
  ];
  const app = await createApp({ dataDir, pluginTrustKeys: [pluginPublicKey], trustedWorkerPackages });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const sign = (manifest: object) => ({ keyId: crypto.createHash("sha256").update(pluginPublicKey).digest("hex").slice(0, 16), manifest, signature: crypto.sign(null, canonicalPluginManifest(manifest), pluginKeyPair.privateKey).toString("base64") });
    const browserManifest = { id: "browser-session-contract-example", version: "0.1.0", sdk: "^0.1.0", name: { en: "Browser contract", "zh-CN": "浏览器契约", ko: "브라우저 계약" }, description: { en: "Worker fixture", "zh-CN": "Worker 夹具", ko: "Worker 픽스처" }, category: "browser-bridge", runtime: "isolated-worker", capabilities: ["browser", "gateway"], routes: [{ path: "/", methods: ["GET", "HEAD"] }, { path: "/health", methods: ["GET", "HEAD"] }, { path: "/session", methods: ["GET"] }, { path: "/task", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const;
    const installed = await app.inject({ method: "POST", url: "/api/plugins", headers: { cookie }, payload: sign(browserManifest) });
    assert.equal(installed.statusCode, 201);
    const installationId = (installed.json() as { installation: { id: string } }).installation.id;
    const taskResponse = await app.inject({ method: "GET", url: `/apps/browser-session-contract-example/${installationId}/task`, headers: { cookie } });
    assert.equal(taskResponse.statusCode, 200);
    const taskBody = taskResponse.json() as { session: { id: string; name: string; status: string }; task: { id: string; kind: string; status: string; input: { target: string; label: string } }; listed: Array<{ id: string }>; cancelled: { id: string; status: string } };
    assert.match(taskBody.session.id, /^browser_[0-9a-f-]{36}$/u);
    assert.equal(taskBody.session.name, "task-fixture");
    assert.equal(taskBody.task.kind, "navigate-and-capture");
    assert.equal(taskBody.task.status, "queued");
    assert.deepEqual(taskBody.task.input, { target: "contract-fixture", label: "Contract fixture" });
    assert.equal(taskBody.listed.some((task) => task.id === taskBody.task.id), true);
    assert.equal(taskBody.cancelled.id, taskBody.task.id);
    assert.equal(taskBody.cancelled.status, "cancelled");
    const database = openDatabase(dataDir);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions WHERE installation_id = ?").get(installationId) as { count: number }).count, 1);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM browser_tasks WHERE installation_id = ? AND status = 'cancelled'").get(installationId) as { count: number }).count, 1);
    database.close();

    const deniedManifest = { ...browserManifest, id: "browser-session-no-capability", capabilities: ["gateway"] as const };
    const deniedInstall = await app.inject({ method: "POST", url: "/api/plugins", headers: { cookie }, payload: sign(deniedManifest) });
    assert.equal(deniedInstall.statusCode, 201);
    const deniedId = (deniedInstall.json() as { installation: { id: string } }).installation.id;
    const denied = await app.inject({ method: "GET", url: `/apps/browser-session-no-capability/${deniedId}/session`, headers: { cookie } });
    assert.equal(denied.statusCode, 503);
    assert.equal(denied.json().code, "CMH.GATEWAY.WORKER_UNAVAILABLE");
    const afterDenied = openDatabase(dataDir);
    assert.equal((afterDenied.db.prepare("SELECT COUNT(*) AS count FROM browser_sessions WHERE installation_id = ?").get(deniedId) as { count: number }).count, 0);
    afterDenied.close();
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("routes the Mihomo Web Bridge through a scoped Core service binding", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-mihomo-bridge-"));
  const upstream = http.createServer((request, response) => {
    if (request.url !== "/configs") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ mode: "rule", source: "local-fixture" }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address !== null && typeof address !== "string");
  const pluginKeyPair = crypto.generateKeyPairSync("ed25519");
  const pluginPublicKey = pluginKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const packageRoot = path.resolve(import.meta.dirname, "..", "..", "carmediahub-plugins", "dist", "plugins", "adapters", "mihomo-web-bridge", "src");
  const app = await createApp({ dataDir, pluginTrustKeys: [pluginPublicKey], trustedWorkerPackages: [{ packageId: "mihomo-web-bridge", packageRoot, workerEntry: "./worker.js" }] });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const manifest = { id: "mihomo-web-bridge", version: "0.1.0", sdk: "^0.1.0", name: { en: "Mihomo Web Bridge", "zh-CN": "Mihomo Web 兼容桥", ko: "Mihomo Web 브리지" }, description: { en: "Bounded bridge", "zh-CN": "受限桥接", ko: "제한된 브리지" }, category: "adapter", runtime: "isolated-worker", capabilities: ["gateway", "network"], routes: [{ path: "/", methods: ["GET", "HEAD"] }, { path: "/health", methods: ["GET", "HEAD"] }, { path: "/proxy", methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const;
    const keyId = crypto.createHash("sha256").update(pluginPublicKey).digest("hex").slice(0, 16);
    const release = { keyId, manifest, signature: crypto.sign(null, canonicalPluginManifest(manifest), pluginKeyPair.privateKey).toString("base64") };
    const installed = await app.inject({ method: "POST", url: "/api/plugins", headers: { cookie }, payload: release });
    assert.equal(installed.statusCode, 201);
    const installationId = (installed.json() as { installation: { id: string } }).installation.id;
    assert.equal((await app.inject({ method: "POST", url: "/api/components", headers: { cookie }, payload: { id: "mihomo", version: "1.0.0", executable: "mihomo/mihomo", checksum: `sha256:${"a".repeat(64)}` } })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: "/api/service-bindings", headers: { cookie }, payload: { componentId: "mihomo", name: "mihomo-web", endpoint: `http://127.0.0.1:${address.port}`, installationId } })).statusCode, 201);
    const response = await app.inject({ method: "GET", url: `/apps/mihomo-web-bridge/${installationId}/proxy?path=%2Fconfigs`, headers: { cookie, accept: "application/json", authorization: "must-not-forward" } });
    assert.equal(response.statusCode, 200);
    const encodedPayload = JSON.parse(response.rawPayload.toString("utf8")) as { type?: string; data?: number[] };
    assert.equal(encodedPayload.type, "Buffer");
    assert.deepEqual(JSON.parse(Buffer.from(encodedPayload.data ?? []).toString("utf8")), { mode: "rule", source: "local-fixture" });
    const denied = await app.inject({ method: "GET", url: `/apps/mihomo-web-bridge/${installationId}/proxy?path=%2Ftraffic`, headers: { cookie } });
    assert.equal(denied.statusCode, 400);
    assert.equal(denied.json().code, "CMH.MIHOMO.PATH_NOT_ALLOWED");
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error === undefined ? resolve() : reject(error)));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("routes the AList Web Bridge directory API through a scoped Core service binding", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-alist-bridge-"));
  let receivedBody = "";
  let receivedHeaders: Record<string, string | string[] | undefined> = {};
  const upstream = http.createServer((request, response) => {
    if (request.url !== "/api/fs/list" || request.method !== "POST") { response.writeHead(404); response.end(); return; }
    receivedHeaders = request.headers;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { receivedBody += chunk; });
    request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ code: 200, data: { content: [{ name: "drive.mp4" }] } })); });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address !== null && typeof address !== "string");
  const pluginKeyPair = crypto.generateKeyPairSync("ed25519");
  const pluginPublicKey = pluginKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const packageRoot = path.resolve(import.meta.dirname, "..", "..", "carmediahub-plugins", "dist", "plugins", "adapters", "alist-web-bridge", "src");
  const app = await createApp({ dataDir, pluginTrustKeys: [pluginPublicKey], trustedWorkerPackages: [{ packageId: "alist-web-bridge", packageRoot, workerEntry: "./worker.js" }] });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const manifest = { id: "alist-web-bridge", version: "0.1.0", sdk: "^0.1.0", name: { en: "AList Web Bridge", "zh-CN": "AList Web 兼容桥", ko: "AList Web 브리지" }, description: { en: "Bounded bridge", "zh-CN": "受限桥接", ko: "제한된 브리지" }, category: "adapter", runtime: "isolated-worker", capabilities: ["gateway", "network"], serviceBindings: ["alist-web"], routes: [{ path: "/", methods: ["GET", "HEAD"] }, { path: "/health", methods: ["GET", "HEAD"] }, { path: "/proxy", methods: ["GET", "HEAD", "POST"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const;
    const keyId = crypto.createHash("sha256").update(pluginPublicKey).digest("hex").slice(0, 16);
    const release = { keyId, manifest, signature: crypto.sign(null, canonicalPluginManifest(manifest), pluginKeyPair.privateKey).toString("base64") };
    const installed = await app.inject({ method: "POST", url: "/api/plugins", headers: { cookie }, payload: release });
    assert.equal(installed.statusCode, 201);
    const installationId = (installed.json() as { installation: { id: string } }).installation.id;
    assert.equal((await app.inject({ method: "POST", url: "/api/components", headers: { cookie }, payload: { id: "alist", version: "1.0.0", executable: "alist/alist", checksum: `sha256:${"a".repeat(64)}` } })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: "/api/service-bindings", headers: { cookie }, payload: { componentId: "alist", name: "alist-web", endpoint: `http://127.0.0.1:${address.port}`, installationId } })).statusCode, 201);
    const response = await app.inject({ method: "POST", url: `/apps/alist-web-bridge/${installationId}/proxy?path=%2Fapi%2Ffs%2Flist`, headers: { cookie, accept: "application/json", authorization: "must-not-forward", "content-type": "application/json" }, payload: { path: "/", password: "operator-input" } });
    assert.equal(response.statusCode, 200);
    const encodedPayload = JSON.parse(response.rawPayload.toString("utf8")) as { type?: string; data?: number[] };
    assert.equal(encodedPayload.type, "Buffer");
    assert.deepEqual(JSON.parse(Buffer.from(encodedPayload.data ?? []).toString("utf8")), { code: 200, data: { content: [{ name: "drive.mp4" }] } });
    assert.equal(receivedBody, JSON.stringify({ path: "/", password: "operator-input" }));
    assert.equal(receivedHeaders.authorization, undefined);
    assert.equal(receivedHeaders.cookie, undefined);
    assert.equal(receivedHeaders["content-type"], "application/json");
    const denied = await app.inject({ method: "POST", url: `/apps/alist-web-bridge/${installationId}/proxy?path=%2Fapi%2Fadmin%2Fusers`, headers: { cookie }, payload: {} });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().code, "CMH.ALIST.POST_PATH_NOT_ALLOWED");
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error === undefined ? resolve() : reject(error)));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("administrator installs only a signed staged plugin package", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-"));
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const source = path.join(dataDir, "staging", "plugins", "wdr-build");
  fs.mkdirSync(path.join(source, "ui"), { recursive: true });
  const wdrWorker = path.resolve(import.meta.dirname, "..", "..", "carmediahub-plugins", "dist", "plugins", "official", "wdr-media", "src", "worker.js");
  fs.copyFileSync(wdrWorker, path.join(source, "worker.js"));
  fs.mkdirSync(path.join(source, "node_modules", "@carmediahub", "sdk"), { recursive: true });
  fs.writeFileSync(path.join(source, "node_modules", "@carmediahub", "sdk", "package.json"), JSON.stringify({ type: "module", exports: { ".": "./dist/index.js" } }));
  fs.cpSync(path.resolve(import.meta.dirname, "..", "..", "carmediahub-sdk", "dist"), path.join(source, "node_modules", "@carmediahub", "sdk", "dist"), { recursive: true });
  fs.writeFileSync(path.join(source, "ui", "index.html"), "<main></main>\n");
  const app = await createApp({ dataDir, pluginTrustKeys: [publicKey] });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const manifest = { id: "wdr-media", version: "0.1.0", sdk: "^0.1.0", name: { en: "WDR", "zh-CN": "WDR", ko: "WDR" }, description: { en: "Media", "zh-CN": "媒体", ko: "미디어" }, category: "official", runtime: "isolated-worker", capabilities: ["db"], routes: [{ path: "/", methods: ["GET"] }, { path: "/health", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" } } as const;
    const keyId = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
    const unsigned = { keyId, manifest, artifact: { id: "wdr-build", digest: pluginPackageDigest(source) } };
    const release = { ...unsigned, signature: crypto.sign(null, canonicalPluginPackageRelease(unsigned), pair.privateKey).toString("base64") };
    const response = await app.inject({ method: "POST", url: "/api/plugins/packages/install", headers: { cookie: login.headers["set-cookie"] }, payload: release });
    assert.equal(response.statusCode, 201);
    assert.match(response.json().package.location, /^plugins\/wdr-media\/0\.1\.0\//);
    const installation = response.json().installation as { id: string };
    assert.ok(installation.id.startsWith("plugin_"));
    assert.equal((await app.inject({ method: "GET", url: "/api/plugins", headers: { cookie: login.headers["set-cookie"] } })).json().installations.length, 1);
    assert.equal((await app.inject({ method: "GET", url: "/api/apps", headers: { cookie: login.headers["set-cookie"] } })).json().applications.some((item: { installationId: string }) => item.installationId === installation.id), true);
    const broken = openDatabase(dataDir);
    broken.db.prepare("DELETE FROM applications WHERE installation_id = ?").run(installation.id);
    broken.db.prepare("DELETE FROM plugin_installations WHERE id = ?").run(installation.id);
    broken.close();
    const recovered = await app.inject({ method: "POST", url: "/api/plugins/packages/install", headers: { cookie: login.headers["set-cookie"] }, payload: release });
    assert.equal(recovered.statusCode, 201);
    const recoveredHealth = await app.inject({ method: "GET", url: `/apps/wdr-media/${recovered.json().installation.id}/health`, headers: { cookie: login.headers["set-cookie"] } });
    assert.equal(recoveredHealth.statusCode, 200);
    assert.equal(recoveredHealth.json().worker, "wdr-media");
    const duplicate = await app.inject({ method: "POST", url: "/api/plugins/packages/install", headers: { cookie: login.headers["set-cookie"] }, payload: release });
    assert.equal(duplicate.statusCode, 409);
    assert.equal((await app.inject({ method: "GET", url: "/api/plugins", headers: { cookie: login.headers["set-cookie"] } })).json().installations.length, 1);
    await app.close();
    const restarted = await createApp({ dataDir, pluginTrustKeys: [publicKey], trustedWorkerPackages: [{ packageId: "wdr-media", packageRoot: source, workerEntry: "./worker.js" }] });
    const restartedLogin = await restarted.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    assert.equal((await restarted.inject({ method: "GET", url: "/api/plugins", headers: { cookie: restartedLogin.headers["set-cookie"] } })).json().installations.length, 1);
    await restarted.close();
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("persists a verified shared adapter entry across Core restart", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-shared-"));
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const source = path.join(dataDir, "staging", "plugins", "shared-build");
  fs.mkdirSync(path.join(source, "ui"), { recursive: true });
  fs.writeFileSync(path.join(source, "adapter.mjs"), "export async function startWorker() { return { stop() {} }; }\n");
  fs.writeFileSync(path.join(source, "worker.js"), "export {};\n");
  fs.writeFileSync(path.join(source, "ui", "index.html"), "<main></main>\n");
  const app = await createApp({ dataDir, pluginTrustKeys: [publicKey] });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const manifest = { id: "shared-adapter-example", version: "0.1.0", sdk: "^0.1.0", name: { en: "Shared", "zh-CN": "共享", ko: "공유" }, description: { en: "Shared", "zh-CN": "共享", ko: "공유" }, category: "core-companion", runtime: "shared-adapter-host", capabilities: ["gateway"], routes: [{ path: "/", methods: ["GET"] }], runtimeEntry: { entry: "./adapter.mjs", protocol: "0.1" } } as const;
    const keyId = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
    const unsigned = { keyId, manifest, artifact: { id: "shared-build", digest: pluginPackageDigest(source) } };
    const release = { ...unsigned, signature: crypto.sign(null, canonicalPluginPackageRelease(unsigned), pair.privateKey).toString("base64") };
    const installed = await app.inject({ method: "POST", url: "/api/plugins/packages/install", headers: { cookie: login.headers["set-cookie"] }, payload: release });
    assert.equal(installed.statusCode, 201);
    assert.ok(installed.json().installation.id.startsWith("plugin_"));
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

test("administrator registers and revokes a scoped remote media source", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-remote-source-api-"));
  let app = await createApp({ dataDir });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const database = openDatabase(dataDir);
    const user = database.db.prepare("SELECT id, organization_id FROM users LIMIT 1").get() as { id: string; organization_id: string };
    database.db.prepare("INSERT INTO plugin_installations (id, package_id, package_version, runtime, manifest_json, granted_capabilities, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("plugin_media_source", "media-source-example", "0.1.0", "isolated-worker", JSON.stringify({ id: "media-source-example", capabilities: ["media-source"], serviceBindings: ["dav"] }), JSON.stringify(["media-source"]), "installed", new Date().toISOString(), new Date().toISOString());
    database.db.prepare("INSERT INTO managed_components (id, version, executable, checksum, installed_at, health) VALUES (?, ?, ?, ?, ?, ?)").run("rclone", "fixture", "rclone", "fixture", new Date().toISOString(), "healthy");
    database.db.prepare("INSERT INTO service_bindings (id, component_id, name, endpoint, installation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("binding_dav", "rclone", "dav", "http://127.0.0.1:5244/", null, new Date().toISOString());
    database.close();
    const created = await app.inject({ method: "POST", url: "/api/media-sources", headers: { cookie }, payload: { installationId: "plugin_media_source", name: "Trip storage", binding: "dav", rootPath: "/dav/" } });
    assert.equal(created.statusCode, 201);
    assert.doesNotMatch(created.body, /5244/u);
    assert.doesNotMatch(created.body, /endpoint/u);
    const handle = (created.json() as { source: { sourceHandle: string } }).source.sourceHandle;
    const listed = await app.inject({ method: "GET", url: "/api/media-sources?installationId=plugin_media_source", headers: { cookie } });
    assert.equal((listed.json() as { sources: unknown[] }).sources.length, 1);
    await app.close();
    app = await createApp({ dataDir });
    const restored = await app.inject({ method: "GET", url: "/api/media-sources?installationId=plugin_media_source", headers: { cookie } });
    assert.equal(restored.statusCode, 200);
    assert.equal((restored.json() as { sources: unknown[] }).sources.length, 1);
    assert.equal((await app.inject({ method: "POST", url: `/api/media-sources/${handle}/revoke?installationId=plugin_media_source`, headers: { cookie } })).statusCode, 204);
    assert.equal(((await app.inject({ method: "GET", url: "/api/media-sources?installationId=plugin_media_source", headers: { cookie } })).json() as { sources: unknown[] }).sources.length, 0);
  } finally { await app.close(); try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may release a transient SQLite handle after the test tick. */ } }
});

test("authenticated transform playback route enforces Range and expiry", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-output-route-"));
  const app = await createApp({ dataDir });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const database = openDatabase(dataDir);
    const user = database.db.prepare("SELECT id, organization_id FROM users LIMIT 1").get() as { id: string; organization_id: string };
    const outputId = "transform_00000000-0000-4000-8000-000000000001";
    const output = path.join(dataDir, "media-transforms", `${outputId}.mp4`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "0123456789");
    database.db.prepare("INSERT INTO media_transform_outputs (id, organization_id, user_id, installation_id, file_name, content_type, bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(outputId, user.organization_id, user.id, "wdr", path.basename(output), "video/mp4", 10, new Date().toISOString(), "2099-01-01T00:00:00.000Z");
    database.close();
    const response = await app.inject({ method: "GET", url: `/api/media/outputs/${outputId}`, headers: { cookie, range: "bytes=2-5" } });
    assert.equal(response.statusCode, 206);
    assert.equal(response.body, "2345");
    assert.equal(response.headers["content-range"], "bytes 2-5/10");
    const head = await app.inject({ method: "HEAD", url: `/api/media/outputs/${outputId}`, headers: { cookie, range: "bytes=2-5" } });
    assert.equal(head.statusCode, 206);
    assert.equal(head.body, "");
    assert.equal(head.headers["content-length"], "4");
    const expired = openDatabase(dataDir);
    expired.db.prepare("UPDATE media_transform_outputs SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", outputId);
    expired.close();
    assert.equal((await app.inject({ method: "GET", url: `/api/media/outputs/${outputId}`, headers: { cookie } })).statusCode, 404);
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
