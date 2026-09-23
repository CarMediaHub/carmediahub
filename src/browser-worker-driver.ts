import { chromium, type BrowserContext, type BrowserType } from "playwright-core";
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
  navigate(targetId: string, relativePath?: string): Promise<Awaited<ReturnType<BrowserContext["newPage"]>>>;
  stop(): Promise<void>;
}

export async function navigateToTarget(handle: Pick<BrowserWorkerHandle, "context">, registry: BrowserTargetRegistry, targetId: string, relativePath = "/") {
  const url = registry.resolveUrl(targetId, relativePath);
  const page = await handle.context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

/** Core-owned Playwright adapter. It exposes a context only to Core Worker code. */
export async function startBrowserWorker(options: BrowserWorkerDriverOptions): Promise<BrowserWorkerHandle> {
  const executable = resolveInstalledExecutable(options.dataDir, options.component);
  const catalogComponent = options.catalog.find((candidate) => candidate.id === options.component.id);
  if (catalogComponent === undefined || !catalogComponent.provides.includes("browser-engine")) throw new Error("Browser component role is unavailable");
  const launch = buildBrowserLaunchSpec(options.dataDir, options.scope);
  const runtime = options.runtime ?? chromium;
  const context = await runtime.launchPersistentContext(launch.userDataDir, {
    executablePath: executable,
    args: [...launch.args],
    headless: true,
    acceptDownloads: false,
    permissions: [],
    serviceWorkers: "block"
  });
  let policy: Awaited<ReturnType<typeof installBrowserNetworkPolicy>>;
  try { policy = await installBrowserNetworkPolicy(context, options.targetRegistry, options.targetId); }
  catch (error) { await context.close(); throw error; }
  const pages = new Set<Awaited<ReturnType<BrowserContext["newPage"]>>>();
  let stopped = false;
  const navigate = async (targetId: string, relativePath = "/") => {
    if (stopped) throw new Error("Browser worker is stopped");
    const page = await navigateToTarget({ context }, options.targetRegistry, targetId, relativePath);
    pages.add(page);
    page.once("close", () => pages.delete(page));
    return page;
  };
  return { context, launch, navigate, stop: async () => { if (stopped) return; stopped = true; await policy.remove(); await Promise.all([...pages].map((page) => page.close().catch(() => undefined))); pages.clear(); await context.close(); } };
}
