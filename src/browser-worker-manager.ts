import type { BrowserWorkerDriverOptions, BrowserWorkerHandle, BrowserWorkerScope } from "./browser-worker-driver.js";
import { startBrowserWorker } from "./browser-worker-driver.js";

export type BrowserWorkerStarter = (options: BrowserWorkerDriverOptions) => Promise<BrowserWorkerHandle>;

interface ManagedWorker {
  readonly targetId: string;
  readonly handle: BrowserWorkerHandle;
}

/** Core-owned lifecycle registry: one isolated Worker per scoped browser session. */
export class BrowserWorkerManager {
  private readonly workers = new Map<string, ManagedWorker>();

  constructor(private readonly starter: BrowserWorkerStarter = startBrowserWorker) {}

  async acquire(options: BrowserWorkerDriverOptions): Promise<BrowserWorkerHandle> {
    const key = scopeKey(options.scope);
    const existing = this.workers.get(key);
    if (existing !== undefined) {
      if (existing.targetId !== options.targetId) throw new Error("Browser worker target mismatch");
      return existing.handle;
    }
    const handle = await this.starter(options);
    this.workers.set(key, { targetId: options.targetId, handle });
    return handle;
  }

  has(scope: BrowserWorkerScope): boolean { return this.workers.has(scopeKey(scope)); }

  async stop(scope: BrowserWorkerScope): Promise<boolean> {
    const key = scopeKey(scope);
    const worker = this.workers.get(key);
    if (worker === undefined) return false;
    this.workers.delete(key);
    await worker.handle.stop();
    return true;
  }

  async stopAll(): Promise<void> {
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(workers.map((worker) => worker.handle.stop()));
  }
}

function scopeKey(scope: BrowserWorkerScope): string {
  return [scope.organizationId, scope.userId, scope.installationId, scope.sessionId].join("\0");
}
