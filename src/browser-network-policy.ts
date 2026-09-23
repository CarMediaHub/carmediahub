import type { BrowserContext, Route } from "playwright-core";
import { BrowserTargetRegistry } from "./browser-target-registry.js";

export const BROWSER_NETWORK_BLOCKED = "CMH.BROWSER.NETWORK_BLOCKED";

export interface BrowserNetworkPolicyHandle {
  remove(): Promise<void>;
}

/** Installs a Core-owned request gate; plugins never receive the route handler. */
export async function installBrowserNetworkPolicy(context: Pick<BrowserContext, "route" | "unroute">, registry: BrowserTargetRegistry, targetId: string): Promise<BrowserNetworkPolicyHandle> {
  if (registry.get(targetId) === undefined) throw new Error("Browser target is not registered");
  const handler = async (route: Route) => {
    let allowed = false;
    try { allowed = registry.allowsOrigin(targetId, new URL(route.request().url()).origin); } catch { allowed = false; }
    if (allowed) await route.continue();
    else await route.abort("blockedbyclient");
  };
  await context.route("**/*", handler);
  return { remove: () => context.unroute("**/*", handler) };
}
