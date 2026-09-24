import type { ScopeContext } from "@carmediahub/sdk";
import { BrowserTaskExecutor } from "./browser-task-executor.js";
import { Repository } from "./repository.js";

export interface BrowserTaskSchedulerOptions { intervalMs?: number; maxTasksPerScope?: number; }
export type BrowserScopeResolver = (userId: string, installationId: string) => ScopeContext | undefined;

/** Recovers only queued tasks attached to active browser sessions. */
export class BrowserTaskRecoveryScheduler {
  private readonly intervalMs: number;
  private readonly maxTasksPerScope: number;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<number> | undefined;

  constructor(private readonly repository: Repository, private readonly executor: BrowserTaskExecutor, private readonly resolveScope: BrowserScopeResolver, options: BrowserTaskSchedulerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.maxTasksPerScope = options.maxTasksPerScope ?? 10;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 100 || this.intervalMs > 60_000) throw new Error("Browser task scheduler interval is invalid");
    if (!Number.isSafeInteger(this.maxTasksPerScope) || this.maxTasksPerScope < 1 || this.maxTasksPerScope > 100) throw new Error("Browser task scheduler batch size is invalid");
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => { void this.runOnce().catch(() => undefined); }, this.intervalMs);
    this.timer.unref();
    void this.runOnce().catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined; }
    await this.activeRun?.catch(() => undefined);
  }

  async runOnce(): Promise<number> {
    if (this.activeRun !== undefined) return this.activeRun;
    const run = this.execute();
    this.activeRun = run;
    try { return await run; }
    finally { if (this.activeRun === run) this.activeRun = undefined; }
  }

  private async execute(): Promise<number> {
    let completed = 0;
    for (const queued of this.repository.queuedBrowserScopes()) {
      const scope = this.resolveScope(queued.userId, queued.installationId);
      if (scope !== undefined) completed += (await this.executor.runUntilIdle(scope, this.maxTasksPerScope)).length;
    }
    return completed;
  }
}
