import type { ScopeContext } from "@carmediahub/sdk";
import { PluginJobService, type PluginJob } from "./job-service.js";

export const JOB_EXECUTION_FAILED = "CMH.JOBS.EXECUTION_FAILED";
export const JOB_HANDLER_MISSING = "CMH.JOBS.NO_HANDLER";

export type JobHandler = (job: PluginJob, scope: ScopeContext, signal: AbortSignal) => Promise<unknown> | unknown;

/** Core-owned dispatcher. Handlers are explicit code registrations, never commands from a manifest. */
export class JobExecutor {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly jobs: PluginJobService) {}

  register(type: string, handler: JobHandler): void {
    if (!/^[a-z][a-z0-9_.-]{0,95}$/u.test(type)) throw new Error("Job type is invalid");
    if (this.handlers.has(type)) throw new Error("Job type is already registered");
    this.handlers.set(type, handler);
  }

  async runOnce(scope: ScopeContext): Promise<PluginJob | undefined> {
    const job = this.jobs.claimNext(scope, [...this.handlers.keys()]);
    if (job === undefined) return undefined;
    const handler = this.handlers.get(job.type);
    if (handler === undefined) return this.jobs.transition(scope, job.id, "failed", { errorCode: JOB_HANDLER_MISSING });
    const controller = new AbortController();
    const key = this.key(scope, job.id);
    this.active.set(key, controller);
    try {
      const result = await handler(job, scope, controller.signal);
      return this.jobs.transition(scope, job.id, "succeeded", { progress: 100, result });
    } catch {
      return this.jobs.transition(scope, job.id, "failed", { errorCode: JOB_EXECUTION_FAILED });
    } finally {
      this.active.delete(key);
    }
  }

  /** Runs a bounded FIFO batch; callers own the scheduling cadence. */
  async runUntilIdle(scope: ScopeContext, maxJobs = 10): Promise<readonly PluginJob[]> {
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) throw new Error("maxJobs is invalid");
    const completed: PluginJob[] = [];
    for (let index = 0; index < maxJobs; index += 1) {
      const result = await this.runOnce(scope);
      if (result === undefined) break;
      completed.push(result);
    }
    return completed;
  }

  /** Requests cooperative cancellation and closes the persisted job state. */
  cancel(scope: ScopeContext, id: string): PluginJob | undefined {
    this.active.get(this.key(scope, id))?.abort();
    return this.jobs.transition(scope, id, "cancelled");
  }

  /** Cancels an organization-visible job and signals any active handler first. */
  cancelOrganization(organizationId: string, id: string): PluginJob | undefined {
    for (const [key, controller] of this.active) {
      if (key.startsWith(`${organizationId}\0`) && key.endsWith(`\0${id}`)) controller.abort();
    }
    return this.jobs.cancelOrganization(organizationId, id);
  }

  private key(scope: ScopeContext, id: string): string {
    return `${scope.organizationId}\0${scope.userId}\0${scope.installationId}\0${id}`;
  }
}
