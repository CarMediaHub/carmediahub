import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWorkerDriverOptions, BrowserWorkerHandle } from "./browser-worker-driver.js";
import { BrowserWorkerManager } from "./browser-worker-manager.js";
import { createNavigateAndCaptureHandler } from "./browser-task-handlers.js";

const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "vehicle", sessionId: "runtime", installationId: "plugin" };
function options(): BrowserWorkerDriverOptions {
  return { dataDir: "data", component: { id: "chromium", version: "1.0.0", executable: "chromium/1.0.0/chromium", checksum: "a".repeat(64) }, catalog: [], scope: { organizationId: "org", userId: "user", installationId: "plugin", sessionId: "browser-session" }, targetRegistry: {} as BrowserWorkerDriverOptions["targetRegistry"], targetId: "fixture" };
}

test("navigate-and-capture returns only a bounded title and closes the page", async () => {
  let closed = 0;
  const page = { title: async () => "  Fixture title  ", close: async () => { closed += 1; } };
  const worker = { navigate: async () => page, stop: async () => undefined, context: {} as never, launch: {} as never } as unknown as BrowserWorkerHandle;
  const manager = new BrowserWorkerManager(async () => worker);
  const handler = createNavigateAndCaptureHandler(manager, async () => options());
  const result = await handler({ id: "task", sessionId: "browser-session", kind: "navigate-and-capture", status: "running", input: { target: "fixture" }, createdAt: "", updatedAt: "" }, scope, new AbortController().signal);
  assert.equal(result?.fields?.page_title, "Fixture title");
  assert.equal(result?.reference, undefined);
  assert.equal(closed, 1);
});

test("navigate-and-capture rejects a resolver that changes scope or target", async () => {
  const worker = { navigate: async () => { throw new Error("must not navigate"); }, stop: async () => undefined, context: {} as never, launch: {} as never } as unknown as BrowserWorkerHandle;
  const manager = new BrowserWorkerManager(async () => worker);
  const handler = createNavigateAndCaptureHandler(manager, async () => ({ ...options(), targetId: "other" }));
  await assert.rejects(() => handler({ id: "task", sessionId: "browser-session", kind: "navigate-and-capture", status: "running", input: { target: "fixture" }, createdAt: "", updatedAt: "" }, scope, new AbortController().signal), /scope or target mismatch/);
});
