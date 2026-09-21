import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "./app.js";
import { totpCode } from "./security.js";
import { currentPlatformKey } from "./components.js";

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
  const app = await createApp({ dataDir });
  try {
    await app.inject({ method: "POST", url: "/api/bootstrap", payload: { username: "admin", password: "correct horse battery staple" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
    const cookie = login.headers["set-cookie"];
    const manifest = { id: "wdr-media", version: "0.1.0", sdk: "^0.1.0", name: { en: "WDR Media", "zh-CN": "WDR", ko: "WDR" }, description: { en: "Media", "zh-CN": "媒体", ko: "미디어" }, category: "official", runtime: "isolated-worker", capabilities: ["db", "history", "events"], routes: [{ path: "/", methods: ["GET"] }], worker: { entry: "./worker.js", protocol: "0.1" }, ui: { entry: "./ui/index.html", vehicleSupported: true } };
    const install = await app.inject({ method: "POST", url: "/api/plugins", headers: { cookie }, payload: manifest });
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
