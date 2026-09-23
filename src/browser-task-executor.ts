import type { ScopeContext, BrowserTask, BrowserTaskKind } from "@carmediahub/sdk";
import { Repository } from "./repository.js";

export const BROWSER_TASK_EXECUTION_FAILED = "CMH.BROWSER.TASK_FAILED";
export const BROWSER_TASK_HANDLER_MISSING = "CMH.BROWSER.NO_HANDLER";
export type BrowserTaskHandler = (task: BrowserTask, scope: ScopeContext, signal: AbortSignal) => Promise<void> | void;
export interface BrowserTaskHandlerOptions {
  /** Logical Core-owned targets. Raw URLs, scripts and host paths are never accepted. */
  allowedTargets: readonly string[];
}

/** Core-owned browser task dispatcher. It supplies no browser APIs or host paths to handlers. */
export class BrowserTaskExecutor {
  private readonly handlers = new Map<BrowserTaskKind, BrowserTaskHandler>();
  private readonly targetPolicies = new Map<BrowserTaskKind, ReadonlySet<string>>();
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly repository: Repository) {}
  register(kind: BrowserTaskKind, handler: BrowserTaskHandler, options: BrowserTaskHandlerOptions): void {
    if (this.handlers.has(kind)) throw new Error("Browser task handler is already registered");
    const targets = new Set(options.allowedTargets);
    if (targets.size === 0 || [...targets].some((target) => !/^[a-z][a-z0-9._-]{0,127}$/u.test(target))) throw new Error("Browser task target allowlist is invalid");
    this.handlers.set(kind, handler);
    this.targetPolicies.set(kind, targets);
  }
  async runOnce(scope: ScopeContext): Promise<BrowserTask | undefined> {
    const task = this.repository.claimBrowserTask(scope); if (task === undefined) return undefined;
    const handler = this.handlers.get(task.kind); if (handler === undefined) return this.repository.failBrowserTask(scope, task.id);
    const target = task.input.target;
    if (target === undefined || !this.targetPolicies.get(task.kind)?.has(target)) return this.repository.failBrowserTask(scope, task.id);
    const controller = new AbortController(); const key = this.key(scope, task.id); this.active.set(key, controller);
    try { await handler(task, scope, controller.signal); return this.repository.completeBrowserTask(scope, task.id); }
    catch { return this.repository.failBrowserTask(scope, task.id); }
    finally { this.active.delete(key); }
  }
  async runUntilIdle(scope: ScopeContext, maxTasks = 10): Promise<readonly BrowserTask[]> {
    if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 100) throw new Error("Browser task batch size is invalid");
    const completed: BrowserTask[] = []; for (let index = 0; index < maxTasks; index += 1) { const task = await this.runOnce(scope); if (task === undefined) break; completed.push(task); } return completed;
  }
  cancel(scope: ScopeContext, taskId: string): BrowserTask | undefined { this.active.get(this.key(scope, taskId))?.abort(); return this.repository.cancelBrowserTask(scope, taskId); }
  cancelSession(scope: ScopeContext, sessionId: string): number {
    let cancelled = 0;
    for (const task of this.repository.browserTasks(scope)) {
      if (task.sessionId === sessionId && (task.status === "queued" || task.status === "running")) {
        this.cancel(scope, task.id); cancelled += 1;
      }
    }
    return cancelled;
  }
  cancelInstallation(organizationId: string, installationId: string): number {
    let cancelled = 0;
    for (const task of this.repository.browserTasksForOrganization(organizationId)) {
      if (task.installationId !== installationId || (task.status !== "queued" && task.status !== "running")) continue;
      const scope = { deploymentId: "core", organizationId, userId: task.userId, deviceId: "core", sessionId: "core", installationId };
      this.cancel(scope, task.id); cancelled += 1;
    }
    return cancelled;
  }
  private key(scope: ScopeContext, taskId: string): string { return `${scope.organizationId}\0${scope.userId}\0${scope.installationId}\0${taskId}`; }
}
