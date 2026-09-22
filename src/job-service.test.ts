import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./database.js";
import { JobExecutor } from "./job-executor.js";
import { INTERRUPTED_JOB_ERROR, MAX_ACTIVE_JOBS_PER_SCOPE, MAX_ACTIVE_MEDIA_JOBS_PER_INSTALLATION, MAX_JOB_PAYLOAD_BYTES, PluginJobService } from "./job-service.js";

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

test("bounds active jobs and serialized payload size per installation scope", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-job-limits-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', '2026-01-01T00:00:00.000Z', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Organization'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'a', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z');");
    const jobs = new PluginJobService(database.db);
    const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "wdr" };
    for (let index = 0; index < MAX_ACTIVE_JOBS_PER_SCOPE; index += 1) jobs.enqueue(scope, `media.transcode.${index}`, { source: String(index) });
    assert.throws(() => jobs.enqueue(scope, "media.transcode.full", { source: "overflow" }), (error: unknown) => error instanceof Error && (error as { code?: string }).code === "CMH.JOBS.QUEUE_FULL");
    assert.throws(() => jobs.enqueue({ ...scope, installationId: "other" }, "media.transcode", { source: "x".repeat(MAX_JOB_PAYLOAD_BYTES) }), (error: unknown) => error instanceof Error && (error as { code?: string }).code === "CMH.JOBS.PAYLOAD_TOO_LARGE");
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("limits active media transforms to one per installation scope", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-media-job-limit-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', '2026-01-01T00:00:00.000Z', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Organization'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'a', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z');");
    const jobs = new PluginJobService(database.db);
    const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "wdr" };
    const first = jobs.enqueueMediaTransform(scope, "media.transcode", { mediaId: "opaque" });
    assert.equal(first.status, "queued");
    assert.throws(() => jobs.enqueueMediaTransform(scope, "media.remux", { mediaId: "opaque-2" }), (error: unknown) => error instanceof Error && (error as { code?: string }).code === "CMH.MEDIA.QUOTA_EXCEEDED");
    assert.equal(jobs.transition(scope, first.id, "cancelled")?.status, "cancelled");
    assert.equal(jobs.enqueueMediaTransform(scope, "media.remux", { mediaId: "opaque-2" }).status, "queued");
    assert.equal(MAX_ACTIVE_MEDIA_JOBS_PER_INSTALLATION, 1);
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("rejects oversized results without changing the active job", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-job-result-limit-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', '2026-01-01T00:00:00.000Z', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Organization'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'a', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z');");
    const jobs = new PluginJobService(database.db);
    const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "wdr" };
    const job = jobs.enqueue(scope, "media.transcode", { source: "asset" });
    assert.equal(jobs.transition(scope, job.id, "running")?.status, "running");
    assert.throws(() => jobs.transition(scope, job.id, "succeeded", { progress: 100, result: { output: "x".repeat(MAX_JOB_PAYLOAD_BYTES) } }), (error: unknown) => error instanceof Error && (error as { code?: string }).code === "CMH.JOBS.RESULT_TOO_LARGE");
    assert.equal(jobs.list(scope)[0]?.status, "running");
    assert.equal(jobs.transition(scope, job.id, "succeeded", { progress: 100, result: { output: "ready" } })?.status, "succeeded");
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("organization task view omits cross-organization jobs and supports admin cancellation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-job-admin-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', '2026-01-01T00:00:00.000Z', 'en'), ('dep2', '2026-01-01T00:00:00.000Z', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Organization'), ('org2', 'dep2', 'Other'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'a', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z'), ('user2', 'org2', 'b', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z');");
    const jobs = new PluginJobService(database.db);
    const first = jobs.enqueue({ deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "d", sessionId: "s", installationId: "wdr" }, "media.transcode", { source: "a" });
    jobs.enqueue({ deploymentId: "dep2", organizationId: "org2", userId: "user2", deviceId: "d", sessionId: "s", installationId: "wdr" }, "media.transcode", { source: "b" });
    assert.deepEqual(jobs.listOrganization("org").map((job) => job.id), [first.id]);
    assert.equal(jobs.cancelOrganization("org", first.id)?.status, "cancelled");
  } finally { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("startup recovery closes interrupted jobs without consuming the queue", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-job-recovery-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', '2026-01-01T00:00:00.000Z', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Organization'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'a', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z');");
    const jobs = new PluginJobService(database.db);
    const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "wdr" };
    const running = jobs.enqueue(scope, "media.transcode", { source: "running" });
    assert.equal(jobs.transition(scope, running.id, "running")?.status, "running");
    const queued = jobs.enqueue({ ...scope, installationId: "other" }, "media.remux", { source: "queued" });
    assert.equal(jobs.recoverInterrupted(), 1);
    const recovered = jobs.list(scope)[0];
    assert.equal(recovered?.id, running.id);
    assert.equal(recovered?.status, "failed");
    assert.equal(recovered?.errorCode, INTERRUPTED_JOB_ERROR);
    assert.equal(jobs.list({ ...scope, installationId: "other" })[0]?.id, queued.id);
    assert.equal(jobs.list({ ...scope, installationId: "other" })[0]?.status, "queued");
    assert.equal(jobs.recoverInterrupted(), 0);
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("job executor claims only registered types and records bounded outcomes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-job-executor-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', '2026-01-01T00:00:00.000Z', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Organization'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'a', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z');");
    const jobs = new PluginJobService(database.db);
    const executor = new JobExecutor(jobs);
    const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "wdr" };
    const unhandled = jobs.enqueue(scope, "media.transcode", { source: "unhandled" });
    assert.equal(await executor.runOnce(scope), undefined);
    assert.equal(jobs.list(scope)[0]?.status, "queued");
    executor.register("media.transcode", async (job) => ({ mediaId: job.payload && typeof job.payload === "object" ? "opaque" : "unknown" }));
    const completed = await executor.runOnce(scope);
    assert.equal(completed?.id, unhandled.id);
    assert.equal(completed?.status, "succeeded");
    assert.deepEqual(completed?.result, { mediaId: "opaque" });
    jobs.enqueue(scope, "media.transcode", { source: "failure" });
    const failing = new JobExecutor(jobs);
    failing.register("media.transcode", () => { throw new Error("secret path"); });
    const failed = await failing.runOnce(scope);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.errorCode, "CMH.JOBS.EXECUTION_FAILED");
    assert.equal(failed?.result, undefined);
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("job executor propagates scoped cancellation and ignores late completion", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-job-cancel-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', '2026-01-01T00:00:00.000Z', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Organization'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'a', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z');");
    const jobs = new PluginJobService(database.db);
    const executor = new JobExecutor(jobs);
    const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "wdr" };
    const job = jobs.enqueue(scope, "media.transcode", { source: "cancel" });
    let observedAbort = false;
    executor.register("media.transcode", (_job, _scope, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { observedAbort = true; reject(new Error("cancelled")); }, { once: true });
    }));
    const running = executor.runOnce(scope);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executor.cancel(scope, job.id)?.status, "cancelled");
    assert.equal((await running), undefined);
    assert.equal(observedAbort, true);
    assert.equal(jobs.list(scope)[0]?.status, "cancelled");
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("organization cancellation aborts an active handler before closing the job", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-job-org-cancel-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', '2026-01-01T00:00:00.000Z', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Organization'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'a', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z');");
    const jobs = new PluginJobService(database.db);
    const executor = new JobExecutor(jobs);
    const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "plugin" };
    let aborted = false;
    executor.register("media.transcode", (_job, _scope, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
    }));
    const job = jobs.enqueue(scope, "media.transcode", { mediaId: "opaque" });
    const running = executor.runOnce(scope);
    await new Promise((resolve) => setImmediate(resolve));
    const cancelled = executor.cancelOrganization(scope.organizationId, job.id);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(aborted, true);
    await running;
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("job executor drains only a bounded FIFO batch", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-job-drain-"));
  const database = openDatabase(dataDir);
  try {
    database.db.exec("INSERT INTO deployments (id, created_at, locale) VALUES ('dep', '2026-01-01T00:00:00.000Z', 'en'); INSERT INTO organizations (id, deployment_id, name) VALUES ('org', 'dep', 'Organization'); INSERT INTO users (id, organization_id, username, password_hash, role, locale, created_at) VALUES ('user', 'org', 'a', 'hash', 'member', 'en', '2026-01-01T00:00:00.000Z');");
    const jobs = new PluginJobService(database.db);
    const executor = new JobExecutor(jobs);
    const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "wdr" };
    const created = [jobs.enqueue(scope, "media.transcode", { n: 1 }), jobs.enqueue(scope, "media.transcode", { n: 2 }), jobs.enqueue(scope, "media.transcode", { n: 3 })];
    executor.register("media.transcode", (job) => ({ n: (job.payload as { n: number }).n }));
    assert.deepEqual((await executor.runUntilIdle(scope, 2)).map((job) => job.id), created.slice(0, 2).map((job) => job.id));
    assert.equal(jobs.list(scope).filter((job) => job.status === "queued").length, 1);
    await assert.rejects(() => executor.runUntilIdle(scope, 0));
    assert.equal((await executor.runUntilIdle(scope)).length, 1);
  } finally {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
