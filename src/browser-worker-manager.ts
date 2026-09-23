import type { BrowserWorkerDriverOptions, BrowserWorkerHandle, BrowserWorkerScope } from "./browser-worker-driver.js";
import { startBrowserWorker } from "./browser-worker-driver.js";

export type BrowserWorkerStarter = (options: BrowserWorkerDriverOptions) => Promise<BrowserWorkerHandle>;

interface ManagedWorker {
  readonly sessionId: string;
  readonly userId: string;
  readonly installationId: string;
  readonly targetId: string;
  readonly handle: BrowserWorkerHandle;
}

/** Core-owned lifecycle registry: one isolated Worker per scoped browser session. */
export class BrowserWorkerManager {
  private readonly workers = new Map<string, ManagedWorker>();
  private readonly pending = new Map<string, Promise<BrowserWorkerHandle>>();

  constructor(private readonly starter: BrowserWorkerStarter = startBrowserWorker) {}

  async acquire(options: BrowserWorkerDriverOptions): Promise<BrowserWorkerHandle> {
    const key = scopeKey(options.scope);
    const existing = this.workers.get(key);
    if (existing !== undefined) {
      if (existing.targetId !== options.targetId) throw new Error("Browser worker target mismatch");
      return existing.handle;
    }
    const pending = this.pending.get(key);
    if (pending !== undefined) {
      const handle = await pending;
      if (options.targetId !== this.workers.get(key)?.targetId) throw new Error("Browser worker target mismatch");
      return handle;
    }
    const start = this.starter(options);
    this.pending.set(key, start);
    let handle: BrowserWorkerHandle;
    try { handle = await start; }
    finally { this.pending.delete(key); }
    this.workers.set(key, { sessionId: options.scope.sessionId, userId: options.scope.userId, installationId: options.scope.installationId, targetId: options.targetId, handle });
    return handle;
  }

  has(scope: BrowserWorkerScope): boolean { return this.workers.has(scopeKey(scope)); }

  async stop(scope: BrowserWorkerScope): Promise<boolean> {
    const key = scopeKey(scope);
    const pending = this.pending.get(key);
    if (pending !== undefined) {
      await pending.catch(() => undefined);
    }
    const worker = this.workers.get(key);
    if (worker === undefined) return false;
    this.workers.delete(key);
    await worker.handle.stop();
    return true;
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const pending = [...this.pending.entries()].filter(([key]) => key.split("\0")[3] === sessionId).map(([, promise]) => promise.catch(() => undefined));
    await Promise.all(pending);
    const entries = [...this.workers.entries()].filter(([, worker]) => worker.sessionId === sessionId);
    for (const [key, worker] of entries) { this.workers.delete(key); await worker.handle.stop(); }
    return entries.length > 0;
  }

  async stopInstallation(installationId: string): Promise<number> {
    const pending = [...this.pending.entries()].filter(([key]) => key.split("\0")[2] === installationId).map(([, promise]) => promise.catch(() => undefined));
    await Promise.all(pending);
    const entries = [...this.workers.entries()].filter(([, worker]) => worker.installationId === installationId);
    for (const [key] of entries) this.workers.delete(key);
    await Promise.all(entries.map(([, worker]) => worker.handle.stop()));
    return entries.length;
  }

  async stopUser(userId: string): Promise<number> {
    const pending = [...this.pending.entries()].filter(([key]) => key.split("\0")[1] === userId).map(([, promise]) => promise.catch(() => undefined));
    await Promise.all(pending);
    const entries = [...this.workers.entries()].filter(([, worker]) => worker.userId === userId);
    for (const [key] of entries) this.workers.delete(key);
    await Promise.all(entries.map(([, worker]) => worker.handle.stop()));
    return entries.length;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.pending.values()].map((promise) => promise.catch(() => undefined)));
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(workers.map((worker) => worker.handle.stop()));
  }
}

function scopeKey(scope: BrowserWorkerScope): string {
  return [scope.organizationId, scope.userId, scope.installationId, scope.sessionId].join("\0");
}
