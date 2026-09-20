import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "./app.js";
import { totpCode } from "./security.js";

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
