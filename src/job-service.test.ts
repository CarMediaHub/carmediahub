import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./database.js";
import { PluginJobService } from "./job-service.js";

test("plugin jobs are persisted and isolated by user and installation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-jobs-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', '2026-01-01T00:00:00.000Z', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Organization'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user-a', 'org', 'a', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z'), ('user-b', 'org', 'b', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z');");
    const jobs = new PluginJobService(database.db);
    const base = { deploymentId: "dep", organizationId: "org", deviceId: "device", sessionId: "session" };
    const firstScope = { ...base, userId: "user-a", installationId: "wdr" };
    const secondUser = { ...base, userId: "user-b", installationId: "wdr" };
    const secondInstallation = { ...base, userId: "user-a", installationId: "other" };
    const job = jobs.enqueue(firstScope, "media.transcode", { source: "asset" });
    assert.equal(jobs.list(firstScope).length, 1);
    assert.equal(jobs.list(secondUser).length, 0);
    assert.equal(jobs.list(secondInstallation).length, 0);
    assert.equal(jobs.transition(secondUser, job.id, "running"), undefined);
    assert.equal(jobs.transition(firstScope, job.id, "running")?.status, "running");
    const completed = jobs.transition(firstScope, job.id, "succeeded", { progress: 100, result: { output: "ready" } });
    assert.equal(completed?.progress, 100);
    assert.deepEqual(completed?.result, { output: "ready" });
    assert.equal(jobs.transition(firstScope, job.id, "running"), undefined);
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
