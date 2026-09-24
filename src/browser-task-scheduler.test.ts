import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserTaskExecutor } from "./browser-task-executor.js";
import { BrowserTaskRecoveryScheduler } from "./browser-task-scheduler.js";
import { openDatabase } from "./database.js";
import { Repository } from "./repository.js";

function setup(expiresInSeconds = 300) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-browser-scheduler-"));
  const database = openDatabase(dataDir);
  const repository = new Repository(database.db, Buffer.alloc(32, 9));
  repository.bootstrap("admin", "correct horse battery staple", "en");
  const user = database.db.prepare("SELECT id, organization_id FROM users LIMIT 1").get() as { id: string; organization_id: string };
  const scope = { deploymentId: "core", organizationId: user.organization_id, userId: user.id, deviceId: "core", sessionId: "scheduler", installationId: "plugin" } as const;
  repository.createBrowserSession(scope, { name: "fixture", purpose: "scheduler test", expiresInSeconds });
  const session = repository.browserSessions(scope)[0]!;
  const task = repository.createBrowserTask(scope, { sessionId: session.id, kind: "navigate-and-capture", input: { target: "fixture" } });
  return { dataDir, database, repository, scope, session, task };
}

function finish(dataDir: string, database: ReturnType<typeof openDatabase>): void {
  database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function executor(repository: Repository, seen: string[] = []): BrowserTaskExecutor {
  const value = new BrowserTaskExecutor(repository);
  value.register("navigate-and-capture", async (task) => {
    seen.push(task.id);
    return { kind: "navigate-and-capture", fields: { status: 200 }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }, { allowedTargets: ["fixture"] });
  return value;
}

test("scheduler recovers queued tasks for active sessions", async () => {
  const fixture = setup();
  try {
    const seen: string[] = [];
    const scheduler = new BrowserTaskRecoveryScheduler(fixture.repository, executor(fixture.repository, seen), () => fixture.scope);
    assert.equal(await scheduler.runOnce(), 1);
    assert.deepEqual(seen, [fixture.task.id]);
    assert.equal(fixture.repository.browserTasks(fixture.scope)[0]?.status, "succeeded");
    assert.equal(await scheduler.runOnce(), 0);
  } finally { finish(fixture.dataDir, fixture.database); }
});

test("scheduler excludes expired sessions", async () => {
  const fixture = setup(30);
  try {
    fixture.database.db.prepare("UPDATE browser_sessions SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1_000).toISOString(), fixture.session.id);
    assert.deepEqual(fixture.repository.queuedBrowserScopes(), []);
    const scheduler = new BrowserTaskRecoveryScheduler(fixture.repository, executor(fixture.repository), () => fixture.scope);
    assert.equal(await scheduler.runOnce(), 0);
    assert.equal(fixture.repository.browserTasks(fixture.scope)[0]?.status, "queued");
  } finally { finish(fixture.dataDir, fixture.database); }
});

test("scheduler validates interval and batch limits", () => {
  const fixture = setup();
  try {
    assert.throws(() => new BrowserTaskRecoveryScheduler(fixture.repository, executor(fixture.repository), () => fixture.scope, { intervalMs: 99 }));
    assert.throws(() => new BrowserTaskRecoveryScheduler(fixture.repository, executor(fixture.repository), () => fixture.scope, { maxTasksPerScope: 101 }));
  } finally { finish(fixture.dataDir, fixture.database); }
});

test("scheduler stop waits for the active recovery round", async () => {
  const fixture = setup();
  try {
    const browserExecutor = new BrowserTaskExecutor(fixture.repository);
    let release!: () => void;
    browserExecutor.register("navigate-and-capture", () => new Promise<void>((resolve) => { release = resolve; }), { allowedTargets: ["fixture"] });
    const scheduler = new BrowserTaskRecoveryScheduler(fixture.repository, browserExecutor, () => fixture.scope, { intervalMs: 100 });
    const running = scheduler.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    release();
    await Promise.all([running, stopping]);
    assert.equal(stopped, true);
  } finally { finish(fixture.dataDir, fixture.database); }
});
