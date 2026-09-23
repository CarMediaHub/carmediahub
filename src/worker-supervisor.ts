import type { RuntimeCredentialScope } from "./runtime-broker.js";

export type WorkerState = "stopped" | "starting" | "running" | "backoff" | "disabled" | "failed";

export interface WorkerHandle {
  stop(): Promise<void> | void;
  onCrash?(listener: (error: Error) => void): void;
}

export interface TrustedWorkerStart {
  installationId: string;
  endpoint: string;
  runtimeCredential: string;
  scope: RuntimeCredentialScope;
}

export interface TrustedWorkerFactory {
  readonly packageId: string;
  start(input: TrustedWorkerStart): Promise<WorkerHandle>;
}

export interface WorkerSupervisorOptions {
  endpoint: string;
  issueCredential(scope: RuntimeCredentialScope): string;
  installation(installationId: string): { packageId: string; status: "installed" | "disabled" | "uninstalled" } | undefined;
  idleTimeoutMs?: number;
  maxRestartAttempts?: number;
  schedule?(callback: () => void, delayMs: number): unknown;
  cancel?(handle: unknown): void;
}

interface ManagedWorker {
  state: WorkerState;
  handle?: WorkerHandle | undefined;
  idleTimer?: unknown | undefined;
  attempts: number;
  lastError?: string | undefined;
}

export interface WorkerStatus {
  installationId: string;
  state: WorkerState;
  attempts: number;
  lastError?: string;
}

/**
 * Schedules trusted Worker factories only. Plugin manifests never provide a
 * command, executable path, or module path, so installation cannot become an
 * arbitrary process-execution channel.
 */
export class WorkerSupervisor {
  private readonly factories = new Map<string, TrustedWorkerFactory>();
  private readonly workers = new Map<string, ManagedWorker>();

  constructor(private readonly options: WorkerSupervisorOptions) {}

  register(factory: TrustedWorkerFactory): void {
    if (this.factories.has(factory.packageId)) throw new Error(`Worker factory already registered: ${factory.packageId}`);
    this.factories.set(factory.packageId, factory);
  }

  hasFactory(packageId: string): boolean {
    return this.factories.has(packageId);
  }

  status(installationId: string): WorkerStatus {
    const worker = this.workers.get(installationId);
    const installation = this.options.installation(installationId);
    return { installationId, state: installation?.status === "disabled" || installation?.status === "uninstalled" ? "disabled" : worker?.state ?? "stopped", attempts: worker?.attempts ?? 0, ...(worker?.lastError === undefined ? {} : { lastError: worker.lastError }) };
  }

  async start(installationId: string, scope: RuntimeCredentialScope): Promise<WorkerStatus> {
    const installation = this.options.installation(installationId);
    if (installation === undefined || installation.status !== "installed") return { installationId, state: "disabled", attempts: 0 };
    if (scope.installationId !== installationId) throw new Error("Worker scope does not match installation");
    const factory = this.factories.get(installation.packageId);
    if (factory === undefined) return { installationId, state: "failed", attempts: 0, lastError: "No trusted worker factory is registered" };
    const current = this.workers.get(installationId);
    if (current?.state === "running" || current?.state === "starting") {
      this.touchIdle(installationId);
      return this.status(installationId);
    }
    const worker: ManagedWorker = { state: "starting", attempts: current?.attempts ?? 0 };
    this.workers.set(installationId, worker);
    try {
      const handle = await factory.start({ installationId, endpoint: this.options.endpoint, runtimeCredential: this.options.issueCredential(scope), scope });
      worker.handle = handle;
      worker.state = "running";
      worker.lastError = undefined;
      handle.onCrash?.((error) => this.crashed(installationId, scope, error));
      this.touchIdle(installationId);
      return this.status(installationId);
    } catch (error) {
      return this.crashed(installationId, scope, error instanceof Error ? error : new Error("Worker start failed"));
    }
  }

  async stop(installationId: string): Promise<WorkerStatus> {
    const worker = this.workers.get(installationId);
    if (worker === undefined) return this.status(installationId);
    this.clearIdle(worker);
    const handle = worker.handle;
    worker.handle = undefined;
    worker.state = this.options.installation(installationId)?.status === "disabled" || this.options.installation(installationId)?.status === "uninstalled" ? "disabled" : "stopped";
    await handle?.stop();
    return this.status(installationId);
  }

  async disable(installationId: string): Promise<void> {
    const worker = this.workers.get(installationId);
    if (worker !== undefined) {
      this.clearIdle(worker);
      const handle = worker.handle;
      worker.handle = undefined;
      worker.state = "disabled";
      await handle?.stop();
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.workers.keys()].map((installationId) => this.stop(installationId)));
  }

  private touchIdle(installationId: string): void {
    const worker = this.workers.get(installationId);
    if (worker === undefined || worker.state !== "running") return;
    this.clearIdle(worker);
    const schedule = this.options.schedule ?? setTimeout;
    worker.idleTimer = schedule(() => { void this.stop(installationId); }, this.options.idleTimeoutMs ?? 60_000);
  }

  private clearIdle(worker: ManagedWorker): void {
    if (worker.idleTimer === undefined) return;
    if (this.options.cancel !== undefined) this.options.cancel(worker.idleTimer);
    else clearTimeout(worker.idleTimer as NodeJS.Timeout);
    worker.idleTimer = undefined;
  }

  private crashed(installationId: string, scope: RuntimeCredentialScope, error: Error): WorkerStatus {
    const worker = this.workers.get(installationId) ?? { state: "failed", attempts: 0 };
    this.clearIdle(worker);
    worker.handle = undefined;
    worker.attempts += 1;
    worker.lastError = error.message;
    const maximum = this.options.maxRestartAttempts ?? 3;
    if (worker.attempts > maximum || this.options.installation(installationId)?.status !== "installed") {
      worker.state = this.options.installation(installationId)?.status === "disabled" || this.options.installation(installationId)?.status === "uninstalled" ? "disabled" : "failed";
      this.workers.set(installationId, worker);
      return this.status(installationId);
    }
    worker.state = "backoff";
    this.workers.set(installationId, worker);
    const delay = Math.min(1_000 * 2 ** (worker.attempts - 1), 30_000);
    (this.options.schedule ?? setTimeout)(() => { void this.start(installationId, scope); }, delay);
    return this.status(installationId);
  }
}
