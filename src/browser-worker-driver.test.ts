import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadComponentCatalog } from "./components.js";
import { startBrowserWorker } from "./browser-worker-driver.js";
import { BrowserTargetRegistry } from "./browser-target-registry.js";

test("browser worker driver launches only the verified browser-engine component", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-browser-driver-"));
  const location = path.join(dataDir, "components", "chromium", "1.0.0");
  fs.mkdirSync(location, { recursive: true });
  const executable = process.platform === "win32" ? "chromium.exe" : "chromium";
  fs.writeFileSync(path.join(location, executable), "browser-fixture");
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(path.join(location, executable))).digest("hex");
  let captured: { executablePath?: string; args?: readonly string[]; userDataDir?: string; acceptDownloads?: boolean; permissions?: readonly string[]; serviceWorkers?: string } | undefined;
  let closed = false;
  let routed = false;
  let unrouted = false;
  const fakeContext = { close: async () => { closed = true; }, route: async () => { routed = true; }, unroute: async () => { unrouted = true; } } as never;
  try {
    const targetRegistry = new BrowserTargetRegistry();
    targetRegistry.register({ id: "media", origins: ["https://media.example"] });
    const handle = await startBrowserWorker({
      dataDir,
      component: { id: "chromium", version: "1.0.0", executable: `chromium/1.0.0/${executable}`, checksum },
      catalog: loadComponentCatalog(path.resolve(import.meta.dirname, "..")),
      scope: { organizationId: "org", userId: "user", installationId: "plugin_abc", sessionId: "browser_session" },
      targetRegistry,
      targetId: "media",
      runtime: { launchPersistentContext: async (userDataDir, options) => { captured = { executablePath: options.executablePath, args: options.args, userDataDir, acceptDownloads: options.acceptDownloads, permissions: options.permissions, serviceWorkers: options.serviceWorkers }; return fakeContext; } }
    });
    assert.equal(captured?.executablePath, path.join(location, executable));
    assert.equal(captured?.userDataDir?.includes(path.join("browser", "sessions", "org", "user", "plugin_abc", "browser_session")), true);
    assert.equal(captured?.args?.includes("--mute-audio"), true);
    assert.equal(captured?.acceptDownloads, false);
    assert.deepEqual(captured?.permissions, []);
    assert.equal(captured?.serviceWorkers, "block");
    assert.equal(routed, true);
    await handle.stop();
    assert.equal(closed, true);
    assert.equal(unrouted, true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("browser worker driver closes the context when network policy setup fails", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-browser-driver-fail-"));
  const location = path.join(dataDir, "components", "chromium", "1.0.0");
  fs.mkdirSync(location, { recursive: true });
  const executable = process.platform === "win32" ? "chromium.exe" : "chromium";
  fs.writeFileSync(path.join(location, executable), "browser-fixture");
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(path.join(location, executable))).digest("hex");
  let closed = false;
  const fakeContext = { close: async () => { closed = true; }, route: async () => undefined, unroute: async () => undefined } as never;
  const registry = new BrowserTargetRegistry();
  try {
    await assert.rejects(() => startBrowserWorker({
      dataDir,
      component: { id: "chromium", version: "1.0.0", executable: `chromium/1.0.0/${executable}`, checksum },
      catalog: loadComponentCatalog(path.resolve(import.meta.dirname, "..")),
      scope: { organizationId: "org", userId: "user", installationId: "plugin_abc", sessionId: "browser_session" },
      targetRegistry: registry,
      targetId: "missing",
      runtime: { launchPersistentContext: async () => fakeContext }
    }), /not registered/);
    assert.equal(closed, true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("browser worker driver has a Playwright Chromium runtime by default", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmh-browser-driver-default-"));
  try {
    await assert.rejects(() => startBrowserWorker({
      dataDir,
      component: { id: "chromium", version: "1.0.0", executable: "chromium/1.0.0/chromium", checksum: "0".repeat(64) },
      catalog: loadComponentCatalog(path.resolve(import.meta.dirname, "..")),
      scope: { organizationId: "org", userId: "user", installationId: "plugin_abc", sessionId: "browser_session" },
      targetRegistry: new BrowserTargetRegistry(),
      targetId: "missing"
    }), /unavailable/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("browser worker navigation resolves only a logical target and relative path", async () => {
  const { navigateToTarget } = await import("./browser-worker-driver.js");
  const registry = new BrowserTargetRegistry();
  registry.register({ id: "media", origins: ["https://media.example"] });
  let navigated = "";
  let closed = false;
  const page = { goto: async (url: string) => { navigated = url; }, close: async () => { closed = true; } };
  const handle = { context: { newPage: async () => page } } as never;
  const result = await navigateToTarget(handle, registry, "media", "/library");
  assert.equal(result, page);
  assert.equal(navigated, "https://media.example/library");
  await assert.rejects(() => navigateToTarget(handle, registry, "media", "https://evil.example"), /path is invalid/);
  assert.equal(closed, false);
});
