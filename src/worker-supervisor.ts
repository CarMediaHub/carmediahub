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
  /** Reset the consecutive crash count after a worker stays healthy. Set to 0 to disable. */
  stableRunMs?: number;
  /** Maximum concurrently starting/running Workers for one installation. */
  maxActiveWorkersPerInstallation?: number;
  onEvent?(event: WorkerSupervisorEvent): void;
  schedule?(callback: () => void, delayMs: number): unknown;
  cancel?(handle: unknown): void;
}

export interface WorkerSupervisorEvent {
  type: "worker.crashed" | "worker.failed" | "worker.quota_exceeded";
  installationId: string;
  attempts: number;
  diagnostic: "worker_crashed" | "worker_failed" | "worker_quota_exceeded";
}

interface ManagedWorker {
  state: WorkerState;
  handle?: WorkerHandle | undefined;
  idleTimer?: unknown | undefined;
  restartTimer?: unknown | undefined;
  stableTimer?: unknown | undefined;
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
    const active = [...this.workers.entries()].filter(([candidateKey, candidate]) => candidateKey === installationId || candidateKey.startsWith(`${installationId}:`)).filter(([, candidate]) => candidate.state === "starting" || candidate.state === "running").length;
    const maximumActive = this.options.maxActiveWorkersPerInstallation ?? 16;
    if (active >= maximumActive) {
      const rejected: ManagedWorker = { state: "failed", attempts: current?.attempts ?? 0, lastError: "Worker capacity exceeded" };
      this.workers.set(key, rejected);
      this.emit({ type: "worker.quota_exceeded", installationId, attempts: rejected.attempts, diagnostic: "worker_quota_exceeded" });
      return { installationId, state: "failed", attempts: rejected.attempts, ...(rejected.lastError === undefined ? {} : { lastError: rejected.lastError }) };
    }
    const worker: ManagedWorker = { state: "starting", attempts: current?.attempts ?? 0 };
    this.workers.set(key, worker);
    try {
      const handle = await factory.start({ installationId, endpoint: this.options.endpoint, runtimeCredential: this.options.issueCredential(scope), scope });
      if (this.workers.get(key) !== worker || worker.state !== "starting" || this.options.installation(installationId)?.status !== "installed") {
        await handle.stop();
        return this.status(installationId);
      }
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
      this.scheduleStableReset(key, worker);
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
      this.clearRestart(worker);
      this.clearStable(worker);
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
      this.clearRestart(worker);
      this.clearStable(worker);
      const handle = worker.handle;
      worker.handle = undefined;
      worker.state = "disabled";
      await handle?.stop();
    }
  }

  async stopAll(): Promise<void> {
    const installationIds = new Set(
      [...this.workers.keys()]
        .map((key) => key.split(":", 1)[0])
        .filter((installationId): installationId is string => installationId !== undefined),
    );
    await Promise.all([...installationIds].map((installationId) => this.stop(installationId)));
  }

  private touchIdle(key: string): void {
    const worker = this.workers.get(key);
    if (worker === undefined || worker.state !== "running") return;
    this.clearIdle(worker);
    const schedule = this.options.schedule ?? setTimeout;
    const idleTimer = schedule(() => {
      const current = this.workers.get(key);
      if (current === undefined) return;
      this.clearIdle(current);
      const handle = current.handle;
      current.handle = undefined;
      current.state = "stopped";
      void handle?.stop();
    }, this.options.idleTimeoutMs ?? 60_000);
    // An idle worker must not keep a short-lived CLI or test process alive.
    // Custom schedulers remain fully under the caller's lifecycle control.
    if (this.options.schedule === undefined && typeof idleTimer === "object" && idleTimer !== null && "unref" in idleTimer && typeof idleTimer.unref === "function") {
      idleTimer.unref();
    }
    worker.idleTimer = idleTimer;
  }

  private clearIdle(worker: ManagedWorker): void {
    if (worker.idleTimer === undefined) return;
    if (this.options.cancel !== undefined) this.options.cancel(worker.idleTimer);
    else clearTimeout(worker.idleTimer as NodeJS.Timeout);
    worker.idleTimer = undefined;
  }

  private clearRestart(worker: ManagedWorker): void {
    if (worker.restartTimer === undefined) return;
    if (this.options.cancel !== undefined) this.options.cancel(worker.restartTimer);
    else clearTimeout(worker.restartTimer as NodeJS.Timeout);
    worker.restartTimer = undefined;
  }

  private scheduleStableReset(key: string, worker: ManagedWorker): void {
    this.clearStable(worker);
    const stableRunMs = this.options.stableRunMs ?? 60_000;
    if (stableRunMs <= 0 || worker.attempts === 0) return;
    const schedule = this.options.schedule ?? setTimeout;
    const stableTimer = schedule(() => {
      const current = this.workers.get(key);
      if (current !== worker || worker.state !== "running") return;
      worker.stableTimer = undefined;
      worker.attempts = 0;
    }, stableRunMs);
    if (this.options.schedule === undefined && typeof stableTimer === "object" && stableTimer !== null && "unref" in stableTimer && typeof stableTimer.unref === "function") {
      stableTimer.unref();
    }
    worker.stableTimer = stableTimer;
  }

  private clearStable(worker: ManagedWorker): void {
    if (worker.stableTimer === undefined) return;
    if (this.options.cancel !== undefined) this.options.cancel(worker.stableTimer);
    else clearTimeout(worker.stableTimer as NodeJS.Timeout);
    worker.stableTimer = undefined;
  }

  private crashed(key: string, installationId: string, scope: RuntimeCredentialScope, error: Error): WorkerStatus {
    const worker = this.workers.get(key) ?? { state: "failed", attempts: 0 };
    this.clearIdle(worker);
    this.clearRestart(worker);
    this.clearStable(worker);
    worker.handle = undefined;
    worker.attempts += 1;
    worker.lastError = error.message;
    const maximum = this.options.maxRestartAttempts ?? 3;
    if (worker.attempts > maximum || this.options.installation(installationId)?.status !== "installed") {
      worker.state = this.options.installation(installationId)?.status === "disabled" || this.options.installation(installationId)?.status === "uninstalled" ? "disabled" : "failed";
      this.workers.set(key, worker);
      if (worker.state === "failed") this.emit({ type: "worker.failed", installationId, attempts: worker.attempts, diagnostic: "worker_failed" });
      return this.status(installationId);
    }
    worker.state = "backoff";
    this.workers.set(key, worker);
    this.emit({ type: "worker.crashed", installationId, attempts: worker.attempts, diagnostic: "worker_crashed" });
    const delay = Math.min(1_000 * 2 ** (worker.attempts - 1), 30_000);
    const schedule = this.options.schedule ?? setTimeout;
    worker.restartTimer = schedule(() => {
      if (this.workers.get(key) !== worker || worker.state !== "backoff") return;
      worker.restartTimer = undefined;
      void this.start(installationId, scope);
    }, delay);
    return this.status(installationId);
  }

  private emit(event: WorkerSupervisorEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Observability failures must not change Worker lifecycle or restart behavior.
    }
  }
}
