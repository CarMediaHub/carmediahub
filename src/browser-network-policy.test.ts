import assert from "node:assert/strict";
import test from "node:test";
import { BrowserTargetRegistry } from "./browser-target-registry.js";
import { installBrowserNetworkPolicy } from "./browser-network-policy.js";

test("browser network policy continues registered HTTPS origins and aborts everything else", async () => {
  const registry = new BrowserTargetRegistry();
  registry.register({ id: "media", origins: ["https://media.example"] });
  let handler: ((route: any) => Promise<void>) | undefined;
  let removed = false;
  let wsRemoved = false;
  let wsHandler: ((socket: any) => void) | undefined;
  const context = { route: async (_pattern: string, value: (route: any) => Promise<void>) => { handler = value; }, unroute: async () => { removed = true; }, routeWebSocket: async (_pattern: string, value: (socket: any) => void) => { wsHandler = value; }, unrouteWebSocket: async () => { wsRemoved = true; } };
  const policy = await installBrowserNetworkPolicy(context, registry, "media");
  let continued = 0;
  let aborted = 0;
  const route = (url: string, location?: string) => ({ request: () => ({ url: () => url }), continue: async () => { continued += 1; }, fetch: async () => ({ headers: () => location === undefined ? {} : { location } }), fulfill: async () => { continued += 1; }, abort: async () => { aborted += 1; } });
  await handler!(route("https://media.example/video"));
  await handler!(route("http://media.example/insecure"));
  await handler!(route("https://other.example/escape"));
  await handler!(route("https://media.example/redirect", "https://other.example/escape"));
  assert.equal(continued, 1);
  assert.equal(aborted, 3);
  let wsClosed = 0;
  wsHandler!({ url: () => "wss://media.example/socket", close: () => { wsClosed += 10; } });
  wsHandler!({ url: () => "wss://other.example/socket", close: () => { wsClosed += 1; } });
  assert.equal(wsClosed, 1);
  await policy.remove();
  assert.equal(removed, true);
  assert.equal(wsRemoved, true);
  assert.equal(wsClosed, 11);
  let closedAfterRemove = 0;
  wsHandler!({ url: () => "wss://media.example/socket", close: () => { closedAfterRemove += 1; } });
  assert.equal(closedAfterRemove, 1);
});

test("browser network policy rejects unknown targets", async () => {
  const context = { route: async () => undefined, unroute: async () => undefined };
  await assert.rejects(() => installBrowserNetworkPolicy(context, new BrowserTargetRegistry(), "missing"), /not registered/);
});

test("browser network policy bounds same-origin redirect chains", async () => {
  const registry = new BrowserTargetRegistry();
  registry.register({ id: "media", origins: ["https://media.example"] });
  let handler: ((route: any) => Promise<void>) | undefined;
  const context = { route: async (_pattern: string, value: (route: any) => Promise<void>) => { handler = value; }, unroute: async () => undefined };
  await installBrowserNetworkPolicy(context, registry, "media");
  let aborted = 0;
  const request = (depth: number): any => ({ url: () => "https://media.example/redirect", redirectedFrom: depth === 0 ? undefined : () => request(depth - 1) });
  const route = { request: () => request(4), fetch: async () => ({ headers: () => ({}) }), fulfill: async () => undefined, abort: async () => { aborted += 1; } };
  await handler!(route);
  assert.equal(aborted, 1);
});
