import type { ScopeContext } from "@carmediahub/sdk";
import { PluginJobService, type PluginJob } from "./job-service.js";

export const JOB_EXECUTION_FAILED = "CMH.JOBS.EXECUTION_FAILED";
export const JOB_HANDLER_MISSING = "CMH.JOBS.NO_HANDLER";

export type JobHandler = (job: PluginJob, scope: ScopeContext) => Promise<unknown> | unknown;

/** Core-owned dispatcher. Handlers are explicit code registrations, never commands from a manifest. */
export class JobExecutor {
  private readonly handlers = new Map<string, JobHandler>();

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
    try {
      const result = await handler(job, scope);
      return this.jobs.transition(scope, job.id, "succeeded", { progress: 100, result });
    } catch {
      return this.jobs.transition(scope, job.id, "failed", { errorCode: JOB_EXECUTION_FAILED });
    }
  }
}
