import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeRecoveryArgs } from "./native-recovery-smoke.mjs";

test("parses an explicit absolute bundle root", () => {
  assert.equal(parseNativeRecoveryArgs(["--bundle-root", String.raw`C:\tmp\carmediahub-native`]), String.raw`C:\tmp\carmediahub-native`);
  assert.equal(parseNativeRecoveryArgs(["--bundle-root", String.raw`C:\cmh-native`]), String.raw`C:\cmh-native`);
});

test("rejects relative bundle roots and unknown options", () => {
  assert.throws(() => parseNativeRecoveryArgs(["--bundle-root", "./native"]), /absolute/);
  assert.throws(() => parseNativeRecoveryArgs(["--unknown", "/tmp/native"]), /usage/);
  assert.throws(() => parseNativeRecoveryArgs(["--bundle-root"]), /usage/);
});
