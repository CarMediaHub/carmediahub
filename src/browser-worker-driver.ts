import type { BrowserContext, BrowserType } from "playwright-core";
import { resolveInstalledExecutable, type ComponentCatalogItem } from "./components.js";
import { buildBrowserLaunchSpec, type BrowserLaunchSpec } from "./browser-engine-launcher.js";
import { installBrowserNetworkPolicy } from "./browser-network-policy.js";
import { BrowserTargetRegistry } from "./browser-target-registry.js";

export interface BrowserWorkerScope {
  organizationId: string;
  userId: string;
  installationId: string;
  sessionId: string;
}

export interface BrowserWorkerDriverOptions {
  dataDir: string;
  component: { id: string; version: string; executable: string; checksum: string };
  catalog: readonly ComponentCatalogItem[];
  scope: BrowserWorkerScope;
  targetRegistry: BrowserTargetRegistry;
  targetId: string;
  runtime?: Pick<BrowserType, "launchPersistentContext">;
}

export interface BrowserWorkerHandle {
  readonly context: BrowserContext;
  readonly launch: BrowserLaunchSpec;
  stop(): Promise<void>;
}

/** Core-owned Playwright adapter. It exposes a context only to Core Worker code. */
export async function startBrowserWorker(options: BrowserWorkerDriverOptions): Promise<BrowserWorkerHandle> {
  const executable = resolveInstalledExecutable(options.dataDir, options.component);
  const catalogComponent = options.catalog.find((candidate) => candidate.id === options.component.id);
  if (catalogComponent === undefined || !catalogComponent.provides.includes("browser-engine")) throw new Error("Browser component role is unavailable");
  const launch = buildBrowserLaunchSpec(options.dataDir, options.scope);
  const runtime = options.runtime;
  if (runtime === undefined) throw new Error("Browser runtime is not configured");
  const context = await runtime.launchPersistentContext(launch.userDataDir, {
    executablePath: executable,
    args: [...launch.args],
    headless: true,
    acceptDownloads: false,
    serviceWorkers: "block"
  });
  let policy: Awaited<ReturnType<typeof installBrowserNetworkPolicy>>;
  try { policy = await installBrowserNetworkPolicy(context, options.targetRegistry, options.targetId); }
  catch (error) { await context.close(); throw error; }
  return { context, launch, stop: async () => { await policy.remove(); await context.close(); } };
}
