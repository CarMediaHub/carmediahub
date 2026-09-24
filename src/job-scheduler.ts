import type { ScopeContext } from "@carmediahub/sdk";
import { JobExecutor } from "./job-executor.js";
import { PluginJobService } from "./job-service.js";

export interface JobRecoverySchedulerOptions {
  intervalMs?: number;
  maxJobsPerScope?: number;
}

export type JobScopeResolver = (userId: string, installationId: string) => ScopeContext | undefined;

/** Core-owned queued job recovery. It never interprets plugin payloads or starts arbitrary commands. */
export class JobRecoveryScheduler {
  private readonly intervalMs: number;
  private readonly maxJobsPerScope: number;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<number> | undefined;

  constructor(
    private readonly jobs: PluginJobService,
    private readonly executor: JobExecutor,
    private readonly resolveScope: JobScopeResolver,
    options: JobRecoverySchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.maxJobsPerScope = options.maxJobsPerScope ?? 10;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 100 || this.intervalMs > 60_000) throw new Error("Job scheduler interval is invalid");
    if (!Number.isSafeInteger(this.maxJobsPerScope) || this.maxJobsPerScope < 1 || this.maxJobsPerScope > 100) throw new Error("Job scheduler batch size is invalid");
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => { void this.runOnce().catch(() => undefined); }, this.intervalMs);
    this.timer.unref();
    void this.runOnce().catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
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
    try {
      for (const queued of this.jobs.queuedScopes()) {
        const scope = this.resolveScope(queued.userId, queued.installationId);
        if (scope !== undefined) completed += (await this.executor.runUntilIdle(scope, this.maxJobsPerScope)).length;
      }
      return completed;
    } finally { /* keep the active promise until callers observe its result */ }
  }
}
