import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTrustedNodeWorkerFactory } from "./trusted-worker-factory.js";

test("trusted Node factory resolves only a package-relative worker entry and stops the child", async () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-worker-package-"));
  const entry = path.join(packageRoot, "worker.js");
  fs.writeFileSync(entry, "export async function startWorker() { setInterval(() => {}, 1000); }", "utf8");
  try {
    assert.throws(() => createTrustedNodeWorkerFactory({ packageId: "pkg", packageRoot, workerEntry: "../worker.js" }));
    const factory = createTrustedNodeWorkerFactory({ packageId: "pkg", packageRoot, workerEntry: "./worker.js" });
    const handle = await factory.start({ installationId: "installation", endpoint: "local", runtimeCredential: "credential", scope: { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "device", sessionId: "session", installationId: "installation", locale: "en", timeZone: "UTC", theme: "system", density: "comfortable", entry: "navigation", display: { deviceClass: "unknown", input: [], fullscreenAvailable: false, viewport: { width: 0, height: 0 } }, policyVersion: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    handle.stop();
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});
