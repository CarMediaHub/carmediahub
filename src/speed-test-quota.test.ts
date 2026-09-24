import assert from "node:assert/strict";
import test from "node:test";
import { SpeedTestQuota } from "./speed-test-quota.js";

test("speed test quota limits concurrent and completed tests per subject", () => {
  const quota = new SpeedTestQuota(2, 1_000);
  const first = quota.tryAcquire("user-a", 0);
  assert.ok(first);
  assert.equal(quota.tryAcquire("user-a", 0), undefined);
  first.release();
  const second = quota.tryAcquire("user-a", 100);
  assert.ok(second);
  second.release();
  assert.equal(quota.tryAcquire("user-a", 200), undefined);
  assert.ok(quota.tryAcquire("user-a", 1_000));
  assert.ok(quota.tryAcquire("user-b", 200));
});

test("speed test quota release is idempotent", () => {
  const quota = new SpeedTestQuota(1);
  const lease = quota.tryAcquire("user-a");
  assert.ok(lease);
  lease.release();
  lease.release();
  assert.equal(quota.tryAcquire("user-a"), undefined);
});
