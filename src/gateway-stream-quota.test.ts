import assert from "node:assert/strict";
import test from "node:test";
import { GatewayStreamQuota } from "./gateway-stream-quota.js";

test("gateway stream quota bounds a session and releases each lease once", () => {
  const quota = new GatewayStreamQuota(2);
  const first = quota.tryAcquire("session-a");
  const second = quota.tryAcquire("session-a");
  assert.notEqual(first, undefined);
  assert.notEqual(second, undefined);
  assert.equal(quota.tryAcquire("session-a"), undefined);
  assert.equal(quota.activeFor("session-a"), 2);
  first?.release();
  first?.release();
  assert.equal(quota.activeFor("session-a"), 1);
  assert.notEqual(quota.tryAcquire("session-a"), undefined);
  second?.release();
});

test("gateway stream quota isolates concurrent limits between sessions", () => {
  const quota = new GatewayStreamQuota(1);
  assert.notEqual(quota.tryAcquire("session-a"), undefined);
  assert.notEqual(quota.tryAcquire("session-b"), undefined);
  assert.throws(() => new GatewayStreamQuota(0), /positive integer/u);
});
