import assert from "node:assert/strict";
import test from "node:test";
import { PluginDrainManager } from "./plugin-drain.js";

test("plugin drain rejects new leases and waits for active work", async () => {
  const drain = new PluginDrainManager();
  const lease = drain.acquire("plugin");
  assert.ok(lease);
  assert.equal(drain.begin("plugin"), true);
  assert.equal(drain.acquire("plugin"), undefined);
  const idle = drain.waitForIdle("plugin", 100);
  lease!.release();
  assert.equal(await idle, true);
  drain.resume("plugin");
  assert.ok(drain.acquire("plugin"));
});

test("plugin drain times out without cancelling active work", async () => {
  const drain = new PluginDrainManager();
  const lease = drain.acquire("plugin");
  assert.ok(lease);
  drain.begin("plugin");
  assert.equal(await drain.waitForIdle("plugin", 1), false);
  lease!.release();
  drain.resume("plugin");
});
