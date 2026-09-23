import assert from "node:assert/strict";
import test from "node:test";
import { BrowserWorkerManager } from "./browser-worker-manager.js";
import type { BrowserWorkerDriverOptions, BrowserWorkerHandle } from "./browser-worker-driver.js";

const scope = { organizationId: "org", userId: "user", installationId: "plugin", sessionId: "session" };
const options = (targetId: string): BrowserWorkerDriverOptions => ({
  dataDir: "C:/managed",
  component: { id: "chromium", version: "1", executable: "chromium/1/chromium", checksum: "a".repeat(64) },
  catalog: [], scope, targetRegistry: {} as never, targetId
});

function fakeHandle(stop: () => void): BrowserWorkerHandle {
  return { context: {} as never, launch: {} as never, navigate: async () => ({} as never), stop: async () => stop() };
}

test("browser worker manager reuses one scoped worker and rejects target changes", async () => {
  let starts = 0;
  let stops = 0;
  const manager = new BrowserWorkerManager(async (input) => { starts += 1; assert.equal(input.scope, scope); return fakeHandle(() => { stops += 1; }); });
  const first = await manager.acquire(options("media"));
  assert.equal(await manager.acquire(options("media")), first);
  assert.equal(starts, 1);
  await assert.rejects(() => manager.acquire(options("other")), /target mismatch/);
  assert.equal(starts, 1);
  assert.equal(manager.has(scope), true);
  assert.equal(await manager.stop(scope), true);
  assert.equal(await manager.stop(scope), false);
  assert.equal(stops, 1);
});

test("browser worker manager isolates scopes and stops all workers idempotently", async () => {
  let stops = 0;
  const manager = new BrowserWorkerManager(async () => fakeHandle(() => { stops += 1; }));
  const secondScope = { ...scope, userId: "other-user" };
  await manager.acquire(options("media"));
  await manager.acquire({ ...options("media"), scope: secondScope });
  assert.equal(manager.has(scope), true);
  assert.equal(manager.has(secondScope), true);
  await manager.stopAll();
  await manager.stopAll();
  assert.equal(stops, 2);
  assert.equal(manager.has(scope), false);
});

test("browser worker manager can stop a session without exposing its scope", async () => {
  let stops = 0;
  const manager = new BrowserWorkerManager(async () => fakeHandle(() => { stops += 1; }));
  await manager.acquire(options("media"));
  assert.equal(await manager.stopSession(scope.sessionId), true);
  assert.equal(await manager.stopSession(scope.sessionId), false);
  assert.equal(stops, 1);
});

test("browser worker manager deduplicates concurrent startup", async () => {
  let starts = 0;
  let release!: (handle: BrowserWorkerHandle) => void;
  const startGate = new Promise<BrowserWorkerHandle>((resolve) => { release = resolve; });
  const handle = fakeHandle(() => undefined);
  const manager = new BrowserWorkerManager(async () => { starts += 1; return startGate; });
  const first = manager.acquire(options("media"));
  const second = manager.acquire(options("media"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  release(handle);
  assert.equal(await first, handle);
  assert.equal(await second, handle);
});

test("browser worker manager stops a worker that finishes after revocation", async () => {
  let release!: (handle: BrowserWorkerHandle) => void;
  let stops = 0;
  const gate = new Promise<BrowserWorkerHandle>((resolve) => { release = resolve; });
  const manager = new BrowserWorkerManager(async () => gate);
  const starting = manager.acquire(options("media"));
  const stopping = manager.stop(scope);
  release(fakeHandle(() => { stops += 1; }));
  await stopping;
  await starting;
  assert.equal(stops, 1);
  assert.equal(manager.has(scope), false);
});
