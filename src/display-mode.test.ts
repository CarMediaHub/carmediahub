import assert from "node:assert/strict";
import test from "node:test";
import { requestDisplayMode } from "./app.js";

const scope = { deploymentId: "deployment", organizationId: "organization", userId: "user", deviceId: "vehicle", sessionId: "session", installationId: "plugin" };
const supported = { deviceClass: "vehicle" as const, input: ["touch" as const], fullscreenAvailable: true, viewport: { width: 1920, height: 1200 } };

test("display mode requests require a host executor before claiming fullscreen", async () => {
  assert.deepEqual(await requestDisplayMode({}, scope, supported, "fullscreen"), { mode: "fullscreen", accepted: false, reason: "user-action-required" });
  assert.deepEqual(await requestDisplayMode({}, scope, supported, "normal"), { mode: "normal", accepted: true });
});

test("display mode requests reject unsupported fullscreen and preserve scope", async () => {
  assert.deepEqual(await requestDisplayMode({ displayModeRequester: (received, mode) => { assert.deepEqual(received, scope); assert.equal(mode, "fullscreen"); return { mode, accepted: true }; } }, scope, { ...supported, fullscreenAvailable: false }, "fullscreen"), { mode: "fullscreen", accepted: false, reason: "unsupported" });
  let receivedScope: typeof scope | undefined;
  assert.deepEqual(await requestDisplayMode({ displayModeRequester: (received, mode) => { receivedScope = received; return { mode, accepted: true }; } }, scope, supported, "fullscreen"), { mode: "fullscreen", accepted: true });
  assert.deepEqual(receivedScope, scope);
});
