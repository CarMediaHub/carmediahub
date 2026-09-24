import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./database.js";
import { JobExecutor } from "./job-executor.js";
import { JobRecoveryScheduler } from "./job-scheduler.js";
import { PluginJobService } from "./job-service.js";

function seed(dataDir: string): { jobs: PluginJobService; executor: JobExecutor; scope: { deploymentId: string; organizationId: string; userId: string; deviceId: string; sessionId: string; installationId: string }; close(): void } {
  const database = openDatabase(dataDir);
  database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', '2026-01-01T00:00:00.000Z', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Organization'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'a', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z');");
  return { jobs: new PluginJobService(database.db), executor: new JobExecutor(new PluginJobService(database.db)), scope: { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "plugin" }, close: () => { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("recovery scheduler executes queued scopes and is idempotent", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-job-scheduler-"));
  const fixture = seed(dataDir);
  try {
    fixture.executor.register("media.transcode", (job) => ({ order: (job.payload as { order: number }).order }));
    fixture.jobs.enqueue(fixture.scope, "media.transcode", { order: 1 });
    fixture.jobs.enqueue(fixture.scope, "media.transcode", { order: 2 });
    const scheduler = new JobRecoveryScheduler(fixture.jobs, fixture.executor, () => fixture.scope, { intervalMs: 100, maxJobsPerScope: 1 });
    assert.equal(await scheduler.runOnce(), 1);
    assert.equal(fixture.jobs.list(fixture.scope).filter((job) => job.status === "queued").length, 1);
    assert.equal(await scheduler.runOnce(), 1);
    assert.equal(await scheduler.runOnce(), 0);
    scheduler.stop();
  } finally { fixture.close(); }
});

test("recovery scheduler rejects unsafe limits", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-job-scheduler-invalid-"));
  const fixture = seed(dataDir);
  try {
    assert.throws(() => new JobRecoveryScheduler(fixture.jobs, fixture.executor, () => fixture.scope, { intervalMs: 50 }), /interval/);
    assert.throws(() => new JobRecoveryScheduler(fixture.jobs, fixture.executor, () => fixture.scope, { maxJobsPerScope: 101 }), /batch/);
  } finally { fixture.close(); }
});

test("scheduler stop waits for an active recovery round", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-job-scheduler-stop-"));
  const fixture = seed(dataDir);
  try {
    let release!: () => void;
    fixture.executor.register("media.transcode", () => new Promise<void>((resolve) => { release = resolve; }));
    fixture.jobs.enqueue(fixture.scope, "media.transcode", { order: 1 });
    const scheduler = new JobRecoveryScheduler(fixture.jobs, fixture.executor, () => fixture.scope, { intervalMs: 100 });
    scheduler.start();
    await new Promise((resolve) => setImmediate(resolve));
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(stopped, true);
  } finally { fixture.close(); }
});
