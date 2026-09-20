import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "./app.js";

test("bootstraps, authenticates, creates a key, and revokes it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-core-"));
  const app = await createApp({ dataDir });
  try {
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
