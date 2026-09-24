import { chromium, type BrowserContext, type BrowserType } from "playwright-core";
import crypto from "node:crypto";
import fs from "node:fs";
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
  component: { id: string; version: string; executable: string; checksum: string; verified: boolean };
  catalog: readonly ComponentCatalogItem[];
  scope: BrowserWorkerScope;
  targetRegistry: BrowserTargetRegistry;
  targetId: string;
  maxPages?: number;
  runtime?: Pick<BrowserType, "launchPersistentContext">;
}

export interface BrowserWorkerHandle {
  readonly context: BrowserContext;
  readonly launch: BrowserLaunchSpec;
  navigate(targetId: string, relativePath?: string): Promise<Awaited<ReturnType<BrowserContext["newPage"]>>>;
  stop(): Promise<void>;
}

async function verifyExecutableDigest(executable: string, expected: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(expected)) throw new Error("Browser component digest is invalid");
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(executable)) hash.update(chunk as Buffer);
  if (hash.digest("hex") !== expected) throw new Error("Browser component digest mismatch");
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
  if (options.component.verified !== true) throw new Error("Browser component is not verified");
  const executable = resolveInstalledExecutable(options.dataDir, options.component);
  const catalogComponent = options.catalog.find((candidate) => candidate.id === options.component.id);
  if (catalogComponent === undefined || !catalogComponent.provides.includes("browser-engine")) throw new Error("Browser component role is unavailable");
  await verifyExecutableDigest(executable, options.component.checksum);
  const launch = buildBrowserLaunchSpec(options.dataDir, options.scope);
  const runtime = options.runtime ?? chromium;
  const context = await runtime.launchPersistentContext(launch.userDataDir, {
    executablePath: executable,
    env: {},
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
  const maxPages = options.maxPages ?? 8;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 32) { await policy.remove(); await context.close(); throw new Error("Browser page limit is invalid"); }
  let stopped = false;
  const navigate = async (targetId: string, relativePath = "/") => {
    if (stopped) throw new Error("Browser worker is stopped");
    if (targetId !== options.targetId) throw new Error("Browser worker target mismatch");
    if (pages.size >= maxPages) throw new Error("Browser page limit exceeded");
    const page = await navigateToTarget({ context }, options.targetRegistry, targetId, relativePath);
    pages.add(page);
    page.once("close", () => pages.delete(page));
    return page;
  };
  return { context, launch, navigate, stop: async () => { if (stopped) return; stopped = true; await policy.remove(); await Promise.all([...pages].map((page) => page.close().catch(() => undefined))); pages.clear(); await context.close(); } };
}
