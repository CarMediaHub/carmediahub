import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { buildBrowserLaunchSpec } from "./browser-engine-launcher.js";

const scope = { organizationId: "org", userId: "user", installationId: "plugin_abc", sessionId: "browser_session" };

test("browser launch spec is silent, isolated and pipe-based", () => {
  const spec = buildBrowserLaunchSpec("C:/cmh-data", scope);
  assert.equal(spec.userDataDir, path.resolve("C:/cmh-data", "browser", "sessions", "org", "user", "plugin_abc", "browser_session"));
  assert.equal(spec.args.includes("--mute-audio"), true);
  assert.equal(spec.args.includes("--remote-debugging-pipe"), true);
  assert.equal(spec.args.some((arg) => arg.startsWith("--remote-debugging-port=")), false);
  assert.equal(spec.args.some((arg) => arg.startsWith("--user-data-dir=")), true);
});

test("browser launch spec rejects unsafe scope identities", () => {
  assert.throws(() => buildBrowserLaunchSpec("C:/cmh-data", { ...scope, userId: "../other" }), /identity is invalid/);
  assert.throws(() => buildBrowserLaunchSpec("C:/cmh-data", { ...scope, sessionId: "" }), /identity is invalid/);
});
