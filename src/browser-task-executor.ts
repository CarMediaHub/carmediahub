import type { ScopeContext, BrowserTask, BrowserTaskKind, BrowserTaskResult } from "@carmediahub/sdk";
import { Repository } from "./repository.js";

export const BROWSER_TASK_EXECUTION_FAILED = "CMH.BROWSER.TASK_FAILED";
export const BROWSER_TASK_HANDLER_MISSING = "CMH.BROWSER.NO_HANDLER";
export type BrowserTaskHandler = (task: BrowserTask, scope: ScopeContext, signal: AbortSignal) => Promise<BrowserTaskResult | void> | BrowserTaskResult | void;
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
    try {
      const result = await handler(task, scope, controller.signal);
      return this.repository.completeBrowserTask(scope, task.id, result === undefined ? undefined : validateResult(task, result));
    }
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
  cancelUser(organizationId: string, userId: string): number {
    let cancelled = 0;
    for (const task of this.repository.browserTasksForOrganization(organizationId)) {
      if (task.userId !== userId || (task.status !== "queued" && task.status !== "running")) continue;
      const scope = { deploymentId: "core", organizationId, userId, deviceId: "core", sessionId: "core", installationId: task.installationId };
      this.cancel(scope, task.id); cancelled += 1;
    }
    return cancelled;
  }
  private key(scope: ScopeContext, taskId: string): string { return `${scope.organizationId}\0${scope.userId}\0${scope.installationId}\0${taskId}`; }
}

export function validateResult(task: BrowserTask, result: BrowserTaskResult): BrowserTaskResult {
  if (result === null || typeof result !== "object" || result.kind !== task.kind || typeof result.expiresAt !== "string") throw new Error("Browser task result is invalid");
  const expiry = Date.parse(result.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 24 * 60 * 60 * 1000) throw new Error("Browser task result expiry is invalid");
  if (result.reference !== undefined && (typeof result.reference !== "string" || !/^[a-z][a-z0-9._:-]{0,511}$/u.test(result.reference))) throw new Error("Browser task result reference is invalid");
  if (result.fields !== undefined) {
    const entries = Object.entries(result.fields);
    if (entries.length > 12 || entries.some(([key, value]) => !/^[a-z][a-z0-9_.-]{0,63}$/u.test(key) || typeof value === "object" || (typeof value === "string" && (value.length > 512 || /cookie|profile|cdp|password|secret|token|path|url/iu.test(key))))) throw new Error("Browser task result fields are invalid");
  }
  return { kind: result.kind, ...(result.reference === undefined ? {} : { reference: result.reference }), ...(result.fields === undefined ? {} : { fields: Object.freeze({ ...result.fields }) }), expiresAt: result.expiresAt };
}
