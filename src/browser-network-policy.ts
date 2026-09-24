import type { BrowserContext, Route, WebSocketRoute } from "playwright-core";
import { BrowserTargetRegistry } from "./browser-target-registry.js";

export const BROWSER_NETWORK_BLOCKED = "CMH.BROWSER.NETWORK_BLOCKED";
const MAX_SAME_ORIGIN_REDIRECTS = 3;

export interface BrowserNetworkPolicyHandle {
  remove(): Promise<void>;
}

type BrowserNetworkContext = Pick<BrowserContext, "route" | "unroute"> & {
  routeWebSocket?: (pattern: string, handler: (socket: WebSocketRoute) => void) => Promise<void>;
  unrouteWebSocket?: (pattern: string, handler: (socket: WebSocketRoute) => void) => Promise<void>;
};

function redirectDepth(request: { redirectedFrom?: () => { redirectedFrom?: () => unknown } | null }): number {
  let depth = 0;
  let previous = request.redirectedFrom?.() ?? null;
  while (previous !== null && previous !== undefined) {
    depth += 1;
    if (depth > MAX_SAME_ORIGIN_REDIRECTS) return depth;
    previous = previous.redirectedFrom?.() ?? null;
  }
  return depth;
}

function policyOrigin(value: string, websocket = false): string {
  const url = new URL(value);
  if (websocket && url.protocol === "wss:") url.protocol = "https:";
  else if (websocket && url.protocol === "ws:") url.protocol = "http:";
  return url.origin;
}

/** Installs a Core-owned request gate; plugins never receive the route handler. */
export async function installBrowserNetworkPolicy(context: BrowserNetworkContext, registry: BrowserTargetRegistry, targetId: string): Promise<BrowserNetworkPolicyHandle> {
  if (registry.get(targetId) === undefined) throw new Error("Browser target is not registered");
  let active = true;
  const activeSockets = new Set<WebSocketRoute>();
  const handler = async (route: Route) => {
    let allowed = false;
    const request = route.request();
    if (redirectDepth(request) > MAX_SAME_ORIGIN_REDIRECTS) { await route.abort("blockedbyclient"); return; }
    try { allowed = registry.allowsOrigin(targetId, new URL(request.url()).origin); } catch { allowed = false; }
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
    try { allowed = registry.allowsOrigin(targetId, policyOrigin(socket.url(), true)); } catch { allowed = false; }
    if (!allowed) { socket.close(); return; }
    activeSockets.add(socket);
    socket.onClose(() => activeSockets.delete(socket));
  };
  if (context.routeWebSocket !== undefined) await context.routeWebSocket("**/*", webSocketHandler);
  return { remove: async () => {
    active = false;
    await context.unroute("**/*", handler);
    if (typeof context.unrouteWebSocket === "function" && context.routeWebSocket !== undefined) await context.unrouteWebSocket("**/*", webSocketHandler);
    for (const socket of activeSockets) socket.close();
    activeSockets.clear();
  } };
}
