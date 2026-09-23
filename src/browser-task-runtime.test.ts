import assert from "node:assert/strict";
import test from "node:test";
import type { ComponentCatalogItem } from "./components.js";
import { BrowserTargetRegistry } from "./browser-target-registry.js";
import { createManagedBrowserWorkerOptionsResolver } from "./browser-task-runtime.js";
import type { Repository } from "./repository.js";
import { currentPlatformKey } from "./components.js";

const scope = { deploymentId: "dep", organizationId: "org", userId: "user", deviceId: "vehicle", sessionId: "runtime", installationId: "plugin" };
const task = { id: "task", sessionId: "browser-session", kind: "navigate-and-capture" as const, status: "running" as const, input: { target: "fixture" }, createdAt: "", updatedAt: "" };
const catalog: ComponentCatalogItem[] = [
  { id: "chromium", version: "1.0.0", provides: ["browser-engine"], platforms: [currentPlatformKey()], status: "installed", executable: "chromium/1.0.0/chromium" },
  { id: "other", version: "1.0.0", provides: ["browser-engine"], platforms: [currentPlatformKey()], status: "installed", executable: "other/1.0.0/other" }
];

test("managed browser resolver selects a healthy Core component and binds the task session", async () => {
  const registry = new BrowserTargetRegistry(); registry.register({ id: "fixture", origins: ["https://fixture.example"] });
  const repository = { pluginHasCapability: () => true, componentById: (id: string) => id === "chromium" ? { id, version: "1.0.0", executable: "chromium/1.0.0/chromium", checksum: "a".repeat(64), health: "healthy" } : undefined } as unknown as Repository;
  const resolve = createManagedBrowserWorkerOptionsResolver({ dataDir: "data", catalog, repository, targetRegistry: registry });
  const options = await resolve(scope, task);
  assert.equal(options.component.id, "chromium");
  assert.equal(options.scope.sessionId, "browser-session");
  assert.equal(options.targetId, "fixture");
});

test("managed browser resolver refuses missing capability or unhealthy components", async () => {
  const registry = new BrowserTargetRegistry(); registry.register({ id: "fixture", origins: ["https://fixture.example"] });
  const noCapability = { pluginHasCapability: () => false, componentById: () => undefined } as unknown as Repository;
  await assert.rejects(() => createManagedBrowserWorkerOptionsResolver({ dataDir: "data", catalog, repository: noCapability, targetRegistry: registry })(scope, task), /capability/);
  const unhealthy = { pluginHasCapability: () => true, componentById: () => ({ id: "chromium", version: "1.0.0", executable: "chromium/1.0.0/chromium", checksum: "a".repeat(64), health: "unhealthy" }) } as unknown as Repository;
  await assert.rejects(() => createManagedBrowserWorkerOptionsResolver({ dataDir: "data", catalog, repository: unhealthy, targetRegistry: registry })(scope, task), /healthy browser-engine/);
});

test("managed browser resolver refuses a browser component for another platform", async () => {
  const registry = new BrowserTargetRegistry(); registry.register({ id: "fixture", origins: ["https://fixture.example"] });
  const repository = { pluginHasCapability: () => true, componentById: () => ({ id: "chromium", version: "1.0.0", executable: "chromium/1.0.0/chromium", checksum: "a".repeat(64), health: "healthy" }) } as unknown as Repository;
  const foreignPlatform = currentPlatformKey() === "linux-x64" ? "windows-x64" : "linux-x64";
  const foreign = [{ id: "chromium", version: "1.0.0", provides: ["browser-engine"], platforms: [foreignPlatform], status: "installed", executable: "chromium/1.0.0/chromium" }] as unknown as ComponentCatalogItem[];
  await assert.rejects(() => createManagedBrowserWorkerOptionsResolver({ dataDir: "data", catalog: foreign, repository, targetRegistry: registry })(scope, task), /healthy browser-engine/);
});
