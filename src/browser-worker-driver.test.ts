import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadComponentCatalog } from "./components.js";
import { startBrowserWorker } from "./browser-worker-driver.js";

test("browser worker driver launches only the verified browser-engine component", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-browser-driver-"));
  const location = path.join(dataDir, "components", "chromium", "1.0.0");
  fs.mkdirSync(location, { recursive: true });
  const executable = process.platform === "win32" ? "chromium.exe" : "chromium";
  fs.writeFileSync(path.join(location, executable), "browser-fixture");
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(path.join(location, executable))).digest("hex");
  let captured: { executablePath?: string; args?: readonly string[]; userDataDir?: string } | undefined;
  let closed = false;
  const fakeContext = { close: async () => { closed = true; } } as never;
  try {
    const handle = await startBrowserWorker({
      dataDir,
      component: { id: "chromium", version: "1.0.0", executable: `chromium/1.0.0/${executable}`, checksum },
      catalog: loadComponentCatalog(path.resolve(import.meta.dirname, "..")),
      scope: { organizationId: "org", userId: "user", installationId: "plugin_abc", sessionId: "browser_session" },
      runtime: { launchPersistentContext: async (userDataDir, options) => { captured = { executablePath: options.executablePath, args: options.args, userDataDir }; return fakeContext; } }
    });
    assert.equal(captured?.executablePath, path.join(location, executable));
    assert.equal(captured?.userDataDir?.includes(path.join("browser", "sessions", "org", "user", "plugin_abc", "browser_session")), true);
    assert.equal(captured?.args?.includes("--mute-audio"), true);
    await handle.stop();
    assert.equal(closed, true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
