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
  readonly packageVersion?: string | undefined;
  start(input: TrustedWorkerStart): Promise<WorkerHandle>;
}

export interface WorkerSupervisorOptions {
  endpoint: string;
  issueCredential(scope: RuntimeCredentialScope): string;
  installation(installationId: string): { packageId: string; packageVersion?: string; status: "installed" | "disabled" | "uninstalled" } | undefined;
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

  private factoryKey(packageId: string, packageVersion?: string): string { return `${packageId}@${packageVersion ?? "*"}`; }

  register(factory: TrustedWorkerFactory): void {
    const key = this.factoryKey(factory.packageId, factory.packageVersion);
    if (this.factories.has(key)) throw new Error(`Worker factory already registered: ${key}`);
    this.factories.set(key, factory);
  }

  hasFactory(packageId: string, packageVersion?: string): boolean {
    return this.factories.has(this.factoryKey(packageId, packageVersion)) || (packageVersion !== undefined && this.factories.has(this.factoryKey(packageId)));
  }

  status(installationId: string): WorkerStatus {
    const workers = [...this.workers.entries()].filter(([key]) => key === installationId || key.startsWith(`${installationId}:`)).map(([, worker]) => worker);
    const worker = workers.find((candidate) => candidate.state === "running") ?? workers.find((candidate) => candidate.state === "starting") ?? workers.find((candidate) => candidate.state === "backoff") ?? workers.find((candidate) => candidate.state === "failed");
    const installation = this.options.installation(installationId);
    return { installationId, state: installation?.status === "disabled" || installation?.status === "uninstalled" ? "disabled" : worker?.state ?? "stopped", attempts: workers.reduce((total, candidate) => total + candidate.attempts, 0), ...(worker?.lastError === undefined ? {} : { lastError: worker.lastError }) };
  }

  private workerKey(installationId: string, scope: RuntimeCredentialScope): string { return `${installationId}:${scope.organizationId}:${scope.userId}`; }

  async start(installationId: string, scope: RuntimeCredentialScope): Promise<WorkerStatus> {
    const installation = this.options.installation(installationId);
    if (installation === undefined || installation.status !== "installed") return { installationId, state: "disabled", attempts: 0 };
    if (scope.installationId !== installationId) throw new Error("Worker scope does not match installation");
    const factory = this.factories.get(this.factoryKey(installation.packageId, installation.packageVersion)) ?? this.factories.get(this.factoryKey(installation.packageId));
    if (factory === undefined) return { installationId, state: "failed", attempts: 0, lastError: "No trusted worker factory is registered" };
    const key = this.workerKey(installationId, scope);
    const current = this.workers.get(key);
    if (current?.state === "running" || current?.state === "starting") {
      this.touchIdle(key);
      return this.status(installationId);
    }
    const worker: ManagedWorker = { state: "starting", attempts: current?.attempts ?? 0 };
    this.workers.set(key, worker);
    try {
      const handle = await factory.start({ installationId, endpoint: this.options.endpoint, runtimeCredential: this.options.issueCredential(scope), scope });
      worker.handle = handle;
      worker.state = "running";
      worker.lastError = undefined;
      handle.onCrash?.((error) => {
        // A process may emit its final exit event after stop() has detached
        // it, including while Core is closing its database. Ignore stale
        // callbacks from handles no longer owned by this supervisor.
        if (this.workers.get(key)?.handle !== handle) return;
        this.crashed(key, installationId, scope, error);
      });
      this.touchIdle(key);
      return this.status(installationId);
    } catch (error) {
      return this.crashed(key, installationId, scope, error instanceof Error ? error : new Error("Worker start failed"));
    }
  }

  async stop(installationId: string): Promise<WorkerStatus> {
    const keys = [...this.workers.keys()].filter((key) => key === installationId || key.startsWith(`${installationId}:`));
    for (const key of keys) {
      const worker = this.workers.get(key);
      if (worker === undefined) continue;
      this.clearIdle(worker);
      const handle = worker.handle;
      worker.handle = undefined;
      worker.state = this.options.installation(installationId)?.status === "disabled" || this.options.installation(installationId)?.status === "uninstalled" ? "disabled" : "stopped";
      await handle?.stop();
    }
    return this.status(installationId);
  }

  async disable(installationId: string): Promise<void> {
    const keys = [...this.workers.keys()].filter((key) => key === installationId || key.startsWith(`${installationId}:`));
    for (const key of keys) {
      const worker = this.workers.get(key);
      if (worker === undefined) continue;
      this.clearIdle(worker);
      const handle = worker.handle;
      worker.handle = undefined;
      worker.state = "disabled";
      await handle?.stop();
    }
  }

  async stopAll(): Promise<void> {
    const installationIds = new Set([...this.workers.keys()].map((key) => key.split(":", 1)[0]));
    await Promise.all([...installationIds].map((installationId) => this.stop(installationId)));
  }

  private touchIdle(key: string): void {
    const worker = this.workers.get(key);
    if (worker === undefined || worker.state !== "running") return;
    this.clearIdle(worker);
    const schedule = this.options.schedule ?? setTimeout;
    worker.idleTimer = schedule(() => {
      const current = this.workers.get(key);
      if (current === undefined) return;
      this.clearIdle(current);
      const handle = current.handle;
      current.handle = undefined;
      current.state = "stopped";
      void handle?.stop();
    }, this.options.idleTimeoutMs ?? 60_000);
  }

  private clearIdle(worker: ManagedWorker): void {
    if (worker.idleTimer === undefined) return;
    if (this.options.cancel !== undefined) this.options.cancel(worker.idleTimer);
    else clearTimeout(worker.idleTimer as NodeJS.Timeout);
    worker.idleTimer = undefined;
  }

  private crashed(key: string, installationId: string, scope: RuntimeCredentialScope, error: Error): WorkerStatus {
    const worker = this.workers.get(key) ?? { state: "failed", attempts: 0 };
    this.clearIdle(worker);
    worker.handle = undefined;
    worker.attempts += 1;
    worker.lastError = error.message;
    const maximum = this.options.maxRestartAttempts ?? 3;
    if (worker.attempts > maximum || this.options.installation(installationId)?.status !== "installed") {
      worker.state = this.options.installation(installationId)?.status === "disabled" || this.options.installation(installationId)?.status === "uninstalled" ? "disabled" : "failed";
      this.workers.set(key, worker);
      return this.status(installationId);
    }
    worker.state = "backoff";
    this.workers.set(key, worker);
    const delay = Math.min(1_000 * 2 ** (worker.attempts - 1), 30_000);
    (this.options.schedule ?? setTimeout)(() => { void this.start(installationId, scope); }, delay);
    return this.status(installationId);
  }
}
