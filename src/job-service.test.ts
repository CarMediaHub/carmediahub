import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./database.js";
import { MAX_ACTIVE_JOBS_PER_SCOPE, MAX_ACTIVE_MEDIA_JOBS_PER_INSTALLATION, MAX_JOB_PAYLOAD_BYTES, PluginJobService } from "./job-service.js";

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
