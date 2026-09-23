export interface DrainLease {
  release(): void;
}

interface DrainState {
  active: number;
  draining: boolean;
  waiters: Array<() => void>;
}

/** Coordinates bounded installation-level draining without exposing runtime details to plugins. */
export class PluginDrainManager {
  private readonly states = new Map<string, DrainState>();

  private state(installationId: string): DrainState {
    const existing = this.states.get(installationId);
    if (existing !== undefined) return existing;
    const created: DrainState = { active: 0, draining: false, waiters: [] };
    this.states.set(installationId, created);
    return created;
  }

  acquire(installationId: string): DrainLease | undefined {
    const state = this.state(installationId);
    if (state.draining) return undefined;
    state.active += 1;
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      state.active -= 1;
      if (state.active === 0) {
        const waiters = state.waiters.splice(0);
        for (const wake of waiters) wake();
      }
    } };
  }

  begin(installationId: string): boolean {
    const state = this.state(installationId);
    if (state.draining) return false;
    state.draining = true;
    return true;
  }

  async waitForIdle(installationId: string, timeoutMs: number): Promise<boolean> {
    const state = this.state(installationId);
    if (!state.draining) throw new Error("Installation is not draining");
    if (state.active === 0) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let wakeIdle: () => void;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.waiters = state.waiters.filter((wake) => wake !== wakeIdle);
        resolve(result);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      wakeIdle = () => { if (state.active === 0) finish(true); };
      state.waiters.push(wakeIdle);
    });
  }

  resume(installationId: string): void {
    const state = this.states.get(installationId);
    if (state === undefined) return;
    state.draining = false;
    if (state.active === 0 && state.waiters.length > 0) {
      const waiters = state.waiters.splice(0);
      for (const wake of waiters) wake();
    }
  }
}
