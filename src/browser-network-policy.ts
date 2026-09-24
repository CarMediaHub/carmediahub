import type { BrowserContext, Route, WebSocketRoute } from "playwright-core";
import { BrowserTargetRegistry } from "./browser-target-registry.js";

export const BROWSER_NETWORK_BLOCKED = "CMH.BROWSER.NETWORK_BLOCKED";

export interface BrowserNetworkPolicyHandle {
  remove(): Promise<void>;
}

type BrowserNetworkContext = Pick<BrowserContext, "route" | "unroute"> & {
  routeWebSocket?: (pattern: string, handler: (socket: WebSocketRoute) => void) => Promise<void>;
  unrouteWebSocket?: (pattern: string, handler: (socket: WebSocketRoute) => void) => Promise<void>;
};

/** Installs a Core-owned request gate; plugins never receive the route handler. */
export async function installBrowserNetworkPolicy(context: BrowserNetworkContext, registry: BrowserTargetRegistry, targetId: string): Promise<BrowserNetworkPolicyHandle> {
  if (registry.get(targetId) === undefined) throw new Error("Browser target is not registered");
  let active = true;
  const handler = async (route: Route) => {
    let allowed = false;
    try { allowed = registry.allowsOrigin(targetId, new URL(route.request().url()).origin); } catch { allowed = false; }
    if (!allowed) { await route.abort("blockedbyclient"); return; }
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers()["location"];
    if (location !== undefined) {
      try { if (!registry.allowsOrigin(targetId, new URL(location, route.request().url()).origin)) { await route.abort("blockedbyclient"); return; } } catch { await route.abort("blockedbyclient"); return; }
    }
    await route.fulfill({ response });
  };
  await context.route("**/*", handler);
  const webSocketHandler = (socket: WebSocketRoute) => {
    if (!active) { socket.close(); return; }
    let allowed = false;
    try { allowed = registry.allowsOrigin(targetId, new URL(socket.url()).origin); } catch { allowed = false; }
    if (!allowed) socket.close();
  };
  if (context.routeWebSocket !== undefined) await context.routeWebSocket("**/*", webSocketHandler);
  return { remove: async () => {
    active = false;
    await context.unroute("**/*", handler);
    if (typeof context.unrouteWebSocket === "function" && context.routeWebSocket !== undefined) await context.unrouteWebSocket("**/*", webSocketHandler);
  } };
}
