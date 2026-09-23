import type { BrowserTask, ScopeContext } from "@carmediahub/sdk";
import type { Page } from "playwright-core";
import type { BrowserWorkerDriverOptions } from "./browser-worker-driver.js";
import type { BrowserWorkerHandle } from "./browser-worker-driver.js";
import { BrowserWorkerManager } from "./browser-worker-manager.js";
import type { BrowserTaskHandler } from "./browser-task-executor.js";

export type BrowserWorkerOptionsResolver = (scope: ScopeContext, task: BrowserTask) => Promise<BrowserWorkerDriverOptions>;

/**
 * Core-owned navigation handler. The resolver supplies only Core-validated Worker options;
 * the returned task result never includes a Page, URL, cookie, profile or host path.
 */
export function createNavigateAndCaptureHandler(manager: BrowserWorkerManager, resolveOptions: BrowserWorkerOptionsResolver): BrowserTaskHandler {
  return async (task, scope, signal) => {
    if (signal.aborted) throw new Error("Browser task was cancelled");
    const target = task.input.target;
    if (target === undefined) throw new Error("Browser task target is missing");
    const options = await resolveOptions(scope, task);
    if (options.targetId !== target || !sameWorkerScope(options.scope, scope, task.sessionId)) throw new Error("Browser Worker scope or target mismatch");
    const worker = await manager.acquire(options);
    const page = await worker.navigate(target);
    const closeOnAbort = () => { void page.close().catch(() => undefined); };
    signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      if (signal.aborted) throw new Error("Browser task was cancelled");
      const title = await boundedTitle(page);
      return {
        kind: "navigate-and-capture",
        ...(title === undefined ? {} : { fields: { page_title: title } }),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
      };
    } finally {
      signal.removeEventListener("abort", closeOnAbort);
      await page.close().catch(() => undefined);
    }
  };
}

function sameWorkerScope(worker: BrowserWorkerDriverOptions["scope"], scope: ScopeContext, sessionId: string): boolean {
  return worker.organizationId === scope.organizationId && worker.userId === scope.userId && worker.installationId === scope.installationId && worker.sessionId === sessionId;
}

async function boundedTitle(page: Pick<Page, "title">): Promise<string | undefined> {
  const title = (await page.title()).trim();
  return title.length === 0 ? undefined : title.slice(0, 512);
}

export type { BrowserWorkerHandle };
